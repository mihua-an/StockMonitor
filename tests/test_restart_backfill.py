"""The fill of a provider restart's gaps (service/market/shioaji/restart_backfill.py)."""
from __future__ import annotations

import threading
from datetime import date, datetime
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from service.market.shioaji import restart_backfill as rb

TAIPEI = ZoneInfo("Asia/Taipei")
OFFSET = 8 * 3600 * 1_000_000_000


def ns(h: int, m: int, s: int = 0, us: int = 0, day: tuple[int, int, int] = (2026, 11, 6)) -> int:
    return int(datetime(*day, h, m, s, us, tzinfo=TAIPEI).timestamp() * 1_000_000) * 1000


def history(*rows: tuple[int, float, float, int]) -> SimpleNamespace:
    """Broker ticks: Taipei wall time as if UTC, like Shioaji's."""
    return SimpleNamespace(ts=[t + OFFSET for t, *_ in rows], close=[r[1] for r in rows], volume=[r[2] for r in rows],
                           tick_type=[r[3] for r in rows])


def gap(**over) -> rb.Gap:
    base = dict(market="STK", code="2330", trading_date="2026-11-06", session="DAY", after_ns=ns(10, 0, 0, 500),
                volume_at_after=3.0, total_before=100.0, restart_from_ns=ns(10, 0, 1), restart_to_ns=ns(10, 5))
    base.update(over)
    return rb.Gap(**base)


def test_the_window_skips_what_is_held_at_its_start_and_leaves_its_end_instant_to_the_live_stream():
    g = gap()
    ticks = history(
        (ns(9, 59, 59), 1000.0, 9.0, 1),        # before the gap: stored
        (ns(10, 0, 0, 500), 1000.0, 3.0, 1),    # at the start instant: the 3 lots Market Runtime holds
        (ns(10, 0, 0, 500), 1000.5, 2.0, 2),    # also at that instant, not held: missed
        (ns(10, 2, 30), 1001.0, 15.0, 1),
        (ns(10, 5, 0, 7), 1002.0, 4.0, 1),      # the first live print's instant: the stream holds it
        (ns(10, 6), 1003.0, 1.0, 1),            # after the gap
    )
    prints = rb.window_prints(ticks, g, ns(10, 5, 0, 7), end_is_live=True)
    assert [(p[1], p[2]) for p in prints] == [(1000.5, 2.0), (1001.0, 15.0)]
    to_close = rb.window_prints(ticks, g, ns(10, 6), end_is_live=False)
    assert [p[2] for p in to_close] == [2.0, 15.0, 4.0, 1.0], "a close ends the gap with its own instant included"


def test_a_code_with_nothing_stored_fills_from_the_open():
    g = gap(after_ns=0, volume_at_after=0.0, total_before=0.0)
    ticks = history((ns(9, 0), 1000.0, 50.0, 0), (ns(9, 30), 1001.0, 2.0, 1))
    assert [p[2] for p in rb.window_prints(ticks, g, ns(10, 5), end_is_live=True)] == [50.0, 2.0]


def test_a_night_window_is_queried_per_calendar_date_in_whole_seconds():
    spans = rb.query_spans(ns(23, 58, 30, 250_000), ns(0, 1, 2, 1, day=(2026, 11, 7)))
    assert spans == [(date(2026, 11, 6), "23:58:30", "23:59:59"), (date(2026, 11, 7), "00:00:00", "00:01:03")]
    assert rb.query_spans(ns(10, 0, 5), ns(10, 4, 0)) == [(date(2026, 11, 6), "10:00:05", "10:04:00")]


class Harness:
    def __init__(self, *, ticks, close_ns=None, clock=None, held_from=0, budget=None):
        self.published = []
        self.reports = []
        self.queries = []
        self.sequences = {}
        self.done = threading.Event()

        def fetch(g, day, start, end):
            self.queries.append((g.code, day, start, end))
            return ticks

        def report(reports):
            self.reports.extend(reports)
            self.done.set()
            return {"known": [True] * len(reports)}

        def next_sequence(code):
            self.sequences[code] = self.sequences.get(code, 0) + 1
            return self.sequences[code]

        self.backfill = rb.RestartBackfill(
            fetch=fetch, query_dates=lambda g, day: [day], publish=lambda e: self.published.append(e) or True, next_sequence=next_sequence,
            admission_lock=threading.Lock(), generation=lambda: 7, scale=10_000, report=report,
            session_open_ns=lambda g: ns(9, 0), session_end_ns=lambda g: close_ns or ns(14, 31),
            stored=lambda market, before: True, history_held_from=lambda g: held_from,
            ticks_budget=budget or SimpleNamespace(take=lambda: True), **({"clock": clock} if clock else {}))


