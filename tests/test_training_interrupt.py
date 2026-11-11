"""A training job ended by force mid-run: its children end with it, its RUNNING status reads as interrupted, and the
staging it left is removed by the next run."""
from __future__ import annotations

import os
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

from api import training_application
from service.analysis.online_training import job as training_job
from service.analysis.online_training.dataset import OnlineDatasetBuilder
from service.platform.process_observer import process_created_epoch_ns, process_exists


def _dead_pid() -> int:
    """A pid no process has now. Staging names carry only the pid, and Windows reuses a pid soon, so one whose number
    another process already took is skipped."""
    while True:
        proc = subprocess.Popen([sys.executable, "-c", "pass"])
        proc.wait()
        if not process_exists(proc.pid):
            return proc.pid


def _ended_process() -> tuple[int, int | None]:
    """The pid and creation time of a process that has ended, as a job's status records them. Windows reuses a pid
    soon, so the pid alone may already name another process by the time it is checked."""
    proc = subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.read()"], stdin=subprocess.PIPE)
    created = process_created_epoch_ns(proc.pid)
    proc.stdin.close()
    proc.wait()
    return proc.pid, created


def _view(monkeypatch, status):
    monkeypatch.setattr(training_job, "read_status", lambda: status)
    monkeypatch.setattr(training_application, "pending_request", lambda: None)
    return training_application.job_view()


def test_a_running_status_whose_process_ended_reads_as_interrupted(monkeypatch):
    pid, created = _ended_process()
    view = _view(monkeypatch, {"state": "RUNNING", "finished_at": None, "pid": pid, "pid_created_ns": created,
                               "updated_at": "2099-01-01T00:00:00+00:00"})
    assert view["running"] is False
    assert view["job"]["state"] == "INTERRUPTED"


def test_a_running_status_of_a_live_process_stays_running(monkeypatch):
    view = _view(monkeypatch, {"state": "RUNNING", "finished_at": None, "pid": os.getpid(),
                               "pid_created_ns": process_created_epoch_ns(os.getpid()),
                               "updated_at": "2000-01-01T00:00:00+00:00"})
    assert view["running"] is True


@pytest.mark.skipif(os.name != "nt", reason="creation time is read on Windows")
def test_a_reused_pid_with_another_creation_time_reads_as_interrupted(monkeypatch):
    view = _view(monkeypatch, {"state": "RUNNING", "finished_at": None, "pid": os.getpid(), "pid_created_ns": 1})
    assert view["job"]["state"] == "INTERRUPTED"


def test_the_next_run_removes_the_staging_of_an_ended_job_and_keeps_a_live_one(tmp_path: Path):
    dead, live = _dead_pid(), os.getpid()
    out = tmp_path / "online_datasets"
    (out / "shards" / "2026-10-27" / f"abc.tmp-{dead}").mkdir(parents=True)
    (out / "shards" / "2026-10-27" / f"abc.tmp-{dead}" / "samples.jsonl").write_text("x")
    (out / f"ods-1.tmp-{dead}").mkdir()
    (out / f".samples-{dead}-1234abcd.parquet.tmp").write_bytes(b"x")
    keep = [out / "shards" / "2026-10-27" / f"def.tmp-{live}", out / f".samples-{live}-5678abcd.parquet.tmp"]
    keep[0].mkdir()
    keep[1].write_bytes(b"x")
    removed = OnlineDatasetBuilder(tmp_path, out, exporter=object()).discard_dead_staging()
    assert len(removed) == 3
    assert [p.name for p in out.rglob(f"*{dead}*")] == []
    assert all(p.exists() for p in keep)


@pytest.mark.skipif(os.name != "nt", reason="job objects are Windows")
def test_a_child_of_a_bound_process_ends_when_that_process_is_killed(tmp_path: Path):
    pid_file = tmp_path / "child.pid"
    parent = subprocess.Popen([sys.executable, "-c", textwrap.dedent(f"""
        import subprocess, sys, time
        from service.platform.child_lifetime import bind_children_to_this_process
        bind_children_to_this_process()
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
        open(r"{pid_file}", "w").write(str(child.pid))
        time.sleep(120)
    """)], cwd=Path(__file__).resolve().parents[1])
    deadline = time.monotonic() + 30
    while not (pid_file.exists() and pid_file.read_text()) and time.monotonic() < deadline:
        time.sleep(0.1)
    child_pid = int(pid_file.read_text())
    assert process_exists(child_pid)
    parent.kill()   # TerminateProcess: no cleanup runs in the parent
    parent.wait()
    deadline = time.monotonic() + 10
    while process_exists(child_pid) and time.monotonic() < deadline:
        time.sleep(0.1)
    assert not process_exists(child_pid)
