"""RuntimeProcess must not leave a daemon behind when startup fails (``__exit__`` never runs then)."""
from __future__ import annotations

import sys

import pytest

import tests.synthetic_runtime as rt


class _Stub(rt.RuntimeProcess):
    def __init__(self, data_dir, script: str, ready_timeout: float) -> None:
        super().__init__(data_dir)
        self.script = script
        self.ready_timeout = ready_timeout

    def command(self) -> list[str]:
        return [sys.executable, "-c", self.script]


def test_daemon_that_never_listens_is_stopped_and_the_error_carries_its_stderr(tmp_path):
    stub = _Stub(tmp_path / "rt", "import sys, time; sys.stderr.write('booting forever'); sys.stderr.flush(); time.sleep(60)", 1.0)
    with pytest.raises(RuntimeError, match="did not listen.*booting forever"):
        stub.__enter__()
    assert stub.proc.poll() is not None


def test_daemon_that_exits_early_is_reported_with_its_exit_code_and_stderr(tmp_path):
    stub = _Stub(tmp_path / "rt", "import sys; sys.stderr.write('bad credentials'); sys.exit(3)", 10.0)
    with pytest.raises(RuntimeError, match="exited with 3.*bad credentials"):
        stub.__enter__()
