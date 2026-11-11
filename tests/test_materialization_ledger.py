"""Materialization request authority: deterministic identity, dedupe, backoff,
owner-only job creation, and zero read-path job side effects."""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from service.market.shared import materialization_jobs as ml_jobs
from service.market.shared import materialization_ledger as ml
from service.market.shared.materialization_jobs import request_materialization

ROOT = Path(__file__).resolve().parents[1]


class Clock:
    def __init__(self) -> None:
        self.now = 1_000_000.0

    def __call__(self) -> float:
        return self.now


def _ledger(tmp_path, clock, submitted):
    def submit_job(**kw):
        submitted.append(kw)
        return request_materialization(**kw)

    return ml.MaterializationLedger("shioaji", jobs_root=tmp_path, clock=clock, submit_job=submit_job)


KEY = ml.MaterializationKey.for_session("shioaji", "STK", "2026-09-08")


def _finish(tmp_path, record, *, ok, error="", status=None, **override):
    """What Health writes: the result of the job, echoing the request it answers."""
    done = tmp_path / "done"
    done.mkdir(parents=True, exist_ok=True)
    pending = tmp_path / "pending" / f"{record['job_id']}.json"
    body = {"schema": ml_jobs.RESULT_SCHEMA, "job_id": record["job_id"], "ok": ok,
            "status": status or ("materialized" if ok else "retryable"),
            "request": json.loads(pending.read_text(encoding="utf-8")) if pending.exists() else None}
    if error:
        body["error"] = error
    body.update(override)
    (done / f"{record['job_id']}.json").write_text(json.dumps(body), encoding="utf-8")
    if pending.exists():
        pending.unlink()


def test_identity_is_deterministic_and_repeat_submit_never_creates_a_second_job(tmp_path):
    clock, submitted = Clock(), []
    ledger = _ledger(tmp_path, clock, submitted)
    first = ledger.submit(KEY, completeness="complete")
    for _ in range(5):
        again = ledger.submit(ml.MaterializationKey("SHIOAJI", "stk", "2026-09-08", "day", "*"), completeness="gap_detected")
        assert again["deduped"] is True and again["job_id"] == first["job_id"]
    assert len(submitted) == 1
    assert len(list((tmp_path / "pending").glob("*.json"))) == 1
    assert first["job_id"].startswith(KEY.key_id)


def test_completed_job_is_reused_not_resubmitted(tmp_path):
    clock, submitted = Clock(), []
    ledger = _ledger(tmp_path, clock, submitted)
    record = ledger.submit(KEY, completeness="complete")
    _finish(tmp_path, record, ok=True)
    ledger.tick()
    assert ledger.status(KEY)["state"] == ml.SUCCEEDED
    assert ledger.submit(KEY, completeness="complete")["deduped"] is True
    assert len(submitted) == 1


def test_failure_becomes_retryable_with_bounded_backoff_and_no_job_storm(tmp_path):
    clock, submitted = Clock(), []
    ledger = _ledger(tmp_path, clock, submitted)
    record = ledger.submit(KEY, completeness="complete")
    _finish(tmp_path, record, ok=False, error="disk full")
    ledger.tick()
    state = ledger.status(KEY)
    assert state["state"] == ml.FAILED_RETRYABLE and state["last_error"] == "disk full"
    assert state["next_attempt_at"] == pytest.approx(clock.now + ml.backoff_seconds(1))
    # Many ticks / submits inside the backoff window must not relaunch.
    for _ in range(20):
        clock.now += 1
        ledger.tick()
        ledger.submit(KEY, completeness="complete")
    assert len(submitted) == 1
    clock.now = state["next_attempt_at"] + 1
    ledger.tick()  # backoff elapsed: exactly one relaunch
    assert len(submitted) == 2 and ledger.status(KEY)["attempts"] == 2
    assert ledger.status(KEY)["job_id"].endswith("-a2")


