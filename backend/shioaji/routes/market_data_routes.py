"""TXF-TAIEX market-data / session-diagnostic routes of the Shioaji daemon.

Current-market reads belong to Market Runtime (``service/market/shared/rust_view_client.py``, ``RustViewClient``);
there is no Python canonical/live view authority. What remains here:

- TAIEX/index market-data delegators: ``history_taiex_session``, ``market_index_features``.
- session status/diagnostics: ``market_session_status``, ``selected_session_diagnostic``.

``MarketDataRouteDependencies`` carries the callables these handlers need, bound to the daemon's DaemonContext
(``backend/shioaji/daemon_context.py``) by the composition root (``backend/shioaji/server.py``).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from fastapi import APIRouter

from service.platform.http.errors import ServiceUnavailableError
from service.platform.json_safety import to_json_safe


@dataclass(frozen=True)
class MarketDataRouteDependencies:
    app_provider: Callable[[], Any]
    session_rollover_provider: Callable[[], Any]
    daemon_health_provider: Callable[[], dict[str, Any]]
    route_key: Callable[..., str]
    await_route_work: Callable[..., Any]


def create_market_data_router(deps: MarketDataRouteDependencies) -> APIRouter:
    app_provider = deps.app_provider
    session_rollover_provider = deps.session_rollover_provider
    daemon_health_provider = deps.daemon_health_provider
    router = APIRouter()

    # M8/M9: /v1/views/snapshot, /v1/views/live, /v1/views/diagnostic removed
    # along with the rest of service/market/canonical/'s duplicate live
    # authority. Their sole FastAPI-side consumer (system_routes.py's
    # realtime_views_diagnostic, a diagnostics-only route) is updated
    # separately to stop calling them. Current-market reads belong to Market
    # Runtime (RustViewClient) now -- see service/market/shared/rust_view_client.py.

    @router.get('/v1/session/status')
    def market_session_status():
        return to_json_safe({"ok": True, **session_rollover_provider().status()})

    @router.get('/v1/session/selected-diagnostic')
    def selected_session_diagnostic(market: str, code: str, actual_contract: str = ""):
        payload = session_rollover_provider().selected_product_diagnostic(market=market, logical_code=code, actual_contract=actual_contract)
        health = daemon_health_provider()
        payload["daemon"] = {
            "state": health.get("state"),
            "pid": health.get("daemon_pid"),
            "instance_id": health.get("daemon_instance_id"),
            "runtime_state": health.get("runtime_state"),
            "server_accepting_clients": health.get("server_accepting_clients"),
            "active_client_count": health.get("active_client_count"),
            "stop_reason": health.get("stop_reason"),
        }
        payload["broker"] = {
            "connected": health.get("shioaji_connected"),
            "session_generation": health.get("broker_session_generation"),
            "login_count": health.get("login_count"),
            "reconnect_count": health.get("reconnect_count"),
        }
        if bool(health.get("half_dead")):
            payload["status"] = "DAEMON_HALF_DEAD"
        elif (
            str(health.get("stop_reason") or "") == "idle_timeout"
            and int(health.get("active_client_count") or 0) > 0
        ):
            payload["status"] = "FALSE_IDLE_SHUTDOWN"
        return to_json_safe({"ok": True, **payload})

    @router.get('/v1/history/taiex-session')
    def history_taiex_session(date: str):
        app = app_provider()
        if app is None:
            raise ServiceUnavailableError("daemon runtime not ready", classification="DAEMON_RUNTIME_NOT_READY")
        return {"ok": True, **app.get_market_index_history_session(date)}

    return router


__all__ = [
    "MarketDataRouteDependencies",
    "create_market_data_router",
]
