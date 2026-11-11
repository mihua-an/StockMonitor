"""Three synthetic (no broker) end-to-end closures using the PRODUCTION event shapes:

    broker-callback adapter -> RustDaemonEventSink -> real market_runtime_daemon (Market Runtime WAL and the session
      evidence it writes) -> per-source session owner -> MaterializationLedger job request
      -> real historical_materializer (Health's job-runner behaviour) -> owner consumes result
      -> HistoricalStore read-back of the real data.

STK, FUT (Shioaji, quote-only WAL, calendar-date FULL partitions) and Futu (exchange-time session).
Skipped only when the Rust release binaries are not built.
"""
from __future__ import annotations

import json
import queue
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

from service.market.futu.callback import FutuThinCallbackAdapter
from service.market.futu.session_lifecycle import FutuSessionLifecycleCoordinator
from service.market.futu.store import FutuControlStore
from service.market.history.historical_store import HistoricalStore
from service.market.lifecycle.rollover import ActiveMarketSession, SessionOrchestrator
from service.market.shared import materialization_ledger as ml
from service.market.shared.rust_live import RustDaemonEventSink
from service.market.shioaji.callback import ShioajiThinCallbackAdapter
from service.market.shioaji.session_evidence_gate import ShioajiSessionEvidenceGate
from tests import synthetic_runtime as rt

rt.require_binaries()

TAIPEI = ZoneInfo("Asia/Taipei")


def _stored(store, market, code, date, kind, session=""):
    """The payloads of one kind the materializer stored in the partition(s), in durable order."""
    return [e["payload"] for e in store.iter_events(market, code, date, session) if (e.get("payload") or {}).get("kind") == kind]


def _tape_side(trade):
    """The side a print shows (event.rs tape_side): a call-auction, 盤後定價 or no-last-sale print has none."""
    return 0 if trade.get("auction") or trade.get("after_hours") or trade.get("no_last_sale") else trade["side"]


class Env:
    """Isolated directories + a running Runtime + a real sink feeding it."""

    def __init__(self, tmp_path, runtime: rt.RuntimeProcess, source: str) -> None:
        self.tmp = tmp_path
        self.wal = tmp_path / "live-engine"
        self.out = tmp_path / "historical"
        self.jobs = tmp_path / "jobs"
        self.sink = RustDaemonEventSink(url=runtime.url, token=rt.ROLE_TOKENS[f"provider:{source}"], source=source)
        # Market Runtime's partition records, as the owners read them.
        self.evidence = self.sink.evidence
        self.sink.start()
        self.store = HistoricalStore(self.out, source=source)

    def drain(self, expected: int) -> dict:
        return rt.wait_acked(self.sink, expected)

    def recorded(self, source: str, market: str, date: str, session: str, accepted: int) -> dict:
        """Market Runtime's record of the partition once it holds ``accepted`` stored events (it writes the counts
        within a second; what completeness is judged from, before it answers)."""
        deadline = time.time() + 10
        while time.time() < deadline:
            summary = self.evidence.summary(source, market, date, session)
            if summary.get("accepted") == accepted:
                return summary
            time.sleep(0.05)
        raise AssertionError(f"{market} {date} {session}: {self.evidence.summary(source, market, date, session)}")

    def run_jobs(self) -> list[dict]:
        return rt.run_all_pending(self.jobs, self.wal, self.out)

    def close(self) -> None:
        self.sink.close(timeout=2.0)


@pytest.fixture()
def runtime(tmp_path):
    (tmp_path / "live-engine").mkdir()
    with rt.RuntimeProcess(tmp_path / "live-engine") as proc:
        yield proc


def _orchestrator(env: Env, app, now: datetime) -> SessionOrchestrator:
    return SessionOrchestrator(
        app_provider=lambda: app, now_provider=lambda: now, finalization_grace_seconds=0,
        manifest_dir=env.tmp / "finalization", materialization_jobs_root=env.jobs,
    )


