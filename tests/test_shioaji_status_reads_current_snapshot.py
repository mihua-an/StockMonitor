"""/api/status answers from the daemon's snapshot as it is now, not as the 2 s health poll last saw it.

After a restart the 即時報價 「行情資料未同步」 notice is cleared by this read; waiting for the poll's next turn was up to
2 s of the 5.85 s measured between the subscribe finishing and the notice clearing.
"""
from __future__ import annotations

import asyncio
import importlib
import os
import time

from service.market.shioaji import daemon_client
from service.market.shioaji.daemon_contract import MARKET_DAEMON_IDENTITY


class _Ledger:
    def set_component_state(self, **_state):
        return None


def _snapshot(*, ready: bool, age_seconds: float = 0.0) -> dict:
    return {
        "generated_epoch_ns": time.time_ns() - int(age_seconds * 1_000_000_000),
        "process": {"pid": os.getpid()},
        "producer": {"ok": True, "identity": MARKET_DAEMON_IDENTITY, "shioaji": {"readiness": {"market_data_ready": ready}}},
    }


def _ready(health: dict) -> bool | None:
    return ((health.get("shioaji") or {}).get("readiness") or {}).get("market_data_ready")


def _client(monkeypatch, snapshot: dict):
    current = {"snapshot": snapshot}
    monkeypatch.setattr(daemon_client, "read_dataflow_snapshot", lambda _path: current["snapshot"])
    return daemon_client.MarketDaemonClient(health_ledger=_Ledger()), current


def test_refresh_adopts_the_snapshot_written_since_the_last_poll(monkeypatch):
    client, current = _client(monkeypatch, _snapshot(ready=False))
    client._running.set()
    client.refresh_health()
    assert _ready(client.cached_health()) is False
    current["snapshot"] = _snapshot(ready=True)
    client.refresh_health()
    assert _ready(client.cached_health()) is True, "a read after the provider wrote must say what it wrote"


def test_refresh_never_touches_the_lease(monkeypatch):
    client, _current = _client(monkeypatch, _snapshot(ready=True))
    calls = []
    monkeypatch.setattr(client._lease, "keep", lambda *a: calls.append(("keep", a)))
    monkeypatch.setattr(client._lease, "observe", lambda *a: calls.append(("observe", a)))
    client._running.set()
    client.refresh_health()
    assert calls == [], "the lease has one driver, the health loop"


def test_a_client_that_has_not_attached_adopts_nothing(monkeypatch):
    client, _current = _client(monkeypatch, _snapshot(ready=True))
    client.refresh_health()
    assert _ready(client.cached_health()) is None, "start() is what first adopts a daemon's health"


def test_the_snapshot_age_limit_does_not_follow_the_poll_interval(monkeypatch):
    client, _current = _client(monkeypatch, _snapshot(ready=True, age_seconds=5.5))
    client.HEALTH_POLL_SECONDS = 0.1
    client._running.set()
    client.refresh_health()
    assert client.cached_health().get("ok") is True, "5.5 s is inside the limit however often the loop reads"


def test_a_snapshot_past_the_age_limit_is_not_adopted(monkeypatch):
    client, _current = _client(monkeypatch, _snapshot(ready=True, age_seconds=7.0))
    client._running.set()
    client.refresh_health()
    assert client.cached_health().get("ok") is False


def test_the_status_route_refreshes_before_it_reads_the_diagnostics(tmp_path, monkeypatch):
    from api import components

    monkeypatch.setenv("STOCK_MONITOR_AUTH_ROOT", str(tmp_path / "auth"))
    quote_api = importlib.import_module("api.services.quote_api")
    monkeypatch.setattr(quote_api, "source_enabled", lambda _source: True)
    from service.market.shared import daemon_singleton

    monkeypatch.setattr(daemon_singleton, "wait_until_owner_ready", lambda *a, **k: True)
    calls: list[str] = []

    class Client:
        def start_in_background(self, *_a, **_k):
            return None

        def attach_in_background(self, *_a, **_k):
            return None

        def refresh_health(self):
            calls.append("refresh_health")

        def cached_health(self):
            calls.append("cached_health")
            return {}

        def stream_stats(self):
            return {}

        def stats(self):
            return {}

    monkeypatch.setattr(components.Components, "lazy", lambda self, name, factory=None: components.Deferred(name, Client))
    from api.service_host import create_composite_app

    app = create_composite_app("quote_api", (("quote_api", quote_api.Resources),), client_token="x")

    async def run():
        async with app.router.lifespan_context(app):
            route = next(r for r in app.router.routes if getattr(r, "path", "") == "/api/status")
            return await route.endpoint()

    payload = asyncio.run(run())
    assert payload["ok"] is True
    assert "refresh_health" in calls, calls
    assert calls.index("refresh_health") < calls.index("cached_health"), calls