def test_a_gap_is_fetched_once_its_first_live_print_arrives_and_reported_with_both_volumes():
    ticks = history((ns(10, 2), 1001.0, 15.0, 1), (ns(10, 4), 1002.0, 10.0, 2))
    h = Harness(ticks=ticks)
    wire = {"market": "STK", "code": "2330", "trading_date": "2026-11-06", "session": "DAY", "after_ns": ns(10, 0),
            "volume_at_after": 5.0, "total_before": 105.0, "restart_from_ns": ns(10, 0), "restart_to_ns": ns(10, 5)}
    h.backfill.requested([wire])
    assert h.backfill.pending() == 1 and not h.queries, "nothing is fetched before the stream took over"
    h.backfill.observe("STK", "2330", ns(10, 0), 105.0, 5.0)  # not after the start: not the end
    h.backfill.observe("STK", "2330", ns(10, 5, 1), 135.0, 5.0)
    assert h.done.wait(5)
    h.backfill.stop()
    assert h.queries == [("2330", date(2026, 11, 6), "10:00:00", "10:05:01")]
    trades = [e for e in h.published if e.event_type == "trade"]
    assert [(e.data["volume"], e.data["total_volume"], e.data["side"]) for e in trades] == [(15.0, 120.0, 1), (10.0, 130.0, -1)]
    assert all(e.flags == {"backfill": True, "backfill_cutoff_ns": ns(10, 5, 1)} for e in trades)
    assert [e.sequence for e in trades] == [1, 2], "the code's own stream sequence space"
    assert h.reports == [{"market": "STK", "code": "2330", "trading_date": "2026-11-06", "session": "DAY", "cause": "restart", "restart_to_ns": ns(10, 5), "end": "first_live_print",
                          "total_before": 105.0, "next_total_before": 130.0, "outcome": "stored", "prints": 2, "volume": 25.0, "history_last_ns": max(ticks.ts) - rb._TAIPEI_OFFSET_NS}]
    assert h.backfill.pending() == 0


def test_a_fill_short_of_its_live_end_reports_how_far_the_brokers_history_reached():
    # 11-09 1101: asked 0.5 s after its first live print at 09:32:42.301, the answer ended at 09:32:41.312 and was one lot
    # short. The shortfall stands (unverified, the close's fill takes it): nothing here stretches it to meet.
    ticks = history((ns(9, 0, 12), 20.0, 7000.0, 1), (ns(9, 32, 41), 20.5, 862.0, 2))
    h = Harness(ticks=ticks)
    h.backfill.requested([{"cause": "late_join", "market": "STK", "code": "1101", "trading_date": "2026-11-06", "session": "DAY", "after_ns": 0,
                           "volume_at_after": 0.0, "total_before": 0.0, "since_ns": ns(9, 32, 43), "next_ns": ns(9, 32, 42), "next_total_before": 7863.0}])
    assert h.done.wait(5)
    h.backfill.stop()
    report = h.reports[0]
    assert (report["outcome"], report["volume"], report["next_total_before"]) == ("stored", 7862.0, 7863.0)
    assert report["history_last_ns"] == ns(9, 32, 41), "the print the answer ended at, before the gap's end"


def test_a_code_that_does_not_print_again_is_filled_at_its_close_with_nothing_to_check_against():
    h = Harness(ticks=history((ns(10, 3), 50.0, 1.0, 1)), close_ns=ns(10, 30), clock=lambda: ns(10, 40))
    h.backfill.requested([{"market": "STK", "code": "1101", "trading_date": "2026-11-06", "session": "DAY", "after_ns": ns(9, 30),
                           "volume_at_after": 1.0, "total_before": 7.0, "restart_from_ns": ns(10, 0), "restart_to_ns": ns(10, 5)}])
    assert h.done.wait(5)
    h.backfill.stop()
    assert h.reports[0]["next_total_before"] is None and h.reports[0]["prints"] == 1


def test_prints_of_another_day_are_never_taken():
    # Seen 11-06 17:58: a futures night queried under trading day 11-09 returned the 11-05 evening's prints (42,194
    # against 40,330 live) at the same times of day. Their own exchange times put them outside the window.
    other_day = (2026, 11, 5)
    g = gap(market="FUT", code="TXFR1", session="NIGHT", after_ns=ns(17, 58, 49), volume_at_after=2.0, total_before=17513.0)
    ticks = history((ns(17, 58, 50, day=other_day), 42194.0, 1.0, 1), (ns(17, 59, 52, day=other_day), 42185.0, 1.0, 2))
    assert rb.window_prints(ticks, g, ns(17, 59, 54), end_is_live=True) == []


def test_a_futures_night_tries_each_date_until_one_returns_the_windows_prints():
    tonight = history((ns(17, 59), 40300.0, 3.0, 1))
    wrong = history((ns(17, 59, day=(2026, 11, 5)), 42190.0, 1.0, 1))
    answers = {date(2026, 11, 9): wrong, date(2026, 11, 6): tonight}
    h = Harness(ticks=None)
    h.backfill._fetch = lambda g, day, start, end: (h.queries.append(day), answers[day])[1]
    h.backfill._query_dates = lambda g, day: [date(2026, 11, 9), date(2026, 11, 6)]
    h.backfill.requested([{"market": "FUT", "code": "TXFR1", "trading_date": "2026-11-06", "session": "NIGHT", "after_ns": ns(17, 58),
                           "volume_at_after": 1.0, "total_before": 100.0, "restart_from_ns": ns(17, 58), "restart_to_ns": ns(18, 0)}])
    h.backfill.observe("FUT", "TXFR1", ns(18, 0, 1), 104.0, 1.0)
    assert h.done.wait(5)
    h.backfill.stop()
    assert h.queries == [date(2026, 11, 9), date(2026, 11, 6)]
    assert [(e.data["price"], e.data["volume"]) for e in h.published] == [(403_000_000, 3.0)]
    assert h.reports[0]["volume"] == 3.0


