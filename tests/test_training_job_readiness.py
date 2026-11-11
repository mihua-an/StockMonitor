"""The automatic training waits for the STK day session to be materialized WHOLE -- the session owner's settled
notice (output/materialization_jobs/settled/shioaji.json, published once STK and IDX both ended) says
materialized -- not for the first partition with a manifest: a session materialized at 13:34 missed the 14:30
after-hours print, and partitions appear one instrument at a time."""
from __future__ import annotations

import json

from service.analysis.online_training import job
from service.market.shared.materialization_jobs import publish_settled_session


def _settled(tmp_path, monkeypatch, *, date="2026-10-06", status="materialized"):
    root = tmp_path / "jobs"
    monkeypatch.setattr(job, "settled_sessions_path", lambda: root / "settled" / "shioaji.json")
    if status is not None:
        publish_settled_session(source="shioaji", market="STK", trading_date=date, session="DAY", status=status,
                                settled_at="2026-10-06T14:42:00+08:00", jobs_root=root)


def test_ready_only_when_the_owner_published_the_whole_stk_session_materialized(tmp_path, monkeypatch):
    _settled(tmp_path / "none", monkeypatch, status=None)
    assert job.session_materialized("2026-10-06") == (False, "2026-10-06 STK session not materialized yet (sealed after the after-hours match)")
    _settled(tmp_path / "older", monkeypatch, date="2026-10-05")
    assert job.session_materialized("2026-10-06")[0] is False, "the newest settled session is the day before"
    for status in ("failed", "no_input"):
        _settled(tmp_path / status, monkeypatch, status=status)
        ready, why = job.session_materialized("2026-10-06")
        assert not ready and status in why
    _settled(tmp_path / "ok", monkeypatch)
    assert job.session_materialized("2026-10-06") == (True, "materialized")


def test_days_settling_out_of_order_keep_the_newest(tmp_path, monkeypatch):
    """The App off for days: at the next start every closed day settles, in any order; the notice keeps the newest,
    whose training window already holds the older days."""
    root = tmp_path / "jobs"
    monkeypatch.setattr(job, "settled_sessions_path", lambda: root / "settled" / "shioaji.json")
    for day in ("2026-10-07", "2026-10-05", "2026-10-06"):
        publish_settled_session(source="shioaji", market="STK", trading_date=day, session="DAY", status="materialized",
                                settled_at="2026-10-08T08:00:00+08:00", jobs_root=root)
    assert job.settled_stk_day()["trading_date"] == "2026-10-07"


def test_an_auto_run_on_a_day_not_yet_settled_is_not_ready(tmp_path, monkeypatch):
    _settled(tmp_path, monkeypatch, date="2026-10-05")
    monkeypatch.setattr(job, "training_root", lambda: tmp_path / "training")
    monkeypatch.setattr(job, "load_config", lambda: {"schema": "model-training-v1"})
    import types

    import config.feature_settings
    import service.analysis.online_training.dataset as dataset

    monkeypatch.setattr(config.feature_settings, "SHIOAJI_FEATURES", types.SimpleNamespace(model_training=True))

    monkeypatch.setattr(dataset, "available_dates", lambda root, shards, **_: ["2026-10-05", "2026-10-06"])  # one manifest is enough
    result = job.Job(mode="auto", job_id="t", trading_date="2026-10-06", hist_root=tmp_path).run()
    assert result["state"] == "NOT_READY" and "not materialized yet" in result["reason"]