def _app(env: Env):
    recorder = ShioajiSessionEvidenceGate(jobs_root=env.jobs, evidence=env.evidence)
    recorder._historical = env.store
    identity = SimpleNamespace(generation=1, live=False, as_dict=lambda: {"generation": 1, "live": False})
    broker = SimpleNamespace(market_identity_authority=SimpleNamespace(current=lambda _m: identity),
                             status=lambda: {"txf": {}})
    return SimpleNamespace(session_evidence_gate=recorder, broker_service=broker, live_event_sink=env.sink), recorder


def _tick(code, at, price, volume, total, seq, tick_type=1, prev_close=99.0):
    # price_chg is the print against the 昨收, as the feed states it: one 昨收 per partition, one Reference event.
    return SimpleNamespace(code=code, datetime=at, close=price, price_chg=price - prev_close, open=100.0, high=price, low=99.0,
                           avg_price=price, tick_type=tick_type, volume=volume, total_volume=total,
                           seqno=seq, total_amount=price * total, amount=price * volume)


# ---------------------------------------------------------------------------------------------------------
# 1. STK / IDX
# ---------------------------------------------------------------------------------------------------------


def test_stk_callbacks_to_sealed_materialized_readback(tmp_path, runtime):
    date = "2026-09-08"
    env = Env(tmp_path, runtime, "shioaji")
    adapter = ShioajiThinCallbackAdapter(rt.shioaji_owner(env.sink))
    at = lambda h, m, s: datetime(2026, 9, 8, h, m, s)  # naive == exchange (Taipei) wall clock
    adapter.on_stock_tick("TSE", _tick("2330", at(9, 0, 1), 100.0, 2, 2, "t1"))
    adapter.on_stock_tick("TSE", _tick("2330", at(9, 0, 30), 101.0, 3, 5, "t2"))
    adapter.on_stock_tick("TSE", _tick("2330", at(9, 1, 2), 102.0, 1, 6, "t3", tick_type=2))
    adapter.on_stock_tick("TSE", _tick("2317", at(9, 0, 5), 500.0, 1, 1, "u1", prev_close=490.0))
    adapter.on_stock_bidask("TSE", SimpleNamespace(
        code="2330", datetime=at(9, 1, 3), bid_price=[101.0, 100.5, 0, 0, 0], ask_price=[102.0, 102.5, 0, 0, 0],
        bid_volume=[5, 4, 0, 0, 0], ask_volume=[7, 6, 0, 0, 0]))
    adapter.on_index_quote(SimpleNamespace(
        code="TAIEX", datetime=at(9, 0, 10), close=22000.0, reference=21900.0, open=21950.0, high=22050.0,
        low=21900.0, vol_sum=0, amount_sum=0))
    # 6 prints/quotes; each states its 昨收, which Market Runtime writes as one Reference per partition (2330, 2317,
    # TAIEX): 5 + 2 stored STK events, 1 + 1 IDX.
    stats = env.drain(6)
    assert stats["acked"] == 6 and stats["rejected"] == 0 and stats["dropped"] == 0
    env.recorded("shioaji", "STK", date, "DAY", 7)
    env.recorded("shioaji", "IDX", date, "DAY", 2)

    # Seal by the Shioaji session owner from durable evidence (NOT the retired recorder).
    app, recorder = _app(env)
    now = datetime(2026, 9, 8, 13, 40, tzinfo=TAIPEI)
    orchestrator = _orchestrator(env, app, now)
    active = ActiveMarketSession(market="STK", trading_date=date, session="DAY", generation=1,
                                 stream_id=f"STK:{date}:DAY", activated_at=datetime(2026, 9, 8, 8, 55, tzinfo=TAIPEI).isoformat())
    assert orchestrator._is_sealed("STK", date) is False, "expired/open is not sealed"
    payload = orchestrator._finalize_prepared({"active": active, "quiesce": {}, "attempt": 0})
    assert payload["finalization_status"] == "PASS" and payload["lifecycle_state"] == "sealed"
    assert payload["completeness"] == "complete" and payload["session_evidence"]["accepted"] == 9
    assert env.evidence.summary("shioaji", "STK", date, "DAY")["sealed"], "Market Runtime froze the partition"
    assert orchestrator._is_sealed("STK", date) is True
    assert {k["market"] for k in payload["materialization_keys"]} == {"STK", "IDX"}
    assert payload["materialization_status"] == "pending"

    # Health runs the real Rust job for each owner-submitted request.
    results = env.run_jobs()
    assert len(results) == 2 and all(r["ok"] and r["status"] == "materialized" for r in results)
    orchestrator.poll_materialization_jobs()
    assert {r["state"] for r in orchestrator._ledger.records()} == {ml.SUCCEEDED}
    manifest = json.loads(next((env.tmp / "finalization").glob("*.json")).read_text(encoding="utf-8"))
    assert manifest["materialization_status"] == "materialized"

    # Read back the real data.
    trades = _stored(env.store, "STK", "2330", date, "trade")
    # The session's first print in the 09:00 minute is the opening call-auction match: 不分內外盤, side 0, whatever the
    # broker's tick_type (the materializer classifies a recording as the ingest does, Engine::classify_recorded).
    assert [t["price"] for t in trades] == [1_000_000, 1_010_000, 1_020_000]
    assert [_tape_side(t) for t in trades] == [0, 1, -1]
    assert len(_stored(env.store, "STK", "2330", date, "order_book")) == 1
    assert env.store.list_codes(date, "STK") == ["2317", "2330"]
    assert env.store.minute_trend("TAIEX", date, market="IDX")["price"].iloc[0] == 22000.0
    stk_manifest = env.store.manifest("STK", "2330", date)
    assert stk_manifest["source"] == "shioaji" and stk_manifest["event_count"] == 5  # 3 trades + 1 bidask + the 昨收 Reference
    assert stk_manifest["content_hash_fnv1a64"] and stk_manifest["completeness"] == "complete"
    assert env.store.artifact_status("STK", date, "DAY")["valid"] is True

    # A / B / C / D
    gate = recorder.evaluate_session(market="STK", trading_date=date, session="DAY")
    assert gate["evidence_ready"] and gate["historical_materialized"] and gate["training_ready"]
    env.close()


