"""A manual run that trained the newest materialized trading date's close has trained that day: the training domain
records it (state.json last_trained_trading_date) and closes that day's auto schedule, so the model center says
today is trained and Health starts no auto run or retry for it. A run whose window lacks that day changes neither.
And the model center shows a retry countdown only for a day Health would retry: one published materialized."""
from __future__ import annotations

from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from service.analysis.online_training import dataset as dataset_module
from service.analysis.online_training import job
from service.analysis.online_training import registry as registry_module
from service.analysis.online_training import trainer as trainer_module
from service.analysis.online_training.today import training_today
from service.market.shared.materialization_jobs import publish_settled_session

DAYS = ["2026-10-26", "2026-10-27", "2026-10-28"]


class _Exporter:
    def spec(self):
        return {"schema_digest": "d"}


class _Builder:
    def __init__(self, *args, **kwargs):
        pass

    def build(self, window, **kwargs):
        return {"dataset_id": "ods-1", "samples": 1, "codes": 1, "trading_dates": list(window), "degraded": False}

    def prune(self, **kwargs):
        return {}


class _Trainer:
    def __init__(self, registry):
        pass

    def train(self, path, **kwargs):
        return {"run_id": "run-1", "slots": {"3m_up": {"status": "TRAINED"}}}


@pytest.fixture
def domain(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(job, "training_root", lambda: tmp_path / "training")
    monkeypatch.setattr(job, "datasets_root", lambda: tmp_path / "datasets")
    monkeypatch.setattr(job, "daily_summary_root", lambda: tmp_path / "summary")
    for day in DAYS:   # every day 完整: trained on
        summary = tmp_path / "summary" / "source=shioaji" / "market=STK" / f"trading_date={day}" / "session=DAY.json"
        summary.parent.mkdir(parents=True)
        summary.write_text('{"tick_complete": true, "codes": {}}', encoding="utf-8")
        summary.with_name("session=DAY.verdict.json").write_text(
            '{"schema": "daily-summary-verdict-v1", "session": "DAY", "tick_complete": true}', encoding="utf-8")
    monkeypatch.setattr(job, "settled_sessions_path", lambda: tmp_path / "jobs" / "settled" / "shioaji.json")
    monkeypatch.setattr(dataset_module, "available_dates", lambda *args, **kwargs: list(DAYS))
    monkeypatch.setattr(dataset_module, "OnlineDatasetBuilder", _Builder)
    monkeypatch.setattr(registry_module, "OnlineModelRegistry", lambda: None)
    monkeypatch.setattr(trainer_module, "OnlineModelTrainer", _Trainer)
    # The 14:30 attempt that waits for its retry, as the ledger stood on 10-28.
    job._write(tmp_path / "training" / "schedule.json", {
        "schema": job.SCHEDULE_SCHEMA, "trading_date": "2026-10-28", "attempts": 1, "state": "WAITING",
        "next_due_at": "2026-10-28T07:00:03+00:00", "last_result": {"state": "FAILED"}})
    return tmp_path


def _settle(root: Path, day: str) -> None:
    publish_settled_session(source="shioaji", market="STK", trading_date=day, session="DAY", status="materialized",
                            settled_at=f"{day}T14:42:00+08:00", jobs_root=root / "jobs")


def _today(clock: str, ready: bool):
    now = datetime.fromisoformat(f"2026-10-28T{clock}:00").replace(tzinfo=ZoneInfo("Asia/Taipei"))
    return training_today(now, schedule=job.read_schedule(), window_days=20, state=job.read_state(), job=None, window=(list(DAYS), []),
                          running=False, available=list(DAYS), materialized=(ready, "materialized" if ready else "not yet"),
                          is_trading=lambda day: True, data_of=lambda day: {"date": day, "instruments": 1, "events": 1, "bytes": 1})


def test_a_manual_run_over_today_s_close_trains_today_and_closes_its_auto_schedule(domain):
    _settle(domain, "2026-10-28")
    result = job.Job(mode="manual", job_id="manual-1", exporter=_Exporter(), hist_root=domain).run()
    assert result["state"] == "SUCCEEDED"
    assert job.read_state()["last_trained_trading_date"] == "2026-10-28"
    schedule = job.read_schedule()
    assert schedule["trading_date"] == "2026-10-28" and schedule["state"] == "DONE" and schedule["next_due_at"] is None
    assert "manual-1" in schedule["last_result"]["reason"]
    assert _today("21:52", ready=True)["phase"] == "TRAINED"


def test_a_manual_run_without_a_materialized_today_leaves_today_and_its_schedule(domain):
    _settle(domain, "2026-10-27")     # today not published materialized yet: the run did not train today's close
    job.Job(mode="manual", job_id="manual-2", exporter=_Exporter(), hist_root=domain).run()
    assert job.read_state()["last_trained_trading_date"] == "2026-10-27"
    assert job.read_schedule()["state"] == "WAITING", "today's auto attempt still stands"
    out = _today("21:52", ready=False)
    assert out["phase"] == "WAITING_SEAL", "no retry countdown for a day Health will not retry until it is materialized"
    assert out["next_run_at"] is None
    assert _today("21:52", ready=True)["phase"] == "RETRY_WAIT"
