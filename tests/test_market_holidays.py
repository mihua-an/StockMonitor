"""Weekday holidays come from TWSE's official schedule, not the weekday rule.

Without holiday data every weekday was a trading day: a weekday holiday opened a session that never traded,
raised 行情停滯 and left the closing panel on an empty "today".
"""
from __future__ import annotations

import json
from datetime import date, datetime

import pytest

import config.market_holidays as holidays
from scripts.tooling import update_market_holidays as updater
from service.market.lifecycle.calendar import MarketSessionCalendar
from service.market.lifecycle.resolver import MarketSessionResolver

ROWS = [
    {"Name": "中華民國開國紀念日", "Date": "1150101"},
    {"Name": "國曆新年開始交易日", "Date": "1150102"},
    {"Name": "市場無交易，僅辦理結算交割作業", "Date": "1150212"},
    {"Name": "中秋節", "Date": "1150925"},
    {"Name": "孔子誕辰紀念日/ 教師節", "Date": "1150928"},
]


@pytest.fixture()
def schedule(tmp_path, monkeypatch):
    path = tmp_path / "market_holidays.json"
    data = updater.merge_fetched({"schema": updater.SCHEMA, "markets": {}}, updater.classify(ROWS), fetched_at="t")
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(holidays, "PATH", path)
    holidays.reload()
    yield path
    holidays.reload()


def test_the_schedule_names_trading_days_too():
    years = updater.classify(ROWS)
    assert [r["date"] for r in years["2026"]["closed"]] == ["2026-01-01", "2026-02-12", "2026-09-25", "2026-09-28"]
    assert [r["date"] for r in years["2026"]["trading"]] == ["2026-01-02"]
    assert updater.roc_date("1150925") == date(2026, 9, 25)


def test_weekday_holidays_are_closed_and_uncovered_years_say_they_fell_back(schedule):
    resolver = MarketSessionResolver(None)
    assert resolver._is_equity_trading_day(date(2026, 9, 25)) == (False, "official_calendar")
    assert resolver._is_equity_trading_day(date(2026, 9, 29)) == (True, "official_calendar")
    assert resolver._is_equity_trading_day(date(2026, 9, 26)) == (False, "official_calendar"), "weekends stay closed"
    assert resolver._is_equity_trading_day(date(2027, 1, 4)) == (True, "weekday_fallback")


def test_a_holiday_afternoon_shows_the_last_real_session(schedule):
    # Monday 09-28 (教師節) after 13:30 must not pick 09-28 itself; Friday 09-25 is 中秋 too.
    assert MarketSessionResolver(None).resolve("STK", now=datetime(2026, 9, 28, 10, 0)).live is False


def test_a_night_session_before_a_long_weekend_rolls_into_the_next_open_day(schedule):
    calendar = MarketSessionCalendar()
    assert calendar.trading_date_for_timestamp(datetime(2026, 9, 24, 16, 0)) == (date(2026, 9, 29), "official_calendar")
    assert calendar.previous_trading_date(date(2026, 9, 29)) == (date(2026, 9, 24), "official_calendar")


def test_a_manual_typhoon_closure_survives_the_next_fetch():
    data = updater.merge_fetched({"schema": updater.SCHEMA, "markets": {}}, updater.classify(ROWS), fetched_at="t1")
    data = updater.add_manual_closure(data, date(2026, 7, 29), "颱風停止交易")
    data = updater.merge_fetched(data, updater.classify(ROWS), fetched_at="t2")
    closed = data["markets"]["TWSE"]["years"]["2026"]["closed"]
    assert {"date": "2026-07-29", "name": "颱風停止交易", "manual": True} in closed


