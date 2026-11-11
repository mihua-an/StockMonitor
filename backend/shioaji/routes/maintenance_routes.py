"""Daemon maintenance and broker-control routes of the Shioaji daemon.

``MaintenanceRouteDependencies`` carries ``app_provider``, bound to the daemon's DaemonContext by the composition
root (``backend/shioaji/server.py``): this module never imports or constructs the running service itself.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from fastapi import APIRouter

from service.platform.http.errors import ServiceUnavailableError
from backend.shioaji.models import (
    PostSessionMaintenanceRequest,
)
from service.market.reference.security_master_service import SecurityMasterService
from service.market.storage.market_storage_layout import process_market_layout
from service.platform.json_safety import to_json_safe


@dataclass(frozen=True)
class MaintenanceRouteDependencies:
    app_provider: Callable[[], Any]


def create_maintenance_router(deps: MaintenanceRouteDependencies) -> APIRouter:
    app_provider = deps.app_provider
    router = APIRouter()

    @router.post('/v1/post-session-maintenance')
    def post_session_maintenance(req: PostSessionMaintenanceRequest):
        # Manual/admin trigger only: per docs/system-architecture/03_protocol_and_storage.md §1 this must not
        # mutate via ``recorder.post_session_maintenance()`` directly -- it
        # requests SessionOrchestrator's single mutation boundary instead, the
        # same one the automatic rollover finalizer uses.
        app = app_provider()
        orchestrator = getattr(app, "market_session_rollover", None) if app is not None else None
        if orchestrator is None or not hasattr(orchestrator, "request_manual_post_session_maintenance"):
            raise ServiceUnavailableError("daemon runtime not ready", classification="MARKET_RECORDER_MAINTENANCE_UNAVAILABLE")
        try:
            result = orchestrator.request_manual_post_session_maintenance(
                market=req.market,
                trading_date=req.trading_date,
                session=req.session,
                actual_contract=req.actual_contract,
                compact_raw=bool(req.compact_raw),
                timeout=float(req.timeout_seconds),
            )
        except RuntimeError as exc:
            # The orchestrator's deliberate "not ready" code only; any other error reaches the logged catch-all.
            if str(exc) != "MARKET_RECORDER_MAINTENANCE_UNAVAILABLE":
                raise
            raise ServiceUnavailableError("daemon runtime not ready", classification="MARKET_RECORDER_MAINTENANCE_UNAVAILABLE") from exc
        return to_json_safe(result)

    @router.get('/v1/shioaji/status')
    def shioaji_status():
        app = app_provider()
        if app is None:
            raise ServiceUnavailableError("daemon runtime not ready", classification="DAEMON_RUNTIME_NOT_READY")
        return {"ok": True, **app.broker_service.status()}

    def _run_shioaji_control(action: str, **kwargs: Any) -> dict[str, Any]:
        """Dispatch the daemon's small, explicit broker-control surface."""
        app = app_provider()
        if app is None:
            raise ServiceUnavailableError("daemon runtime not ready", classification="DAEMON_RUNTIME_NOT_READY")
        operations = {
            "sync_now": app.broker_service.sync_now,
            "reconnect": app.broker_service.reconnect,
        }
        return operations[action](**kwargs)

    @router.post('/v1/shioaji/sync')
    def shioaji_sync():
        result = _run_shioaji_control("sync_now")
        return result if result.get("ok") is not False or "error" not in result else {**result, "message": result.get("error")}

    @router.post('/v1/shioaji/reconnect')
    def shioaji_reconnect():
        result = _run_shioaji_control("reconnect")
        return result if result.get("ok") is not False or "error" not in result else {**result, "message": result.get("error")}

    @router.post('/v1/history/fill-gaps')
    def history_fill_gaps(body: dict[str, Any]):
        """A closed session's gaps from the broker's history (scripts/fill_history_gaps.py); nothing is published."""
        app = app_provider()
        if app is None:
            raise ServiceUnavailableError("daemon runtime not ready", classification="DAEMON_RUNTIME_NOT_READY")
        return to_json_safe(app.broker_service.fill_history_windows(list(body.get("items") or [])))

    @router.post('/v1/control/credentials-changed')
    def credentials_changed():
        # Credentials themselves never cross this IPC. The daemon re-loads them from
        # the canonical Windows Credential Manager during the controlled reconnect.
        result = _run_shioaji_control("reconnect", reason="credentials_changed")
        return result if result.get("ok") is not False or "error" not in result else {**result, "message": result.get("error")}

    # app_api follows this master's writes here and rebuilds the product catalog (security_master_feed.py).
    @router.get('/v1/security-master/events')
    def security_master_events():
        from service.market.reference import security_master_feed

        return security_master_feed.events_response("shioaji", process_market_layout().shioaji_security_master)

    def security_master_maintenance() -> dict[str, Any]:
        """Write the security master now (an explicit refresh) through the provider's maintenance owner. Today's master
        is the login's to write (ShioajiService._on_shioaji_connected); the product catalog follows its write notice."""
        app = app_provider()
        if app is None:
            raise ServiceUnavailableError("daemon runtime not ready", classification="DAEMON_RUNTIME_NOT_READY")
        # Shioaji contract enumeration (especially contracts.info per symbol) can
        # monopolize the provider's Python/API lane for many seconds. During PREOPEN
        # or LIVE that would delay Tick/BidAsk callbacks and make the selected panel
        # appear empty even though the broker socket is connected. SessionPolicy is
        # authoritative: keep using the local master and defer this maintenance job
        # until the market-data lane no longer owns real-time traffic.
        # A runtime without a session orchestrator (maintenance/repair) has no live lane to protect. One that has it
        # but cannot report its phase is treated as not CLOSED: the old `except: pass` here ran the full contract
        # enumeration exactly when lifecycle state was failing -- fail-open on the real-time process.
        rollover_owner = getattr(app, "market_session_rollover", None)
        if rollover_owner is not None:
            try:
                rollover = dict(rollover_owner.status() or {})
                stock_decision = dict(
                    ((rollover.get("session_policy") or {}).get("decisions") or {}).get("STK") or {}
                )
                phase = str(stock_decision.get("phase") or "").upper()
            except Exception as exc:
                from service.platform.http.errors import logged_error
                phase, status_error = "", logged_error("maintenance session status", exc)
            else:
                status_error = ""
            # Fail closed while lifecycle identity is still being established. An
            # empty/unknown phase is a startup race, not permission to run provider
            # maintenance on the real-time process.
            if phase != "CLOSED":
                local = SecurityMasterService(process_market_layout().shioaji_security_master)
                return {
                    "ok": True,
                    "deferred": True,
                    "count": len(local.load_master()),
                    "phase": phase,
                    "reason": ("LIVE_MARKET_DATA_PRIORITY" if phase in {"PREOPEN", "LIVE"}
                               else "SESSION_STATUS_UNAVAILABLE" if status_error else "SESSION_PHASE_NOT_READY"),
                    "preserved_existing": local.master_file.exists(),
                    "file": str(local.master_file),
                    "errors": [status_error] if status_error else [],
                }
        coordinator = app.market_maintenance_coordinator
        api = app.broker_service.get_api()
        if api is None:
            # The master and the futures table are written from the broker's contracts, which exist only once logged in.
            raise ServiceUnavailableError("Shioaji is not logged in", classification="BROKER_NOT_LOGGED_IN")
        return coordinator.refresh_connected(api)

    @router.post('/v1/security-master/refresh')
    def refresh_security_master():
        return security_master_maintenance()

    return router


__all__ = [
    "MaintenanceRouteDependencies",
    "create_maintenance_router",
]