def test_stk_dropped_event_is_sealed_with_gap_and_never_training_ready(tmp_path, runtime):
    date = "2026-09-08"
    env = Env(tmp_path, runtime, "shioaji")
    adapter = ShioajiThinCallbackAdapter(rt.shioaji_owner(env.sink))
    adapter.on_stock_tick("TSE", _tick("2330", datetime(2026, 9, 8, 9, 0, 1), 100.0, 2, 2, "t1"))
    env.drain(1)
    # The provider's queue is full: the next print is lost, reported to Market Runtime, and kept there.
    def queue_full(_event):
        raise queue.Full

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(env.sink._queue, "put_nowait", queue_full)
        adapter.on_stock_tick("TSE", _tick("2330", datetime(2026, 9, 8, 9, 0, 2), 100.0, 1, 3, "t2"))
    deadline = time.time() + 10
    while env.sink.stats()["losses_reported"] < 1 and time.time() < deadline:
        time.sleep(0.02)
    assert env.evidence.summary("shioaji", "STK", date, "DAY")["dropped"] == 1
    app, recorder = _app(env)
    orchestrator = _orchestrator(env, app, datetime(2026, 9, 8, 13, 40, tzinfo=TAIPEI))
    active = ActiveMarketSession(market="STK", trading_date=date, session="DAY", generation=1, stream_id="s")
    payload = orchestrator._finalize_prepared({"active": active, "quiesce": {}, "attempt": 0})
    assert payload["finalization_status"] == "FINALIZED_WITH_GAPS" and payload["completeness"] == "gap_detected"
    assert payload["lifecycle_state"] == "sealed", "a gap is an outcome, not a reason to never seal"
    env.run_jobs()
    orchestrator.poll_materialization_jobs()
    gate = recorder.evaluate_session(market="STK", trading_date=date, session="DAY")
    assert gate["evidence_ready"] is False and gate["training_ready"] is False
    env.close()


# ---------------------------------------------------------------------------------------------------------
# 2. FUT: quote-only WAL, calendar-date FULL partitions crossing midnight
# ---------------------------------------------------------------------------------------------------------


def _fut_quote(at, price, total):
    return SimpleNamespace(code="TXFR1", datetime=at, close=price, reference=22000.0, open=22000.0, high=price,
                           low=21990.0, total_volume=total, total_amount=0.0, simtrade=False, avg_price=price,
                           volume=1, amount=0.0, to_dict=lambda: {})