def test_backoff_doubles_then_goes_terminal_after_max_attempts(tmp_path):
    clock, submitted = Clock(), []
    ledger = _ledger(tmp_path, clock, submitted)
    delays = []
    record = ledger.submit(KEY, completeness="complete")
    for attempt in range(1, ml.MAX_ATTEMPTS + 1):
        _finish(tmp_path, record, ok=False, error="boom")
        ledger.tick()
        state = ledger.status(KEY)
        if attempt < ml.MAX_ATTEMPTS:
            assert state["state"] == ml.FAILED_RETRYABLE
            delays.append(state["next_attempt_at"] - clock.now)
            clock.now = state["next_attempt_at"] + 1
            ledger.tick()
            record = ledger.status(KEY)
    assert ledger.status(KEY)["state"] == ml.FAILED_TERMINAL
    assert delays == sorted(delays) and delays[1] == pytest.approx(delays[0] * 2)
    assert ml.backoff_seconds(50) == ml.BACKOFF_CAP_SECONDS
    count = len(submitted)
    clock.now += 10 * ml.BACKOFF_CAP_SECONDS
    ledger.tick()
    ledger.submit(KEY, completeness="complete")
    assert len(submitted) == count  # terminal: never retried automatically


def test_ledger_survives_restart_and_two_instances_stay_coherent(tmp_path):
    clock, submitted = Clock(), []
    first = _ledger(tmp_path, clock, submitted)
    record = first.submit(KEY, completeness="complete")
    second = _ledger(tmp_path, clock, submitted)  # restart / second reader
    assert second.status(KEY)["job_id"] == record["job_id"]
    assert second.submit(KEY, completeness="complete")["deduped"] is True
    assert len(submitted) == 1


def test_intents_are_idempotent_and_create_no_job(tmp_path):
    a = ml.propose_intent("shioaji", "STK", "2026-09-08", jobs_root=tmp_path, reason="x")
    b = ml.propose_intent("shioaji", "stk", "2026-09-08", jobs_root=tmp_path, reason="y")
    assert a["key_id"] == b["key_id"]
    assert len(ml.drain_intents("shioaji", jobs_root=tmp_path)) == 1
    assert not (tmp_path / "pending").exists(), "proposing an intent must never create a job"
    assert ml.intent_or_job_status("shioaji", "STK", "2026-09-08", jobs_root=tmp_path)["state"] == "intent_pending"


def test_only_the_ledger_may_create_materializer_jobs():
    """Source scan: request_materialization( is called nowhere except the ledger's own default."""
    offenders = []
    for base in ("api", "backend", "service", "scripts", "health"):
        for path in (ROOT / base).rglob("*.py"):
            if path.name in {"materialization_jobs.py"}:
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
            if re.search(r"\brequest_materialization\(", text):
                offenders.append(path.relative_to(ROOT).as_posix())
    assert offenders == []


def test_key_builder_takes_session_from_the_wal_identity_contract():
    """One builder: STK/IDX -> DAY, Futu -> FULL; shioaji FUT is partitioned per session (DAY / NIGHT),
    so its caller names the partition -- never a '*' field, never a session the WAL cannot carry."""
    assert ml.MaterializationKey.for_session("shioaji", "STK", "2026-09-08").session == "DAY"
    assert ml.MaterializationKey.for_session("shioaji", "IDX", "2026-09-08").session == "DAY"
    fut = ml.MaterializationKey.for_session("shioaji", "FUT", "2026-09-08", session="night")
    assert fut.session == "NIGHT" and fut.instrument == ""
    with pytest.raises(ValueError):
        ml.MaterializationKey.for_session("shioaji", "FUT", "2026-09-08")  # which session?
    assert ml.MaterializationKey.for_session("futu", "HK", "2026-09-08").session == "FULL"
    assert "*" not in json.dumps(fut.as_dict()) and fut.cli_code == "*"


def test_intent_and_owner_submit_share_one_key(tmp_path):
    intent = ml.propose_intent("shioaji", "FUT", "2026-09-08", jobs_root=tmp_path, session="NIGHT")
    submitted = []
    ledger = _ledger(tmp_path, Clock(), submitted)
    record = ledger.submit(ml.MaterializationKey.from_dict(intent), completeness="complete")
    assert record["key_id"] == intent["key_id"] == ml.MaterializationKey.for_session("shioaji", "FUT", "2026-09-08", session="NIGHT").key_id
    assert submitted[0]["session"] == "NIGHT" and submitted[0]["code"] == "*"


