from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import pytest

from service.market.shared.source_runtime import source_status
from backend.futu.runtime import FutuRuntime
from backend.shioaji.runtime import ShioajiRuntime

ROOT = Path(__file__).resolve().parents[1]


def isolated(code: str, sources: str, tmp_path: Path):
    tmp_path.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [sys.executable, "-c", code], cwd=tmp_path, capture_output=True, text=True,
        encoding="utf-8", timeout=35,
        env={**os.environ, "PYTHONPATH": str(ROOT), "STOCK_MONITOR_SOURCES": sources,
             "STOCK_MONITOR_DATA_ROOT": str(tmp_path / "data"),
             "FUTU_MARKET_DB": str(tmp_path / "futu.db"),
             "FUTU_SECURITY_MASTER_FILE": str(tmp_path / "master.csv")},
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return result.stdout


def test_default_configuration_preserves_both_sources(tmp_path):
    result = subprocess.run(
        [sys.executable, "-c", "from config.source_settings import ENABLED_SOURCES; print(sorted(ENABLED_SOURCES))"],
        cwd=tmp_path, capture_output=True, text=True, encoding="utf-8", timeout=15,
        env={key: value for key, value in {**os.environ, "PYTHONPATH": str(ROOT)}.items()
             if key != "STOCK_MONITOR_SOURCES"},
    )
    assert result.returncode == 0, result.stderr
    assert "['futu', 'shioaji']" in result.stdout


def test_futu_only_api_import_allocates_no_shioaji_client_or_worker(tmp_path):
    isolated("""
import builtins, sys, threading
original_import=builtins.__import__
def import_without_shioaji(name, *args, **kwargs):
    if name == 'shioaji' or name.startswith('shioaji.'):
        raise ModuleNotFoundError('simulated missing disabled Shioaji SDK')
    return original_import(name, *args, **kwargs)
builtins.__import__=import_without_shioaji
before = {t.name for t in threading.enumerate()}
from api.service_host import ServiceHost
from api.services import quote_api
api = quote_api.Resources(ServiceHost("quote_api", port=None, config_revision=None))
created = {t.name for t in threading.enumerate()} - before
assert type(api.runtime).__name__ == 'DisabledSourceClient'
assert not created, created
assert 'service.market.shioaji.service' not in sys.modules
assert api.runtime.status()['source_status']['lifecycle'] == 'disabled'
""", "futu", tmp_path)


def test_shioaji_only_api_import_does_not_load_or_create_futu_service(tmp_path):
    isolated("""
import builtins, sys
original_import=builtins.__import__
def import_without_futu(name, *args, **kwargs):
    if name in {'moomoo','futu'} or name.startswith(('moomoo.','futu.')):
        raise ModuleNotFoundError('simulated missing disabled Futu SDK')
    return original_import(name, *args, **kwargs)
builtins.__import__=import_without_futu
from api.service_host import ServiceHost
from api.services import quote_api
api = quote_api.Resources(ServiceHost("quote_api", port=None, config_revision=None))
assert type(api.futu).__name__ == 'DisabledSourceClient'
assert 'service.market.futu.daemon_client' not in sys.modules
assert 'service.market.futu.service' not in sys.modules
assert api.futu.status()['source_status']['lifecycle'] == 'disabled'
""", "shioaji", tmp_path)


def test_disabled_compatibility_route_is_rejected_before_handler(tmp_path):
    isolated("""
import asyncio, json
from api.service_host import create_service_app
api = create_service_app("quote_api", lambda app, host: None, client_token="client-token-0123456789")
sent=[]
async def send(message): sent.append(message)
async def receive(): return {'type':'http.request','body':b'','more_body':False}
scope={'type':'http','asgi':{'version':'3.0'},'http_version':'1.1','method':'GET',
 'scheme':'http','path':'/api/futu/status','raw_path':b'/api/futu/status',
 'query_string':b'','headers':[(b'authorization', b'Bearer client-token-0123456789')],'client':('test',1),'server':('test',80),'root_path':''}
asyncio.run(api(scope, receive, send))
assert sent[0]['status'] == 409
body=json.loads(sent[1]['body'])
assert body['error'] == 'SOURCE_DISABLED' and body['source'] == 'futu'
""", "shioaji", tmp_path)


def test_all_source_combinations_expose_only_selected_clients(tmp_path):
    for selected in ("shioaji", "futu", "shioaji,futu"):
        output = isolated("""
import json
from api.service_host import ServiceHost
from api.services import quote_api
api = quote_api.Resources(ServiceHost("quote_api", port=None, config_revision=None))
print(json.dumps({'enabled':__import__('config.source_settings', fromlist=['SOURCE_SETTINGS']).SOURCE_SETTINGS['enabled_sources'],
 'shioaji':type(api.runtime).__name__, 'futu':type(api.futu).__name__}))
""", selected, tmp_path / selected.replace(",", "_"))
        payload = json.loads(output.strip().splitlines()[-1])
        assert payload["enabled"] == selected.split(",")
        assert (payload["shioaji"] != "DisabledSourceClient") == ("shioaji" in selected)
        assert (payload["futu"] != "DisabledSourceClient") == ("futu" in selected)


