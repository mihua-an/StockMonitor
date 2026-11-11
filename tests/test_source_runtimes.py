from __future__ import annotations

import importlib
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from backend.futu.runtime import FutuRuntime
from backend.shioaji.runtime import ShioajiRuntime

ROOT = Path(__file__).resolve().parents[1]


def run_isolated(code, tmp_path):
    result = subprocess.run(
        [sys.executable, "-c", code], cwd=tmp_path,
        env={**os.environ, "PYTHONPATH": str(ROOT),
             "STOCK_MONITOR_DATA_ROOT": str(tmp_path / "data"),
             "FUTU_MARKET_DB": str(tmp_path / "futu.db"),
             "FUTU_SECURITY_MASTER_FILE": str(tmp_path / "master.csv")},
        capture_output=True, text=True, encoding="utf-8", timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return result.stdout


def test_imports_do_not_start_workers_connect_or_load_native(tmp_path):
    run_isolated('''
import importlib, os, platform, socket, sqlite3, subprocess, sys, threading
# Cache Python's Windows version probe before forbidding process creation.
# pandas uses this cached standard-library value during import.
platform.uname()
def forbidden(*args, **kwargs):
    raise AssertionError("import attempted to start a worker, process or connection")
threading.Thread.start = forbidden
socket.socket.connect = forbidden
sqlite3.connect = forbidden
subprocess.Popen = forbidden
before_path, before_cwd = list(sys.path), os.getcwd()
for name in (
    "backend.shioaji.runtime", "backend.futu.runtime", "service.market.shioaji.daemon_client",
    "service.market.shioaji.service", "service.market.futu.service",
    "backend.shioaji.run_shioaji_daemon", "backend.futu.run_futu_daemon",
):
    importlib.import_module(name)
import backend.futu.runtime as futu_runtime_module
from backend.futu.runtime import FutuRuntime
from backend.shioaji.runtime import ShioajiRuntime
assert not hasattr(futu_runtime_module, "get_futu_runtime"), "no process-global Futu runtime"
for owner in (FutuRuntime(), ShioajiRuntime()):
    assert owner.status()["connected"] is False
    assert owner.status()["running"] is False
assert not any(name in sys.modules for name in ("shioaji", "futu", "moomoo"))
assert sys.path == before_path and os.getcwd() == before_cwd
''', tmp_path)


def test_futu_daemon_import_does_not_construct_service(tmp_path):
    run_isolated('''
import socket, sqlite3, threading
def forbidden(*args, **kwargs):
    raise AssertionError("daemon import attempted to acquire a resource")
socket.socket.connect = forbidden
sqlite3.connect = forbidden
threading.Thread.start = forbidden
import backend.futu.server as daemon
assert daemon.futu_daemon.runtime._service is None
assert daemon.futu_daemon.health()["opend_connected"] is False
other = daemon.FutuDaemon(daemon.FutuRuntime())
assert other.instance_id != daemon.futu_daemon.instance_id, "each daemon is its own instance, no shared globals"
''', tmp_path)


def test_shioaji_daemon_import_does_not_start_workers_or_service(tmp_path):
    run_isolated('''
import socket, sqlite3, threading
def forbidden(*args, **kwargs):
    raise AssertionError("daemon import attempted to acquire a resource")
socket.socket.connect = forbidden
sqlite3.connect = forbidden
threading.Thread.start = forbidden
import backend.shioaji.server as daemon
assert daemon.daemon_context.runtime.service is None
assert daemon.daemon_context.route_work is None
assert daemon.daemon_context.route_work_metrics()["state"] == "NOT_STARTED"
''', tmp_path)


def test_shioaji_daemon_routes_delegate_to_explicit_service_owners():
    from backend.shioaji.routes import MaintenanceRouteDependencies, create_maintenance_router

    calls = []
    broker = SimpleNamespace(
        sync_now=lambda: calls.append("sync_now") or {"ok": True, "action": "sync"},
        reconnect=lambda reason="manual_request": calls.append(f"reconnect:{reason}") or {"ok": True, "action": "reconnect"},
    )
    app = SimpleNamespace(broker_service=broker)
    router = create_maintenance_router(MaintenanceRouteDependencies(app_provider=lambda: app))
    endpoint = {(route.path, method): route.endpoint for route in router.routes for method in route.methods}

    assert endpoint[("/v1/shioaji/sync", "POST")]()["action"] == "sync"
    assert endpoint[("/v1/shioaji/reconnect", "POST")]()["action"] == "reconnect"
    assert endpoint[("/v1/control/credentials-changed", "POST")]()["action"] == "reconnect"
    # A credential change tells the session why it restarts (provider.broker_session_reconnect's trigger).
    assert calls == ["sync_now", "reconnect:manual_request", "reconnect:credentials_changed"]

    source = (ROOT / "backend" / "shioaji" / "server.py").read_text(encoding="utf-8")
    assert "Facade" not in source
    assert not (ROOT / "backend" / "shioaji_daemon_facade.py").exists()


class FutuServiceDouble:
    def __init__(self):
        self.events = []
        self.worker_alive = False

    def start(self):
        self.events.append("start")
        self.worker_alive = True

    def stop(self, *, timeout):
        self.events.append("stop")
        self.worker_alive = False
        return {"ok": True, "timeout_budget": timeout}

    def status(self):
        return {"provider": "futu", "connected": self.worker_alive, "worker_alive": self.worker_alive,
                "context_generation": 7, "storage": "data/moomoo_market.db"}


def test_futu_single_service_start_order_and_explicit_restart():
    factory = MagicMock(side_effect=FutuServiceDouble)
    runtime = FutuRuntime(service_factory=factory)
    assert not factory.called
    assert runtime.stop()["not_started"]
    runtime.start()
    runtime.start()
    service = runtime.service
    assert factory.call_count == 1
    assert service.events == ["start"]
    assert runtime.status()["running"]
    assert runtime.status()["context_generation"] == 7
    assert runtime.stop(timeout=8)["timeout_budget"] == 8
    runtime.stop()
    assert service.events == ["start", "stop"]
    runtime.start()
    assert runtime.service is service and factory.call_count == 1
    runtime.stop()


class ShioajiServiceDouble:
    def __init__(self, **kwargs):
        self.arguments = kwargs
        self.started = threading.Event()
        self.shutdown = []
        self.logout_count = 0
        self.broker_service = SimpleNamespace(status=lambda: {"connected": self.started.is_set()})

    def start(self):
        self.started.set()

    def run_once(self):
        return {"ok": True, "source": "shioaji"}

    def shutdown_background_processing(self, *, defer_broker_logout=False, deadline=None):
        self.shutdown.append(defer_broker_logout)
        return {"ok": True}

    def finalize_broker_logout(self, busy=()):
        self.logout_count += 1
        return {"ok": True, "logged_out": True}


def test_shioaji_single_owner_and_deferred_logout():
    service = ShioajiServiceDouble()
    factory = MagicMock(return_value=service)
    owner = ShioajiRuntime(service_factory=factory)
    assert owner.service is None and not owner.status()["running"]
    try:
        owner.start()
        assert service.started.wait(3)
        owner.start()
        assert factory.call_count == 1
        assert owner.service is owner.app is service
        assert owner.status()["source"] == "shioaji"
        assert owner.status()["connected"]
        assert owner.stop(timeout=4, defer_broker_logout=True)["ok"]
        assert service.shutdown and all(service.shutdown)
        assert service.logout_count == 0
        owner.finalize_broker_logout()
        assert service.logout_count == 1
    finally:
        owner.stop(timeout=4, defer_broker_logout=True)


def test_shioaji_stop_during_assembly_never_starts_broker():
    entered, release = threading.Event(), threading.Event()
    service = ShioajiServiceDouble()
    def factory(**kwargs):
        entered.set()
        assert release.wait(3)
        return service
    owner = ShioajiRuntime(service_factory=factory)
    try:
        owner.start()
        assert entered.wait(2)
        owner.stop(wait=False, timeout=0.2, defer_broker_logout=True)
        release.set()
        owner.thread.join(3)
        assert not owner.thread.is_alive()
        assert not service.started.is_set()
        assert service.shutdown == [True]
    finally:
        release.set()
        owner.stop(timeout=4, defer_broker_logout=True)


def test_futu_real_graph_is_control_only_and_forwards_to_market_runtime(tmp_path, monkeypatch):
    from service.market.futu.service import FutuMarketService
    from service.market.futu.store import FutuControlStore
    monkeypatch.setenv("FUTU_MARKET_DB", str(tmp_path / "existing.db"))
    monkeypatch.setenv("FUTU_SECURITY_MASTER_FILE", str(tmp_path / "master.csv"))
    from config.network_settings import endpoint
    service = FutuMarketService()
    assert service.db_path == tmp_path / "existing.db"
    # OpenD is reached at the effective network setting, the address Health probes.
    assert (service.host, service.port) == endpoint("external_futu_opend")
    assert service.provider_backend.provider == "futu"
    assert isinstance(service.control_store, FutuControlStore)
    assert service._thread is None
    # No Python-side live market store / recorder / product snapshot layer.
    for name in ("market_store", "market_writer", "market_queries", "_durable_recorder", "_product_bar_cache"):
        assert not hasattr(service, name), name
    import sqlite3
    with sqlite3.connect(str(service.db_path)) as db:
        tables = {row[0] for row in db.execute("select name from sqlite_master where type='table'")}
    assert tables == {"watchlist", "runtime_state"}


@pytest.mark.parametrize("source", ["shioaji", "futu"])
def test_launcher_selects_only_its_native_path_before_service_import(source, tmp_path):
    run_isolated(f'''
import importlib, sys
importlib.import_module("backend.{source}.run_{source}_daemon")
from backend.shared.provider_main import _configure_process
_configure_process()
assert "service.market.futu.service" not in sys.modules
assert "service.market.shioaji.service" not in sys.modules
''', tmp_path)


def test_process_owner_classification_requires_canonical_entry_name(monkeypatch):
    from service.market.shioaji.daemon_singleton import classify_singleton_owner
    monkeypatch.setattr("service.market.shared.daemon_process_identity.process_exists", lambda pid: True)
    assert classify_singleton_owner({"owner_pid": 123, "command_line": "python run_shioaji_daemon.py"}) == "KNOWN_DAEMON_OWNER"
    assert classify_singleton_owner({"owner_pid": 123, "command_line": "python run_market_daemon.py"}) == "UNKNOWN_PROCESS_OWNER"


def test_legacy_import_modules_are_removed():
    for name in (
        "app.stock_monitor_app",
        "runtime.source_compat",
        "service.market_runtime_coordinator",
        "service.moomoo_market_service",
        "service.moomoo_durable_recorder",
        "service.moomoo_native_ingress_adapter",
        "service.moomoo_realtime_stream",
        "runtime.launchers.run_market_daemon",
        "runtime.launchers.run_moomoo_daemon",
    ):
        with pytest.raises(ModuleNotFoundError):
            importlib.import_module(name)


def test_futu_daemon_lifespan_and_legacy_http_contract(monkeypatch):
    import backend.futu.server as daemon
    from service.platform.daemon_auth import load_or_create_daemon_token

    service = FutuServiceDouble()
    futu = daemon.FutuDaemon(FutuRuntime(service_factory=lambda: service))
    futu.idle_watchdog = lambda: None
    app = daemon.create_daemon_app(futu)
    daemon_token = load_or_create_daemon_token()

    async def request(method, path, body=None):
        messages = []
        async def receive():
            return {"type": "http.request", "body": json.dumps(body).encode() if body is not None else b"", "more_body": False}
        async def send(message):
            messages.append(message)
        await app({
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
            "method": method, "scheme": "http", "path": path, "raw_path": path.encode(),
            "query_string": b"", "root_path": "", "headers": [
                (b"content-type", b"application/json"),
                (b"authorization", f"Bearer {daemon_token}".encode()),
            ],
            "server": ("test", 80), "client": ("test", 123),
        }, receive, send)
        assert messages[0]["status"] == 200
        return json.loads(b"".join(message.get("body", b"") for message in messages))

    async def exercise():
        async with app.router.lifespan_context(app):
            status = await request("GET", "/v1/futu/status")
            assert status["provider"] == status["source"] == "futu"
            assert status["daemon"]["identity"] == daemon.MOOMOO_DAEMON_IDENTITY
            assert status["daemon"]["daemon_runtime_version"] == daemon.MOOMOO_DAEMON_RUNTIME_VERSION
    asyncio.run(exercise())
    assert service.events == ["start", "stop"]


def test_gateway_runtime_is_a_client_without_source_service_imports(tmp_path):
    run_isolated('''
import socket, sqlite3, sys, threading
def forbidden(*args, **kwargs):
    raise AssertionError("gateway runtime attempted to acquire broker resources")
socket.socket.connect = forbidden
original_start = threading.Thread.start
threading.Thread.start = forbidden
from service.market.shioaji.daemon_client import MarketDaemonClient
# Import stays passive. Explicit client construction may create its existing
# historical cache/workers, but must never own a live broker graph.
threading.Thread.start = original_start
owner = MarketDaemonClient()
assert not hasattr(owner, "allow_spawn")
assert "service.market.shioaji.service" not in sys.modules
assert "service.market.futu.service" not in sys.modules
assert "backend.shioaji.runtime" not in sys.modules
assert "backend.futu.runtime" not in sys.modules
''', tmp_path)


def test_the_provider_sources_are_shioaji_and_futu():
    from service.market.shared.provider_contract import CANONICAL_PROVIDER_SOURCES, normalize_provider_source
    assert CANONICAL_PROVIDER_SOURCES == {"shioaji", "futu"}
    assert normalize_provider_source("futu") == "futu"



def test_the_security_master_refresh_stops_before_logout():
    """Shutdown never stopped the maintenance/K-bar workers; they could call the broker after logout."""
    import threading
    from datetime import datetime

    from service.market.shioaji import maintenance

    release = threading.Event()
    coordinator = maintenance.MarketMaintenanceCoordinator()
    coordinator.refresh_connected = lambda api, day=None: (release.wait(5), {"ok": True})[1]
    assert coordinator.schedule_daily(now=datetime(2026, 10, 9, 8, 0), connected=True, api=object())["scheduled"]
    receipt = coordinator.shutdown(timeout=0.05)
    assert receipt == {"ok": False, "running": True}, "a refresh still running is reported, not hidden"
    release.set()
    assert coordinator.shutdown(timeout=5)["ok"] is True
    later = coordinator.schedule_daily(now=datetime(2026, 10, 10, 8, 0), connected=True, api=object())
    assert later == {"scheduled": False, "reason": "shutting_down", "day": "2026-10-10"}


def test_the_session_owner_is_bound_before_the_shioaji_service_starts(monkeypatch):
    """The runtime started first and its first callbacks could precede the session generation owner."""
    import time as time_module

    from backend.shioaji.runtime import ShioajiRuntime

    order = []

    class Service:
        def __init__(self, **_kw):
            order.append("built")

        def start(self):
            order.append("started")

        def run_once(self):
            return {}

        def shutdown_background_processing(self, **_kw):
            return {"ok": True}

    monkeypatch.setattr("backend.shioaji.runtime.source_enabled", lambda source: True)
    runtime = ShioajiRuntime(service_factory=Service)
    runtime.on_service_built = lambda service: order.append("owner bound")
    runtime.start()
    deadline = time_module.time() + 5
    while "started" not in order and time_module.time() < deadline:
        time_module.sleep(0.01)
    runtime.stop(timeout=5)
    assert order[:3] == ["built", "owner bound", "started"]
