"""Futu 盤中才訂閱的商品補當天走勢: get_rt_data 分時 rows become backfill minute bars, read once for a code that newly joined the plan."""
from __future__ import annotations

from datetime import datetime, timezone

from service.market.futu.callback import FutuThinCallbackAdapter
from service.market.futu.trend_backfill import FutuTrendBackfill
from service.market.shared.session_identity_contract import market_zone


def _adapter():
    events = []

    class Sink:
        def publish(self, event):
            events.append(event)
            return True

    return FutuThinCallbackAdapter(Sink(), generation=lambda: 1), events


def _ns(hhmm: str) -> int:
    hour, minute = (int(part) for part in hhmm.split(":"))
    return int(datetime(2026, 11, 13, hour, minute, 0, tzinfo=market_zone("US")).timestamp() * 1_000_000_000)


# -- the adapter publishes get_rt_data rows as backfill minute bars, before the cut-off only ----------------------
def test_publish_minute_backfill_emits_backfill_bars_before_the_cutoff():
    adapter, events = _adapter()
    cutoff_ns = _ns("10:05")
    rows = [
        {"code": "US.AAPL", "time": "2026-11-13 09:31:00", "cur_price": 250.0, "avg_price": 249.5, "volume": 100, "turnover": 25000.0},
        {"code": "US.AAPL", "time": "2026-11-13 09:32:00", "cur_price": 251.0, "avg_price": 250.0, "volume": 120, "turnover": 30000.0},
        {"code": "US.AAPL", "time": "2026-11-13 09:33:00", "is_blank": True, "cur_price": 0.0, "volume": 0, "turnover": 0.0},
        {"code": "US.AAPL", "time": "2026-11-13 10:30:00", "cur_price": 255.0, "avg_price": 252.0, "volume": 200, "turnover": 51000.0},
        {"code": "US.AAPL", "cur_price": 256.0, "volume": 10, "turnover": 2560.0},
    ]
    published, skipped = adapter.publish_minute_backfill("US.AAPL", rows, cutoff_ns)
    assert (published, skipped) == (2, 3), "two 分時 points before the cut-off; a blank, a post-cut-off and a timeless row left out"
    assert [event.event_type for event in events] == ["minute_bar", "minute_bar"]
    assert [event.sequence for event in events] == [1, 2], "the minute_bar sequence space, monotonic"
    for event in events:
        assert event.flags.get("backfill") is True
        assert event.flags.get("backfill_cutoff_ns") == cutoff_ns
        assert event.flags.get("time_label") is True
        assert event.exchange_ts_ns < cutoff_ns
    # US bars are end-labelled: the 09:31 point covers 09:30, so it is filed at 09:30 (one minute before its label).
    assert events[0].exchange_ts_ns == _ns("09:30")
    assert events[0].data["close"] == 2_500_000, "cur_price 250 -> scaled close (price * 10000)"
    assert events[0].data["average"] == 2_495_000


def test_publish_minute_backfill_shares_the_live_minute_bar_sequence_space():
    # A backfill bar and a later live bar must not collide: both take the next (code, minute_bar) sequence.
    adapter, events = _adapter()
    adapter.publish_minute_backfill("US.AAPL", [
        {"code": "US.AAPL", "time": "2026-11-13 09:31:00", "cur_price": 250.0, "volume": 10, "turnover": 2500.0},
    ], _ns("10:05"))
    adapter._publish("minute_bar", [{"code": "US.AAPL", "time": "2026-11-13 10:05:00", "cur_price": 260.0, "volume": 5, "turnover": 1300.0}])
    assert [event.sequence for event in events] == [1, 2], "the live bar after the backfill takes the next sequence"
    assert events[1].flags.get("backfill", False) is False, "a live bar is not a backfill"


# -- the publisher reads only a code that joined the plan while running, once, retrying only a failed read --------
class _Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def mono(self) -> float:
        return self.t


def _publisher(clock):
    return FutuTrendBackfill(lambda code, rows, cutoff_ns: (len(list(rows)), 0),
                             now=lambda: datetime(2026, 11, 13, 15, 0, tzinfo=timezone.utc),
                             monotonic=clock.mono, clock_ns=lambda: 111)


