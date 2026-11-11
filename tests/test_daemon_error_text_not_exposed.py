"""Daemon status/route errors carry a fixed message + error_id; the exception text goes to the log only (04 §5)."""
import logging
import re

import pytest

from backend.futu.runtime import FutuRuntime
from service.platform.http.errors import logged_error

SECRET = r"C:\Users\someone\secret\path.db: SELECT * FROM raw_trades"
ERROR_ID = re.compile(r"error_id=([0-9a-f]{12})")


class _Boom:
    def start(self):
        raise RuntimeError(SECRET)

    def stop(self, timeout=None):
        raise RuntimeError(SECRET)

    def status(self):
        return {"provider": "futu", "connected": False}


def test_logged_error_hides_text_and_logs_it(caplog):
    with caplog.at_level(logging.ERROR):
        message = logged_error("unit", RuntimeError(SECRET))
    assert SECRET not in message
    error_id = ERROR_ID.search(message).group(1)
    assert any(error_id in r.getMessage() and r.exc_info for r in caplog.records)


def test_futu_runtime_start_and_stop_failures_do_not_expose_exception_text(monkeypatch):
    monkeypatch.setattr("backend.futu.runtime.source_enabled", lambda *_: True, raising=False)
    runtime = FutuRuntime(service_factory=_Boom)
    with pytest.raises(RuntimeError):
        runtime.start()
    status = runtime.status()
    text = repr(status)
    assert SECRET not in text
    assert ERROR_ID.search(text)


def test_daemon_sources_have_no_raw_exception_text_in_payloads():
    from pathlib import Path

    root = Path(__file__).resolve().parents[1] / "backend"
    offenders = []
    for path in root.rglob("*.py"):
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            stripped = line.strip()
            if "str(exc)" not in stripped and "{exc}" not in stripped:
                continue
            # The log itself: logger calls, console prints, and detached_output.py's write into the daemon's own log file.
            if stripped.startswith(("logger.", "print(", "if ")) or (path.name == "detached_output.py" and stripped.startswith("self._handle.write(")):
                continue
            # Deliberate messages this code writes for the caller (lifecycle / validation / load-test auth / the
            # data-center "not ready" startup race) are allowed; any other exception text is not.
            allowed = ("ServiceUnavailableError(str(exc)", "status_code=403", "status_code=400", "status_code=409")
            if any(token in stripped for token in allowed):
                continue
            offenders.append(f"{path.relative_to(root)}:{number}: {stripped}")
    assert offenders == []
