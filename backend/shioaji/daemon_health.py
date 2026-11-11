"""The Shioaji daemon's health projections, built from its DaemonContext.

``passive_runtime_health_payload`` is the lock-light ownership/readiness snapshot (/health, the passive DataFlow
snapshot FastAPI reads); ``daemon_health_summary`` the compact /v1/health; ``daemon_health`` the on-demand full dump.
"""

from __future__ import annotations

import os
from typing import Any

from backend.shioaji.daemon_context import DaemonContext, safe_call
from config.network_settings import NETWORK_REVISION
from service.market.shared.startup_realtime_diagnostic import startup_realtime_diagnostic
from service.market.shioaji.daemon_contract import (
    MARKET_DAEMON_IDENTITY,
    MARKET_DAEMON_PROTOCOL_VERSION,
    MARKET_DAEMON_RUNTIME_VERSION,
)
from service.market.shioaji.daemon_settings import MARKET_DAEMON_HOST, MARKET_DAEMON_PORT
from service.platform.json_safety import to_json_safe



def _max_subscription_event(subscription_state: dict[str, Any], lane: str) -> str | None:
    values: list[str] = []
    target_lane = str(lane or "").lower()
    for state in subscription_state.values():
        if not isinstance(state, dict):
            continue
        # Legacy stock view nests Tick/BidAsk below the symbol. It also
        # exposes canonical stream identities in a flat map so fixed TXFR1 lanes
        # participate in the same daemon freshness diagnostics.
        nested = state.get(lane)
        if isinstance(nested, dict):
            stamp = str(nested.get("last_event_at") or "")
            if stamp:
                values.append(stamp)
        quote_type = str(state.get("quote_type") or "").lower()
        if quote_type == target_lane:
            stamp = str(state.get("last_event_at") or "")
            if stamp:
                values.append(stamp)
    return max(values) if values else None


