"""The seal trigger itself: what makes SessionOrchestrator activate and then seal a session.

tests/test_synthetic_e2e_closure.py already proves seal -> job -> materializer -> read-back, but it
hand-builds the ActiveMarketSession and calls _finalize_prepared() directly, so it never exercises
the one stage an isolated acceptance run structurally could not reach: the rollover transition that
decides a session is over. These tests drive ``reconcile()`` only, and the sole inputs are

  * the exchange timestamps the event stream itself produced (the RustDaemonEventSink's market clock, kept at the
    one choke point every event passes), and
  * the local wall clock.

That is the production mechanism. The market clock is what makes it reachable when the two disagree --
a broker whose exchange clock has drifted from the machine's.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

from service.market.lifecycle.rollover import ObservedMarketClock, SessionOrchestrator
from service.market.shared.rust_live import RustDaemonEventSink, RustLiveEvent
from tests.market_runtime_evidence_fake import FakeMarketRuntimeEvidence, FakeSink

TAIPEI = ZoneInfo("Asia/Taipei")
# 2026-09-27 is a Sunday: the wall clock alone can never resolve a live TW session on this day,
# which is the off-hours condition every isolated acceptance run is executed under.
OFF_HOURS = datetime(2026, 9, 27, 21, 0, tzinfo=TAIPEI)
TRADING_DAY = "2026-09-24"  # the Thursday the isolated feed stamps its events with (09-25 is 中秋, closed)


def _event(market: str, stamp: datetime, *, session: str = "") -> SimpleNamespace:
    return SimpleNamespace(
        source="shioaji", market=market, trading_date=stamp.date().isoformat(),
        session=session or ("FULL" if market == "FUT" else "DAY"),
        exchange_ts_ns=int(stamp.timestamp() * 1_000_000_000),
    )


class FakeClock:
    def __init__(self) -> None:
        self.value = 1_000.0

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


@pytest.fixture()
def harness(tmp_path: Path):
    """A SessionOrchestrator whose only market input is the stream: each fed event moves the sink's market clock and is
    stored in its partition's record, as Market Runtime keeps it."""
    evidence = FakeMarketRuntimeEvidence(tmp_path / "evidence")
    sink = FakeSink(evidence)

    def feed(event):
        evidence.stored(event)
        sink.clock[event.market] = max(sink.clock.get(event.market, 0), event.exchange_ts_ns)

    identity = SimpleNamespace(generation=0, live=False, as_dict=lambda: {"generation": 0, "live": False})
    broker = SimpleNamespace(
        status=lambda: {"txf": {"target_code": "TXFI6"}},
        market_identity_authority=SimpleNamespace(current=lambda _market: identity),
        mark_market_session_transition=lambda **_kw: None,
        set_market_session_event_listener=lambda _listener: None,
    )
    app = SimpleNamespace(broker_service=broker, live_event_sink=sink,
                          session_evidence_gate=None, historical_repository=None)
    orchestrator = SessionOrchestrator(
        app_provider=lambda: app, now_provider=lambda: OFF_HOURS, finalization_grace_seconds=0,
        manifest_dir=tmp_path / "finalization", materialization_jobs_root=tmp_path / "jobs",
        market_clock_stale_seconds=20.0,
    )
    return SimpleNamespace(orchestrator=orchestrator, evidence=evidence, feed=feed, tmp=tmp_path)


# -------------------------------------------------------------------------------------------------
# ObservedMarketClock: the clock itself
# -------------------------------------------------------------------------------------------------


def test_market_clock_ignores_a_value_that_has_never_advanced():
    """A row left behind by an earlier run is a baseline, not a stream that is producing time now."""
    ticker = FakeClock()
    clock = ObservedMarketClock(stale_seconds=20.0, monotonic=ticker)
    stale_value = int(datetime(2026, 9, 24, 10, 0, tzinfo=TAIPEI).timestamp() * 1_000_000_000)
    clock.observe("STK", stale_value)
    assert clock.now("STK") is None, "first sight is a baseline only"
    assert clock.last("STK") is not None, "but it is still the newest market time seen"

    clock.observe("STK", stale_value + 60 * 1_000_000_000)
    assert clock.now("STK") == datetime(2026, 9, 24, 10, 1, tzinfo=TAIPEI)


def test_market_clock_falls_back_to_the_wall_clock_once_the_stream_stops_advancing():
    ticker = FakeClock()
    clock = ObservedMarketClock(stale_seconds=20.0, monotonic=ticker)
    base = int(datetime(2026, 9, 24, 10, 0, tzinfo=TAIPEI).timestamp() * 1_000_000_000)
    clock.observe("STK", base)
    clock.observe("STK", base + 1_000_000_000)
    assert clock.now("STK") is not None

    ticker.advance(19.0)
    assert clock.now("STK") is not None, "still advancing within the staleness window"
    ticker.advance(2.0)
    assert clock.now("STK") is None, "a quiet stream must hand the session decision back to the wall clock"
    assert clock.last("STK") == datetime(2026, 9, 24, 10, 0, 1, tzinfo=TAIPEI)