def test_history_of_other_dates_only_is_reported_unavailable_and_nothing_is_taken():
    wrong = history((ns(17, 59, day=(2026, 11, 5)), 42190.0, 1.0, 1))
    h = Harness(ticks=wrong)
    h.backfill._query_dates = lambda g, day: [date(2026, 11, 9), date(2026, 11, 6)]
    h.backfill.requested([{"market": "FUT", "code": "TXFR1", "trading_date": "2026-11-06", "session": "NIGHT", "after_ns": ns(17, 58),
                           "volume_at_after": 1.0, "total_before": 100.0, "restart_from_ns": ns(17, 58), "restart_to_ns": ns(18, 0)}])
    h.backfill.observe("FUT", "TXFR1", ns(18, 0, 1), 104.0, 1.0)
    assert h.done.wait(5)
    h.backfill.stop()
    assert h.published == [] and h.reports[0]["outcome"] == "failed"
    assert "holds no 2026-11-06 prints yet" in h.reports[0]["reason"]


def test_a_failed_fetch_is_reported_failed():
    class Boom:
        @property
        def ts(self):
            raise RuntimeError("no data")
    h = Harness(ticks=Boom())
    h.backfill.requested([{"market": "FUT", "code": "TXFR1", "trading_date": "2026-11-06", "session": "NIGHT", "after_ns": ns(16, 0),
                           "volume_at_after": 1.0, "total_before": 10.0, "restart_from_ns": ns(16, 0), "restart_to_ns": ns(16, 1)}])
    h.backfill.observe("FUT", "TXFR1", ns(16, 1, 2), 30.0, 1.0)
    assert h.done.wait(5)
    h.backfill.stop()
    assert h.reports[0]["outcome"] == "failed" and "no data" in h.reports[0]["reason"]


def test_an_index_gap_is_filled_with_one_backfill_quote_per_history_print():
    """Rust B takes an index only while its clock is ahead of the stock's last finished minute (features.rs fresh):
    the index must come back every 5 s as its live quotes do, not as one bar per minute, the same as the close's fill
    (history_fill.fill_events)."""
    ticks = history((ns(10, 1, 5), 20000.0, 7.0, 0), (ns(10, 1, 50), 20010.0, 4.0, 0), (ns(10, 2, 1), 19990.0, 5.0, 0),
                    (ns(10, 3, 0), 19995.0, 6.0, 0))  # the first live quote's instant: the stream holds it
    h = Harness(ticks=ticks, clock=lambda: ns(10, 3, 1))
    h.backfill.requested([{"market": "IDX", "code": "TAIEX", "trading_date": "2026-11-06", "session": "DAY", "after_ns": ns(10, 1),
                           "volume_at_after": 0.0, "total_before": None, "restart_from_ns": ns(10, 1), "restart_to_ns": ns(10, 2, 30)}])
    h.backfill.observe("IDX", "TAIEX", ns(10, 3), None, None)
    assert h.done.wait(5)
    h.backfill.stop()
    assert [e.event_type for e in h.published] == ["quote"] * 3
    assert [(e.exchange_ts_ns, e.data["current"]) for e in h.published] == [
        (ns(10, 1, 5), 200_000_000), (ns(10, 1, 50), 200_100_000), (ns(10, 2, 1), 199_900_000)]
    assert h.published[0].data == {"current": 200_000_000, "open": 0, "high": 0, "low": 0, "total_volume": 0.0, "total_amount": 0.0,
                                   "status": "live", "average": 0, "volume": 0.0, "amount": 0.0}
    assert all(e.flags == {"backfill": True, "backfill_cutoff_ns": ns(10, 3)} for e in h.published)
    assert [e.sequence for e in h.published] == [1, 2, 3] and h.sequences == {"IX0001": 3}, "TAIEX is IX0001's stream"
    assert h.reports[0]["prints"] == 3 and h.reports[0]["volume"] == 0.0 and h.reports[0]["outcome"] == "stored"


def late_join(**over) -> dict:
    """A late join as Market Runtime answers it (market_runtime late_join.rs): from the open to the first print."""
    base = {"cause": "late_join", "market": "STK", "code": "3481", "trading_date": "2026-11-06", "session": "DAY", "after_ns": 0,
            "volume_at_after": 0.0, "total_before": 0.0, "since_ns": ns(10, 30), "next_ns": ns(10, 30, 2), "next_total_before": 65.0}
    base.update(over)
    return base