def test_common_status_distinguishes_lifecycle_connection_and_market_state():
    provider = {"connected": True, "readiness": {
        "state": "MARKET_CLOSED", "canonical_ready": True, "market_data_ready": False,
    }}
    status = source_status("futu", "started", provider, services_started=True)
    assert status["start_accepted"] and status["services_started"]
    assert status["broker_connected"] and status["services_ready"]
    assert status["health"] == "idle"
    stale = source_status("futu", "started", {"connected": True, "readiness": {
        "state": "STALE", "canonical_ready": True, "stale": True}}, services_started=True)
    assert stale["health"] == "degraded" and not stale["services_ready"]
    failed = source_status("shioaji", "stop_failed", {}, error="timeout")
    assert failed["health"] == "failed" and failed["lifecycle"] == "stop_failed"


def test_electron_startup_uses_same_three_source_combinations():
    result = subprocess.run(["node", str(ROOT / "tests" / "source_enablement_contract.cjs")],
                            cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=25)
    assert result.returncode == 0, result.stdout + result.stderr


def test_offline_ui_keeps_brokers_disabled_but_exposes_local_history(tmp_path):
    tmp_path.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [sys.executable, "-c", """
import sys
from api.service_host import ServiceHost
from api.services import quote_api
api = quote_api.Resources(ServiceHost("quote_api", port=None, config_revision=None))
assert type(api.runtime).__name__ == 'DisabledSourceClient'
assert type(api.futu).__name__ == 'DisabledSourceClient'
from api.components import Components
history = Components("history_api")
assert type(history.shioaji_provider()).__name__ == 'DisabledSourceClient'
assert history.history_repository() is not None
assert Components("data_center_api").data_center() is not None
assert history.history_replay().list_dates() == []
from api.source_gate import offline_local_read_allowed
assert offline_local_read_allowed('/api/history/dates', 'GET')
assert offline_local_read_allowed('/api/data-center/dates', 'GET')
assert offline_local_read_allowed('/api/data-center/date?date=2026-09-04', 'GET')
assert offline_local_read_allowed('/api/data-center/closing', 'GET')
assert not offline_local_read_allowed('/api/data-center/kbars/preview', 'POST')
assert not offline_local_read_allowed('/api/history/dates', 'POST'), 'offline, the history API is read-only'
assert not offline_local_read_allowed('/api/market/start', 'POST')
assert 'service.market.shioaji.service' not in sys.modules
assert 'service.market.futu.service' not in sys.modules
"""],
        cwd=tmp_path, capture_output=True, text=True, encoding="utf-8", timeout=35,
        env={**os.environ, "PYTHONPATH": str(ROOT), "STOCK_MONITOR_OFFLINE_UI": "1",
             "STOCK_MONITOR_SOURCES": "shioaji,futu",
             "STOCK_MONITOR_DATA_ROOT": str(tmp_path / "data")},
    )
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize(("launcher", "enabled", "server_module", "service_module"), [
    ("shioaji", "futu", "backend.shioaji.server", "service.market.shioaji.service"),
    ("futu", "shioaji", "backend.futu.server", "service.market.futu.service"),
])
def test_disabled_daemon_launcher_exits_before_server_or_sdk_service_import(
    launcher, enabled, server_module, service_module, tmp_path,
):
    isolated(f"""
import importlib, sys
module=importlib.import_module('backend.{launcher}.run_{launcher}_daemon')
assert module.main() == 0
assert {server_module!r} not in sys.modules
assert {service_module!r} not in sys.modules
""", enabled, tmp_path)


def test_futu_stop_failure_blocks_restart_and_preserves_single_service():
    class Service:
        def __init__(self): self.starts = 0; self.stops = 0
        def start(self): self.starts += 1
        def stop(self, timeout=0): self.stops += 1; return {"ok": False, "error": "drain timeout"}
        def status(self): return {"connected": True, "worker_alive": True, "readiness": {"state": "READY", "canonical_ready": True}}
    service = Service()
    runtime = FutuRuntime(service_factory=lambda: service)
    assert runtime.start()["accepted"]
    stopped = runtime.stop()
    assert not stopped["ok"] and stopped["source_status"]["lifecycle"] == "stop_failed"
    assert runtime.start()["accepted"] is False
    assert (service.starts, service.stops) == (1, 1)


def test_shioaji_start_acceptance_precedes_service_start_and_stop_is_once():
    release = threading.Event()
    started = threading.Event()
    class Market:
        def status(self): return {"connected": started.is_set(), "readiness": {"state": "STARTING", "canonical_ready": True}}
    class Service:
        broker_service = Market()
        def __init__(self): self.stops = 0
        def start(self): release.wait(3); started.set()
        def run_once(self): return {}
        def shutdown_background_processing(self, **kwargs): self.stops += 1; return {"ok": True}
        def finalize_broker_logout(self): pass
    service = Service()
    runtime = ShioajiRuntime(service_factory=lambda **kwargs: service)
    accepted = runtime.start()
    assert accepted["accepted"] and accepted["source_status"]["lifecycle"] == "starting"
    assert not accepted["source_status"]["services_started"]
    release.set()
    assert started.wait(3)
    for _ in range(50):
        if runtime.status()["source_status"]["services_started"]: break
        time.sleep(.01)
    assert runtime.status()["source_status"]["services_started"]
    assert runtime.stop(timeout=3)["ok"]
    assert runtime.stop(timeout=3)["ok"]
    assert service.stops == 1

