"""Contract tests for the materialization-correctness closure that do not need the Rust binaries:
STK `_finalize_prepared` outcomes, `_is_sealed` semantics,
HistoricalStore artifact validation."""
from __future__ import annotations

import json
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import Mock
from zoneinfo import ZoneInfo

from service.market.history.historical_store import HistoricalStore
from tests.historical_fixtures import event, needs_verifier, write_partition
from service.market.lifecycle.rollover import ActiveMarketSession, SessionOrchestrator
from service.market.shared import materialization_ledger as ml
from tests.market_runtime_evidence_fake import FakeMarketRuntimeEvidence, FakeSink

TAIPEI = ZoneInfo("Asia/Taipei")
DATE = "2026-09-08"


def _ns(hour, minute):
    return int(datetime.fromisoformat(DATE).replace(hour=hour, minute=minute, tzinfo=TAIPEI).timestamp()) * 1_000_000_000


def _ev(market="STK", date=DATE, session="DAY"):
    return SimpleNamespace(source="shioaji", market=market, trading_date=date, session=session, exchange_ts_ns=1)


class Sink(FakeSink):
    def __init__(self, evidence, *, stuck=False, unconfirmed=None):
        super().__init__(evidence, unconfirmed=unconfirmed)
        self._stuck = stuck

    def stats(self):
        return {"queue_depth": 1 if self._stuck else 0, "pending": False}


def _orchestrator(tmp_path, evidence, *, stuck=False, now=None):
    recorder = SimpleNamespace(evaluate_session=Mock(return_value={
        "ok": True, "materialized": {"ok": False, "skipped": True}}))
    identity = SimpleNamespace(generation=1, live=False, as_dict=lambda: {})
    app = SimpleNamespace(
        session_evidence_gate=recorder, live_event_sink=Sink(evidence, stuck=stuck),
        broker_service=SimpleNamespace(market_identity_authority=SimpleNamespace(current=lambda _m: identity),
                                       status=lambda: {"txf": {}}))
    orchestrator = SessionOrchestrator(
        app_provider=lambda: app, now_provider=lambda: now or datetime(2026, 9, 8, 13, 40, tzinfo=TAIPEI),
        finalization_grace_seconds=0, manifest_dir=tmp_path / "fin", materialization_jobs_root=tmp_path / "jobs")
    return orchestrator


def _active(market="STK", date=DATE, session="DAY"):
    return ActiveMarketSession(market=market, trading_date=date, session=session, generation=1, stream_id=f"{market}:{date}")


def _finalize(orchestrator, active):
    return orchestrator._finalize_prepared({"active": active, "quiesce": {}, "attempt": 0})


# -- STK _finalize_prepared: evidence, not the retired recorder ---------------------------------------


def test_stk_seals_from_session_evidence_and_never_reads_recorder_stream_metrics(tmp_path):
    evidence = FakeMarketRuntimeEvidence(tmp_path / "evidence")
    for market in ("STK", "IDX"):
        evidence.stored(_ev(market))
    orchestrator = _orchestrator(tmp_path, evidence)
    payload = _finalize(orchestrator, _active())
    assert payload["lifecycle_state"] == "sealed" and payload["completeness"] == "complete"
    assert payload["coverage"]["authority"] == "session_evidence"
    assert payload["tick"]["persist_lag"] == 0
    assert orchestrator._is_sealed("STK", DATE) is True


def test_events_still_in_flight_block_the_seal(tmp_path):
    evidence = FakeMarketRuntimeEvidence(tmp_path / "evidence")
    evidence.stored(_ev())
    orchestrator = _orchestrator(tmp_path, evidence, stuck=True)
    orchestrator.app_provider().live_event_sink.unconfirmed = {"STK": [_ns(13, 30)]}   # still queued, not answered
    payload = _finalize(orchestrator, _active())
    assert payload["finalization_status"] == "FAILED" and payload["completeness"] == "gap_detected"
    assert payload["lifecycle_state"] == "expired" and payload["materialization_status"] == "not_requested"
    assert payload["tick"]["persist_lag"] == 1
    # The durability gate is the barrier's real value now, not a constant True (R13-04).
    assert payload["finalization_barrier"]["blocked_by"] == ["DURABLE_DATA_NOT_LANDED"]
    assert orchestrator._is_sealed("STK", DATE) is False, "expired is not sealed"
    assert list((tmp_path / "jobs" / "pending").glob("*.json")) == [] if (tmp_path / "jobs" / "pending").exists() else True


