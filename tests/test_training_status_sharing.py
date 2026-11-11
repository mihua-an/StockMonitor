"""The training job rewrites status.json on every progress line while model_api and Health read it.

10-28 23:37 a manual run died in features 2026-10-20: `os.replace` of status.json hit WinError 5 because model_api had
it open (Python's open() has no delete sharing), and the FAILED status could not be written either, so the screen
showed the run as interrupted. The job now writes through `atomic_files.write_bytes_atomic` and reads through
`read_text_shared`.
"""
from __future__ import annotations

import os
import threading

import pytest

from service.analysis.online_training import job
from service.platform import atomic_files

windows_only = pytest.mark.skipif(os.name != "nt", reason="the sharing violation is Windows behaviour")


@windows_only
def test_status_is_replaced_while_a_reader_holds_it_open(tmp_path):
    # A reader that opened with delete sharing (Node's fs, read_text_shared) must not block the job's rewrite.
    path = tmp_path / "status.json"
    job._write(path, {"state": "RUNNING", "n": 0})
    kernel32, handle = atomic_files._open_handle(path, 0x80000000)   # GENERIC_READ, share all
    try:
        job._write(path, {"state": "RUNNING", "n": 1})
    finally:
        kernel32.CloseHandle(handle)
    assert job._read(path) == {"state": "RUNNING", "n": 1}


@windows_only
def test_reads_and_rewrites_of_status_never_collide(tmp_path):
    path = tmp_path / "status.json"
    job._write(path, {"n": 0})
    errors: list[BaseException] = []
    stop = threading.Event()

    def reader():
        while not stop.is_set():
            try:
                job._read(path)
                job._read_authoritative(path)
            except BaseException as exc:   # the failure is what the test reports
                errors.append(exc)
                return

    thread = threading.Thread(target=reader)
    thread.start()
    try:
        for n in range(300):
            job._write(path, {"n": n, "pad": "x" * 2000})
    finally:
        stop.set()
        thread.join()
    assert errors == []
    assert job._read(path)["n"] == 299


def test_a_missing_file_is_still_nothing_recorded(tmp_path):
    assert job._read(tmp_path / "absent.json") == {}
    assert job._read_authoritative(tmp_path / "absent.json") == {}
