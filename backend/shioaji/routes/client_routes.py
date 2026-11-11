"""Client lease and realtime WebSocket routes of the Shioaji daemon.

``ClientRouteDependencies`` carries the lease-tracking lifecycle manager and the realtime hub of the daemon's
DaemonContext, handed in by the composition root (``backend/shioaji/server.py``). Subscription demand does not flow
through client "view interests": Market Runtime drives it via the live event sink's control channel.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from typing import Any, Callable

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from backend.shared.client_lease_routes import create_client_lease_router
from service.market.lifecycle.daemon import MarketDaemonLifecycleError
from service.market.shared.startup_realtime_diagnostic import startup_realtime_diagnostic
from service.platform.failure_record import record_failure


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ClientRouteDependencies:
    daemon_instance_id: str
    lifecycle_provider: Callable[[], Any]
    hub_provider: Callable[[], Any]
    shutdown_state_provider: Callable[[], dict[str, Any]]
    health_payload_provider: Callable[[], dict[str, Any]]


def create_client_router(deps: ClientRouteDependencies) -> APIRouter:
    daemon_instance_id = deps.daemon_instance_id
    lifecycle_provider = deps.lifecycle_provider
    hub_provider = deps.hub_provider
    shutdown_state_provider = deps.shutdown_state_provider
    health_payload_provider = deps.health_payload_provider
    router = APIRouter()

    # The lease routes are shared with the Futu daemon (backend/shared/client_lease_routes.py).
    router.include_router(create_client_lease_router(label="SHIOAJI DAEMON", daemon_instance_id=daemon_instance_id,
                                                     lifecycle_provider=lifecycle_provider))

    @router.websocket('/v1/stream')
    async def stream(websocket: WebSocket):
        if lifecycle_provider().state in {"STOPPING", "STOPPED"} or shutdown_state_provider().get("stopping"):
            # Reject before registering the socket in the fan-out hub or creating a
            # lease. This prevents the half-dead pattern where a stopped runtime keeps
            # accepting fresh normal clients and therefore keeps the process alive.
            try:
                await websocket.close(code=1012, reason="DAEMON_STOPPING")
            except Exception as exc:
                record_failure(logger, "closing a client websocket while the daemon stops", exc)
            return
        startup_realtime_diagnostic.observe_websocket("connect_count")
        client_id = str(websocket.query_params.get("client_id") or "").strip() or f"ws-{uuid.uuid4().hex}"
        connection_id = str(websocket.query_params.get("connection_id") or "").strip() or f"ws-{uuid.uuid4().hex}"
        lease_id = ""
        try:
            lease = lifecycle_provider().attach(
                client_id,
                connection_id=connection_id,
                lease_kind="websocket",
                expires=False,
                client_name="fastapi-daemon-stream",
            )
            lease_id = str(lease.get("lease_id") or "")
        except MarketDaemonLifecycleError:
            # not an error: the daemon is stopping; the client is told so (1012 DAEMON_STOPPING)
            try:
                await websocket.close(code=1012, reason="DAEMON_STOPPING")
            except Exception as exc:
                record_failure(logger, "closing a client websocket while the daemon stops", exc)
            return
        # The lease is held from here on: connecting the socket to the hub is inside the try, so a failure there
        # still detaches it (a leaked never-expiring lease would keep the daemon from idle-stopping).
        try:
            await hub_provider().connect(websocket)
            await hub_provider().send_json(websocket, {
                "type": "system.market_daemon.attached",
                # The first frame is the WebSocket handshake. Never aggregate the
                # recorder/session/native diagnostic locks here: FastAPI cannot mark
                # itself attached (or render durable snapshots) until this arrives.
                "payload": health_payload_provider(),
            })
            while True:
                # Keep this socket full duplex for future client metrics/control without
                # turning market callbacks into request/response traffic.
                message = await websocket.receive_json()
                try:
                    lifecycle_provider().heartbeat(client_id, lease_id=lease_id, connection_id=connection_id)
                except MarketDaemonLifecycleError:
                    # not an error: the daemon is stopping; the client is told so (1012 DAEMON_STOPPING)
                    try:
                        await websocket.close(code=1012, reason="DAEMON_STOPPING")
                    except Exception as exc:
                        record_failure(logger, "closing a client websocket while the daemon stops", exc)
                    break
                if str(message.get("type") or "") == "client.ping":
                    await hub_provider().send_json(websocket, {"type": "daemon.pong", "payload": {"instance_id": daemon_instance_id}})
        except WebSocketDisconnect:  # not an error: the client disconnected; the stream ends
            pass
        except Exception as exc:
            logger.error(f"[SHIOAJI DAEMON] stream client error: {exc}")
        finally:
            startup_realtime_diagnostic.observe_websocket("disconnect_count")
            await hub_provider().disconnect(websocket)
            lifecycle_provider().detach(client_id, lease_id=lease_id or None, connection_id=connection_id)

    return router


__all__ = ["ClientRouteDependencies", "create_client_router"]