def test_events_lost_with_an_earlier_process_are_a_gap_not_a_permanent_block(tmp_path):
    # 28,639 events died in the queue of earlier provider processes. They can never be
    # acknowledged, so treating them as persist lag failed the STK close forever (never sealed). Market Runtime keeps
    # that process's end as a restart of the partition: a gap, and nothing this process waits for.
    evidence = FakeMarketRuntimeEvidence(tmp_path / "evidence")
    evidence.record("shioaji", "STK", DATE, "DAY", accepted=1, restarts=[
        {"from_ns": _ns(10, 0), "to_ns": _ns(10, 5), "during_trading": True}])
    orchestrator = _orchestrator(tmp_path, evidence, stuck=False)
    payload = _finalize(orchestrator, _active())
    assert payload["tick"]["persist_lag"] == 0
    assert payload["finalization_status"] == "FINALIZED_WITH_GAPS" and payload["completeness"] == "gap_detected"
    assert payload["lifecycle_state"] == "sealed"
    assert orchestrator._is_sealed("STK", DATE) is True


def test_another_markets_traffic_in_the_shared_sink_does_not_block_a_close(tmp_path):
    # Persist lag was the whole sink's queue. At the 13:30 STK close the futures stream
    # still trades (until 13:45), so the queue is rarely empty and the STK close would fail every attempt.
    evidence = FakeMarketRuntimeEvidence(tmp_path / "evidence")
    for market in ("STK", "IDX"):
        evidence.stored(_ev(market))
    orchestrator = _orchestrator(tmp_path, evidence, stuck=True)
    orchestrator.app_provider().live_event_sink.unconfirmed = {"FUT": [_ns(13, 35)]}   # another market's, in flight
    payload = _finalize(orchestrator, _active())
    assert payload["tick"]["persist_lag"] == 0 and payload["lifecycle_state"] == "sealed"


def test_a_gap_is_sealed_as_gap_detected_and_never_complete(tmp_path):
    evidence = FakeMarketRuntimeEvidence(tmp_path / "evidence")
    evidence.stored(_ev())
    evidence.lost(_ev())  # queue-full drop: never admitted, so nothing is left unacknowledged
    payload = _finalize(_orchestrator(tmp_path, evidence), _active())
    assert payload["finalization_status"] == "FINALIZED_WITH_GAPS" and payload["completeness"] == "gap_detected"
    assert payload["lifecycle_state"] == "sealed"


def test_session_with_no_evidence_is_gap_detected_not_complete(tmp_path):
    payload = _finalize(_orchestrator(tmp_path, FakeMarketRuntimeEvidence(tmp_path / "evidence")), _active())
    assert payload["completeness"] == "gap_detected"


# -- _is_sealed: persisted business lifecycle only ------------------------------------------------------


def test_is_sealed_is_never_derived_from_date_clock_or_artifacts(tmp_path):
    orchestrator = _orchestrator(tmp_path, FakeMarketRuntimeEvidence(tmp_path / "evidence"),
                                 now=datetime(2030, 1, 1, tzinfo=TAIPEI))
    assert orchestrator._is_sealed("STK", "2020-01-01") is False, "an old date is not sealed by the wall clock"
    store = tmp_path / "historical" / "source=shioaji" / "market=STK" / f"trading_date={DATE}" / "session=DAY" / "2330"
    store.mkdir(parents=True)
    (store / "manifest.json").write_text("{}")
    assert orchestrator._is_sealed("STK", DATE) is False, "an existing artifact does not seal a session"
    orchestrator._write_finalization_manifest({
        "session_key": "k", "market": "STK", "trading_date": DATE, "session": "DAY", "lifecycle_state": "expired"})
    assert orchestrator._is_sealed("STK", DATE) is False
    orchestrator._write_finalization_manifest({
        "session_key": "k", "market": "STK", "trading_date": DATE, "session": "DAY", "lifecycle_state": "sealed"})
    assert orchestrator._is_sealed("STK", DATE) is True and orchestrator._is_sealed("IDX", DATE) is True


def test_fut_calendar_partition_is_sealed_only_by_a_later_dated_sealed_finalization(tmp_path):
    orchestrator = _orchestrator(tmp_path, FakeMarketRuntimeEvidence(tmp_path / "evidence"))
    orchestrator._write_finalization_manifest({
        "session_key": "f", "market": "FUT", "trading_date": "2026-09-09", "session": "NIGHT",
        "lifecycle_state": "sealed", "finalized_at": datetime(2026, 9, 9, 5, 10, tzinfo=TAIPEI).isoformat()})
    assert orchestrator._is_sealed("FUT", "2026-09-08") is True
    assert orchestrator._is_sealed("FUT", "2026-09-09") is False, "its own calendar date is still being written"


