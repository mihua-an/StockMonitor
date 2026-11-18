"""One way to run a one-shot B job (native_binaries.run_job): UTF-8 both ways, a time limit, the answer on the last
stdout line, and an error that carries the job's stderr. history_fill, history_download and historical_store use it."""
from __future__ import annotations

import logging
import sys
import textwrap
from pathlib import Path

import pytest

from service.market.history import history_fill
from service.market.history.historical_store import HistoricalStore
from service.market.shioaji import history_download
from service.platform import native_binaries
from service.platform.native_binaries import NativeJobError, run_job

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="the stand-in job is a Windows batch file")


def fake_job(tmp_path: Path, body: str) -> Path:
    """A stand-in for analysis_runtime: a batch file running `body` as Python (UTF-8 stdout, like B's)."""
    script = tmp_path / "fake_job.py"
    script.write_text(textwrap.dedent(body), encoding="utf-8")
    batch = tmp_path / "fake_job.bat"
    batch.write_text(f'@"{sys.executable}" -X utf8 "{script}" %*\r\n', encoding="ascii")
    return batch


def test_the_answer_is_the_last_stdout_line_read_as_utf8(tmp_path):
    job = fake_job(tmp_path, """
        import json, sys
        print("a progress line")
        print(json.dumps({"ok": True, "name": "台積電", "mode": sys.argv[1]}, ensure_ascii=False))
    """)
    assert run_job(["--gap-report"], 30, binary=job) == {"ok": True, "name": "台積電", "mode": "--gap-report"}


def test_a_failure_answer_is_returned_and_a_missing_one_raises_with_stderr(tmp_path):
    failed = fake_job(tmp_path, """
        import json, sys
        print(json.dumps({"ok": False, "error": "bad input"}))
        sys.exit(1)
    """)
    assert run_job(["--import-kbars"], 30, binary=failed) == {"ok": False, "error": "bad input"}
    silent = fake_job(tmp_path, """
        import sys
        sys.stderr.write("panicked at kbar_store.rs")
        sys.exit(101)
    """)
    with pytest.raises(NativeJobError, match="exited 101 without a result: panicked at kbar_store.rs"):
        run_job(["--import-kbars"], 30, binary=silent)


def test_a_success_line_with_a_failing_exit_is_not_an_answer(tmp_path):
    job = fake_job(tmp_path, """
        import json, sys
        print(json.dumps({"ok": True}))
        sys.exit(3)
    """)
    with pytest.raises(NativeJobError, match="exited 3"):
        run_job(["--verify-partitions"], 30, binary=job)


def test_the_gap_report_is_bounded_in_time(tmp_path, monkeypatch):
    job = fake_job(tmp_path, """
        import json, time
        time.sleep(4)
        print(json.dumps({"ok": True, "codes": []}))
    """)
    monkeypatch.setattr(history_fill, "GAP_REPORT_TIMEOUT_SECONDS", 1, raising=False)
    with pytest.raises(NativeJobError, match="ran past"):
        history_fill.gap_report(job, tmp_path, "STK", "2026-11-13", "DAY")


def test_the_kbar_import_reads_its_answer_as_utf8(tmp_path, monkeypatch):
    job = fake_job(tmp_path, """
        import json
        print(json.dumps({"ok": True, "imported": 1, "note": "日K 已存"}, ensure_ascii=False))
    """)
    monkeypatch.setattr(native_binaries, "analysis_runtime_job_binary", lambda: job)
    answer = history_download.import_into_kbar_store(tmp_path / "kbars", {"code": "2330", "days": []})
    assert answer == {"ok": True, "imported": 1, "note": "日K 已存"}


def test_partition_verification_records_a_job_that_gave_no_answer(tmp_path, caplog):
    job = fake_job(tmp_path, """
        import sys
        sys.stderr.write("cannot open dir")
        sys.exit(2)
    """)
    store = HistoricalStore(tmp_path / "store", verifier=job)
    with caplog.at_level(logging.WARNING):
        assert store._verify([str(tmp_path)]) == {}
    assert any("cannot open dir" in record.getMessage() or "cannot open dir" in str(record.exc_info)
               for record in caplog.records)
