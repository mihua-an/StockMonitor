from __future__ import annotations

from types import SimpleNamespace

from backend.shioaji import daemon_health
from backend.shioaji.daemon_context import create_daemon_context


def _context(service=None, thread=None):
    return create_daemon_context(runtime=SimpleNamespace(
        service=service, thread=thread, status=lambda: {}, lightweight_source_status=lambda: None))


def _ready(ctx):
    ctx.lifecycle.status = lambda: {"state": "READY"}
    ctx.lifecycle._state = "READY"
    return ctx


def test_a_dead_runtime_thread_is_half_dead_in_every_payload_and_healthy_is_gone() -> None:
    dead = SimpleNamespace(is_alive=lambda: False)
    ctx = _ready(_context(thread=dead))
    for build in (daemon_health.passive_runtime_health_payload, daemon_health.daemon_health_summary, daemon_health.daemon_health):
        payload = build(ctx)
        assert payload["runtime_state"] == "DAEMON_HALF_DEAD", build.__name__
        assert "healthy" not in payload, build.__name__


def test_a_living_runtime_thread_reports_the_lifecycle_state() -> None:
    ctx = _ready(_context(thread=SimpleNamespace(is_alive=lambda: True)))
    assert daemon_health.passive_runtime_health_payload(ctx)["runtime_state"] == "READY"
    assert daemon_health.daemon_health(ctx)["runtime_state"] == "READY"


def test_daemon_health_and_diagnostics_do_not_raise_without_runtime_app() -> None:
    """Regression: a stale module global made daemon_health() raise NameError."""
    ctx = _context()
    for name in ("daemon_health", "daemon_health_summary", "passive_runtime_health_payload", "lightweight_health_payload"):
        assert isinstance(getattr(daemon_health, name)(ctx), dict), name


def test_the_passive_payload_carries_the_brokers_login_time() -> None:
    # 系統拓樸 Shioaji SDK 連線時長 counts from it; the payload carried only last_login_attempt_at (10-14).
    broker = SimpleNamespace(lightweight_status=lambda: {"last_login_at": "2026-10-14T05:05:00", "last_login_attempt_at": "2026-10-14T05:04:58"})
    sink = SimpleNamespace(health=lambda: {"running": True, "queue_depth": 0, "capacity": 4096, "acked": 1})
    ctx = _context(SimpleNamespace(broker_service=broker, live_event_sink=sink))
    payload = daemon_health.passive_runtime_health_payload(ctx)
    assert payload["last_login_at"] == "2026-10-14T05:05:00"
    assert payload["live_ingress"]["queue_depth"] == 0 and payload["live_ingress"]["capacity"] == 4096


def test_v1_health_reports_the_sink_as_the_futu_daemon_does() -> None:
    # I24 reads event_sink.durable_pending and transport_errors from both daemons; /v1/health carried a hand-picked
    # subset without them, so the Shioaji half could not be checked.
    from service.market.shared.rust_live import RustDaemonEventSink

    sink = RustDaemonEventSink(source="shioaji", url="ws://127.0.0.1:1/live", token="t")
    ctx = _context(SimpleNamespace(broker_service=SimpleNamespace(lightweight_status=dict), live_event_sink=sink))
    event_sink = daemon_health.daemon_health_summary(ctx)["event_sink"]
    assert {"durable_pending", "durable_held", "transport_errors", "acked", "queue_depth", "running"} <= set(event_sink)
    assert event_sink["durable_pending"] == 0 and event_sink["transport_errors"] == 0