def test_zero_match_is_no_input_never_succeeded_and_never_retried(tmp_path):
    clock, submitted = Clock(), []
    ledger = _ledger(tmp_path, clock, submitted)
    record = ledger.submit(KEY, completeness="complete")
    _finish(tmp_path, record, ok=False, status="no_matching_input", error="no events matched")
    ledger.tick()
    assert ledger.status(KEY)["state"] == ml.NO_INPUT != ml.SUCCEEDED
    clock.now += 10 * ml.BACKOFF_CAP_SECONDS
    ledger.tick()
    ledger.submit(KEY, completeness="complete")
    assert len(submitted) == 1


def test_invalid_identity_is_terminal_without_retry_storm(tmp_path):
    clock, submitted = Clock(), []
    ledger = _ledger(tmp_path, clock, submitted)
    record = ledger.submit(KEY, completeness="complete")
    _finish(tmp_path, record, ok=False, status="invalid_identity", error="bad session")
    ledger.tick()
    assert ledger.status(KEY)["state"] == ml.FAILED_TERMINAL
    clock.now += 10 * ml.BACKOFF_CAP_SECONDS
    ledger.tick()
    assert len(submitted) == 1


def test_the_job_stage_is_read_never_guessed_from_a_lease(tmp_path, monkeypatch):
    # Claimed by Health = RUNNING for as long as it is claimed; neither pending, claimed nor done = lost, retried
    # at once (after its backoff) and recorded -- no 900 s lease to wait out.
    emitted = []

    class Emitter:
        def emit(self, **event):
            emitted.append(event)

    import service.platform.remediation as remediation
    monkeypatch.setattr(remediation, "emitter", lambda: Emitter())
    clock, submitted = Clock(), []
    ledger = _ledger(tmp_path, clock, submitted)
    record = ledger.submit(KEY, completeness="complete")
    job = f"{record['job_id']}.json"
    (tmp_path / "claimed").mkdir()
    (tmp_path / "pending" / job).rename(tmp_path / "claimed" / job)      # Health's claim
    ledger.tick()
    assert ledger.status(KEY)["state"] == ml.RUNNING
    clock.now += 100_000
    ledger.tick()
    assert ledger.status(KEY)["state"] == ml.RUNNING, "claimed is running, however long"
    (tmp_path / "claimed" / job).unlink()                                 # gone without a result
    ledger.tick()
    status = ledger.status(KEY)
    assert (status["state"], status["retry_cause"]) == (ml.FAILED_RETRYABLE, "request_lost")
    clock.now += ml.backoff_seconds(1) + 1
    ledger.tick()
    assert len(submitted) == 2 and ledger.status(KEY)["attempts"] == 2
    assert [(e["mechanism_id"], e["trigger_reason"], e["outcome"]) for e in emitted] == [
        ("materialization.job_retry", "request_lost", "succeeded")]


def test_an_invalid_request_is_terminal(tmp_path):
    clock, submitted = Clock(), []
    ledger = _ledger(tmp_path, clock, submitted)
    record = ledger.submit(KEY, completeness="complete")
    _finish(tmp_path, record, ok=False, status="invalid_request", error="unreadable")
    ledger.tick()
    assert ledger.status(KEY)["state"] == ml.FAILED_TERMINAL


def test_failed_request_write_is_recorded_retryable_not_lost(tmp_path):
    clock = Clock()

    def broken(**_kw):
        raise OSError("disk full")

    ledger = ml.MaterializationLedger("shioaji", jobs_root=tmp_path, clock=clock, submit_job=broken)
    assert ledger.submit(KEY, completeness="complete")["state"] == ml.FAILED_RETRYABLE
    assert ledger.status(KEY)["state"] == ml.FAILED_RETRYABLE


def _exhaust(tmp_path, clock, ledger):
    record = ledger.submit(KEY, completeness="complete")
    for _ in range(ml.MAX_ATTEMPTS):
        _finish(tmp_path, record, ok=False, error="materializer job timed out after 120000ms")
        ledger.tick()
        state = ledger.status(KEY)
        if state["state"] == ml.FAILED_RETRYABLE:
            clock.now = state["next_attempt_at"] + 1
            ledger.tick()
            record = ledger.status(KEY)
    assert ledger.status(KEY)["state"] == ml.FAILED_TERMINAL