def test_a_late_join_is_filled_from_the_open_at_once_and_reported_as_one():
    # 3481 subscribed 10:30: its stream starts at 10:30:02 with 65 lots traded before it. Market Runtime states the end.
    ticks = history((ns(9, 0), 1000.0, 50.0, 0), (ns(9, 40), 1001.0, 15.0, 1), (ns(10, 30, 2), 1002.0, 4.0, 1))
    h = Harness(ticks=ticks)
    h.backfill.requested([late_join()])
    assert h.done.wait(5), "its end is known: nothing waits for the live stream"
    h.backfill.stop()
    assert h.queries == [("3481", date(2026, 11, 6), "09:00:00", "10:30:02")]
    trades = [e for e in h.published if e.event_type == "trade"]
    assert [(e.data["volume"], e.data["total_volume"]) for e in trades] == [(50.0, 50.0), (15.0, 65.0)], "the live instant is the stream's"
    assert all(e.flags == {"backfill": True, "backfill_cutoff_ns": ns(10, 30, 2)} for e in trades)
    assert trades[0].data["trade_id"] == f"bf{ns(10, 30)}:1"
    assert h.reports == [{"market": "STK", "code": "3481", "trading_date": "2026-11-06", "session": "DAY", "cause": "late_join",
                          "restart_to_ns": 0, "end": "first_live_print", "total_before": 0.0, "next_total_before": 65.0,
                          "outcome": "stored", "prints": 2, "volume": 65.0, "history_last_ns": max(ticks.ts) - rb._TAIPEI_OFFSET_NS}]


def test_a_late_index_and_futures_contract_take_the_same_path():
    h = Harness(ticks=history((ns(9, 1, 5), 500.0, 3.0, 0), (ns(9, 2, 5), 501.0, 2.0, 0)))
    h.backfill.requested([late_join(market="IDX", code="IX0028", total_before=None, next_total_before=None)])
    assert h.done.wait(5)
    h.backfill.stop()
    assert [e.event_type for e in h.published] == ["quote", "quote"], "an index: one quote per history print"
    assert h.reports[0]["cause"] == "late_join" and h.reports[0]["prints"] == 2
    f = Harness(ticks=history((ns(8, 45), 23000.0, 30.0, 1), (ns(9, 0), 23001.0, 2.0, 2)))
    f.backfill.requested([late_join(market="FUT", code="TXFR1", total_before=None, next_total_before=40_000.0)])
    assert f.done.wait(5)
    f.backfill.stop()
    trades = [e for e in f.published if e.event_type == "trade"]
    assert [e.data["volume"] for e in trades] == [30.0, 2.0]
    assert all("total_volume" not in e.data for e in trades), "a FUT session's total at its open is not known: none is invented"


def test_a_late_join_is_recorded_as_its_own_remediation(monkeypatch):
    begun = []

    class Operation:
        def finish(self, outcome, **kwargs):
            begun[-1]["outcome"] = outcome

    class Emitter:
        def begin(self, **kwargs):
            begun.append(kwargs)
            return Operation()

    monkeypatch.setattr(rb.remediation, "emitter", lambda: Emitter())
    h = Harness(ticks=history((ns(9, 0), 1000.0, 65.0, 0)))
    h.backfill.requested([late_join()])
    assert h.done.wait(5)
    h.backfill.stop()
    assert (begun[0]["mechanism_id"], begun[0]["trigger_reason"], begun[0]["outcome"]) == ("provider.late_join_backfill", "late_join", "succeeded")
    assert begun[0]["detail"]["subscribed"].startswith("2026-11-06T10:30:00")


def test_a_gap_of_an_unknown_cause_is_recorded_and_not_filled():
    h = Harness(ticks=history())
    h.backfill.requested([late_join(cause="mystery")])
    assert h.backfill.pending() == 0 and h.backfill.stats["failed"] == 1


def test_a_gap_the_brokers_history_does_not_hold_yet_is_left_to_the_close_and_reported_so():
    """A futures night's evening: asked before its midnight the broker answers another night's prints (11-06 18:05 to
    23:19), so the gap is not fetched; the fill after the session's materialization takes it."""
    midnight = ns(0, 0, day=(2026, 11, 7))
    h = Harness(ticks=history((ns(20, 0, 5), 39700.0, 2.0, 1)), held_from=midnight, clock=lambda: ns(20, 1))
    h.backfill.requested([late_join(market="FUT", code="TXFR1", session="NIGHT", since_ns=ns(20, 0), next_ns=ns(20, 0, 30),
                                    total_before=None, next_total_before=60_000.0)])
    assert h.done.wait(5)
    h.backfill.stop()
    assert h.queries == [] and h.published == [], "nothing fetched, nothing published"
    assert h.reports[0]["outcome"] == "after_close" and "2026-11-07T00:00:00+08:00" in h.reports[0]["reason"]
    assert h.backfill.stats["deferred"] == 1 and h.backfill.stats["failed"] == 0
    after = Harness(ticks=history((ns(0, 30, 5, day=(2026, 11, 7)), 39700.0, 2.0, 1)), held_from=midnight,
                    clock=lambda: ns(0, 31, day=(2026, 11, 7)))
    after.backfill.requested([late_join(market="FUT", code="TXFR1", session="NIGHT", since_ns=ns(0, 30, day=(2026, 11, 7)),
                                        next_ns=ns(0, 30, 30, day=(2026, 11, 7)), total_before=None, next_total_before=None)])
    assert after.done.wait(5)
    after.backfill.stop()
    assert after.queries and after.reports[0]["outcome"] == "stored", "after its midnight the night is fetched as it trades"