def daemon_health(ctx: DaemonContext) -> dict[str, Any]:
    app = ctx.app()
    runtime_status = ctx.runtime.status()
    shioaji = app.broker_service.status() if app is not None else {
        "connected": False,
        "running": False,
        "session_generation": 0,
        "login_count": 0,
        "desired_subscription_count": 0,
        "confirmed_subscription_count": 0,
        "unhealthy_subscription_count": 0,
        "full_subscription_sync_count": 0,
        "delta_subscribe_count": 0,
        "delta_unsubscribe_count": 0,
        "reconnect_count": 0,
        "subscriptions": {},
    }
    subscriptions = shioaji.get("subscriptions") if isinstance(shioaji, dict) else {}
    subscriptions = subscriptions if isinstance(subscriptions, dict) else {}
    subscription_streams = shioaji.get("subscription_streams") if isinstance(shioaji, dict) else {}
    subscription_streams = subscription_streams if isinstance(subscription_streams, dict) else {}
    freshness_state = {**subscriptions, **subscription_streams}
    live_ingress = safe_call(None, lambda: app.live_event_sink.health()) if app is not None else None
    lifecycle = ctx.lifecycle.status()
    lifecycle_state = str(lifecycle.get("state") or "STARTING")
    runtime_state, half_dead = _runtime_state(ctx, lifecycle_state)
    return to_json_safe({
        "ok": True,
        "identity": MARKET_DAEMON_IDENTITY,
        "daemon_instance_id": ctx.instance_id,
        "daemon_pid": os.getpid(),
        "protocol_version": MARKET_DAEMON_PROTOCOL_VERSION,
        "daemon_runtime_version": MARKET_DAEMON_RUNTIME_VERSION,
        "host": MARKET_DAEMON_HOST,
        "port": MARKET_DAEMON_PORT,
        # The network revision this daemon resolved its endpoint from: Health's applier requires it equal.
        "config_revision": NETWORK_REVISION,
        **lifecycle,
        "runtime_state": runtime_state,
        "half_dead": half_dead,
        "server_accepting_clients": bool(lifecycle_state not in {"STOPPING", "STOPPED"} and not ctx.shutdown.state.get("stopping")),
        "session_generation": int(shioaji.get("session_generation") or 0),
        "broker_session_generation": int(shioaji.get("session_generation") or 0),
        "market_session_generation": int((safe_call({}, lambda: ctx.session_rollover_coordinator.status()) if ctx.session_rollover_coordinator is not None else {}).get("market_session_generation") or 0),
        "market_sessions": safe_call({}, lambda: ctx.session_rollover_coordinator.status()) if ctx.session_rollover_coordinator is not None else {},
        "shioaji_connected": bool(shioaji.get("connected")),
        "shioaji_login_at": shioaji.get("last_login_at"),
        "shioaji_version": shioaji.get("version"),
        "daemon_lifetime_login_count": int(shioaji.get("daemon_lifetime_login_count") or shioaji.get("login_count") or 0),
        "login_count": int(shioaji.get("login_count") or 0),
        "reconnect_count": int(shioaji.get("reconnect_count") or 0),
        "last_login_attempt_at": shioaji.get("last_login_attempt_at"),
        "desired_subscription_count": int(shioaji.get("desired_subscription_count") or 0),
        "confirmed_subscription_count": int(shioaji.get("confirmed_subscription_count") or 0),
        "healthy_subscription_count": int(shioaji.get("healthy_subscription_count") or 0),
        "unhealthy_subscription_count": int(shioaji.get("unhealthy_subscription_count") or 0),
        "subscription_limit": int(shioaji.get("subscription_limit") or 200),
        # 設定 → 永豐行情連線: the setting and each open connection with what it holds (session.py _connections_status).
        "subscription_connections": shioaji.get("connections") or {},
        "active_subscription_count": int(shioaji.get("active_subscription_count") or 0),
        "available_subscription_slots": int(shioaji.get("available_subscription_slots") or 0),
        "planned_instrument_count": int(shioaji.get("planned_instrument_count") or 0),
        "refused_instruments": shioaji.get("refused_instruments") or [],
        "history_repository": safe_call({}, lambda: app.historical_repository.lightweight_metrics()) if app is not None else {},
        "full_subscription_sync_count": int(shioaji.get("full_subscription_sync_count") or 0),
        "delta_subscribe_count": int(shioaji.get("delta_subscribe_count") or 0),
        "delta_unsubscribe_count": int(shioaji.get("delta_unsubscribe_count") or 0),
        "last_tick_at": _max_subscription_event(freshness_state, "Tick"),
        "last_bidask_at": _max_subscription_event(freshness_state, "BidAsk"),
        "last_market_callback_at": shioaji.get("last_callback_at"),
        # The sink to Market Runtime (rust_live.py health()), named and shaped as the Futu daemon's event_sink.
        "event_sink": live_ingress,
        "historicalctx.route_work": ctx.route_work_metrics(),
        "shutdown": {
            "stopping": bool(ctx.shutdown.state.get("stopping")),
            "stopped": bool(ctx.shutdown.state.get("stopped")),
            "reason": ctx.shutdown.state.get("reason"),
            "phase": ((ctx.shutdown.state.get("phases") or [{}])[-1].get("phase") if (ctx.shutdown.state.get("phases") or []) else None),
        },
        "source": "shioaji",
        "source_status": runtime_status.get("source_status"),
        "monitor_runtime": runtime_status,
        "clients": ctx.hub.stats(),
        "shioaji": shioaji,
        "last_error": (
            "DAEMON_HALF_DEAD: market runtime stopped while server process is alive"
            if half_dead else None
        ) or runtime_status.get("last_error") or shioaji.get("last_error"),
    })


def _runtime_state(ctx: DaemonContext, lifecycle_state: str) -> tuple[str, bool]:
    """(runtime_state, half_dead), the one verdict of every health payload. Takes no lock: the passive heartbeat must
    answer while broker and session locks are held, so it reads the runtime thread itself, never runtime.status()."""
    thread = ctx.runtime.thread
    half_dead = lifecycle_state not in {"STARTING", "STOPPING", "STOPPED"} and not (thread is not None and thread.is_alive())
    return ("DAEMON_HALF_DEAD" if half_dead else lifecycle_state), half_dead


def daemon_health_summary(ctx: DaemonContext) -> dict[str, Any]:
    """Compact diagnostics DTO. Never walks full subscriptions/trace journals."""
    base = lightweight_health_payload(ctx)
    app = ctx.app()
    live_ingress = safe_call({}, lambda: app.live_event_sink.health()) if app is not None else {}
    live_ingress = live_ingress if isinstance(live_ingress, dict) else {}
    return to_json_safe({
        **base,
        # The whole sink record, durable_pending and transport_errors included, as the Futu daemon reports it.
        "event_sink": live_ingress,
        "diagnostics_full_endpoint": "/v1/diagnostics/full",
    })


