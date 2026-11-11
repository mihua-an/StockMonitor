"""C-1: a FUT finalization submits EVERY session partition (DAY, or a NIGHT dated by the day it opened) that has
persisted WAL evidence and whose session is over - enumerated from the evidence, never from fixed day arithmetic.

FUT is stored per business session, not per calendar day: a night is ONE partition across
midnight, so a Friday night is not split into a Friday and a Saturday partition.
"""
from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import Mock
from zoneinfo import ZoneInfo

from service.market.lifecycle.rollover import ActiveMarketSession, SessionOrchestrator
from tests.market_runtime_evidence_fake import FakeMarketRuntimeEvidence, FakeSink

TAIPEI = ZoneInfo("Asia/Taipei")


def _fut_evidence(evidence, *partitions):
    for day, session in partitions:
        event = SimpleNamespace(source="shioaji", market="FUT", trading_date=day, session=session, exchange_ts_ns=1)
        evidence.stored(event)


def _finalize(tmp_path, evidence, now, orchestrator=None):
    recorder = SimpleNamespace(evaluate_session=Mock(return_value={"ok": True}))
    identity = SimpleNamespace(generation=1, live=False, as_dict=lambda: {})
    app = SimpleNamespace(
        session_evidence_gate=recorder, live_event_sink=FakeSink(evidence),
        broker_service=SimpleNamespace(market_identity_authority=SimpleNamespace(current=lambda _m: identity),
                                       status=lambda: {"txf": {}}))
    if orchestrator is None:
        orchestrator = SessionOrchestrator(
            app_provider=lambda: app, now_provider=lambda: now, finalization_grace_seconds=0,
            manifest_dir=tmp_path / "fin", materialization_jobs_root=tmp_path / "jobs")
    else:
        orchestrator.now_provider = lambda: now
    active = ActiveMarketSession(market="FUT", trading_date=now.date().isoformat(), session="NIGHT",
                                 actual_contract="TXFI6", generation=1, stream_id="FUT:" + now.isoformat())
    payload = orchestrator._finalize_prepared({"active": active, "quiesce": {}, "attempt": 0})
    return orchestrator, sorted(f'{k["trading_date"]}:{k["session"]}' for k in payload["materialization_keys"])


def _pending(tmp_path):
    return len(list((tmp_path / "jobs" / "pending").glob("*.json")))


def test_one_night_case(tmp_path):
    evidence = FakeMarketRuntimeEvidence(tmp_path / "evidence")
    _fut_evidence(evidence, ("2026-09-08", "NIGHT"))
    _o, keys = _finalize(tmp_path, evidence, datetime(2026, 9, 9, 5, 10, tzinfo=TAIPEI))
    assert keys == ["2026-09-08:NIGHT"], "the night that opened 09-08 ended 09-09 05:00"


def test_a_weekend_night_is_one_partition(tmp_path):
    evidence = FakeMarketRuntimeEvidence(tmp_path / "evidence")
    _fut_evidence(evidence, ("2026-09-04", "NIGHT"))  # Fri 15:00 -> Sat 05:00
    _o, keys = _finalize(tmp_path, evidence, datetime(2026, 9, 7, 5, 10, tzinfo=TAIPEI))
    assert keys == ["2026-09-04:NIGHT"]


def test_long_holiday_first_day_night_partition_is_not_stranded(tmp_path):
    evidence = FakeMarketRuntimeEvidence(tmp_path / "evidence")
    _fut_evidence(evidence, ("2026-09-02", "NIGHT"))  # holiday first day, real night-session event
    _o, keys = _finalize(tmp_path, evidence, datetime(2026, 9, 9, 5, 10, tzinfo=TAIPEI))  # 7 days later
    assert keys == ["2026-09-02:NIGHT"]