def test_fut_callbacks_cross_midnight_to_sealed_materialized_readback(tmp_path, runtime):
    env = Env(tmp_path, runtime, "shioaji")
    adapter = ShioajiThinCallbackAdapter(rt.shioaji_owner(env.sink))
    evening = datetime(2026, 9, 8, 20, 0, 0)
    after_midnight = datetime(2026, 9, 9, 1, 30, 0)
    adapter.on_futures_quote("TAIFEX", _fut_quote(evening, 22010.0, 10))
    adapter.on_futures_quote("TAIFEX", _fut_quote(evening + timedelta(minutes=1), 22020.0, 20))
    adapter.on_futures_quote("TAIFEX", _fut_quote(after_midnight, 22030.0, 30))
    env.drain(3)

    # FUT is partitioned per business session: the whole night, past midnight included, is ONE
    # partition dated by the day it opened -- the identity the jobs use.
    env.recorded("shioaji", "FUT", "2026-09-08", "NIGHT", 3)
    assert not env.evidence.summary("shioaji", "FUT", "2026-09-09", "NIGHT").get("observed")

    app, recorder = _app(env)
    now = datetime(2026, 9, 9, 5, 10, tzinfo=TAIPEI)  # the NIGHT session (09-08 15:00 -> 09-09 05:00) just ended
    orchestrator = _orchestrator(env, app, now)
    active = ActiveMarketSession(market="FUT", trading_date="2026-09-09", session="NIGHT", actual_contract="TXFI6",
                                 generation=1, stream_id="FUT:TXFR1:2026-09-09:NIGHT:TXFI6",
                                 activated_at=datetime(2026, 9, 8, 15, 0, tzinfo=TAIPEI).isoformat())
    payload = orchestrator._finalize_prepared({"active": active, "quiesce": {}, "attempt": 0})
    assert payload["lifecycle_state"] == "sealed" and payload["completeness"] == "complete"
    submitted = {(k["market"], k["trading_date"], k["session"]) for k in payload["materialization_keys"]}
    assert submitted == {("FUT", "2026-09-08", "NIGHT")}, "one job: the night's own partition"
    assert orchestrator._is_sealed("FUT", "2026-09-08", "NIGHT") and not orchestrator._is_sealed("FUT", "2026-09-09", "DAY")

    results = env.run_jobs()
    assert [r["status"] for r in results] == ["materialized"]
    orchestrator.poll_materialization_jobs()
    states = {(r["trading_date"], r["session"]): r["state"] for r in orchestrator._ledger.records()}
    assert states == {("2026-09-08", "NIGHT"): ml.SUCCEEDED}

    manifest = env.store.manifest("FUT", "TXFR1", "2026-09-08", "NIGHT")
    assert manifest["event_count"] == 3 and manifest["source"] == "shioaji" and manifest["session"] == "NIGHT"
    assert env.store.artifact_status("FUT", "2026-09-08", "NIGHT")["valid"] is True
    assert env.store.artifact_status("FUT", "2026-09-08", "DAY")["valid"] is False
    events = list(env.store.iter_events("FUT", "TXFR1", "2026-09-08", "NIGHT"))
    assert [e["payload"]["current"] for e in events] == [220_100_000, 220_200_000, 220_300_000]
    assert [e["payload"]["minute"] for e in events] == [1200, 1201, 1440 + 90], "the night's minutes continue past 1440"
    env.close()


# ---------------------------------------------------------------------------------------------------------
# 3. Futu: exchange-time session identity, owner-only submission
# ---------------------------------------------------------------------------------------------------------


