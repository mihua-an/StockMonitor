"""Session-wide test isolation.

service/platform/project_root.py resolves the runtime locations (var/data, var/output, var/state, ...) at import
time. Pointing STOCK_MONITOR_VAR_ROOT at a disposable directory BEFORE any test module is imported means no test can read
or write the developer's real var/ directory (market data, logs); STOCK_MONITOR_AUTH_ROOT is pointed at a disposable directory too (tokens). Tests that need the default layout run it in a
subprocess with this variable removed (see tests/test_var_layout.py).
"""
import atexit
import os
import shutil
import tempfile

import pytest

# realpath: Windows can hand out a TEMP in 8.3 form (RUNNER~1), and the storage layout reports resolved paths.
_TEST_VAR_ROOT = os.path.realpath(tempfile.mkdtemp(prefix="stockmonitor-test-var-"))
os.environ["STOCK_MONITOR_VAR_ROOT"] = _TEST_VAR_ROOT
atexit.register(shutil.rmtree, _TEST_VAR_ROOT, ignore_errors=True)
# AUTH_ROOT (local IPC tokens) lives outside var/ in %LOCALAPPDATA%; the suite must never read or create the real one either.
_TEST_AUTH_ROOT = tempfile.mkdtemp(prefix="stockmonitor-test-auth-")
os.environ["STOCK_MONITOR_AUTH_ROOT"] = _TEST_AUTH_ROOT
atexit.register(shutil.rmtree, _TEST_AUTH_ROOT, ignore_errors=True)


# CI builds the two Rust release executables first and sets STOCK_MONITOR_REQUIRE_RELEASE_EXES=1:
# the integration tests that need them then never skip silently -- a test skipped for a missing executable fails the run.
_RELEASE_SKIP_REASONS = ("binary not built", "binaries not built")


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report = outcome.get_result()
    if os.environ.get("STOCK_MONITOR_REQUIRE_RELEASE_EXES") != "1" or not report.skipped:
        return
    reason = str(report.longrepr[-1] if isinstance(report.longrepr, tuple) else report.longrepr)
    if any(text in reason for text in _RELEASE_SKIP_REASONS):
        report.outcome = "failed"
        report.longrepr = f"{report.nodeid}: skipped for a missing Rust release executable while CI requires them ({reason})"


@pytest.fixture(autouse=True)
def _isolated_session_evidence(tmp_path, monkeypatch):
    """Event sinks persist session evidence under var/output/; tests must never touch the real one."""
    monkeypatch.setenv("STOCK_MONITOR_SESSION_EVIDENCE_ROOT", str(tmp_path / "_session_evidence"))