def test_the_broker_holds_a_futures_nights_prints_from_the_midnight_after_its_evening():
    from service.market.shioaji.session import ShioajiBrokerService

    night = gap(market="FUT", code="TXFR1", session="NIGHT", trading_date="2026-11-06")
    assert ShioajiBrokerService._gap_history_held_from_ns(night) == ns(0, 0, day=(2026, 11, 7))
    assert ShioajiBrokerService._gap_history_held_from_ns(gap()) == 0
    assert ShioajiBrokerService._gap_history_held_from_ns(gap(market="FUT", code="TXFR1", session="DAY")) == 0


# A broker-connection outage (decisions.md 券商連線自己重連的空檔記在商品層): Market Runtime took the code's start when
# the connection went down and answers the gap once the outage's report touched trading, with its end when the code
# printed again (market_runtime outage_gap.rs). The same path fills it; the report names the outage.

def outage(**over) -> dict:
    base = {"cause": "outage", "market": "STK", "code": "2330", "trading_date": "2026-11-06", "session": "DAY",
            "after_ns": ns(10, 0), "volume_at_after": 0.0, "total_before": 1200.0, "connection": "connection 2",
            "outage_to_ns": ns(10, 2), "next_ns": ns(10, 2, 1), "next_total_before": 1225.0}
    base.update(over)
    return base


def test_a_connection_outage_is_filled_from_its_start_to_the_first_print_market_runtime_states(monkeypatch):
    begun = []

    class Operation:
        def finish(self, outcome, **kwargs):
            begun[-1]["outcome"] = outcome

    class Emitter:
        def begin(self, **kwargs):
            begun.append(kwargs)
            return Operation()

    monkeypatch.setattr(rb.remediation, "emitter", lambda: Emitter())
    ticks = history((ns(10, 0, 30), 1001.0, 15.0, 1), (ns(10, 1), 1002.0, 10.0, 2), (ns(10, 2, 1), 1003.0, 3.0, 1))
    h = Harness(ticks=ticks)
    h.backfill.requested([outage()])
    assert h.done.wait(5), "its end is stated: nothing waits for the live stream"
    h.backfill.stop()
    assert h.queries == [("2330", date(2026, 11, 6), "10:00:00", "10:02:01")]
    trades = [e for e in h.published if e.event_type == "trade"]
    assert [(e.data["volume"], e.data["total_volume"]) for e in trades] == [(15.0, 1215.0), (10.0, 1225.0)]
    assert trades[0].data["trade_id"] == f"bf{ns(10, 2)}:1"
    assert h.reports == [{"market": "STK", "code": "2330", "trading_date": "2026-11-06", "session": "DAY", "cause": "outage",
                          "restart_to_ns": 0, "connection": "connection 2", "outage_to_ns": ns(10, 2), "end": "first_live_print",
                          "total_before": 1200.0, "next_total_before": 1225.0, "outcome": "stored", "prints": 2, "volume": 25.0, "history_last_ns": max(ticks.ts) - rb._TAIPEI_OFFSET_NS}]
    assert (begun[0]["mechanism_id"], begun[0]["trigger_reason"], begun[0]["outcome"]) == (
        "provider.outage_backfill", "broker_connection_outage", "succeeded")
    assert begun[0]["detail"]["connection"] == "connection 2"


def test_a_connection_outage_whose_code_never_printed_again_runs_to_its_close():
    h = Harness(ticks=history((ns(13, 25), 1001.0, 4.0, 1)), close_ns=ns(13, 30))
    h.backfill.requested([outage(after_ns=ns(13, 20), next_ns=None, next_total_before=None)])
    assert h.done.wait(5)
    h.backfill.stop()
    assert h.reports[0]["end"] == "session_close" and h.reports[0]["prints"] == 1


# Shioaji's published limits: 50 queries per 10 seconds, and 10 ticks queries during trading.
def test_the_pacer_holds_the_published_query_rate():
    assert (rb.QUERY_LIMIT, rb.QUERY_WINDOW_S) == (50, 10.0)


def test_the_intraday_ticks_budget_stops_at_ten_and_survives_a_restart(tmp_path):
    path = tmp_path / "ticks.json"
    clock = lambda: ns(10, 0)
    first = rb.IntradayTicksBudget(path, clock=clock)
    assert [first.take() for _ in range(6)] == [True] * 6
    restarted = rb.IntradayTicksBudget(path, clock=clock)
    assert [restarted.take() for _ in range(5)] == [True] * 4 + [False]


def test_the_intraday_ticks_budget_counts_only_the_day_session_and_resets_each_day(tmp_path):
    path = tmp_path / "ticks.json"
    used_up = rb.IntradayTicksBudget(path, clock=lambda: ns(13, 45))
    assert [used_up.take() for _ in range(11)] == [True] * 10 + [False]
    assert rb.IntradayTicksBudget(path, clock=lambda: ns(13, 46)).take(), "after the session nothing is limited"
    assert rb.IntradayTicksBudget(path, clock=lambda: ns(8, 44)).take(), "before the session nothing is limited"
    assert rb.IntradayTicksBudget(path, clock=lambda: ns(10, 0, day=(2026, 11, 9))).take(), "a new day starts over"