# -- intents are decided only by the owner, only when sealed --------------------------------------------


def test_shioaji_owner_honours_intents_only_for_sealed_sessions_and_dedupes(tmp_path):
    evidence = FakeMarketRuntimeEvidence(tmp_path / "evidence")
    evidence.stored(_ev())
    orchestrator = _orchestrator(tmp_path, evidence)
    ml.propose_intent("shioaji", "STK", DATE, jobs_root=tmp_path / "jobs")
    assert orchestrator.process_materialization_intents() == 0
    assert not (tmp_path / "jobs" / "pending").exists()
    orchestrator._write_finalization_manifest({
        "session_key": "k", "market": "STK", "trading_date": DATE, "session": "DAY", "lifecycle_state": "sealed"})
    assert orchestrator.process_materialization_intents() == 1
    ml.propose_intent("shioaji", "STK", DATE, jobs_root=tmp_path / "jobs")
    orchestrator.process_materialization_intents()
    assert len(list((tmp_path / "jobs" / "pending").glob("*.json"))) == 1


def test_an_intent_for_a_session_market_runtime_no_longer_holds_opens_no_job(tmp_path):
    # Pruned with the WAL that kept it: a job would publish what is left of it over the complete history.
    orchestrator = _orchestrator(tmp_path, FakeMarketRuntimeEvidence(tmp_path / "evidence"))
    orchestrator._write_finalization_manifest({
        "session_key": "k", "market": "STK", "trading_date": DATE, "session": "DAY", "lifecycle_state": "sealed"})
    ml.propose_intent("shioaji", "STK", DATE, jobs_root=tmp_path / "jobs")
    assert orchestrator.process_materialization_intents() == 0
    assert not (tmp_path / "jobs" / "pending").exists()
    assert ml.drain_intents("shioaji", jobs_root=tmp_path / "jobs") == [], "settled, not left waiting"


def test_sealed_manifests_are_parsed_once_until_they_change(tmp_path, monkeypatch):
    """Every reconcile pass re-read every sealed manifest."""
    orchestrator = _orchestrator(tmp_path, FakeMarketRuntimeEvidence(tmp_path / "evidence"))
    key = ml.MaterializationKey.for_session("shioaji", "STK", DATE)
    orchestrator._write_finalization_manifest({
        "session_key": "k", "market": "STK", "trading_date": DATE, "session": "DAY", "lifecycle_state": "sealed",
        "materialization_keys": [key.as_dict()]})
    assert orchestrator._is_sealed("STK", DATE)
    reads = []
    original = type(state_path := orchestrator.manifest_dir).read_text
    monkeypatch.setattr(type(state_path), "read_text", lambda self, *a, **k: reads.append(self) or original(self, *a, **k))
    # The sealed check of each materialization intent reads the one index (R13-06).
    assert orchestrator._is_sealed("STK", DATE) and orchestrator._is_sealed("IDX", DATE)
    assert reads == [], "an unchanged manifest is not read again"


# -- HistoricalStore artifact validation + training fingerprint -----------------------------------------


def _artifact(root, code="2330", *, events=2, tamper=False, market="STK", session="DAY"):
    part = root / "source=shioaji" / f"market={market}" / f"trading_date={DATE}" / f"session={session}" / code
    raw = write_partition(part, [event(i + 1, market=market, code=code, session=session, trading_date=DATE)
                                 for i in range(events)],
                          source="shioaji", market=market, logical_code=code, trading_date=DATE, session=session,
                          completeness="complete", schema="v1")
    if tamper:
        (part / "events.jsonl").write_bytes(raw + b"x\n")


@needs_verifier
def test_artifact_status_rejects_count_and_hash_mismatch_and_empty(tmp_path):
    store = HistoricalStore(tmp_path)
    assert store.artifact_status("STK", DATE, "DAY")["valid"] is False
    _artifact(tmp_path)
    assert store.artifact_status("STK", DATE, "DAY")["valid"] is True
    _artifact(tmp_path, tamper=True)
    assert store.artifact_status("STK", DATE, "DAY")["valid"] is False
    _artifact(tmp_path, events=0)
    assert store.artifact_status("STK", DATE, "DAY")["valid"] is False, "a zero-event artifact is not usable"