def passive_runtime_health_payload(ctx: DaemonContext, *, include_sessions: bool = False) -> dict[str, Any]:
    """Lock-light producer snapshot that does not claim HTTP readiness."""
    # Startup liveness must not enter broker/native/repository status locks.  The
    # detailed ``daemon_health`` payload intentionally aggregates those systems
    # and can therefore be delayed while Shioaji is logging in or a native frame
    # is being materialised. Electron only needs an ownership/protocol handshake
    # here; detailed diagnostics remain available from /v1/health.
    # This endpoint is the OS-process ownership handshake.  It must remain
    # responsive even when shutdown/session locks are contended by
    # pandas work.  Reading these atomic Python references is sufficient here;
    # detailed locked state remains available from /v1/health.
    lifecycle_state = str(getattr(ctx.lifecycle, "_state", "STARTING") or "STARTING")
    app = ctx.app()
    broker = app.broker_service.lightweight_status() if app is not None else {}
    # ui/main/startup_lifecycle.js's `payload?.live_ingress?.running === true ||
    # payload?.live_ingress?.ready === true` startup gate reads the `live_ingress`
    # field below; it reflects only this daemon's live-ingress sink (the
    # connection to the external Market Runtime), never live market state.
    ingress_health = safe_call({}, lambda: app.live_event_sink.health()) if app is not None else {}
    ingress_running = bool(ingress_health.get("running"))
    ingress_accepting = ingress_running
    market_sessions = (
        ctx.session_rollover_coordinator.lightweight_status()
        if include_sessions and ctx.session_rollover_coordinator is not None
        else {}
    )
    return {
        "ok": True,
        "identity": MARKET_DAEMON_IDENTITY,
        "daemon_instance_id": ctx.instance_id,
        "daemon_pid": os.getpid(),
        "protocol_version": MARKET_DAEMON_PROTOCOL_VERSION,
        "daemon_runtime_version": MARKET_DAEMON_RUNTIME_VERSION,
        "host": MARKET_DAEMON_HOST,
        "port": MARKET_DAEMON_PORT,
        # The network revision this daemon resolved its endpoint from: Health's applier requires it equal.
        "config_revision": NETWORK_REVISION,
        "runtime_state": _runtime_state(ctx, lifecycle_state)[0],
        "shioaji_connected": bool(broker.get("connected")),
        "live_ingress": {
            "ready": bool(ingress_running and ingress_accepting),
            "running": ingress_running,
            "accepting_hydration": ingress_accepting,
            # This source's own events Market Runtime acknowledged: 連線診斷 animates Shioaji -> Rust A on it,
            # never on A's intake total, which the other source also feeds.
            "acked": ingress_health.get("acked"),
            # The sink's queue to Market Runtime (rust_live.py stats()), shown as 事件佇列 for both providers.
            "queue_depth": ingress_health.get("queue_depth"), "capacity": ingress_health.get("capacity"),
            "authority": {
                "schema": "live-ingress-health-v1",
                "authority": "RustDaemonEventSink",
                "role": "SHIOAJI_DAEMON_LIVE_INGRESS_HEALTH",
                "live_state_authority": False,
                "note": "Market Runtime (external process) is the sole live authority",
            },
        },
        "session_generation": int(broker.get("session_generation") or 0),
        "broker_session_generation": int(broker.get("session_generation") or 0),
        "market_session_generation": int(market_sessions.get("market_session_generation") or 0),
        "login_count": int(broker.get("login_count") or 0),
        "reconnect_count": int(broker.get("reconnect_count") or 0),
        "last_market_callback_at": broker.get("last_callback_at"),
        "last_login_attempt_at": broker.get("last_login_attempt_at"),
        # The successful login of this broker session: 系統拓樸 Shioaji SDK 連線時長 counts from it (it read a field
        # this payload never carried, so the tile was always empty -- 10-14).
        "last_login_at": broker.get("last_login_at"),
        # /api/status's provider envelope reads `source_status` from this passive snapshot (FastAPI's cached_health()).
        "source_status": safe_call(None, ctx.runtime.lightweight_source_status),
        "market_sessions": market_sessions,
        "shioaji": broker,
        "server_accepting_clients": bool(
            lifecycle_state not in {"STOPPING", "STOPPED"}
            and not ctx.shutdown.state.get("stopping")
        ),
    }


def lightweight_health_payload(ctx: DaemonContext) -> dict[str, Any]:
    startup_realtime_diagnostic.mark("DAEMON_HTTP_READY", once=True)
    return passive_runtime_health_payload(ctx)
