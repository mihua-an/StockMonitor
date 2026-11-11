from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Callable
from datetime import datetime
from config.source_settings import SOURCE_SETTINGS, source_enabled
from service.market.shared.source_runtime import disabled_source
from service.market.shioaji.daemon_contract import MARKET_DAEMON_IDENTITY
from service.market.shioaji.daemon_probe import is_daemon_usable
from service.market.shared.provider_contract import (
    ORDINARY_STALE_SECONDS,
    provider_link_online,
    provider_readiness,
)
from api.routes.dependencies import BrokerStatusReader, MarketSessionsReader, SourceStatusSnapshot


@dataclass(frozen=True)
class SourceDiagnostics:
    broker_status: BrokerStatusReader
    market_sessions: MarketSessionsReader
    status_snapshot: SourceStatusSnapshot


def timestamp_age_seconds(timestamp: Any, *, clock: Callable[..., datetime] = datetime.now) -> float | None:
    """Seconds since an ISO-8601 timestamp (never negative); None for none or one that is not ISO-8601.

    Only what the contract allows is "no age": an empty value or a string that does not parse (ValueError). Anything
    else -- the clock, the arithmetic -- is a fault and is raised, not shown as a missing age.
    """
    if not timestamp:
        return None
    try:
        parsed = datetime.fromisoformat(str(timestamp).replace("Z", "+00:00"))
    except ValueError:  # not an error: a timestamp that is not ISO has no age (None) by contract
        return None
    now = clock(parsed.tzinfo) if parsed.tzinfo else clock()
    return max(0.0, (now - parsed).total_seconds())