def test_manifest_is_not_settled_as_no_input_while_a_sibling_partition_is_still_unfinished(tmp_path):
    orchestrator = _orchestrator(tmp_path, FakeMarketRuntimeEvidence(tmp_path / "evidence"))
    stk = ml.MaterializationKey.for_session("shioaji", "STK", DATE)
    idx = ml.MaterializationKey.for_session("shioaji", "IDX", DATE)
    orchestrator._write_finalization_manifest({
        "session_key": "k", "market": "STK", "trading_date": DATE, "session": "DAY", "lifecycle_state": "sealed",
        "materialization_keys": [stk.as_dict(), idx.as_dict()], "materialization_status": "pending"})

    def state(key, value):
        record = {**key.as_dict(), "key_id": key.key_id, "state": value, "attempts": 1}
        if value == ml.RUNNING:
            # A running job is one Health claimed: its request sits in claimed/.
            job_id = f"{key.key_id}-a1"
            claimed = tmp_path / "jobs" / "claimed"
            claimed.mkdir(parents=True, exist_ok=True)
            (claimed / f"{job_id}.json").write_text("{}", encoding="utf-8")
            record["job_id"] = job_id
        orchestrator._ledger._records[key.key_id] = record
        orchestrator._ledger._save()

    def status():
        return json.loads(next((tmp_path / "fin").glob("*.json")).read_text(encoding="utf-8"))["materialization_status"]

    state(idx, ml.NO_INPUT)
    state(stk, ml.RUNNING)
    orchestrator.poll_materialization_jobs()
    assert status() == "pending", "one finished-empty key must not settle the manifest while STK still runs"
    released = []
    orchestrator._app().live_event_sink.release_held = lambda *args: released.append(args)
    state(stk, ml.SUCCEEDED)
    orchestrator.poll_materialization_jobs()
    assert status() == "materialized"
    assert released == [(["STK", "ODD"], DATE, "DAY"), (["IDX"], DATE, "DAY")], "the settled stock session lets its stocks, odd lots and indices go"


def test_the_stk_day_session_is_published_settled_only_when_the_whole_session_ended(tmp_path):
    """The automatic training starts from this notice (health/training_job_runner.js), never from a clock."""
    orchestrator = _orchestrator(tmp_path, FakeMarketRuntimeEvidence(tmp_path / "evidence"))
    stk = ml.MaterializationKey.for_session("shioaji", "STK", DATE)
    idx = ml.MaterializationKey.for_session("shioaji", "IDX", DATE)
    orchestrator._write_finalization_manifest({
        "session_key": "k", "market": "STK", "trading_date": DATE, "session": "DAY", "lifecycle_state": "sealed",
        "materialization_keys": [stk.as_dict(), idx.as_dict()], "materialization_status": "pending"})
    notice = tmp_path / "jobs" / "settled" / "shioaji.json"

    def state(key, value):
        orchestrator._ledger._records[key.key_id] = {**key.as_dict(), "key_id": key.key_id, "state": value, "attempts": 1}
        orchestrator._ledger._save()

    state(stk, ml.SUCCEEDED)
    state(idx, ml.PENDING)
    orchestrator.poll_materialization_jobs()
    assert not notice.exists(), "IDX has not ended: the session is not settled"
    state(idx, ml.SUCCEEDED)
    orchestrator.poll_materialization_jobs()
    entry = json.loads(notice.read_text(encoding="utf-8"))["sessions"]["STK:DAY"]
    assert (entry["trading_date"], entry["status"]) == (DATE, "materialized") and entry["settled_at"]
    notice.unlink()
    orchestrator.poll_materialization_jobs()
    assert not notice.exists(), "published once, at the transition"


def test_an_answer_seen_before_put_nowait_returned_does_not_leave_the_session_in_flight():
    # The sender can dequeue and see Market Runtime's answer before publish() returns: an event counted as unanswered
    # only after put_nowait stayed "in flight" forever, and every close failed.
    from service.market.shared.rust_live import RustDaemonEventSink, RustLiveEvent

    sink = RustDaemonEventSink(source="shioaji", token="t")
    event = RustLiveEvent(source="shioaji", market="STK", code="2330", generation=1, sequence=1, event_type="trade",
                          exchange_ts_ns=_ns(10, 0), arrival_ns=1, data={"price": 1, "volume": 1})
    real_put = sink._queue.put_nowait
    sink._queue.put_nowait = lambda item: (real_put(item), sink._confirm(item))   # answered while being queued
    assert sink.publish(event)
    assert sink.unconfirmed_before(["STK"], _ns(14, 31)) == 0


