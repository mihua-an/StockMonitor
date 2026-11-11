"""Process execution belongs to Health; observation and the business services never execute processes.

docs/system-architecture/00 section 3 / 04 section 4: Health is the single process-lifecycle and recovery authority.
It owns the supervisor (health/supervisor.js) and the per-service hosts that spawn and stop processes; monitoring
(health/monitoring/) only observes, and no API client can start or kill a provider.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_monitoring_has_no_process_execution_dependency():
    source = (ROOT / "health/monitoring/collector.js").read_text(encoding="utf-8")
    for forbidden in ("require(\"child_process\")", "spawn(", "execFile(", ".kill("):
        assert forbidden not in source


def test_clients_do_not_acquire_process_authority():
    for provider in ("shioaji", "futu"):
        source = (ROOT / f"service/market/{provider}/daemon_client.py").read_text(encoding="utf-8")
        assert "_spawn_detached_daemon" not in source
        assert "def explicit_stop_daemon" not in source


def test_supervisor_bounds_automatic_recovery_and_never_kills_an_unverified_occupant():
    source = (ROOT / "health/supervisor.js").read_text(encoding="utf-8")
    assert "RESTART_BUDGET" in source and "RESTART_LIMIT" in source
    assert "unverified occupant; not restarted, not killed" in source
    assert not (ROOT / "service/platform/recovery_executor.py").exists()