def test_market_clock_never_moves_backwards():
    clock = ObservedMarketClock(stale_seconds=20.0, monotonic=FakeClock())
    base = int(datetime(2026, 9, 24, 10, 0, tzinfo=TAIPEI).timestamp() * 1_000_000_000)
    clock.observe("STK", base)
    clock.observe("STK", base + 5_000_000_000)
    clock.observe("STK", base - 3_600_000_000_000)  # a late/out-of-order event
    assert clock.last("STK") == datetime(2026, 9, 24, 10, 0, 5, tzinfo=TAIPEI)


# -------------------------------------------------------------------------------------------------
# The event sink is the clock's source, at the one choke point every event passes
# -------------------------------------------------------------------------------------------------


def _published(sink: RustDaemonEventSink, market: str, stamp: datetime, *, time_quality: str = "") -> None:
    sink.publish(RustLiveEvent(source="shioaji", market=market, code="X", generation=1, sequence=1,
                               event_type="trade" if not time_quality else "reference",
                               exchange_ts_ns=int(stamp.timestamp() * 1_000_000_000), arrival_ns=1, data={},
                               time_quality=time_quality,
                               describes_trading_date=stamp.date().isoformat() if time_quality else ""))


def test_the_sink_reports_the_newest_exchange_timestamp_it_admitted():
    sink = RustDaemonEventSink(source="shioaji", token="t")
    assert sink.observed_market_clock("STK") == 0

    early = datetime(2026, 9, 24, 9, 0, tzinfo=TAIPEI)
    _published(sink, "STK", early)
    _published(sink, "STK", early + timedelta(hours=2))
    _published(sink, "IDX", early + timedelta(hours=3))
    _published(sink, "FUT", early + timedelta(hours=4))

    assert sink.observed_market_clock("STK") == int((early + timedelta(hours=2)).timestamp() * 1e9)
    # IDX rides the STK session, so the STK clock is the newer of the two.
    assert sink.observed_market_clock("STK", "IDX") == int((early + timedelta(hours=3)).timestamp() * 1e9)
    assert sink.observed_market_clock("FUT") == int((early + timedelta(hours=4)).timestamp() * 1e9)


def test_a_reference_read_time_never_moves_the_market_clock():
    """A Reference read from the broker is stamped when it was read (backend_clock), not by the exchange: read hours
    after the last print (or on a PC whose clock runs ahead), it must not carry the market past its close."""
    sink = RustDaemonEventSink(source="shioaji", token="t")
    opening = datetime(2026, 9, 24, 9, 0, 1, tzinfo=TAIPEI)
    _published(sink, "STK", opening)
    _published(sink, "STK", datetime(2026, 9, 24, 15, 0, tzinfo=TAIPEI), time_quality="backend_clock")
    assert sink.observed_market_clock("STK") == int(opening.timestamp() * 1e9)


def test_the_market_clock_is_this_process_s_stream_only():
    """It must reflect THIS process's live stream: another process (a restart) starts without one."""
    first = RustDaemonEventSink(source="shioaji", token="t")
    _published(first, "STK", datetime(2026, 9, 24, 11, 0, tzinfo=TAIPEI))
    assert first.observed_market_clock("STK") > 0
    assert RustDaemonEventSink(source="shioaji", token="t").observed_market_clock("STK") == 0


# -------------------------------------------------------------------------------------------------
# The rollover transition: activate on the stream's clock, seal when it ends
# -------------------------------------------------------------------------------------------------


def test_reconcile_alone_never_activates_a_session_off_hours(harness):
    """Baseline: with no market events, the wall clock rules and a Sunday owns no session.

    This is precisely why an isolated acceptance run could not reach the seal: nothing ever
    became ACTIVE, so nothing could ever become sealed."""
    result = harness.orchestrator.reconcile()
    assert result["active"] == {}
    assert result["transitions"] == []


def test_stream_clock_activates_the_session_its_own_events_belong_to(harness):
    orchestrator = harness.orchestrator
    open_time = datetime(2026, 9, 24, 9, 0, 1, tzinfo=TAIPEI)
    harness.feed(_event("STK", open_time))
    orchestrator.reconcile()                                    # baseline sight only
    harness.feed(_event("STK", open_time + timedelta(minutes=5)))
    orchestrator.reconcile()

    active = orchestrator.status()["active"]
    assert "STK" in active, "the session the events belong to must be the session that is owned"
    assert active["STK"]["trading_date"] == TRADING_DAY
    assert active["STK"]["session"] == "DAY"
    # activated_at is market time, not local time: session_windows() uses it as a window bound.
    assert active["STK"]["activated_at"].startswith(TRADING_DAY)
    assert orchestrator.status()["market_clock"]["STK"]["advancing"] is True