def test_only_an_explicit_retry_relaunches_a_terminal_failure_and_it_is_recorded(tmp_path):
    # FUT sessions exhausted five attempts against a 120 s bound; nothing could start them again.
    clock, submitted = Clock(), []
    ledger = _ledger(tmp_path, clock, submitted)
    _exhaust(tmp_path, clock, ledger)
    count = len(submitted)
    assert ledger.submit(KEY, completeness="complete")["deduped"] is True, "the owner's automatic path: still terminal"
    assert len(submitted) == count
    retried = ledger.submit(KEY, completeness="complete", retry_terminal=True, reason="operator: timeout fixed")
    assert retried["terminal_retry"] is True and retried["state"] == ml.PENDING and retried["attempts"] == 1
    assert len(submitted) == count + 1
    entry = ledger.status(KEY)["terminal_retries"][0]
    assert entry["reason"] == "operator: timeout fixed" and entry["previous_attempts"] == ml.MAX_ATTEMPTS
    assert "timed out" in entry["previous_error"]
    # A fresh job id: the first round's finished -a1 result must not be read as this attempt's.
    assert retried["job_id"].endswith("-r1a1") and retried["job_id"] != f"{KEY.key_id}-a1"
    _finish(tmp_path, retried, ok=True)
    ledger.tick()
    assert ledger.status(KEY)["state"] == ml.SUCCEEDED
    assert ledger.submit(KEY, completeness="complete", retry_terminal=True, reason="again")["deduped"] is True, \
        "a succeeded record is never relaunched"


def test_an_explicit_retry_intent_needs_a_reason_and_carries_its_flag(tmp_path):
    with pytest.raises(ValueError):
        ml.propose_intent("shioaji", "FUT", "2026-10-06", session="DAY", retry_terminal=True, jobs_root=tmp_path)
    intent = ml.propose_intent("shioaji", "FUT", "2026-10-06", session="DAY", retry_terminal=True,
                               reason="operator", jobs_root=tmp_path)
    assert intent["retry_terminal"] is True and intent["session"] == "DAY"
    plain = ml.propose_intent("shioaji", "STK", "2026-10-06", reason="trade_replay_prepare:2330", jobs_root=tmp_path)
    assert "retry_terminal" not in plain


def test_the_operator_tool_refuses_anything_but_a_terminal_record(tmp_path, monkeypatch):
    from scripts.maintenance import retry_terminal_materialization as tool

    monkeypatch.setattr(ml, "default_jobs_root", lambda: tmp_path)
    args = ["--market", "STK", "--date", "2026-09-08", "--reason", "operator"]
    assert tool.main(args) == 1 and not (tmp_path / "intents").exists(), "no record: nothing proposed"
    clock, submitted = Clock(), []
    _exhaust(tmp_path, clock, _ledger(tmp_path, clock, submitted))
    assert tool.main(args) == 0
    intent = json.loads(next((tmp_path / "intents" / "shioaji").glob("*.json")).read_text(encoding="utf-8"))
    assert intent["retry_terminal"] is True and intent["reason"] == "operator"


def test_a_result_survives_a_crash_before_the_ledger_is_saved(tmp_path, monkeypatch):
    """The result file was deleted on read, before the ledger saved; a crash in between lost it."""
    clock, submitted = Clock(), []
    ledger = _ledger(tmp_path, clock, submitted)
    record = ledger.submit(KEY, completeness="complete")
    _finish(tmp_path, record, ok=True)
    result_file = tmp_path / "done" / f"{record['job_id']}.json"

    def crash():
        raise OSError("power loss while saving")

    monkeypatch.setattr(ledger, "_save", crash)
    with pytest.raises(OSError):
        ledger.tick()
    assert result_file.exists(), "the result stays until its outcome is durably recorded"

    restarted = _ledger(tmp_path, clock, submitted)
    restarted.tick()
    assert restarted.status(KEY)["state"] == ml.SUCCEEDED
    assert not result_file.exists(), "acknowledged once the ledger holding it was saved"
    assert len(submitted) == 1, "the job was not run again"


def test_a_job_carries_the_close_that_asked_for_it(tmp_path):
    """The close operation id is on the ledger record and in the job request (the result echoes it)."""
    import json

    clock, submitted = Clock(), []
    ledger = _ledger(tmp_path, clock, submitted)
    record = ledger.submit(KEY, completeness="complete", close_operation_id="close:shioaji:STK:2026-09-08:DAY")
    assert record["close_operation_id"] == "close:shioaji:STK:2026-09-08:DAY"
    assert submitted[0]["close_operation_id"] == "close:shioaji:STK:2026-09-08:DAY"
    request = json.loads((tmp_path / "pending" / f"{record['job_id']}.json").read_text(encoding="utf-8"))
    assert request["close_operation_id"] == "close:shioaji:STK:2026-09-08:DAY"
    again = ledger.submit(KEY, completeness="complete", close_operation_id="close:later")
    assert again["deduped"] and again["close_operation_id"] == "close:shioaji:STK:2026-09-08:DAY"
    assert ledger.status(KEY)["related_close_operations"] == ["close:later"]


