"""A Shioaji day rolls in on its first print, and a day with none by 09:00 is an observed closure (user 10-23).

Market Runtime writes both into its sessions file (native/market_runtime/src/rollover.rs MarketSessions);
config/market_holidays.py reads it again whenever it changes, so an observed closure is no trading day here, the
screens' trading date waits for the first print, and no lane is expected to have data before it (no 行情停滯).
"""
from __future__ import annotations

import json
import os
from datetime import date, datetime

import pytest

import config.market_holidays as holidays
from service.market.lifecycle.policy import SessionPolicyEngine
from service.market.lifecycle.resolver import MarketSessionResolver


@pytest.fixture()
def sessions(tmp_path, monkeypatch):
    path = tmp_path / "market_sessions.json"
    monkeypatch.setattr(holidays, "sessions_path", lambda: path)
    holidays.reload()
    stamp = [1_700_000_000_000_000_000]

    def write(day: str, closures: list[str] = ()):
        path.write_text(json.dumps({"schema": "market-sessions-v1", "opened": {"day": day, "night": day},
                                    "closures": [{"date": d, "observed_at": "t", "reason": "r"} for d in closures]}),
                        encoding="utf-8")
        # Each write gets a newer modification time, as the reader keys on it.
        stamp[0] += 1_000_000_000
        os.utime(path, ns=(stamp[0], stamp[0]))

    yield write
    holidays.reload()


def test_without_a_sessions_file_the_clock_decides(sessions):
    assert holidays.tw_day_session_opened(date(2026, 10, 7)) is True
    assert holidays.tw_trading_day(date(2026, 10, 7)) is True


def test_an_observed_closure_is_no_trading_day_and_is_read_again_when_the_file_changes(sessions):
    sessions("2026-10-06")
    assert holidays.tw_trading_day(date(2026, 10, 7)) is True
    assert holidays.tw_day_session_opened(date(2026, 10, 7)) is False
    assert holidays.tw_day_session_opened(date(2026, 10, 6)) is True
    sessions("2026-10-06", ["2026-10-07"])
    assert holidays.tw_trading_day(date(2026, 10, 7)) is False
    resolver = MarketSessionResolver(None)
    assert resolver.resolve("STK", now=datetime(2026, 10, 7, 10, 0)).live is False


def test_a_file_that_stops_validating_keeps_the_last_closures(sessions, tmp_path):
    sessions("2026-10-06", ["2026-10-07"])
    assert holidays.tw_trading_day(date(2026, 10, 7)) is False
    path = holidays.sessions_path()
    path.write_text("{", encoding="utf-8")
    os.utime(path, ns=(1_800_000_000_000_000_000, 1_800_000_000_000_000_000))
    assert holidays.tw_trading_day(date(2026, 10, 7)) is False



def test_no_lane_is_expected_before_the_first_print_but_the_session_still_owns_the_subscriptions(sessions):
    resolution = MarketSessionResolver(None).resolve("STK", now=datetime(2026, 10, 7, 9, 30))
    engine = SessionPolicyEngine()
    waiting = engine.evaluate(resolution, candidate_identity="STK|2026-10-07|DAY|", opened=False)
    assert waiting.expected_lanes == {}
    assert waiting.owns_market_data and waiting.activate_candidate
    opened = engine.evaluate(resolution, candidate_identity="STK|2026-10-07|DAY|", opened=True)
    assert set(opened.expected_lanes) == {"stk.tick", "stk.bidask", "index.quote"}
