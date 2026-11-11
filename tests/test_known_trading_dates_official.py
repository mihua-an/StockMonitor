"""A day with data on disk is not a trading day unless the official schedule says so.

A weekend broker snapshot became a sealed FUT "DAY" partition for a Saturday; the display context then
resolved 期貨 日盤 / 夜盤 / 全日 to that empty Saturday and the 期貨走勢 panel showed nothing.
"""
from __future__ import annotations

from datetime import date

from service.market.history import historical_store
from service.market.lifecycle.calendar import MarketSessionCalendar


def _store_with(monkeypatch, dates):
    monkeypatch.setattr(historical_store.HistoricalStore, "list_dates", lambda self, market=None: list(dates))


def test_data_on_disk_is_never_calendar_evidence(monkeypatch):
    # One calendar -- the official schedule, else the weekday rule. A stored Saturday or closure
    # partition changes nothing.
    _store_with(monkeypatch, ["2026-10-03", "2026-10-02", "2026-10-09", "2026-10-08"])
    calendar = MarketSessionCalendar()
    assert not hasattr(calendar, "known_trading_dates")
    assert calendar.next_trading_date(date(2026, 10, 3)) == (date(2026, 10, 5), "official_calendar"), "Saturday is skipped"
    assert calendar.next_trading_date(date(2026, 10, 9)) == (date(2026, 10, 12), "official_calendar"), "so is the closure"
    assert calendar.previous_trading_date(date(2026, 10, 12)) == (date(2026, 10, 8), "official_calendar")



def test_full_after_a_closure_reads_the_night_that_really_opened_it():
    from service.market.shared.session_identity_contract import session_windows
    assert session_windows("shioaji", "FUT", "2026-10-12", "FULL") == [
        ("shioaji", "FUT", "2026-10-08", "NIGHT"), ("shioaji", "FUT", "2026-10-12", "DAY")],         "Monday 10/12's night opened Thursday 10/8 (Friday 10/9 closed), not on the closure"
    assert session_windows("shioaji", "FUT", "2026-10-05", "NIGHT") == [("shioaji", "FUT", "2026-10-02", "NIGHT")]
    assert session_windows("shioaji", "FUT", "2026-10-07", "FULL")[0][2] == "2026-10-06"