def test_only_an_explicit_retry_intent_relaunches_a_terminal_session(tmp_path):
    # A terminal failure is relaunched by the owner only for an operator's explicit retry intent.
    evidence = FakeMarketRuntimeEvidence(tmp_path / "evidence")
    evidence.stored(_ev())
    orchestrator = _orchestrator(tmp_path, evidence)
    orchestrator._write_finalization_manifest({
        "session_key": "k", "market": "STK", "trading_date": DATE, "session": "DAY", "lifecycle_state": "sealed"})
    key = ml.MaterializationKey.for_session("shioaji", "STK", DATE)
    ledger_path = tmp_path / "jobs" / "ledger" / "shioaji.json"
    ml.propose_intent("shioaji", "STK", DATE, jobs_root=tmp_path / "jobs")
    orchestrator.process_materialization_intents()
    records = json.loads(ledger_path.read_text(encoding="utf-8"))
    records[key.key_id].update(state=ml.FAILED_TERMINAL, attempts=ml.MAX_ATTEMPTS, last_error="timed out")
    ledger_path.write_text(json.dumps(records), encoding="utf-8")

    ml.propose_intent("shioaji", "STK", DATE, reason="trade_replay_prepare:2330", jobs_root=tmp_path / "jobs")
    orchestrator.process_materialization_intents()
    assert json.loads(ledger_path.read_text(encoding="utf-8"))[key.key_id]["state"] == ml.FAILED_TERMINAL
    ml.propose_intent("shioaji", "STK", DATE, reason="operator retry", retry_terminal=True, jobs_root=tmp_path / "jobs")
    orchestrator.process_materialization_intents()
    record = json.loads(ledger_path.read_text(encoding="utf-8"))[key.key_id]
    assert record["state"] == ml.PENDING and record["terminal_retries"][0]["reason"] == "operator retry"


def test_a_close_has_one_operation_id_and_its_recoveries_are_recorded(tmp_path, monkeypatch):
    # The finalization manifest names the close operation; a finalization retry is recorded under it.
    emitted = []

    class Emitter:
        def emit(self, **event):
            emitted.append(event)

    import service.platform.remediation as remediation
    monkeypatch.setattr(remediation, "emitter", lambda: Emitter())
    orchestrator = _orchestrator(tmp_path, FakeMarketRuntimeEvidence(tmp_path / "evidence"))
    orchestrator._write_finalization_manifest({"session_key": "shioaji:STK:2026-10-08:DAY", "market": "STK",
                                               "trading_date": "2026-10-08", "session": "DAY", "lifecycle_state": "sealed"})
    manifest = json.loads(next((tmp_path / "fin").glob("*.json")).read_text(encoding="utf-8"))
    assert manifest["close_operation_id"] == "close:shioaji:STK:2026-10-08:DAY"
    orchestrator._finalization_failed({"job_id": "shioaji:STK:2026-10-08:DAY", "attempt": 0}, result=None, error="disk")
    record = emitted[-1]
    assert (record["mechanism_id"], record["trigger_reason"], record["detail"]["close_operation_id"]) == (
        "session.close_recovery", "finalization_retry", "close:shioaji:STK:2026-10-08:DAY")


def test_a_retried_finalization_ends_recorded_and_a_failure_says_why(tmp_path, monkeypatch):
    """A finalization that needed retries left only its failed attempts (with `error: null`)
    in the remediation record and nothing when it then completed."""
    emitted = []

    class Emitter:
        def emit(self, **event):
            emitted.append(event)

    import service.platform.remediation as remediation
    monkeypatch.setattr(remediation, "emitter", lambda: Emitter())
    orchestrator = _orchestrator(tmp_path, FakeMarketRuntimeEvidence(tmp_path / "evidence"))
    results = iter([{"cache_cleanup_allowed": False, "finalization_status": "WAITING_DURABLE"},
                    {"cache_cleanup_allowed": True, "finalization_status": "COMPLETE"}])
    monkeypatch.setattr(orchestrator, "_finalize_prepared", lambda job: next(results))
    orchestrator._running.clear()
    orchestrator._finalization_queue.put({"job_id": "shioaji:STK:2026-10-08:DAY", "attempt": 0})
    orchestrator._finalization_run()
    assert emitted[-1]["outcome"] == "abandoned" and "WAITING_DURABLE" in emitted[-1]["detail"]["error"]
    orchestrator._finalization_queue.put({"job_id": "shioaji:STK:2026-10-08:DAY", "attempt": 2})
    orchestrator._finalization_run()
    assert (emitted[-1]["trigger_reason"], emitted[-1]["outcome"], emitted[-1]["attempt"]) == ("finalization_retry", "succeeded", 3)
