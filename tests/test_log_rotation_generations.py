"""Each process of a run has its own error log (error-<source>.log; Electron main's error-electron.log) and each
provider its own dataflow log (dataflow-<component>.log): one writer appends to and rotates a file, so no process's
rotation moves a file another is appending to and each file's size bound is its writer's own. Rotation renames to a
unique generation and never deletes or replaces the file it renames, so rotations by a process's threads lose no
line; only generations beyond the kept number are removed. The error mirror's rotation size is the configured one at
every append, and a last error line without a newline still reaches the error log at exit."""
from __future__ import annotations

import io
import threading

import pytest

from service.platform.atomic_files import ROTATED_GENERATIONS, append_line, rotate_if_larger
from service.platform.error_logging import (
    ErrorOnlyMirror, append_runtime_error, error_log_name, mirror_process_output, rotate_bytes_from_env, runtime_error_path)


def _generations(path):
    return sorted(p for p in path.parent.glob(f"{path.name}.*"))


def test_concurrent_rotations_keep_every_line(tmp_path):
    path = tmp_path / "error.log"
    writers, per_writer = 6, 300
    barrier = threading.Barrier(writers)

    def write(n):
        barrier.wait()
        for i in range(per_writer):
            rotate_if_larger(path, 2_000, keep=10_000)
            append_line(path, f"w{n}-{i}")

    threads = [threading.Thread(target=write, args=(n,)) for n in range(writers)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    lines = []
    for file in [*_generations(path), path]:
        lines += file.read_text(encoding="utf-8").splitlines()
    assert sorted(lines) == sorted(f"w{n}-{i}" for n in range(writers) for i in range(per_writer))
    assert len(_generations(path)) > 1


def test_each_process_writes_its_own_error_log(tmp_path):
    # The Shioaji and Futu providers and Electron main appended to one error.log, each rotating it at its own size
    # (16 MiB / 8 MiB): whether it rotated depended on who wrote next, and one's rotation moved the file another had
    # just created. Each process now writes and rotates its own file.
    shioaji = mirror_process_output(io.StringIO(), source="SHIOAJI_DAEMON", output_root=tmp_path)
    futu = mirror_process_output(io.StringIO(), source="FUTU_DAEMON", output_root=tmp_path)
    shioaji.write("2026-11-03 10:00:00,000 ERROR a: shioaji failed\n")
    futu.write("2026-11-03 10:00:00,000 ERROR b: futu failed\n")
    assert runtime_error_path("SHIOAJI_DAEMON", tmp_path).name == "error-shioaji_daemon.log"
    files = {p.name: p.read_text(encoding="utf-8") for p in tmp_path.glob("error*.log")}
    assert sorted(files) == ["error-futu_daemon.log", "error-shioaji_daemon.log"]
    assert "shioaji failed" in files["error-shioaji_daemon.log"] and "futu" not in files["error-shioaji_daemon.log"]
    assert "futu failed" in files["error-futu_daemon.log"]
    with pytest.raises(ValueError):
        error_log_name("  ")


def test_each_provider_writes_its_own_dataflow_log(tmp_path, monkeypatch):
    from service.platform import dataflow_log

    monkeypatch.setattr(dataflow_log, "log_session_path", lambda name: tmp_path / name)
    dataflow_log.write_dataflow_row({"component": "market_daemon", "events": {"a": 1}})
    dataflow_log.write_dataflow_row({"component": "futu_daemon", "events": {"b": 2}})
    assert sorted(p.name for p in tmp_path.iterdir()) == ["dataflow-futu_daemon.log", "dataflow-market_daemon.log"]


def test_only_the_newest_generations_are_kept(tmp_path):
    path = tmp_path / "dataflow.log"
    for n in range(ROTATED_GENERATIONS + 3):
        path.write_text(f"{n}\n" * 100, encoding="utf-8")
        rotate_if_larger(path, 10)
    kept = _generations(path)
    assert len(kept) == ROTATED_GENERATIONS
    assert [p.read_text(encoding="utf-8").split()[0] for p in kept] == [str(n) for n in range(3, ROTATED_GENERATIONS + 3)]


def test_rotations_in_one_millisecond_keep_their_order(tmp_path, monkeypatch):
    # The name was only millisecond-precise and then random: rotations in the same millisecond sorted at random, so
    # pruning could remove the newest generation and keep an older one.
    from service.platform import atomic_files

    monkeypatch.setattr(atomic_files.time, "time", lambda: 1_762_700_000.123)
    path = tmp_path / "dataflow.log"
    for n in range(20):
        path.write_text(f"{n}\n" * 100, encoding="utf-8")
        rotate_if_larger(path, 10)
    assert [p.read_text(encoding="utf-8").split()[0] for p in _generations(path)] == ["17", "18", "19"]


def test_the_configured_rotation_size_applies_at_every_append(tmp_path):
    path = tmp_path / "error.log"
    mirror = ErrorOnlyMirror(io.StringIO(), error_path=path, source="T", rotate_bytes=200)
    for i in range(40):
        mirror.write(f"2026-10-21 10:00:00,000 ERROR x: failure {i}\n")
    assert _generations(path), "rotated at the configured 200 bytes, not at the 16 MiB default"
    append_runtime_error(path, "T", "x" * 10, rotate_bytes=10)
    assert path.read_text(encoding="utf-8").count("\n") == 1


@pytest.mark.parametrize("raw,expected", [("", 16 * 1024 * 1024), ("2097152", 2097152)])
def test_rotation_size_from_env(raw, expected):
    assert rotate_bytes_from_env({"STOCK_MONITOR_ERROR_LOG_ROTATE_BYTES": raw}) == expected


@pytest.mark.parametrize("raw", ["16MB", "1000"])
def test_a_bad_rotation_size_is_refused_not_defaulted(raw):
    with pytest.raises(ValueError, match="STOCK_MONITOR_ERROR_LOG_ROTATE_BYTES"):
        rotate_bytes_from_env({"STOCK_MONITOR_ERROR_LOG_ROTATE_BYTES": raw})


def test_a_last_error_line_without_newline_is_kept_at_finalize(tmp_path):
    path = tmp_path / "error.log"
    mirror = ErrorOnlyMirror(io.StringIO(), error_path=path, source="T")
    mirror.write("2026-10-21 10:00:00,000 ERROR x: fatal at exit")
    mirror.flush()
    assert not path.exists(), "a flush mid-line does not decide the line"
    mirror.finalize()
    mirror.finalize()
    assert path.read_text(encoding="utf-8").count("fatal at exit") == 1
