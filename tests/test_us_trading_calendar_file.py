"""The US trading calendar file: the Futu provider writes what OpenD published, and every US trading-day decision on the
Python side reads it (config/market_holidays.py). Thanksgiving (Thursday 2026-11-26) is the closed weekday."""
from __future__ import annotations

import json
from datetime import date, datetime, timezone
from types import SimpleNamespace

import pytest

import config.market_holidays as holidays
from service.market.futu.trading_calendar import FutuTradingCalendar
from service.market.lifecycle.session import FUTU_US_ALL_SPEC, resolve_session

SDK = SimpleNamespace(TradeDateMarket=SimpleNamespace(US="US"))
NOVEMBER_TRADING_DAYS = [f"2026-11-{day:02d}" for day in (16, 17, 18, 19, 20, 23, 24, 25, 27, 30)]


def _write(path, *, first="2026-11-16", last="2026-11-30", days=NOVEMBER_TRADING_DAYS, schema=holidays.US_CALENDAR_SCHEMA):
    path.write_text(json.dumps({"schema": schema, "source": "futu_opend", "from": first, "to": last,
                                "read_at": "2026-11-16T09:00:00-05:00",
                                "days": [{"date": day, "kind": "WHOLE"} for day in days]}), encoding="utf-8")
    return path


@pytest.fixture()
def calendar_file(tmp_path, monkeypatch):
    path = tmp_path / "us_trading_calendar.json"
    monkeypatch.setattr(holidays, "us_calendar_path", lambda: path)
    return path


def test_the_window_decides_and_outside_it_the_nyse_days_stand(calendar_file):
    # No file written yet: the NYSE days of config/market_holidays.json (Thanksgiving closed, 12-25 closed).
    assert holidays.us_trading_day(date(2026, 11, 26)) is False
    assert holidays.futu_trading_day("US", date(2026, 11, 26)) is False
    assert holidays.us_trading_day(date(2029, 11, 22)) is None, "a year the NYSE section does not list: no answer"
    assert holidays.futu_trading_day("US", date(2029, 11, 22)) is True, "the weekday rule"
    _write(calendar_file)
    assert holidays.us_trading_day(date(2026, 11, 26)) is False
    assert holidays.us_trading_day(date(2026, 11, 25)) is True
    assert holidays.us_trading_day(date(2026, 11, 28)) is False, "a weekend inside the window is closed too"
    assert holidays.us_trading_day(date(2026, 12, 1)) is True, "after the window: the NYSE days"
    assert holidays.us_trading_day(date(2026, 12, 25)) is False, "after the window: the NYSE days"
    assert holidays.futu_trading_day("US", date(2026, 11, 26)) is False
    assert holidays.futu_trading_day("HK", date(2026, 11, 26)) is True, "no calendar is read for the other markets"


def test_a_file_that_does_not_validate_keeps_the_last_answer(calendar_file):
    _write(calendar_file)
    assert holidays.us_trading_day(date(2026, 11, 26)) is False
    _write(calendar_file, days=["2026-12-24"])          # a trading day outside its own window
    assert holidays.us_trading_day(date(2026, 11, 26)) is False


def test_each_opend_answer_is_written_whole_for_every_reader(tmp_path, monkeypatch):
    path = tmp_path / "futu" / "us_trading_calendar.json"
    monkeypatch.setattr(holidays, "us_calendar_path", lambda: path)

    def call(context, method, **kwargs):
        return [{"time": day, "trade_date_type": "WHOLE"} for day in NOVEMBER_TRADING_DAYS]

    calendar = FutuTradingCalendar(call, lambda: SDK, clock=lambda: datetime(2026, 11, 20, 15, 0, tzinfo=timezone.utc), path=path)
    calendar.refresh(object())
    written = json.loads(path.read_text(encoding="utf-8"))
    assert (written["schema"], written["from"], written["to"]) == (holidays.US_CALENDAR_SCHEMA, "2026-11-10", "2026-12-04")
    assert holidays.us_trading_day(date(2026, 11, 26)) is False


def test_a_failed_write_is_a_failed_read_asked_again(tmp_path):
    blocker = tmp_path / "not-a-directory"
    blocker.write_text("x", encoding="utf-8")

    def call(context, method, **kwargs):
        return [{"time": "2026-11-25", "trade_date_type": "WHOLE"}]

    calendar = FutuTradingCalendar(call, lambda: SDK, clock=lambda: datetime(2026, 11, 20, 15, 0, tzinfo=timezone.utc),
                                   path=blocker / "us_trading_calendar.json")
    with pytest.raises(OSError):
        calendar.refresh(object())
    assert not (blocker / "us_trading_calendar.json").exists()
    assert not calendar.due(), "asked again a minute later, like a refused read"


def test_the_us_session_lifecycle_has_no_session_on_a_holiday(calendar_file):
    _write(calendar_file)
    new_york = FUTU_US_ALL_SPEC.zone
    thanksgiving_noon = datetime(2026, 11, 26, 12, 0, tzinfo=new_york)
    resolution = resolve_session(FUTU_US_ALL_SPEC, thanksgiving_noon)
    assert resolution.active is False
    assert resolution.restore_identity.trading_date == "2026-11-25", "the session that just closed, not the one before"
    saturday = resolve_session(FUTU_US_ALL_SPEC, datetime(2026, 11, 21, 12, 0, tzinfo=new_york))
    assert saturday.active is False and saturday.restore_identity.trading_date == "2026-11-20"
    # Thursday 20:00 opens Friday's session (the half day), as Sunday 20:00 opens Monday's; its prints go to the
    # partition of the New York date they happen on (session_identity_contract.futu_partition_date).
    evening = resolve_session(FUTU_US_ALL_SPEC, datetime(2026, 11, 26, 20, 30, tzinfo=new_york))
    assert evening.active is True and evening.current_identity.trading_date == "2026-11-26"
    # Wednesday 20:00 opens nothing: Thursday has no session.
    wednesday_evening = resolve_session(FUTU_US_ALL_SPEC, datetime(2026, 11, 25, 20, 30, tzinfo=new_york))
    assert wednesday_evening.active is False
