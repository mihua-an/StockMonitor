"""The client-lease routes both provider daemons serve (/v1/client/attach, heartbeat, detach).

One factory, given the daemon's own lifecycle manager and instance id; each daemon mounts it, so both daemons
answer a refused lease the same way and log a detach that leaves clients behind the same way.
"""
from __future__ import annotations

import logging
from typing import Any, Callable

from fastapi import APIRouter

from backend.shared.daemon_models import ClientAttachRequest, ClientLeaseRequest
from service.market.lifecycle.daemon import MarketDaemonLifecycleError
from service.platform.http.errors import ServiceUnavailableError

logger = logging.getLogger(__name__)


def create_client_lease_router(*, label: str, daemon_instance_id: str, lifecycle_provider: Callable[[], Any]) -> APIRouter:
    router = APIRouter()

    @router.post("/v1/client/attach")
    async def attach_client(req: ClientAttachRequest):
        lifecycle = lifecycle_provider()
        try:
            result = lifecycle.attach(
                req.client_id,
                lease_id=req.lease_id or None,
                connection_id=req.connection_id or "control",
                lease_kind="heartbeat",
                expires=True,
                client_name=req.client_name,
                client_pid=req.client_pid,
                electron_pid=req.electron_pid,
            )
        except MarketDaemonLifecycleError as exc:
            raise ServiceUnavailableError(str(exc), classification="CLIENT_ATTACH_REJECTED")
        if result.get("idle_shutdown_cancelled"):
            logger.info(f"[{label}] client reattached; idle shutdown cancelled clients={result.get('client_count')}")
        else:
            logger.info(f"[{label}] active clients={result.get('client_count')}")
        return {**result, "daemon_instance_id": daemon_instance_id}

    @router.post("/v1/client/heartbeat")
    async def heartbeat_client(req: ClientLeaseRequest):
        lifecycle = lifecycle_provider()
        try:
            result = lifecycle.heartbeat(req.client_id, lease_id=req.lease_id or None,
                                         connection_id=req.connection_id or "control")
        except MarketDaemonLifecycleError as exc:
            raise ServiceUnavailableError(str(exc), classification="CLIENT_HEARTBEAT_REJECTED")
        return {**result, "daemon_instance_id": daemon_instance_id}

    @router.post("/v1/client/detach")
    async def detach_client(req: ClientLeaseRequest):
        lifecycle = lifecycle_provider()
        result = lifecycle.detach(req.client_id, lease_id=req.lease_id or None, connection_id=req.connection_id or "control")
        if result.get("entered_idle_grace"):
            status = lifecycle.status()
            logger.info(f"[{label}] client detached; clients=0; entering idle grace "
                        f"timeout={status.get('idle_timeout_seconds')}s")
        else:
            logger.info(f"[{label}] client detached; clients={result.get('client_count')}")
        return {**result, "daemon_instance_id": daemon_instance_id, **lifecycle.status()}

    return router
