"""The futures session windows the lifecycle resolves come from the one session contract (config/trading_sessions.json,
which Market Runtime partitions by): DAY 08:45-13:45 on every trading date, the monthly expiry date included, and the
NIGHT the trading date rolls into (the preceding evening). No market-wide date rule shortens a session: a contract
month's own last trading day is that contract's data."""
from __future__ import annotations

from datetime import date, datetime

from service.market.lifecycle import calendar as calendar_module
from service.market.lifecycle.calendar import MarketSessionCalendar
from service.market.shared.session_identity_contract import partition_end

THIRD_WEDNESDAY = date(2026, 9, 16)


def test_the_monthly_expiry_date_closes_at_13_45_like_any_other():
    calendar = MarketSessionCalendar()
    day = calendar.window(THIRD_WEDNESDAY, "day")
    assert (day.start, day.end) == (datetime(2026, 9, 16, 8, 45), datetime(2026, 9, 16, 13, 45))
    full = calendar.window(THIRD_WEDNESDAY, "full")
    assert (full.start, full.end) == (datetime(2026, 9, 15, 15, 0), datetime(2026, 9, 16, 13, 45))
    assert day.end == partition_end("shioaji", "FUT", "2026-09-16", "DAY").replace(tzinfo=None)
    assert not hasattr(calendar, "is_expiry_day") and not hasattr(day, "expiry_day")


def test_the_night_before_is_a_full_night():
    night = MarketSessionCalendar().window(THIRD_WEDNESDAY, "night")
    assert (night.start, night.end) == (datetime(2026, 9, 15, 15, 0), datetime(2026, 9, 16, 5, 0))


def test_a_monday_night_opened_friday_ends_saturday_morning():
    night = MarketSessionCalendar().window(date(2026, 9, 21), "night")
    assert (night.start, night.end) == (datetime(2026, 9, 18, 15, 0), datetime(2026, 9, 19, 5, 0))


def test_the_windows_are_the_session_contract(monkeypatch):
    contract = {"markets": {"shioaji|FUT": [{"session": "DAY", "intervals": [[530, 820]]},
                                            {"session": "NIGHT", "intervals": [[905, 1730]]}]}}
    monkeypatch.setattr(calendar_module, "TRADING_SESSIONS", contract)
    full = MarketSessionCalendar().window(date(2026, 9, 17), "full")
    assert (full.start, full.end) == (datetime(2026, 9, 16, 15, 5), datetime(2026, 9, 17, 13, 40))
