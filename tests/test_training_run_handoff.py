"""A manual training request hands over to its job without a gap: the job writes its own RUNNING status before it
loads the training modules, and only then removes the request, so the model center sees the request (queued) or the
new job (running) -- never the previous job's status with nothing queued."""
from __future__ import annotations

import json
import os
from pathlib import Path

from api import training_application
from service.analysis.online_training import job as training_job
from service.platform.process_observer import process_created_epoch_ns


def test_the_job_publishes_its_status_before_running_and_then_takes_the_request(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(training_job, "training_root", lambda: tmp_path)
    (tmp_path / "status.json").write_text(json.dumps({"job_id": "previous", "state": "RUNNING", "finished_at": None,
                                                      "pid": 1, "pid_created_ns": 1}), encoding="utf-8")
    request = tmp_path / "requests" / "manual-1.json"
    request.parent.mkdir()
    request.write_text("{}", encoding="utf-8")
    seen = {}

    def run(self):
        # What a reader sees while the job loads its modules and works.
        seen["status"] = json.loads((tmp_path / "status.json").read_text(encoding="utf-8"))
        seen["request"] = request.exists()
        seen["view"] = training_application.job_view()
        return self._finish("SUCCEEDED")

    monkeypatch.setattr(training_job.Job, "run", run)
    assert training_job.main(["--mode", "manual", "--job-id", "manual-1", "--security-master", "master.csv", "--request-file", str(request)]) == 0
    assert seen["status"]["job_id"] == "manual-1"
    assert seen["status"]["state"] == "RUNNING"
    assert seen["status"]["pid"] == os.getpid()
    assert seen["status"]["pid_created_ns"] == process_created_epoch_ns(os.getpid())
    assert seen["request"] is False
    assert seen["view"]["running"] is True and seen["view"]["job"]["job_id"] == "manual-1"


def test_an_auto_job_is_on_disk_before_it_runs(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(training_job, "training_root", lambda: tmp_path)
    monkeypatch.setattr(training_job, "begin_auto_attempt", lambda day: {})
    monkeypatch.setattr(training_job, "end_auto_attempt", lambda day, result: {})
    seen = {}

    def run(self):
        seen["status"] = json.loads((tmp_path / "status.json").read_text(encoding="utf-8"))
        return self._finish("SUCCEEDED")

    monkeypatch.setattr(training_job.Job, "run", run)
    assert training_job.main(["--mode", "auto", "--job-id", "auto-1", "--security-master", "master.csv", "--trading-date", "2026-10-28"]) == 0
    assert seen["status"]["job_id"] == "auto-1" and seen["status"]["state"] == "RUNNING"


def test_a_gated_job_does_nothing_until_health_says_start(monkeypatch, tmp_path: Path, capsys):
    # Health records the job's process (pid + creation time) before it sends "start"; a Health that dies first closes
    # stdin, and the job must end without writing a status or taking its request.
    import io

    monkeypatch.setattr(training_job, "training_root", lambda: tmp_path)
    request = tmp_path / "requests" / "manual-1.json"
    request.parent.mkdir()
    request.write_text("{}", encoding="utf-8")
    ran = []
    monkeypatch.setattr(training_job.Job, "run", lambda self: ran.append(self.job_id) or self._finish("SUCCEEDED"))
    args = ["--mode", "manual", "--job-id", "manual-1", "--security-master", "m.csv", "--request-file", str(request),
            "--start-gate", "stdin"]
    monkeypatch.setattr("sys.stdin", io.StringIO(""))
    assert training_job.main(args) == 0
    assert json.loads(capsys.readouterr().out.strip().splitlines()[-1])["state"] == "NOT_STARTED"
    assert not ran and not (tmp_path / "status.json").exists() and request.exists()
    monkeypatch.setattr("sys.stdin", io.StringIO("start\n"))
    assert training_job.main(args) == 0
    assert ran == ["manual-1"] and not request.exists()