def test_futu_callbacks_late_cross_midnight_to_materialized_readback(tmp_path, runtime):
    env = Env(tmp_path, runtime, "futu")
    clock = {"now": datetime(2026, 9, 9, 3, 0, tzinfo=timezone.utc)}  # 23:00 ET on 09-08
    store = FutuControlStore(tmp_path / "control.db")
    store.initialize_schema()
    coord = FutuSessionLifecycleCoordinator(
        store, event_sink=env.sink, now=lambda: clock["now"], tick_seconds=0, jobs_root=env.jobs,
        ledger=ml.MaterializationLedger("futu", jobs_root=env.jobs, clock=lambda: clock["now"].timestamp()))
    adapter = FutuThinCallbackAdapter(env.sink, generation=lambda: 1, observe=lambda code, kind: None)
    adapter._publish("trade", [
        {"code": "US.AAPL", "price": 190.5, "volume": 10, "time": "2026-09-08 15:59:58", "ticker_direction": "BUY"},
        {"code": "US.AAPL", "price": 190.6, "volume": 5, "time": "2026-09-08 15:59:59", "ticker_direction": "SELL"},
    ])
    env.drain(2)
    env.recorded("futu", "US", "2026-09-08", "FULL", 2)

    coord.tick(force=True)
    assert list(env.jobs.glob("pending/*.json")) == [], "session still open at 23:00 ET: no job yet"
    # a LATE callback stamped 09-08 arrives after midnight ET but inside the seal grace
    clock["now"] = datetime(2026, 9, 9, 4, 5, tzinfo=timezone.utc)  # 00:05 ET
    adapter._publish("trade", [{"code": "US.AAPL", "price": 190.7, "volume": 1, "time": "2026-09-08 20:00:00",
                                "ticker_direction": "BUY"}])
    env.drain(3)
    env.recorded("futu", "US", "2026-09-08", "FULL", 3)
    clock["now"] = datetime(2026, 9, 9, 6, 0, tzinfo=timezone.utc)
    coord.tick(force=True)
    pending = sorted(env.jobs.glob("pending/*.json"))
    assert len(pending) == 1
    request = json.loads(pending[0].read_text(encoding="utf-8"))
    assert (request["source"], request["market"], request["trading_date"], request["session"], request["code"]) == \
        ("futu", "US", "2026-09-08", "FULL", "*")
    assert request["completeness"] == "complete"

    results = env.run_jobs()
    assert results[0]["ok"] and results[0]["status"] == "materialized"
    clock["now"] = datetime(2026, 9, 9, 6, 1, tzinfo=timezone.utc)
    coord.tick(force=True)
    assert coord._sessions["US"]["2026-09-08"]["materialization"] == "materialized"
    manifest = env.store.manifest("US", "US.AAPL", "2026-09-08", "FULL")
    assert manifest["event_count"] == 3 and manifest["source"] == "futu" and manifest["completeness"] == "complete"
    trades = _stored(env.store, "US", "US.AAPL", "2026-09-08", "trade", "FULL")
    assert [t["price"] for t in trades] == [1_905_000, 1_906_000, 1_907_000]
    env.close()


def test_fut_long_holiday_first_day_night_event_is_still_materialized(tmp_path, runtime):
    """A partition more than 3 calendar days before the finalization date must not be stranded."""
    env = Env(tmp_path, runtime, "shioaji")
    adapter = ShioajiThinCallbackAdapter(rt.shioaji_owner(env.sink))
    adapter.on_futures_quote("TAIFEX", _fut_quote(datetime(2026, 9, 2, 0, 30, 0), 22050.0, 5))  # holiday first day, night tail
    env.drain(1)
    app, _recorder = _app(env)
    orchestrator = _orchestrator(env, app, datetime(2026, 9, 9, 5, 10, tzinfo=TAIPEI))  # 7 days later
    active = ActiveMarketSession(market="FUT", trading_date="2026-09-09", session="NIGHT", actual_contract="TXFI6",
                                 generation=1, stream_id="FUT:long-holiday",
                                 activated_at=datetime(2026, 9, 8, 15, 0, tzinfo=TAIPEI).isoformat())
    payload = orchestrator._finalize_prepared({"active": active, "quiesce": {}, "attempt": 0})
    # 09-02 00:30 is the tail of the night that opened 09-01.
    assert [(k["trading_date"], k["session"]) for k in payload["materialization_keys"]] == [("2026-09-01", "NIGHT")]
    results = env.run_jobs()
    assert [r["status"] for r in results] == ["materialized"]
    assert env.store.manifest("FUT", "TXFR1", "2026-09-01", "NIGHT")["event_count"] == 1
    env.close()
