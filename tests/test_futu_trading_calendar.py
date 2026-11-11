"""The US exchange calendar read from OpenD (service/market/futu/trading_calendar.py)."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from service.market.futu.trading_calendar import FutuTradingCalendar

SDK = SimpleNamespace(TradeDateMarket=SimpleNamespace(US="US"))


class Clock:
    def __init__(self, now: datetime) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


def test_reads_once_per_new_york_day_and_writes_the_days(tmp_path):
    calls = []

    def call(context, method, **kwargs):
        calls.append((method, kwargs))
        return [{"time": "2026-11-26", "trade_date_type": "WHOLE"}, {"time": "2026-11-27", "trade_date_type": "MORNING"}, {"time": "bad"}]

    # 2026-11-26 03:00 UTC is still 2026-11-25 in New York.
    clock = Clock(datetime(2026, 11, 26, 3, 0, tzinfo=timezone.utc))
    path = tmp_path / "us_trading_calendar.json"
    calendar = FutuTradingCalendar(call, lambda: SDK, clock=clock, path=path)
    assert calendar.due()
    calendar.refresh(object())
    assert calls == [("request_trading_days", {"market": "US", "start": "2026-11-15", "end": "2026-12-09"})]
    written = json.loads(path.read_text(encoding="utf-8"))
    assert (written["from"], written["to"]) == ("2026-11-15", "2026-12-09")
    assert written["days"] == [{"date": "2026-11-26", "kind": "WHOLE"}, {"date": "2026-11-27", "kind": "MORNING"}]
    assert not calendar.due()
    clock.now += timedelta(hours=5)  # 2026-11-26 in New York: a new day's read
    assert calendar.due()


def test_a_refused_read_is_recorded_and_asked_again_a_minute_later():
    def call(context, method, **kwargs):
        raise RuntimeError("OpenD refused")

    clock = Clock(datetime(2026, 11, 26, 15, 0, tzinfo=timezone.utc))
    calendar = FutuTradingCalendar(call, lambda: SDK, clock=clock)
    with pytest.raises(RuntimeError):
        calendar.refresh(object())
    assert not calendar.due()
    clock.now += timedelta(seconds=61)
    assert calendar.due()