def test_the_auto_schedule_is_the_training_domains_own_ledger(tmp_path, monkeypatch):
    # Every auto attempt is recorded when it starts (the next one due retry_minutes later, so an
    # attempt that dies is still followed by one) and when it ends; a later attempt for the same date is a recorded
    # training.auto_retry.
    from datetime import datetime, timezone

    monkeypatch.setattr(job, "training_root", lambda: tmp_path)
    emitted = []

    class Emitter:
        def emit(self, **event):
            emitted.append(event)

    import service.platform.remediation as remediation
    monkeypatch.setattr(remediation, "emitter", lambda: Emitter())
    start = datetime(2026, 10, 6, 6, 40, tzinfo=timezone.utc)
    assert job.begin_auto_attempt("2026-10-06", now=start) == {}
    entry = job.read_schedule()
    assert (entry["attempts"], entry["state"], entry["next_due_at"]) == (1, "RUNNING", "2026-10-06T07:10:00+00:00")
    job.end_auto_attempt("2026-10-06", {"state": "NOT_READY", "reason": "not committed"})
    assert job.read_schedule()["state"] == "WAITING"
    assert job.read_schedule()["next_due_at"] is None, "NOT_READY waits for the next settled notice, not a clock"
    previous = job.begin_auto_attempt("2026-10-06", now=start)
    assert previous["last_result"]["state"] == "NOT_READY" and job.read_schedule()["attempts"] == 2
    entry = job.end_auto_attempt("2026-10-06", {"state": "SUCCEEDED"})
    job._record_auto_retry("2026-10-06", previous, {"state": "SUCCEEDED"}, entry["attempts"])
    assert job.read_schedule()["state"] == "DONE"
    assert [(e["mechanism_id"], e["trigger_reason"], e["outcome"], e["attempt"]) for e in emitted] == [
        ("training.auto_retry", "not_ready", "succeeded", 2)]
    # An attempt that never recorded its end was interrupted.
    job.begin_auto_attempt("2026-10-07", now=start)
    previous = job.begin_auto_attempt("2026-10-07", now=start)
    job._record_auto_retry("2026-10-07", previous, {"state": "FAILED"}, 2)
    assert emitted[-1]["trigger_reason"] == "interrupted" and emitted[-1]["outcome"] == "failed"


def test_a_damaged_ledger_is_never_read_as_nothing_recorded(tmp_path, monkeypatch, capsys):
    """state.json / schedule.json are the domain's own ledgers: a damaged one stops the job (FAILED, file untouched)
    instead of resetting the attempt count or retraining a date already trained."""
    import pytest

    monkeypatch.setattr(job, "training_root", lambda: tmp_path)
    assert job.read_state() == {} and job.read_schedule() == {}, "absent is nothing recorded yet"
    schedule = tmp_path / "schedule.json"
    schedule.write_text('{"trading_date": "2026-10-06", "attem', encoding="utf-8")
    with pytest.raises(job.TrainingLedgerCorrupt):
        job.read_schedule()
    (tmp_path / "state.json").write_text("[1]", encoding="utf-8")
    with pytest.raises(job.TrainingLedgerCorrupt):
        job.read_state()
    assert job.main(["--mode", "auto", "--job-id", "t1", "--security-master", "master.csv", "--trading-date", "2026-10-06"]) == 0
    result = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert result["state"] == "FAILED" and "schedule ledger damaged" in result["error"]
    assert schedule.read_text(encoding="utf-8") == '{"trading_date": "2026-10-06", "attem', "the damaged ledger is kept"


def test_a_broken_remediation_pipe_does_not_turn_a_finished_job_into_a_runner_failure(tmp_path, monkeypatch, capsys):
    """The retry's remediation record runs after the job finished: when the emitter fails, the job still prints its
    terminal result (SUCCEEDED here) with the failure noted, and exits 0 (R14-14)."""
    from datetime import datetime, timezone

    monkeypatch.setattr(job, "training_root", lambda: tmp_path)
    job.begin_auto_attempt("2026-10-06", now=datetime(2026, 10, 6, 6, 40, tzinfo=timezone.utc))
    job.end_auto_attempt("2026-10-06", {"state": "NOT_READY", "reason": "not committed"})
    monkeypatch.setattr(job.Job, "run", lambda self: self._finish("SUCCEEDED", result={"trained": ["a"]}))

    import service.platform.remediation as remediation

    def broken():
        raise OSError("pipe broken")
    monkeypatch.setattr(remediation, "emitter", broken)
    assert job.main(["--mode", "auto", "--job-id", "t2", "--security-master", "master.csv", "--trading-date", "2026-10-06"]) == 0
    result = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert result["state"] == "SUCCEEDED" and result["ok"] is True
    assert "pipe broken" in result["remediation"]
    assert result["schedule"]["state"] == "DONE"