def test_an_unreadable_count_is_treated_as_used_up(tmp_path):
    path = tmp_path / "ticks.json"
    path.write_text("not json", encoding="utf-8")
    assert not rb.IntradayTicksBudget(path, clock=lambda: ns(10, 0)).take()


def test_a_gap_over_the_intraday_budget_is_left_to_the_close_without_a_query():
    h = Harness(ticks=history((ns(10, 2), 1000.0, 5.0, 1)), clock=lambda: ns(10, 6), budget=SimpleNamespace(take=lambda: False))
    h.backfill.requested([{"market": "STK", "code": "2330", "trading_date": "2026-11-06", "session": "DAY", "after_ns": ns(10, 0),
                           "volume_at_after": 0.0, "total_before": 100.0, "restart_from_ns": ns(10, 0, 1), "restart_to_ns": ns(10, 5)}])
    h.backfill.observe("STK", "2330", ns(10, 5), 130.0, 2.0)
    assert h.done.wait(5)
    h.backfill.stop()
    assert h.queries == [] and h.published == []
    assert [r["outcome"] for r in h.reports] == ["after_close"]
    assert h.backfill.stats["deferred"] == 1 and h.backfill.stats["failed"] == 0


def test_a_closed_session_window_over_the_budget_reports_why_and_makes_no_query():
    item = {"market": "STK", "code": "2330", "trading_date": "2026-11-06", "session": "DAY",
            "windows": [{"after_ns": ns(10, 0), "end_ns": ns(10, 5), "end_is_live": True}]}
    calls = []
    [result] = rb.fetch_windows(lambda *a: calls.append(a), lambda g, day: [day], lambda g: ns(9, 0), [item],
                                ticks_budget=SimpleNamespace(take=lambda: False))
    assert calls == [] and "IntradayTicksLimit" in result["windows"][0]["error"]


def test_a_closed_session_viewed_is_fetched_whole_shown_only_and_never_reported():
    """decisions.md 收盤後看任何商品都要有資料."""
    h = Harness(ticks=history((ns(9, 0), 1000.0, 50.0, 0), (ns(13, 30), 1001.0, 2.0, 1)), clock=lambda: ns(20, 0))
    h.backfill.requested([{"cause": rb.CAUSE_CLOSED_VIEW, "market": "STK", "code": "2330", "trading_date": "2026-11-06", "session": "DAY",
                           "after_ns": 0, "volume_at_after": 0.0, "total_before": 0.0, "since_ns": ns(20, 0)}])
    for _ in range(200):
        if h.backfill.pending() == 0 and h.backfill.stats["filled"]:
            break
        threading.Event().wait(0.01)
    h.backfill.stop()
    assert [e.data["volume"] for e in h.published] == [50.0, 2.0]
    assert [e.data["total_volume"] for e in h.published] == [50.0, 52.0], "the session counted from 0"
    assert all(e.flags["view_only"] and e.flags["backfill"] for e in h.published), "never written"
    assert h.reports == [], "it stores nothing, so there is nothing to report"


def test_a_closed_session_viewed_waits_for_room_in_the_ingress_queue():
    h = Harness(ticks=history((ns(9, 0), 1000.0, 50.0, 0), (ns(9, 1), 1001.0, 2.0, 1)), clock=lambda: ns(20, 0))
    refused = [False, False]
    accepted = []
    h.backfill._publish = lambda e: (refused.pop() if refused else (accepted.append(e) or True))
    h.backfill.requested([{"cause": rb.CAUSE_CLOSED_VIEW, "market": "STK", "code": "2330", "trading_date": "2026-11-06", "session": "DAY",
                           "after_ns": 0, "volume_at_after": 0.0, "total_before": 0.0, "since_ns": ns(20, 0)}])
    for _ in range(300):
        if h.backfill.stats["filled"]:
            break
        threading.Event().wait(0.01)
    h.backfill.stop()
    assert [e.sequence for e in accepted] == [1, 2], "the refused print is sent again as itself"
    assert h.backfill.stats["failed"] == 0


def test_a_closed_session_viewed_states_its_prev_close_on_the_first_print_only():
    h = Harness(ticks=history((ns(9, 0), 1000.0, 50.0, 0), (ns(9, 1), 1001.0, 2.0, 1)), clock=lambda: ns(20, 0))
    h.backfill._prev_close = lambda g: 999.5
    h.backfill.requested([{"cause": rb.CAUSE_CLOSED_VIEW, "market": "STK", "code": "2330", "trading_date": "2026-11-06", "session": "DAY",
                           "after_ns": 0, "volume_at_after": 0.0, "total_before": 0.0, "since_ns": ns(20, 0)}])
    for _ in range(300):
        if h.backfill.stats["filled"]:
            break
        threading.Event().wait(0.01)
    h.backfill.stop()
    assert [e.data.get("stated_prev_close") for e in h.published] == [9_995_000, None]


