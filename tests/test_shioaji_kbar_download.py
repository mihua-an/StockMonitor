from __future__ import annotations

import json

from datetime import datetime, timezone

import pandas as pd

from service.market.shioaji.history_download import KBarDownloadManager
from tests.support.kbar_download_fakes import FakeAPI, FakeRepository, store_import


def seed_sample(manager, observed=1000, days=1):
    with manager.jobs.connect() as conn:
        conn.execute(
            "INSERT INTO kbar_usage_samples(observed_at,used_bytes,limit_bytes,remaining_bytes,observed_bytes,row_count,day_count,model_version) VALUES(?,?,?,?,?,?,?,?)",
            (datetime.now(timezone.utc).isoformat(), 0, 100000, 100000, observed, 2, days, "test"),
        )


def test_budget_reservation_blocks_without_call(tmp_path):
    api = FakeAPI([{"bytes": 99950, "limit_bytes": 100000, "remaining_bytes": 50}])
    repo = FakeRepository(tmp_path, api)
    manager = KBarDownloadManager(lambda: api, repo, db_path=tmp_path / "runtime.db", kbar_root=lambda: tmp_path / "kbars", import_runner=store_import)
    seed_sample(manager, observed=1000)
    job = manager.create_job("2330", "2026-09-01", "2026-09-01", user_budget_bytes=100, safety_reserve_bytes=0)
    result = manager.run_next(job["job_id"])
    assert result["state"] == "WAITING_BUDGET"
    assert repo.calls == []


def test_success_aggregates_daily_and_persists_minutes(tmp_path):
    api = FakeAPI([
        {"bytes": 0, "limit_bytes": 100000, "remaining_bytes": 100000},
        {"bytes": 1000, "limit_bytes": 100000, "remaining_bytes": 99000},
    ])
    repo = FakeRepository(tmp_path, api)
    manager = KBarDownloadManager(lambda: api, repo, db_path=tmp_path / "runtime.db", kbar_root=lambda: tmp_path / "kbars", import_runner=store_import)
    seed_sample(manager)
    job = manager.create_job("2330", "2026-09-01", "2026-09-01")
    result = manager.run_next(job["job_id"])
    assert result["state"] == "COMPLETED"
    assert len(repo.calls) == 1
    session = json.loads((tmp_path / "kbars" / "source=shioaji" / "market=STK" / "2330.json").read_bytes())["sessions"]["DAY"]
    assert session["daily"] == {}, "the daily bar is folded by Rust B from the minutes, not sent"
    assert session["intraday"]["2026-09-01"]["bars"][0][0] == 539


def test_unknown_usage_and_no_samples_are_conservative(tmp_path):
    api = FakeAPI([RuntimeError("usage unavailable")])
    repo = FakeRepository(tmp_path, api)
    manager = KBarDownloadManager(lambda: api, repo, db_path=tmp_path / "runtime.db", kbar_root=lambda: tmp_path / "kbars", import_runner=store_import)
    preview = manager.preview("2330", "2026-09-01", "2026-09-01")
    assert preview["estimate_confidence"] == "NONE"
    assert preview["can_execute"] is False
    assert repo.calls == []


def test_date_windows_never_exceed_shioaji_limit(tmp_path):
    api = FakeAPI([{"bytes": 0, "limit_bytes": 100000, "remaining_bytes": 100000}])
    repo = FakeRepository(tmp_path, api)
    manager = KBarDownloadManager(lambda: api, repo, db_path=tmp_path / "runtime.db", kbar_root=lambda: tmp_path / "kbars", import_runner=store_import)
    plan = manager.preview("2330", "2026-01-01", "2026-03-31", refresh_usage=True)
    assert all((pd.Timestamp(s["end_date"]) - pd.Timestamp(s["start_date"])).days < 30 for s in plan["segments"])


def test_usage_is_sampled_in_the_background_and_cached_reads_never_call_the_broker(tmp_path):
    # 連線診斷 polls the quota every 2 s: those reads are served from kbar_usage_samples only.
    api = FakeAPI([{"bytes": 1200, "limit_bytes": 500000, "remaining_bytes": 498800}])
    repo = FakeRepository(tmp_path, api)
    clock = {"now": datetime(2026, 10, 3, 1, 0, tzinfo=timezone.utc)}
    manager = KBarDownloadManager(lambda: api, repo, db_path=tmp_path / "runtime.db", kbar_root=lambda: tmp_path / "kbars", import_runner=store_import,
                                  clock=lambda: clock["now"])
    assert manager.sample_usage_if_due(background=False) is True
    assert api.usage_calls == 1
    assert manager.sample_usage_if_due(background=False) is False, "a sample younger than 10 min is enough"
    clock["now"] = datetime(2026, 10, 3, 1, 5, tzinfo=timezone.utc)
    for _ in range(5):
        cached = manager.refresh_usage()
        assert cached["known"] and cached["used_bytes"] == 1200 and cached["cached"]
    assert cached["expired"] is True, "past the 120 s TTL it is still today's figure, flagged"
    assert api.usage_calls == 1, "cached reads never reach the broker"
    clock["now"] = datetime(2026, 10, 3, 1, 11, tzinfo=timezone.utc)
    assert manager.sample_usage_if_due(background=False) is True and api.usage_calls == 2
    # A new Taipei day: yesterday's figure is not today's quota.
    clock["now"] = datetime(2026, 10, 3, 16, 5, tzinfo=timezone.utc)
    assert manager.usage._same_day(manager.usage.latest()["observed_at"]) is False


