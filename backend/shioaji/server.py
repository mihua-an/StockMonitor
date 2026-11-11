"""Shioaji daemon HTTP server: the composition root of the sole Shioaji runtime process owner.

It builds the process's one ``DaemonContext`` (``daemon_context.py``) and the FastAPI app over it: the lifespan
starts and stops what the context owns, and every route family -- health/diagnostics, load test, control, market
data, client leases, history, maintenance -- is built from the context or callables bound to it. The health
projection lives in ``daemon_health.py`` and the stop in ``daemon_shutdown.py``.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI

from backend.shioaji.daemon_context import DaemonContext, create_daemon_context
from backend.shioaji.daemon_health import daemon_health, lightweight_health_payload
from backend.shioaji.daemon_shutdown import idle_watchdog, shutdown_daemon
from backend.shioaji.routes import (
    ClientRouteDependencies,
    HistoryRouteDependencies,
    MaintenanceRouteDependencies,
    MarketDataRouteDependencies,
    create_client_router,
    create_health_router,
    create_history_router,
    create_maintenance_router,
    create_market_data_router,
)
from service.market.shared.dataflow_health import dataflow_health_ledger
from service.market.storage.market_storage_layout import require_market_storage_ready
from service.platform.daemon_auth import DaemonAuthenticationMiddleware
from service.platform.http.errors import register_error_handlers
from service.platform.http.safe_json_response import SafeJSONResponse

logger = logging.getLogger(__name__)


def create_daemon_app(ctx: DaemonContext) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        dataflow_health_ledger.set_component_state(lifecycle="STARTING")
        logger.info(f"[SHIOAJI DAEMON] starting new instance={ctx.instance_id} pid={os.getpid()}")
        require_market_storage_ready()
        # The provider daemon is a thin broker adapter. Live market data is never forwarded from here; the hub is
        # only the attach/control channel.
        await ctx.hub.start()
        session_rollover = ctx.session_rollover()
        # Install market-session generation ownership before any runtime producer can emit a live event: the runtime
        # builds its service graph on its own thread and hands it to the owner before starting it.
        ctx.runtime.on_service_built = session_rollover.bind_service
        ctx.runtime.start()
        # Minute-K retention is not run here: its one owner is ShioajiMarketService's maintenance pass (weekdays from
        # 13:50, off the listener's start). Run here as well it read, aggregated and deleted files before the daemon
        # was READY, and only when the runtime thread happened to have built the service already (Codex 1022-ST-08).

        # Market-session ownership is NOT a broker capability: SessionOrchestrator only reads broker_service.status()
        # and the session evidence the event sink already produced, and it never logs in, subscribes or places an
        # order.
        session_rollover.start()
        ctx.idle_watchdog_thread = threading.Thread(target=idle_watchdog, args=(ctx,), name="ShioajiDaemonIdleGrace", daemon=True)
        ctx.idle_watchdog_thread.start()
        ctx.start_route_work()
        dataflow_health_ledger.set_component_state(lifecycle="RUNNING")
        try:
            yield
        finally:
            dataflow_health_ledger.set_component_state(lifecycle="STOPPING")
            await ctx.hub.stop()
            await asyncio.to_thread(shutdown_daemon, ctx, "process_exit")
            dataflow_health_ledger.set_component_state(lifecycle="STOPPED")
            logger.info("[SHIOAJI DAEMON] stopped")

    api = FastAPI(title="Stock Monitor Shioaji Daemon", lifespan=lifespan, default_response_class=SafeJSONResponse)
    api.add_middleware(DaemonAuthenticationMiddleware)
    register_error_handlers(api)

    @api.post("/v1/control/stop")
    async def stop_daemon(reason: str = "explicit_stop"):
        result = await asyncio.to_thread(shutdown_daemon, ctx, reason)
        if result.get("ok") and result.get("durable_handoff_complete"):
            asyncio.get_running_loop().call_later(0.20, ctx.request_server_exit)
        body = {**result, "server_exit_requested": ctx.server_exit_callback is not None}
        if not result.get("ok"):
            # A stop that failed answers 500 with the same state, like Futu's; shutdown_daemon's dict contract stays
            # for its internal callers.
            return SafeJSONResponse(status_code=500, content={"classification": "STOP_FAILED", **body})
        return body

    api.include_router(create_health_router(ctx))
    # Rust owns all live canonical snapshots and deltas. What is left here is read by daemon_client.py over real HTTP
    # (session status, TAIEX history session, index features).
    api.include_router(create_market_data_router(MarketDataRouteDependencies(
        app_provider=ctx.app,
        session_rollover_provider=ctx.session_rollover,
        daemon_health_provider=lambda: daemon_health(ctx),
        route_key=ctx.route_key,
        await_route_work=ctx.await_route_work,
    )))
    # The whole client router, including /v1/stream: FastAPI's service/market/shioaji/daemon_client.py runs a
    # MarketDaemonStream client against it (its "system.market_daemon.attached" seeds the client's health).
    api.include_router(create_client_router(ClientRouteDependencies(
        daemon_instance_id=ctx.instance_id,
        lifecycle_provider=lambda: ctx.lifecycle,
        hub_provider=lambda: ctx.hub,
        shutdown_state_provider=lambda: ctx.shutdown.state,
        health_payload_provider=lambda: lightweight_health_payload(ctx),
    )))
    api.include_router(create_history_router(HistoryRouteDependencies(
        app_provider=ctx.app,
        data_center_service_provider=ctx.data_center_service,
        route_key=ctx.route_key,
        await_route_work=ctx.await_route_work,
    )))
    api.include_router(create_maintenance_router(MaintenanceRouteDependencies(app_provider=ctx.app)))
    return api


# The process's one context and app. run_shioaji_daemon.py serves `api` and reads `daemon_context` (its instance id,
# passive snapshot, server-exit callback and stop verdict).
daemon_context = create_daemon_context()
api = create_daemon_app(daemon_context)