def test_a_closed_session_viewed_shows_the_last_best_bid_and_ask_its_history_states():
    ticks = history((ns(9, 0), 1000.0, 50.0, 0), (ns(13, 30), 1001.0, 2.0, 1))
    ticks.bid_price, ticks.bid_volume, ticks.ask_price, ticks.ask_volume = [999.0, 1000.0], [5, 7], [1001.0, 1001.5], [6, 8]
    h = Harness(ticks=ticks, clock=lambda: ns(20, 0))
    h.backfill.requested([{"cause": rb.CAUSE_CLOSED_VIEW, "market": "STK", "code": "2330", "trading_date": "2026-11-06", "session": "DAY",
                           "after_ns": 0, "volume_at_after": 0.0, "total_before": 0.0, "since_ns": ns(20, 0)}])
    for _ in range(300):
        if h.backfill.stats["filled"]:
            break
        threading.Event().wait(0.01)
    h.backfill.stop()
    book = h.published[-1]
    assert (book.event_type, book.exchange_ts_ns) == ("orderbook", ns(13, 30))
    assert book.data == {"bids": [{"price": 10_000_000, "volume": 7.0}], "asks": [{"price": 10_015_000, "volume": 8.0}], "simtrade": False}
    assert book.flags["view_only"]


def _run_closed_view(h):
    h.backfill.requested([{"cause": rb.CAUSE_CLOSED_VIEW, "market": "STK", "code": "2330", "trading_date": "2026-11-06", "session": "DAY",
                           "after_ns": 0, "volume_at_after": 0.0, "total_before": 0.0, "since_ns": ns(20, 0)}])
    for _ in range(300):
        if h.backfill.stats["filled"]:
            break
        threading.Event().wait(0.01)
    h.backfill.stop()


def test_a_closed_session_viewed_asks_the_exchange_once_and_shows_its_five_levels():
    from service.market.shioaji.closing_state_source import ClosingState

    h = Harness(ticks=history((ns(9, 0), 1000.0, 50.0, 0), (ns(13, 30), 1001.0, 2.0, 1)), clock=lambda: ns(20, 0))
    asked = []
    h.backfill._prev_close = lambda g: asked.append("daily_quotes")
    h.backfill._closing_state = lambda g: asked.append("twse") or ClosingState(
        prev_close=999.5, limit_up=1099.0, limit_down=900.0, bids=[(1000.0 - i, 5.0 + i) for i in range(5)], asks=[(1001.0 + i, 6.0 + i) for i in range(5)])
    _run_closed_view(h)
    assert asked == ["twse"], "one request, and the broker's daily quotes are not needed"
    assert h.published[0].event_type == "reference"
    assert h.published[0].data == {"prev_close": 9_995_000, "limit_up": 10_990_000, "limit_down": 9_000_000}
    assert h.published[0].flags["view_only"]
    book = h.published[-1]
    assert (book.event_type, len(book.data["bids"]), len(book.data["asks"])) == ("orderbook", 5, 5)
    assert "stated_prev_close" not in h.published[1].data


def test_without_the_exchange_a_closed_session_keeps_the_brokers_history():
    h = Harness(ticks=history((ns(9, 0), 1000.0, 50.0, 0)), clock=lambda: ns(20, 0))
    h.backfill._prev_close = lambda g: 999.5
    h.backfill._closing_state = lambda g: None
    _run_closed_view(h)
    assert h.published[0].data.get("stated_prev_close") == 9_995_000


def test_an_index_or_a_future_never_asks_the_exchange():
    h = Harness(ticks=history((ns(9, 0), 1000.0, 50.0, 0)), clock=lambda: ns(20, 0))
    asked = []
    h.backfill._closing_state = lambda g: asked.append(g.code)
    h.backfill.requested([{"cause": rb.CAUSE_CLOSED_VIEW, "market": "FUT", "code": "TXF202611", "trading_date": "2026-11-06", "session": "DAY",
                           "after_ns": 0, "volume_at_after": 0.0, "total_before": 0.0, "since_ns": ns(20, 0)}])
    for _ in range(300):
        if h.backfill.stats["filled"]:
            break
        threading.Event().wait(0.01)
    h.backfill.stop()
    assert asked == []


def test_the_exchanges_answer_is_used_only_for_its_own_date():
    from service.market.shioaji import closing_state_source

    row = {"c": "2912", "d": "20261106", "y": "214.5000", "u": "235.5000", "w": "193.5000", "b": "210.5000_210.0000_", "g": "29_357_", "a": "211.0000_-_", "f": "30_122_"}
    state = closing_state_source.parse({"msgArray": [row]}, "2912", "2026-11-06")
    assert (state.prev_close, state.limit_up, state.limit_down) == (214.5, 235.5, 193.5)
    assert state.bids == [(210.5, 29.0), (210.0, 357.0)]
    assert state.asks == [(211.0, 30.0)], "a level with no price is left out"
    assert closing_state_source.parse({"msgArray": [row]}, "2912", "2026-11-09") is None
    assert closing_state_source.parse({"msgArray": []}, "2912", "2026-11-06") is None