def test_usage_is_not_sampled_while_logged_out_and_failures_back_off(tmp_path):
    api = FakeAPI([RuntimeError("usage unavailable")])
    repo = FakeRepository(tmp_path, api)
    logged_in = {"api": None}
    manager = KBarDownloadManager(lambda: logged_in["api"], repo, db_path=tmp_path / "runtime.db", kbar_root=lambda: tmp_path / "kbars", import_runner=store_import)
    assert manager.sample_usage_if_due(background=False) is False, "logged out: never asks"
    logged_in["api"] = api
    assert manager.sample_usage_if_due(background=False) is True and api.usage_calls == 1
    assert manager.refresh_usage()["known"] is False
    assert manager.sample_usage_if_due(background=False) is False
    assert api.usage_calls == 1, "a failed usage() is not retried by the 2 s readers or the sampler within the backoff"


def _ready_manager(tmp_path):
    api = FakeAPI([{"bytes": 0, "limit_bytes": 100000, "remaining_bytes": 100000}])
    repo = FakeRepository(tmp_path, api)
    manager = KBarDownloadManager(lambda: api, repo, db_path=tmp_path / "runtime.db", kbar_root=lambda: tmp_path / "kbars", import_runner=store_import)
    seed_sample(manager)
    return manager, repo, manager.create_job("2330", "2026-09-01", "2026-09-01")


def test_q29_a_segment_someone_else_claimed_is_not_downloaded_again(tmp_path):
    # The reserving UPDATE never checked its row count, so two callers that both read the segment as
    # PENDING both answered RESERVED and both downloaded it.
    manager, repo, job = _ready_manager(tmp_path)
    segment = manager.job(job["job_id"])["segments"][0]
    with manager.jobs.connect() as conn:  # another runner claims it between our read and our write
        conn.execute("UPDATE kbar_download_segments SET state='DOWNLOADING' WHERE segment_id=?", (segment["segment_id"],))
    assert manager._reserve(manager.job(job["job_id"]), segment) == (False, "SEGMENT_TAKEN")
    stale = dict(manager.job(job["job_id"]), segments=[dict(segment, state="PENDING")])
    manager.job = lambda job_id, _real=manager.job: stale if job_id == job["job_id"] else _real(job_id)
    result = manager.run_next(job["job_id"])
    assert result["skipped"] == "SEGMENT_TAKEN" and repo.calls == [], "nothing downloaded, job state untouched"


def test_q29_one_runner_per_job(tmp_path):
    manager, repo, job = _ready_manager(tmp_path)
    manager._running_jobs.add(job["job_id"])  # another caller is draining it
    assert manager.run_job(job["job_id"])["busy"] is True and repo.calls == []
    manager._running_jobs.clear()
    assert manager.run_job(job["job_id"])["state"] == "COMPLETED" and len(repo.calls) == 1
    assert manager._running_jobs == set(), "released when the run ends"


def test_shutdown_waits_for_a_job_runner_and_reports_one_still_running(tmp_path):
    """Shutdown waited only for the usage sampler; a job runner could still call the broker after logout."""
    import threading

    api = FakeAPI([{"bytes": 0, "limit_bytes": 100000, "remaining_bytes": 100000}])
    repo = FakeRepository(tmp_path, api)
    manager = KBarDownloadManager(lambda: api, repo, db_path=tmp_path / "runtime.db", kbar_root=lambda: tmp_path / "kbars", import_runner=store_import)
    with manager._lock:
        manager._running_jobs.add("job-1")
    held = manager.shutdown(timeout=0.05)
    assert held["ok"] is False and held["jobs_running"] == ["job-1"]

    def finish():
        with manager._lock:
            manager._running_jobs.discard("job-1")
            manager._jobs_idle.notify_all()

    threading.Timer(0.1, finish).start()
    assert manager.shutdown(timeout=5.0) == {"ok": True, "usage_sample_running": False, "jobs_running": []}


def test_an_unreadable_quota_waits_as_waiting_usage_not_as_an_insufficient_budget(tmp_path):
    api = FakeAPI([RuntimeError("usage API unavailable")])
    repo = FakeRepository(tmp_path, api)
    manager = KBarDownloadManager(lambda: api, repo, db_path=tmp_path / "runtime.db", kbar_root=lambda: tmp_path / "kbars", import_runner=store_import)
    seed_sample(manager, observed=1000)
    job = manager.create_job("2330", "2026-09-01", "2026-09-01", safety_reserve_bytes=0)
    result = manager.run_next(job["job_id"])
    assert result["state"] == "WAITING_USAGE" and repo.calls == []


def test_every_reservation_outcome_has_its_own_wait_state():
    import pytest

    assert KBarDownloadManager._wait_state("WAITING_ESTIMATE") == "WAITING_ESTIMATE"
    assert KBarDownloadManager._wait_state("WAITING_USAGE") == "WAITING_USAGE"
    assert KBarDownloadManager._wait_state("BUDGET_INSUFFICIENT: available=0 estimate=10") == "WAITING_BUDGET"
    with pytest.raises(ValueError):
        KBarDownloadManager._wait_state("SOMETHING_NEW")
