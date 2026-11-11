"""training_ready = evidence_ready (A: session evidence) AND historical_materialized (B: valid artifact).

C (evidence completeness) and D (dataset readiness) stay separate; a materializer run or a
SUCCEEDED ledger record alone is never enough, and NO_INPUT / retryable / terminal never count."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from service.market.shared import materialization_ledger as ml
from service.market.shioaji.session_evidence_gate import ShioajiSessionEvidenceGate
from tests.market_runtime_evidence_fake import FakeMarketRuntimeEvidence

DATE = "2026-09-08"


def _recorder(tmp_path):
    return ShioajiSessionEvidenceGate(jobs_root=tmp_path / "jobs", evidence=FakeMarketRuntimeEvidence(tmp_path / "evidence"))


def _evidence(recorder, *, dropped=0, events=3):
    for market in ("STK", "IDX"):
        event = SimpleNamespace(source="shioaji", market=market, trading_date=DATE, session="DAY", exchange_ts_ns=1)
        for _ in range(events):
            recorder.session_evidence.stored(event)
        for _ in range(dropped):
            recorder.session_evidence.stored(event)
            recorder.session_evidence.lost(event)


def _mark(recorder, state, *, artifact_valid=True):
    for market in ("STK", "IDX"):
        key = ml.MaterializationKey.for_session("shioaji", market, DATE)
        recorder._ledger._records[key.key_id] = {**key.as_dict(), "key_id": key.key_id, "state": state, "attempts": 1}
        recorder._ledger._save()
    recorder._historical.artifact_status = lambda *_a, **_k: {"valid": artifact_valid, "events": 3}


def _run(recorder):
    return recorder.evaluate_session(market="STK", trading_date=DATE, session="DAY")


@pytest.mark.parametrize("state", [None, ml.PENDING, ml.RUNNING, ml.FAILED_RETRYABLE, ml.FAILED_TERMINAL, ml.NO_INPUT])
def test_unfinished_or_empty_materialization_never_makes_training_ready(tmp_path, state):
    recorder = _recorder(tmp_path)
    _evidence(recorder)
    if state:
        _mark(recorder, state)
    result = _run(recorder)
    assert result["evidence_ready"] is True
    assert result["historical_materialized"] is False and result["training_ready"] is False
    assert result["materialized"]["ok"] is False and not result["materialized"].get("skipped")


def test_materialized_but_evidence_gap_is_still_not_training_ready(tmp_path):
    recorder = _recorder(tmp_path)
    _evidence(recorder, dropped=1)
    _mark(recorder, ml.SUCCEEDED)
    result = _run(recorder)
    assert result["historical_materialized"] is True and result["evidence_ready"] is False
    assert result["training_ready"] is False


def test_no_evidence_for_the_session_is_never_evidence_ready(tmp_path):
    recorder = _recorder(tmp_path)
    _mark(recorder, ml.SUCCEEDED)
    result = _run(recorder)
    assert result["evidence_ready"] is False and result["training_ready"] is False


def test_succeeded_ledger_record_without_a_valid_artifact_is_not_materialized(tmp_path):
    recorder = _recorder(tmp_path)
    _evidence(recorder)
    _mark(recorder, ml.SUCCEEDED, artifact_valid=False)
    result = _run(recorder)
    assert result["evidence_ready"] is True and result["historical_materialized"] is False
    assert result["training_ready"] is False


def test_both_capabilities_ready_is_the_only_way_to_training_ready(tmp_path):
    recorder = _recorder(tmp_path)
    _evidence(recorder)
    _mark(recorder, ml.SUCCEEDED)
    result = _run(recorder)
    assert result["evidence_ready"] and result["historical_materialized"] and result["training_ready"]