def test_a_session_already_fetched_is_shown_from_the_cache_with_no_request(tmp_path):
    from service.market.history.query_cache import QueryCache
    from service.market.shioaji.closing_state_source import ClosingState

    cache = QueryCache(tmp_path)
    first = Harness(ticks=history((ns(9, 0), 1000.0, 50.0, 0), (ns(13, 30), 1001.0, 2.0, 1)), clock=lambda: ns(20, 0))
    first.backfill._cache = cache
    first.backfill._closing_state = lambda g: ClosingState(prev_close=999.5, limit_up=1099.0, limit_down=900.0, bids=[(1000.0, 5.0)], asks=[(1001.0, 6.0)])
    _run_closed_view(first)

    # After a restart: a new process, the same disk.
    again = Harness(ticks=history(), clock=lambda: ns(20, 0))
    again.backfill._cache = QueryCache(tmp_path)
    asked = []
    again.backfill._closing_state = lambda g: asked.append("twse")
    again.backfill._prev_close = lambda g: asked.append("daily_quotes")
    _run_closed_view(again)
    assert again.queries == [] and asked == [], "neither the broker nor TWSE is asked"
    assert [(e.event_type, e.data) for e in again.published[:2]] == [(e.event_type, e.data) for e in first.published[:2]]
    assert again.published[-1].data == first.published[-1].data, "the five levels come back too"
    assert again.reports == []


def test_a_session_the_broker_answered_empty_is_not_cached(tmp_path):
    from service.market.history.query_cache import QueryCache

    h = Harness(ticks=history(), clock=lambda: ns(20, 0))
    h.backfill._cache = QueryCache(tmp_path)
    _run_closed_view(h)
    assert not list(tmp_path.rglob("*.gz"))



def _closed_view_wire(day="2026-11-06"):
    return {"cause": rb.CAUSE_CLOSED_VIEW, "market": "STK", "code": "2458", "trading_date": day, "session": "DAY",
            "after_ns": 0, "volume_at_after": 0.0, "total_before": 0.0, "since_ns": ns(13, 40)}


def _tick(h, now, at):
    with h.backfill._cond:
        now[0] = at
        h.backfill._cond.notify_all()


def test_a_view_asked_before_the_close_waits_for_it_and_is_fetched_then():
    # 11-11 14:27: 2458 searched after its last print and before the 14:30 closing minute was dropped and never asked
    # again; with no 盤後定價 print no late join named it either, so the screen stayed empty all day.
    now = [ns(13, 40)]
    h = Harness(ticks=history((ns(9, 0), 117.0, 50.0, 0), (ns(13, 30), 117.0, 133.0, 0)), clock=lambda: now[0])
    h.backfill.requested([_closed_view_wire()])
    threading.Event().wait(0.2)
    assert h.queries == [] and h.backfill.pending() == 1, "nothing is fetched before the close"
    _tick(h, now, ns(14, 32))
    for _ in range(300):
        if h.backfill.stats["filled"]:
            break
        threading.Event().wait(0.01)
    h.backfill.stop()
    assert h.queries and h.queries[0][0] == "2458"
    assert [e.data["volume"] for e in h.published if e.event_type == "trade"] == [50.0, 133.0]


def test_a_live_print_of_the_partition_drops_a_view_waiting_for_its_close():
    now = [ns(13, 40)]
    h = Harness(ticks=history((ns(9, 0), 117.0, 50.0, 0)), clock=lambda: now[0])
    h.backfill.requested([_closed_view_wire()])
    h.backfill.observe("STK", "2458", ns(14, 30), 184.0, 1.0)
    assert h.backfill.pending() == 0 and h.backfill.stats["superseded"] == 1, "the late join names what the stream missed"
    _tick(h, now, ns(14, 32))
    threading.Event().wait(0.2)
    h.backfill.stop()
    assert h.queries == [] and h.published == []


def test_a_live_print_of_another_day_leaves_a_past_sessions_view_alone():
    h = Harness(ticks=history((ns(9, 0), 117.0, 50.0, 0)), clock=lambda: ns(13, 40))
    h.backfill.requested([_closed_view_wire()])
    h.backfill.observe("STK", "2458", ns(9, 1, day=(2026, 11, 9)), 1.0, 1.0)
    assert h.backfill.pending() == 1 and h.backfill.stats["superseded"] == 0
    h.backfill.stop()


def test_the_provider_hands_a_view_asked_before_the_close_to_the_fill_once():
    from service.market.shioaji.session import ShioajiBrokerService

    asked = []
    owner = SimpleNamespace(_api=object(), _lock=threading.Lock(), _closed_views_waiting=[], _closed_views_asked=set(),
                            _restart_backfill=SimpleNamespace(requested=lambda items: asked.extend(items)))
    payload = {"market": "STK", "code": "2458", "trading_date": "2099-11-06", "session": "DAY"}
    ShioajiBrokerService._closed_view_requested(owner, payload)
    ShioajiBrokerService._closed_view_requested(owner, payload)
    assert [(i["cause"], i["code"]) for i in asked] == [(rb.CAUSE_CLOSED_VIEW, "2458")], "queued for its close, asked once"