def _fetcher():
    fetched = []

    def fetch(code):
        fetched.append(code)
        return [{"code": code, "time": "2026-11-13 09:31:00", "cur_price": 1.0}]

    return fetch, fetched


def test_the_first_plan_is_not_read():
    # An App restart re-sends the plan that was already subscribed: none of its codes is a late join.
    clock = _Clock()
    fetch, fetched = _fetcher()
    backfill = _publisher(clock)
    backfill.plan_replaced(["US.AAPL", "US.MSFT"])
    assert backfill.run(fetch, ["US.AAPL", "US.MSFT"]) == 0
    assert fetched == [] and backfill.calls == 0
    backfill.plan_replaced(["US.AAPL", "US.MSFT"])
    clock.t += 10.0
    assert backfill.run(fetch, ["US.AAPL", "US.MSFT"]) == 0
    assert fetched == [], "the same plan sent again adds nothing"


def test_a_code_that_joins_the_plan_is_backfilled_once():
    clock = _Clock()
    fetch, fetched = _fetcher()
    backfill = _publisher(clock)
    backfill.plan_replaced(["US.AAPL"])
    backfill.plan_replaced(["US.AAPL", "US.NVDA"])
    assert backfill.run(fetch, ["US.AAPL"]) == 0
    assert fetched == [], "not read before OpenD confirms its RT_DATA"
    assert backfill.snapshot_status()["pending"] == 1
    assert backfill.run(fetch, ["US.AAPL", "US.NVDA"]) == 1
    assert fetched == ["US.NVDA"], "only the new code is read"
    clock.t += 10.0
    assert backfill.run(fetch, ["US.AAPL", "US.NVDA"]) == 0
    assert fetched == ["US.NVDA"], "no second read"
    assert backfill.filled == 1 and backfill.snapshot_status()["pending"] == 0


def test_a_code_dropped_before_its_read_is_not_read_and_a_rejoin_is_a_new_join():
    clock = _Clock()
    fetch, fetched = _fetcher()
    backfill = _publisher(clock)
    backfill.plan_replaced(["US.AAPL"])
    backfill.plan_replaced(["US.AAPL", "US.NVDA"])
    backfill.plan_replaced(["US.AAPL"])
    assert backfill.run(fetch, ["US.AAPL", "US.NVDA"]) == 0
    assert fetched == [], "dropped from the plan before it was read"
    backfill.plan_replaced([])
    backfill.plan_replaced(["US.AAPL"])
    assert backfill.run(fetch, ["US.AAPL"]) == 1
    assert fetched == ["US.AAPL"], "AAPL left the plan and joined again: a new join, read"


def test_a_failed_read_is_retried_after_the_backoff():
    clock = _Clock()
    attempts = {"n": 0}

    def fetch(code):
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise RuntimeError("OpenD busy")
        return [{"code": code, "time": "2026-11-13 09:31:00", "cur_price": 1.0}]

    backfill = _publisher(clock)
    backfill.plan_replaced([])
    backfill.plan_replaced(["US.AAPL"])
    assert backfill.run(fetch, ["US.AAPL"]) == 0
    assert backfill.failures == 1 and backfill.last_error
    clock.t += 1.0   # within MIN_CALL_INTERVAL and the retry backoff: nothing happens
    assert backfill.run(fetch, ["US.AAPL"]) == 0
    assert attempts["n"] == 1, "not retried before the backoff"
    clock.t += 61.0  # past the retry backoff
    assert backfill.run(fetch, ["US.AAPL"]) == 1
    assert attempts["n"] == 2 and backfill.filled == 1


def test_reads_are_throttled_between_cycles():
    clock = _Clock()
    backfill = _publisher(clock)
    backfill.plan_replaced([])
    backfill.plan_replaced(["US.AAPL"])
    backfill.run(lambda code: [], ["US.AAPL"])
    backfill.plan_replaced(["US.AAPL", "US.MSFT"])
    assert backfill.due(["US.MSFT"]) == [], "another cycle within MIN_CALL_INTERVAL reads nothing"
    clock.t += 3.0
    assert backfill.due(["US.MSFT"]) == ["US.MSFT"]
