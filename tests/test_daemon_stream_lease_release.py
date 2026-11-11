"""The daemon's /v1/stream attached a non-expiring lease, then called hub.connect() outside the
try/finally; a failure there leaked the lease and the daemon could never idle-stop."""
from __future__ import annotations

import asyncio

from backend.shioaji.routes.client_routes import ClientRouteDependencies, create_client_router


class Lifecycle:
    state = "RUNNING"

    def __init__(self):
        self.attached, self.detached = [], []

    def attach(self, client_id, **kw):
        self.attached.append(client_id)
        return {"lease_id": "L1"}

    def detach(self, client_id, **kw):
        self.detached.append((client_id, kw.get("lease_id")))
        return {"client_count": 0}


class BrokenHub:
    async def connect(self, websocket):
        raise RuntimeError("accept failed")

    async def disconnect(self, websocket):
        pass


class Socket:
    query_params = {"client_id": "c1", "connection_id": "x"}

    async def close(self, code=None, reason=None):
        pass


def test_a_failed_hub_connect_still_releases_the_lease():
    lifecycle = Lifecycle()
    router = create_client_router(ClientRouteDependencies(
        daemon_instance_id="d1", lifecycle_provider=lambda: lifecycle, hub_provider=lambda: BrokenHub(),
        shutdown_state_provider=lambda: {}, health_payload_provider=lambda: {}))
    endpoint = next(route.endpoint for route in router.routes if getattr(route, "path", "") == "/v1/stream")
    asyncio.run(endpoint(Socket()))
    assert lifecycle.attached == ["c1"]
    assert lifecycle.detached == [("c1", "L1")], "the lease is detached even though the hub never took the socket"