def test_days_without_wal_evidence_are_not_submitted_and_an_unended_session_is_excluded(tmp_path):
    evidence = FakeMarketRuntimeEvidence(tmp_path / "evidence")
    _fut_evidence(evidence, ("2026-09-02", "NIGHT"), ("2026-09-09", "DAY"))  # 09-09 DAY ends at 13:45: still open
    _o, keys = _finalize(tmp_path, evidence, datetime(2026, 9, 9, 5, 10, tzinfo=TAIPEI))
    assert keys == ["2026-09-02:NIGHT"]
    assert _pending(tmp_path) == 1, "dates without evidence produce no job at all"


def test_a_day_partition_is_submitted_once_its_session_is_over(tmp_path):
    evidence = FakeMarketRuntimeEvidence(tmp_path / "evidence")
    _fut_evidence(evidence, ("2026-09-09", "DAY"))
    _o, keys = _finalize(tmp_path, evidence, datetime(2026, 9, 9, 13, 50, tzinfo=TAIPEI))
    assert keys == ["2026-09-09:DAY"]


def test_already_submitted_partition_is_not_resubmitted(tmp_path):
    evidence = FakeMarketRuntimeEvidence(tmp_path / "evidence")
    _fut_evidence(evidence, ("2026-09-02", "NIGHT"), ("2026-09-08", "NIGHT"))
    orchestrator, first = _finalize(tmp_path, evidence, datetime(2026, 9, 9, 5, 10, tzinfo=TAIPEI))
    assert first == ["2026-09-02:NIGHT", "2026-09-08:NIGHT"] and _pending(tmp_path) == 2
    _fut_evidence(evidence, ("2026-09-09", "NIGHT"))
    _o, second = _finalize(tmp_path, evidence, datetime(2026, 9, 10, 5, 10, tzinfo=TAIPEI), orchestrator)
    assert second == ["2026-09-09:NIGHT"], "the manifest lists only the partitions it newly owns"
    assert _pending(tmp_path) == 3, "only the newly ended partition created a new job"
    assert len(orchestrator._ledger.records()) == 3


def test_partition_completeness_is_its_own_evidence_not_the_whole_sessions(tmp_path):
    evidence = FakeMarketRuntimeEvidence(tmp_path / "evidence")
    _fut_evidence(evidence, ("2026-09-02", "NIGHT"), ("2026-09-08", "NIGHT"))
    evidence.lost(SimpleNamespace(source="shioaji", market="FUT", trading_date="2026-09-02", session="NIGHT", exchange_ts_ns=1))
    orchestrator, _ = _finalize(tmp_path, evidence, datetime(2026, 9, 9, 5, 10, tzinfo=TAIPEI))
    by_date = {r["trading_date"]: r["completeness"] for r in orchestrator._ledger.records()}
    assert by_date == {"2026-09-02": "gap_detected", "2026-09-08": "complete"}


def test_manifest_key_sets_stay_bounded_and_settled_manifests_are_not_repolled(tmp_path):
    evidence = FakeMarketRuntimeEvidence(tmp_path / "evidence")
    _fut_evidence(evidence, ("2026-09-02", "NIGHT"), ("2026-09-08", "NIGHT"))
    orchestrator, first = _finalize(tmp_path, evidence, datetime(2026, 9, 9, 5, 10, tzinfo=TAIPEI))
    assert first == ["2026-09-02:NIGHT", "2026-09-08:NIGHT"]
    _o, second = _finalize(tmp_path, evidence, datetime(2026, 9, 10, 5, 10, tzinfo=TAIPEI), orchestrator)
    assert second == [], "partitions already owned by an earlier finalization are not repeated in later manifests"
    import json
    statuses = sorted(json.loads(p.read_text(encoding="utf-8"))["materialization_status"]
                      for p in (tmp_path / "fin").glob("*.json"))
    assert statuses == ["no_new_partitions", "pending"]
    # a manifest whose partitions terminally failed is settled and never polled again
    for record in orchestrator._ledger._records.values():
        record["state"] = "failed_terminal"
    orchestrator._ledger._save()
    orchestrator.poll_materialization_jobs()
    calls = []
    real_status = orchestrator._ledger.status
    orchestrator._ledger.status = lambda key: calls.append(key) or real_status(key)
    orchestrator.poll_materialization_jobs()
    assert calls == [], "settled manifests cost nothing on later reconcile polls"
