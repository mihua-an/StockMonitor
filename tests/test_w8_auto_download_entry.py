"""The automatic K-bar download keeps an entry point only -- the user decided not to build it
yet. The daily maintenance calls the hook and reports it; the hook creates no job and calls no broker API."""
from __future__ import annotations

from datetime import date, datetime

from service.market.shioaji.history_download import KBarDownloadManager

from tests.support.kbar_download_fakes import FakeAPI, FakeRepository, store_import


def test_the_entry_point_exists_and_creates_nothing(tmp_path):
    api = FakeAPI([{"bytes": 0, "limit_bytes": 100000, "remaining_bytes": 100000}])
    repo = FakeRepository(tmp_path, api)
    manager = KBarDownloadManager(lambda: api, repo, db_path=tmp_path / "runtime.db", kbar_root=lambda: tmp_path / "kbars", import_runner=store_import)
    report = manager.plan_auto_downloads(today=date(2026, 10, 6))
    assert report == {"ok": True, "enabled": False, "reason": "NOT_IMPLEMENTED", "date": "2026-10-06", "jobs_created": 0}
    assert manager.list_jobs() == [] and repo.calls == [] and api.usage_calls == 0


def test_the_daily_maintenance_reports_the_hook():
    from service.market.shioaji.service import ShioajiMarketService

    class Manager:
        def maintain(self, *, today):
            return {"ok": True}

        def resume_auto_jobs(self):
            return []

        def plan_auto_downloads(self, *, today):
            return {"enabled": False, "date": today.isoformat()}

    service = ShioajiMarketService.__new__(ShioajiMarketService)
    service.kbar_download_manager = Manager()
    report = ShioajiMarketService._run_shioaji_maintenance(service, datetime(2026, 10, 6, 14, 45), [])
    assert report["kbar_maintenance"]["auto_download"] == {"enabled": False, "date": "2026-10-06"}


def test_recovery_after_restart_names_every_job_and_segment(tmp_path, monkeypatch):
    """One event per segment with its identity and old/new state, and one per job whose state changed -- never a
    job-wide segment list, which the event detail sanitizer cut to 16 items of 128 characters."""
    import sqlite3

    from service.market.shioaji import history_download

    api = FakeAPI([{"bytes": 0, "limit_bytes": 100000, "remaining_bytes": 100000}])
    repo = FakeRepository(tmp_path, api)
    KBarDownloadManager(lambda: api, repo, db_path=tmp_path / "runtime.db", kbar_root=lambda: tmp_path / "kbars", import_runner=store_import)
    with sqlite3.connect(tmp_path / "runtime.db") as conn:
        for job in ("j1", "j2"):
            conn.execute("INSERT INTO kbar_download_jobs(job_id,code,start_date,end_date,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                         (job, "2330", "2026-10-01", "2026-10-02", "PARTIAL", "t", "t"))
        for seg, job, start in (("s1", "j1", "2026-10-01"), ("s2", "j1", "2026-10-02"), ("s3", "j2", "2026-10-01")):
            conn.execute("INSERT INTO kbar_download_segments(segment_id,job_id,code,start_date,end_date,state) VALUES(?,?,?,?,?,?)",
                         (seg, job, "2330", start, start, "DOWNLOADING"))
    events = []
    monkeypatch.setattr(history_download, "_record_kbar_recovery", lambda trigger, detail: events.append((trigger, detail)))
    KBarDownloadManager(lambda: api, repo, db_path=tmp_path / "runtime.db", kbar_root=lambda: tmp_path / "kbars", import_runner=store_import)
    segments = [d for _, d in events if "segment_id" in d]
    assert [(d["job_id"], d["segment_id"]) for d in segments] == [("j1", "s1"), ("j1", "s2"), ("j2", "s3")]
    assert all(d["old_state"] == "DOWNLOADING" and d["new_state"] == "PENDING" for d in segments)
    jobs = [d for _, d in events if "segment_id" not in d]
    assert [(d["job_id"], d["segments_recovered"], d["job_new_state"]) for d in jobs] == [("j1", 2, "READY"), ("j2", 1, "READY")]
    assert all(t == "inflight_at_restart" for t, _ in events)


def test_a_detail_list_longer_than_the_sanitizer_keeps_says_how_long_it_was():
    from service.platform.remediation import sanitize_detail

    out = sanitize_detail({"codes": [str(i) for i in range(40)], "few": [1, 2]})
    assert len(out["codes"]) == 16 and out["codes_total"] == 40
    assert out["few"] == [1, 2] and "few_total" not in out