def create_source_diagnostics(runtime, futu_client, *, clock: Callable[..., datetime] = datetime.now) -> SourceDiagnostics:
    """Read daemon-owned truth; never acquire broker or recovery ownership."""
    moomoo_daemon_client = futu_client

    def _age_seconds(timestamp: Any) -> float | None:
        return timestamp_age_seconds(timestamp, clock=clock)


    def _market_sessions(health: dict[str, Any] | None = None) -> dict[str, Any]:
        """The daemon's session diagnostics (``/health`` can omit them while a freshly spawned daemon logs in). Which
        session the screens show is not here: Market Runtime pushes it to every window (session.current)."""
        source = health if isinstance(health, dict) else {}
        market_sessions = source.get("market_sessions") if isinstance(source.get("market_sessions"), dict) else {}
        return dict(market_sessions or {})


    def _persistent_broker_status() -> dict[str, Any]:
        """Current broker truth from the Persistent Market Daemon only.

        App-side native/egress bridge state is intentionally diagnostic-only.
        A stale startup error must never override a currently healthy daemon.
        """
        health = runtime.cached_health()
        health = health if isinstance(health, dict) else {}
        daemon_reachable = bool(health.get("ok") and str(health.get("identity") or "") == MARKET_DAEMON_IDENTITY)
        daemon_compatible = bool(daemon_reachable and is_daemon_usable(health))
        shioaji = health.get("shioaji") if isinstance(health.get("shioaji"), dict) else {}
        shioaji_readiness = shioaji.get("readiness") if isinstance(shioaji.get("readiness"), dict) else {}
        callback_lanes = health.get("callback_lanes") if isinstance(health.get("callback_lanes"), dict) else {}
        shioaji_connected = bool(health.get("shioaji_connected") or shioaji.get("connected"))
        link_online = provider_link_online(connected=shioaji_connected)
        last_tick_at = health.get("last_tick_at")
        last_bidask_at = health.get("last_bidask_at")
        callback_timestamps = [
            str(row.get("source_timestamp") or "")
            for row in callback_lanes.values() if isinstance(row, dict) and row.get("source_timestamp")
        ]
        last_market_callback_at = (
            health.get("last_market_callback_at")
            or shioaji.get("last_callback_at")
            or (max(callback_timestamps) if callback_timestamps else None)
        )
        callback_age = _age_seconds(last_market_callback_at or max([str(last_tick_at or ""), str(last_bidask_at or "")]))

        market_sessions = _market_sessions(health)
        expected_sessions = market_sessions.get("expected") if isinstance(market_sessions.get("expected"), dict) else {}
        active_sessions = market_sessions.get("active") if isinstance(market_sessions.get("active"), dict) else {}
        any_expected_live = any(bool((item or {}).get("live")) for item in expected_sessions.values() if isinstance(item, dict))
        any_active = any(bool((item or {}).get("state") == "ACTIVE") for item in active_sessions.values() if isinstance(item, dict))

        fut_expected = expected_sessions.get("FUT") if isinstance(expected_sessions.get("FUT"), dict) else {}
        txf = shioaji.get("txf") if isinstance(shioaji.get("txf"), dict) else {}
        txf_lanes: dict[str, Any] = {}
        # TXFR1 deliberately owns one Quote lane, mirroring TAIEX. Tick/BidAsk are
        # not expected health dependencies because live trade-detail/five-level
        # subscriptions are intentionally disabled.
        for lane_name, max_receive_age in (("Quote", 120.0),):
            lane = txf.get(lane_name) if isinstance(txf.get(lane_name), dict) else {}
            ledger_lane = callback_lanes.get("futures.quote") if isinstance(callback_lanes.get("futures.quote"), dict) else {}
            if not lane and ledger_lane:
                lane = {
                    "confirmed": int(ledger_lane.get("observed") or 0) > 0,
                    "health": "HEALTHY",
                    "market_session": ledger_lane.get("session"),
                    "session_generation": ledger_lane.get("generation"),
                    "last_event_at": ledger_lane.get("source_timestamp"),
                    "last_exchange_timestamp": ledger_lane.get("source_timestamp"),
                    "receive_age_seconds": ledger_lane.get("age_seconds"),
                }
            try:
                receive_age = float(lane.get("receive_age_seconds")) if lane.get("receive_age_seconds") is not None else _age_seconds(lane.get("last_event_at"))
            except (TypeError, ValueError):  # not an error: a receive age that is not a number is taken from the lane's last event time
                receive_age = _age_seconds(lane.get("last_event_at"))
            exchange_age = _age_seconds(lane.get("last_exchange_timestamp"))
            # The callback ledger lane carries no session/generation (both arrive empty); a missing value is not a
            # mismatch, otherwise a lane updating every second read as FUT_QUOTE_STALE all session.
            lane_generation = int(lane.get("session_generation") or 0)
            lane_session = str(lane.get("market_session") or "").upper()
            generation_ok = not lane_generation or lane_generation == int(health.get("session_generation") or shioaji.get("session_generation") or 0)
            session_ok = not fut_expected.get("live") or not lane_session or lane_session == str(fut_expected.get("session") or "").upper()
            healthy = bool(
                lane.get("confirmed")
                and generation_ok
                and session_ok
                and str(lane.get("health") or "HEALTHY").upper() not in {"STALE", "UNSUBSCRIBE_UNCERTAIN"}
                and (receive_age is None or receive_age <= max_receive_age)
                and (exchange_age is None or exchange_age <= max_receive_age * 2.0)
            )
            txf_lanes[lane_name] = {
                # Whether the provider reported any evidence for this lane at all. No evidence is UNKNOWN, not
                # stale: the rebuilt provider reports neither shioaji.txf nor callback_lanes, and treating that as
                # stale showed 「永豐 已連線（行情停滯）」 all through trading while TXFR1 updated every minute.
                "known": bool(lane),
                "healthy": healthy, "confirmed": bool(lane.get("confirmed")),
                "health": lane.get("health"), "market_session": lane.get("market_session"),
                "session_generation": lane.get("session_generation"),
                "last_event_at": lane.get("last_event_at"),
                "last_exchange_timestamp": lane.get("last_exchange_timestamp"),
                "receive_age_seconds": receive_age, "exchange_age_seconds": exchange_age,
            }

        stale_reason = None
        state = "CONNECTED"
        if not daemon_reachable:
            state = "DISCONNECTED"
            stale_reason = "DAEMON_UNREACHABLE"
        elif not daemon_compatible:
            state = "DISCONNECTED"
            stale_reason = "DAEMON_INCOMPATIBLE"
        elif not link_online:
            state = "DISCONNECTED"
            stale_reason = "SHIOAJI_DISCONNECTED"
        elif not any_expected_live and expected_sessions:
            state = "CONNECTED_MARKET_CLOSED"
            stale_reason = "MARKET_SESSION_CLOSED"
        elif any_expected_live and not any_active and not bool(shioaji_readiness.get("market_data_ready")):
            state = "CONNECTED_WAITING_SESSION"
            stale_reason = "SESSION_NOT_BOOTSTRAPPED"
        elif bool(fut_expected.get("live")) and bool((txf_lanes.get("Quote") or {}).get("known"))                 and not bool((txf_lanes.get("Quote") or {}).get("healthy")):
            state = "CONNECTED_STREAM_STALE"
            stale_reason = "FUT_QUOTE_STALE"
        elif any_expected_live and callback_age is not None and callback_age > ORDINARY_STALE_SECONDS:
            # Silence outside an expected-live session is IDLE, not stale.  This
            # guard is what keeps a closed market -- and a cold start whose
            # session ownership has not been published yet -- from reporting
            # 「資料停滯」 the moment a real last-callback timestamp exists.
            state = "CONNECTED_STREAM_STALE"
            stale_reason = "ACTIVE_STREAM_CALLBACK_STALE"

        canonical_ready = bool(
            ((health.get("live_ingress") or {}).get("ready"))
            if isinstance(health.get("live_ingress"), dict)
            else False
        ) or bool(shioaji_readiness.get("canonical_ready"))
        market_data_ready = bool(shioaji_readiness.get("market_data_ready")) or state == "CONNECTED"
        readiness = provider_readiness(
            provider="shioaji",
            connected=daemon_reachable and daemon_compatible and link_online,
            market_data_ready=market_data_ready,
            canonical_ready=canonical_ready,
            market_closed=state == "CONNECTED_MARKET_CLOSED",
            waiting_session=state == "CONNECTED_WAITING_SESSION",
            stale_reason=stale_reason if state == "CONNECTED_STREAM_STALE" else None,
        )
        return {
            "authority": "persistent_market_daemon",
            "state": state,
            "daemon_reachable": daemon_reachable,
            "daemon_compatible": daemon_compatible,
            "daemon_instance_id": health.get("daemon_instance_id"),
            "daemon_runtime_version": health.get("daemon_runtime_version"),
            "shioaji_connected": shioaji_connected,
            "session_generation": int(health.get("session_generation") or shioaji.get("session_generation") or 0),
            "broker_session_generation": int(health.get("broker_session_generation") or health.get("session_generation") or 0),
            "market_session_generation": int(health.get("market_session_generation") or 0),
            "readiness": readiness,
            "market_sessions": market_sessions,
            "login_count": int(health.get("login_count") or shioaji.get("login_count") or 0),
            "reconnect_count": int(health.get("reconnect_count") or shioaji.get("reconnect_count") or 0),
            "last_tick_at": last_tick_at,
            "last_bidask_at": last_bidask_at,
            "last_market_callback_at": last_market_callback_at,
            "callback_age_seconds": callback_age,
            "txf_lanes": txf_lanes,
            "stale_reason": stale_reason,
            # 設定 → 永豐行情連線 shows these (the provider's lightweight status, session.py _connections_status).
            "subscription_connections": shioaji.get("connections") or {},
            "active_subscription_count": shioaji.get("active_subscription_count"),
            "subscription_limit": shioaji.get("subscription_limit"),
        }


    def source_status_snapshot() -> dict[str, dict[str, Any]]:
        """One provider-neutral status envelope; daemon details stay source-owned."""
        statuses: dict[str, dict[str, Any]] = {}
        for source in SOURCE_SETTINGS["sources"]:
            if not source_enabled(source):
                statuses[source] = disabled_source(source)["source_status"]
                continue
            health = runtime.cached_health() if source == "shioaji" else moomoo_daemon_client.cached_health()
            owner = health.get("source_status") or (health.get("monitor_runtime") or {}).get("source_status")
            statuses[source] = owner or {
                "contract_version": 1, "source": source, "enabled": True,
                "lifecycle": "starting", "start_accepted": None,
                "services_started": None, "broker_connected": None,
                "services_ready": None, "health": "waiting",
                "reason": "DAEMON_STATUS_UNAVAILABLE",
            }
        return statuses

    return SourceDiagnostics(_persistent_broker_status, _market_sessions, source_status_snapshot)