def test_a_close_operation_given_to_an_existing_record_is_saved(tmp_path):
    # A record created without an owning close gets the first close that covers it -- on disk, not only in memory:
    # a restarted ledger (another instance) still knows which close owns it.
    clock, submitted = Clock(), []
    ledger = _ledger(tmp_path, clock, submitted)
    ledger.submit(KEY, completeness="complete")
    ledger.submit(KEY, completeness="complete", close_operation_id="close:first")
    reopened = _ledger(tmp_path, clock, [])
    assert reopened.status(KEY)["close_operation_id"] == "close:first"


@pytest.mark.parametrize("override", [
    {"schema": "something-else"}, {"job_id": "another-job"}, {"status": "done"}, {"ok": "yes"},
    {"status": "retryable"}, {"request": None},
    {"request": {"job_id": "x", "source": "shioaji"}},
])
def test_an_invalid_result_is_quarantined_and_never_changes_the_ledger(tmp_path, override):
    clock, submitted = Clock(), []
    ledger = _ledger(tmp_path, clock, submitted)
    record = ledger.submit(KEY, completeness="complete")
    _finish(tmp_path, record, ok=True)
    result_file = tmp_path / "done" / f"{record['job_id']}.json"
    result_file.write_text(json.dumps({**json.loads(result_file.read_text(encoding="utf-8")), **override}), encoding="utf-8")
    ledger.tick()
    assert ledger.status(KEY)["state"] == ml.PENDING, "nothing is read from an invalid result"
    assert (tmp_path / "done_quarantine" / f"{record['job_id']}.json").exists()
    ledger.tick()
    status = ledger.status(KEY)
    assert (status["state"], status["retry_cause"]) == (ml.FAILED_RETRYABLE, "request_lost"), "then retried as lost"


def test_a_result_of_another_identity_is_refused(tmp_path):
    clock, submitted = Clock(), []
    ledger = _ledger(tmp_path, clock, submitted)
    record = ledger.submit(KEY, completeness="complete")
    request = json.loads((tmp_path / "pending" / f"{record['job_id']}.json").read_text(encoding="utf-8"))
    _finish(tmp_path, record, ok=True, request={**request, "trading_date": "2026-09-09"})
    ledger.tick()
    assert ledger.status(KEY)["state"] != ml.SUCCEEDED


def test_the_attempt_is_journaled_before_its_request_exists(tmp_path):
    """A crash between the request write and the ledger save left a request no record named."""
    clock = Clock()
    seen = {}

    def submit_job(**kw):
        seen["ledger"] = json.loads((tmp_path / "ledger" / "shioaji.json").read_text(encoding="utf-8"))
        raise SystemExit("crash before the request is written")

    ledger = ml.MaterializationLedger("shioaji", jobs_root=tmp_path, clock=clock, submit_job=submit_job)
    with pytest.raises(SystemExit):
        ledger.submit(KEY, completeness="complete")
    journaled = seen["ledger"][KEY.key_id]
    assert (journaled["state"], journaled["attempts"]) == (ml.PENDING, 1) and journaled["job_id"]
    restarted = _ledger(tmp_path, clock, [])
    restarted.tick()
    assert restarted.status(KEY)["retry_cause"] == "request_lost", "the missing request is found by its stage"


def test_an_unreadable_ledger_is_never_replaced_by_an_empty_one(tmp_path):
    clock, submitted = Clock(), []
    _ledger(tmp_path, clock, submitted).submit(KEY, completeness="complete")
    path = tmp_path / "ledger" / "shioaji.json"
    path.write_text('{"abc": {"state": "succ', encoding="utf-8")
    with pytest.raises(ml.MaterializationLedgerUnreadable):
        _ledger(tmp_path, clock, submitted)
    assert path.read_text(encoding="utf-8") == '{"abc": {"state": "succ'