def test_session_seals_when_its_own_market_clock_passes_the_close(harness):
    """The production boundary: the stream walks past the after-hours match (14:40) and the orchestrator finalizes.

    Nothing here is test-only -- the same transition fires in live when the wall clock and the
    exchange clock (which agree there) cross 13:30 together."""
    orchestrator = harness.orchestrator
    start = datetime(2026, 9, 24, 9, 0, 1, tzinfo=TAIPEI)
    harness.feed(_event("STK", start))
    orchestrator.reconcile()
    harness.feed(_event("STK", start + timedelta(minutes=1)))
    orchestrator.reconcile()
    assert "STK" in orchestrator.status()["active"]

    # the feed reaches the closing auction and then the close: the day is held for the 14:30 after-hours print
    harness.feed(_event("STK", datetime(2026, 9, 24, 13, 31, tzinfo=TAIPEI)))
    held = orchestrator.reconcile()
    assert not [t for t in held["transitions"] if t.get("market") == "STK" and "finalization" in t]
    assert "STK" in orchestrator.status()["active"], "not sealed before the after-hours match"
    harness.feed(_event("STK", datetime(2026, 9, 24, 14, 30, tzinfo=TAIPEI)))
    orchestrator.reconcile()
    assert "STK" in orchestrator.status()["active"]
    harness.feed(_event("STK", datetime(2026, 9, 24, 14, 41, tzinfo=TAIPEI)))
    result = orchestrator.reconcile()

    sealed = [t for t in result["transitions"] if t.get("market") == "STK" and "finalization" in t]
    assert sealed, "crossing the close must schedule finalization"
    assert sealed[0]["from"]["trading_date"] == TRADING_DAY
    assert "SEAL" in sealed[0]["actions"] and "FINALIZE" in sealed[0]["actions"]
    assert "STK" not in orchestrator.status()["active"]


def test_session_seals_when_the_feed_stops_and_the_wall_clock_says_the_market_is_closed(harness):
    """The other production boundary: the stream goes quiet and real time takes the decision back.

    This is the market having closed: the seal comes from the wall clock, not from a test hook."""
    orchestrator = harness.orchestrator
    start = datetime(2026, 9, 24, 10, 0, tzinfo=TAIPEI)
    harness.feed(_event("STK", start))
    orchestrator.reconcile()
    harness.feed(_event("STK", start + timedelta(minutes=1)))
    orchestrator.reconcile()
    assert "STK" in orchestrator.status()["active"]

    # No further events: the clock goes stale and OFF_HOURS (a Sunday) resolves CLOSED.
    orchestrator.market_clock.stale_seconds = 0.0
    result = orchestrator.reconcile()

    sealed = [t for t in result["transitions"] if t.get("market") == "STK" and "finalization" in t]
    assert sealed, "a stream that stopped while the real market is closed must finalize"
    assert orchestrator.status()["market_clock"]["STK"]["advancing"] is False


def test_a_quiet_stream_inside_a_live_session_does_not_seal_it(harness, monkeypatch):
    """Falling back to the wall clock must not seal a session the wall clock says is still open.

    This is the live regression this change could otherwise introduce: a thin market with a long
    quiet lane must not be finalized mid-session."""
    orchestrator = harness.orchestrator
    mid_session = datetime(2026, 9, 24, 11, 0, tzinfo=TAIPEI)
    monkeypatch.setattr(orchestrator, "now_provider", lambda: mid_session)

    harness.feed(_event("STK", mid_session))
    orchestrator.reconcile()
    harness.feed(_event("STK", mid_session + timedelta(seconds=1)))
    orchestrator.reconcile()
    assert "STK" in orchestrator.status()["active"]

    orchestrator.market_clock.stale_seconds = 0.0          # the lane goes quiet
    result = orchestrator.reconcile()
    assert not [t for t in result["transitions"] if "finalization" in t]
    assert "STK" in orchestrator.status()["active"], "a quiet lane is not a closed session"


def test_the_market_clock_changes_nothing_when_it_agrees_with_the_wall_clock(harness, monkeypatch):
    """Live equivalence: when the exchange clock and the wall clock are the same clock, the
    resolution is identical to the wall-clock-only behaviour this replaced."""
    orchestrator = harness.orchestrator
    now = datetime(2026, 9, 24, 10, 30, tzinfo=TAIPEI)
    monkeypatch.setattr(orchestrator, "now_provider", lambda: now)

    harness.feed(_event("STK", now - timedelta(seconds=2)))
    orchestrator.reconcile()
    harness.feed(_event("STK", now))
    orchestrator.reconcile()

    from_market_clock = dict(orchestrator.status()["active"]["STK"])
    orchestrator.market_clock.stale_seconds = 0.0          # force pure wall-clock resolution
    orchestrator.reconcile()
    from_wall_clock = dict(orchestrator.status()["active"]["STK"])

    for field in ("market", "trading_date", "session"):
        assert from_market_clock[field] == from_wall_clock[field]
    assert orchestrator.generation_for("STK") == 1, "no spurious rollover between the two clocks"
