"""Electron's startup rows wait for stream.attached, live_ingress.running/ready and moomoo.attached in
/api/diagnostics/heartbeat, but the heartbeat only answered ok/service_id, so every wait ran to its timeout."""
from __future__ import annotations

import asyncio
import importlib
import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _heartbeat(tmp_path):
    os.environ["STOCK_MONITOR_AUTH_ROOT"] = str(tmp_path / "auth")
    from api.service_host import create_composite_app

    quote_api = importlib.import_module("api.services.quote_api")
    app = create_composite_app("quote_api", (("quote_api", quote_api.Resources),), client_token="x")

    async def run():
        async with app.router.lifespan_context(app):
            route = next(r for r in app.router.routes if getattr(r, "path", "") == "/api/diagnostics/heartbeat")
            return route.endpoint()

    return asyncio.run(run())


def test_the_heartbeat_carries_every_fact_the_startup_rows_wait_for(tmp_path, monkeypatch):
    monkeypatch.delenv("STOCK_MONITOR_AUTH_ROOT", raising=False)
    payload = _heartbeat(tmp_path)
    assert payload["ok"] is True
    assert isinstance(payload["stream"]["attached"], bool)
    assert isinstance(payload["live_ingress"]["running"], bool)
    assert isinstance(payload["live_ingress"]["ready"], bool)
    assert isinstance(payload["moomoo"]["attached"], bool)

    # Electron's predicates (ui/main/startup_lifecycle.js HEARTBEAT_READY) run on this very payload: with every
    # boolean set they all hold, with every boolean cleared none does -- a rename on either side fails here.
    def every_bool(value, flag):
        if isinstance(value, dict):
            return {key: every_bool(item, flag) for key, item in value.items()}
        return flag if isinstance(value, bool) else value

    script = ("const { HEARTBEAT_READY } = require('./ui/main/startup_lifecycle.js');"
              "const [up, down] = JSON.parse(require('fs').readFileSync(0, 'utf8'));"
              "const run = (p) => Object.fromEntries(Object.entries(HEARTBEAT_READY).map(([k, f]) => [k, f(p)]));"
              "process.stdout.write(JSON.stringify([run(up), run(down)]));")
    out = subprocess.run(["node", "-e", script], input=json.dumps([every_bool(payload, True), every_bool(payload, False)]),
                         capture_output=True, text=True, cwd=ROOT, timeout=60, check=True)
    up, down = json.loads(out.stdout)
    assert set(up) == {"shioajiAttached", "liveIngressUp", "futuAttached"}
    assert all(up.values()), up
    assert not any(down.values()), down

def test_the_heartbeat_never_waits_on_a_daemon_client_still_being_built(tmp_path, monkeypatch):
    # Deferred.__getattr__ resolved the client under its factory lock: while the background start was building it
    # (~1.2 s), every heartbeat stood behind that lock past Electron's 800 ms and was aborted.
    import threading
    import time

    from api import components

    monkeypatch.setenv("STOCK_MONITOR_AUTH_ROOT", str(tmp_path / "auth"))
    quote_api = importlib.import_module("api.services.quote_api")
    monkeypatch.setattr(quote_api, "source_enabled", lambda source: True)
    from service.market.shared import daemon_singleton

    monkeypatch.setattr(daemon_singleton, "wait_until_owner_ready", lambda *a, **k: True)   # both daemons READY
    release, building = threading.Event(), threading.Event()

    class Client:
        def start_in_background(self, *_a, **_k):
            return None

        def attach_in_background(self, *_a, **_k):
            return None

        def cached_health(self):
            return {"live_ingress": {"running": True, "ready": True}}

        def stream_stats(self):
            return {"attached": True}

        def stats(self):
            return {"attached": True}

    def slow_factory():
        building.set()
        assert release.wait(10), "the test releases the build"
        return Client()

    monkeypatch.setattr(components.Components, "lazy", lambda self, name, factory=None: components.Deferred(name, slow_factory))
    from api.service_host import create_composite_app

    app = create_composite_app("quote_api", (("quote_api", quote_api.Resources),), client_token="x")

    async def run():
        async with app.router.lifespan_context(app):
            route = next(r for r in app.router.routes if getattr(r, "path", "") == "/api/diagnostics/heartbeat")
            assert building.wait(5), "the background start is building a client"
            started = time.monotonic()
            during = route.endpoint()
            waited = time.monotonic() - started
            release.set()
            deadline = time.monotonic() + 5
            after = route.endpoint()
            while not after["stream"]["attached"] and time.monotonic() < deadline:
                await asyncio.sleep(0.02)
                after = route.endpoint()
            return during, waited, after

    during, waited, after = asyncio.run(run())
    assert waited < 0.2, f"the heartbeat waited {waited:.3f} s on the build"
    assert during["stream"]["attached"] is False and during["moomoo"]["attached"] is False, "a client being built is not attached"
    assert after["stream"]["attached"] is True and after["live_ingress"]["ready"] is True, "a built client is read"