def test_a_typhoon_closure_on_a_trading_friday_keeps_the_last_session_on_screen(tmp_path, monkeypatch):
    """10-23 (薔琵颱風): Friday was a trading day until TWSE closed it the evening before; Monday 10-26 is 光復節.
    Recorded by hand, the closed Friday is no trading day and no session is live on it (which session the screens
    hold is Market Runtime's: rollover.rs an_observed_closure_keeps_the_last_session_and_is_no_trading_day)."""
    from service.market.shared.session_identity_contract import is_business_session

    rows = ROWS + [{"Name": "臺灣光復暨金門古寧頭大捷紀念日補假", "Date": "1151026"}]
    data = updater.merge_fetched({"schema": updater.SCHEMA, "markets": {}}, updater.classify(rows), fetched_at="t")
    path = tmp_path / "market_holidays.json"
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(holidays, "PATH", path)
    holidays.reload()
    resolver = MarketSessionResolver(None)
    assert resolver.resolve("STK", now=datetime(2026, 10, 23, 10, 0)).live is True, "before the closure: a trading day"

    path.write_text(json.dumps(updater.add_manual_closure(data, date(2026, 10, 23), "薔琵颱風停止交易"), ensure_ascii=False),
                    encoding="utf-8")
    holidays.reload()
    try:
        for hhmm in ((8, 40), (10, 0), (14, 0)):
            resolution = resolver.resolve("STK", now=datetime(2026, 10, 23, *hhmm))
            assert (resolution.live, resolution.reason) == (False, "non_trading_day"), hhmm
        assert is_business_session("shioaji", "STK", "DAY", "2026-10-23") is False
        assert is_business_session("shioaji", "STK", "DAY", "2026-10-27") is True
        assert resolver.resolve("STK", now=datetime(2026, 10, 26, 10, 0)).live is False
        # The night session Thursday opened belongs to the next open day.
        assert MarketSessionCalendar().trading_date_for_timestamp(datetime(2026, 10, 22, 16, 0)) == (date(2026, 10, 27), "official_calendar")
    finally:
        holidays.reload()


def test_us_days_come_from_the_nyse_section_where_opend_has_no_calendar(tmp_path, monkeypatch):
    # No OpenD file (Futu off, or OpenD not read yet): Thanksgiving was a trading day by the weekday rule.
    data = {"schema": updater.SCHEMA, "markets": {}}
    updater.add_nyse_day(data, date(2026, 11, 26), "Thanksgiving Day", "closed")
    updater.add_nyse_day(data, date(2026, 11, 27), "Day after Thanksgiving", "half")
    path = tmp_path / "market_holidays.json"
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(holidays, "PATH", path)
    monkeypatch.setattr(holidays, "us_calendar_path", lambda: tmp_path / "absent.json")
    holidays.reload()
    try:
        assert holidays.futu_trading_day("US", date(2026, 11, 26)) is False
        assert holidays.futu_trading_day("US", date(2026, 11, 27)) is True, "a half day trades"
        assert holidays.us_trading_day(date(2026, 11, 28)) is False, "a weekend"
        assert holidays.us_trading_day(date(2027, 11, 25)) is None, "a year the section does not list"
        assert holidays.futu_trading_day("HK", date(2026, 11, 26)) is True, "no calendar is read for HK"
        # OpenD's calendar decides inside its window: it trades a day the file closed.
        opend = tmp_path / "us_trading_calendar.json"
        opend.write_text(json.dumps({"schema": holidays.US_CALENDAR_SCHEMA, "from": "2026-11-26", "to": "2026-11-26",
                                     "days": [{"date": "2026-11-26", "kind": "WHOLE"}]}), encoding="utf-8")
        monkeypatch.setattr(holidays, "us_calendar_path", lambda: opend)
        assert holidays.us_trading_day(date(2026, 11, 26)) is True
    finally:
        holidays.reload()


def test_an_nyse_day_is_in_one_list_and_never_a_weekend():
    data = {"schema": updater.SCHEMA, "markets": {}}
    updater.add_nyse_day(data, date(2026, 11, 27), "x", "closed")
    updater.add_nyse_day(data, date(2026, 11, 27), "Day after Thanksgiving", "half")
    year = data["markets"]["NYSE"]["years"]["2026"]
    assert year["closed"] == [] and [r["date"] for r in year["half"]] == ["2026-11-27"]
    with pytest.raises(SystemExit):
        updater.add_nyse_day(data, date(2026, 11, 28), "Saturday", "closed")


def test_the_repo_file_lists_the_2026_nyse_days():
    data = json.loads(holidays.PATH.read_text(encoding="utf-8"))
    year = data["markets"]["NYSE"]["years"]["2026"]
    assert "2026-11-26" in {r["date"] for r in year["closed"]}
    assert {r["date"] for r in year["half"]} == {"2026-11-27", "2026-12-24"}
