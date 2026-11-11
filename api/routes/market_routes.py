from __future__ import annotations
from dataclasses import dataclass
import logging
from fastapi import APIRouter, Request
from service.platform.http.errors import ServiceUnavailableError, ValidationError, internal_error
from api.routes.dependencies import AttachedCallback, BrokerStatusReader, EventArchive, FutuDaemonClient, ProviderRuntime
from service.market.history.trade_detail_query import trade_page as rust_trade_page

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class MarketRouteDependencies:
    runtime: ProviderRuntime
    futu_client: FutuDaemonClient
    broker_status: BrokerStatusReader
    events: EventArchive | None = None
    on_moomoo_attached: AttachedCallback | None = None


def create_market_router(d: MarketRouteDependencies) -> APIRouter:
    # Past days' event tape: the AnalysisEventArchive (Rust B's event files) every caller passes.
    events = d.events
    router = APIRouter()
    runtime = d.runtime
    moomoo_daemon_client = d.futu_client
    _persistent_broker_status = d.broker_status

    def get_trade_detail_page(
        request: Request,
        market: str, logical_code: str, trading_date: str = "", session: str = "", actual_contract: str = "",
        page: int = 1, page_size: int = 100, snapshot_watermark: int = 0, before_sequence: int = 0,
    ):
        """One page of a session's trades, answered by Market Runtime (trade_detail_query)."""
        metadata_only = str(request.query_params.get("metadata_only") or "").lower() in {"1", "true", "yes", "on"}
        # A stock's trades always belong to one trading day, and the caller names it: the day its view shows, from
        # Market Runtime's session.current. Guessing a day here was a second session owner.
        if str(market or "").upper() == "STK" and not str(trading_date or "").strip():
            raise ValidationError("trading_date is required for STK trades (the day the caller's view shows)",
                                  classification="TRADING_DATE_REQUIRED")
        params = {
            "market": market, "logical_code": logical_code, "trading_date": trading_date, "session": session,
            "actual_contract": actual_contract, "page": max(1, int(page)), "page_size": max(1, min(int(page_size), 100)),
            "snapshot_watermark": max(0, int(snapshot_watermark or 0)), "before_sequence": max(0, int(before_sequence or 0)),
            "metadata_only": bool(metadata_only),
        }
        try:
            return rust_trade_page(
                market=params["market"], code=params["logical_code"],
                trading_date=params["trading_date"], session=params["session"],
                page=params["page"], page_size=params["page_size"],
                snapshot_watermark=params["snapshot_watermark"],
                before_sequence=params["before_sequence"], metadata_only=params["metadata_only"],
            )
        except Exception as exc:
            return {
                **internal_error("[TRADE DETAIL] page", exc, log=logger), "classification": "RUST_DURABLE_PROJECTION_UNAVAILABLE",
                "rows": [], "page": params["page"], "page_size": params["page_size"],
            }


    def get_market_daemon_status():
        return {"ok": True, **runtime.cached_health(), "client": runtime.stream_stats()}


    def get_moomoo_daemon_status():
        return {"ok": True, **moomoo_daemon_client.health(refresh=True), "client": moomoo_daemon_client.stats()}


    def reconnect_moomoo():
        # The background attach loop gives up after a single OPEND_NOT_RUNNING
        # classification instead of polling forever (see
        # MoomooDaemonClient.attach_in_background) -- this is the manual retry
        # the System Connection Diagnostics panel's button calls once the user
        # has actually started/logged into OpenD.
        result = moomoo_daemon_client.manual_reattach()
        if result.get("ok") and d.on_moomoo_attached is not None:
            try:
                d.on_moomoo_attached()
            except Exception as exc:
                logger.warning(f"[APP] Moomoo watchlist restore after manual reconnect failed: {exc}")
        return {"ok": bool(result.get("ok")), **result}


    def get_shioaji_status():
        # The persistent daemon is the only broker-status authority.  Do not expose
        # the broad app proxy shape here as a second provider contract.
        return {"ok": True, **_persistent_broker_status()}


    def sync_shioaji_subscriptions():
        if runtime.app is None:
            raise ServiceUnavailableError("Market Daemon client 尚未初始化", classification="MONITOR_RUNTIME_NOT_READY")
        return runtime.app.broker_service.sync_now()


    def reconnect_shioaji():
        if runtime.app is None:
            raise ServiceUnavailableError("Market Daemon client 尚未初始化", classification="MONITOR_RUNTIME_NOT_READY")
        return runtime.app.broker_service.reconnect()


    # One trading day's events from Rust B's event file (G13): today's tape is Market Runtime's `events.subscribe`.
    # The 事件列表 reads the exact date Market Runtime names (its ARCHIVE presentation) and 歷史回放 its day; the
    # date list the renderer searched through is gone.
    def get_monitor_events(date: str = "", limit: int = 500):
        # Rust B's event file is the only source: nothing writes `signal_event` any more, so there is no raw
        # stream to rebuild a missing day from (the old fallback called a method AnalysisEventArchive never had).
        # The caller names the day (Market Runtime's presentation date, or 歷史回放's day).
        date_text = str(date or "").strip()[:10]
        if not date_text:
            raise ValidationError("date is required (the trading day whose events to read)", classification="DATE_REQUIRED")
        payload = events.read(date_text=date_text, limit=limit)
        # COMPLETE: the day's archive (events or none); PARTIAL: an archive with damaged lines -- what was read is not
        # all the day had; MISSING: B wrote no archive for it -- a day with no events and a day without an archive read
        # the same before.
        if payload.get("archived"):
            payload["coverage"] = "PARTIAL" if payload.get("damaged_lines") else "COMPLETE"
            payload["source"] = "monitor_event_projection"
        else:
            payload["coverage"] = "MISSING"
            payload["source"] = "none"
        return payload


    # What Market Runtime holds is not served here: /api/latest-signals (the renderer asks A's
    # `signals.snapshot`), /api/market/display-session (A's `session.current`) and /api/monitor/context (大單流向
    # is the canonical view's; its Python TradeFlowEngine fill was a second large-order definition).
    routes = (
        ("GET", "/api/trade-detail/page", get_trade_detail_page),
        ("GET", "/api/market-daemon/status", get_market_daemon_status),
        ("GET", "/api/futu-daemon/status", get_moomoo_daemon_status),
        ("POST", "/api/futu-daemon/reconnect", reconnect_moomoo),
        ("GET", "/api/shioaji/status", get_shioaji_status),
        ("POST", "/api/shioaji/sync", sync_shioaji_subscriptions),
        ("POST", "/api/shioaji/reconnect", reconnect_shioaji),
        ("GET", "/api/monitor/events", get_monitor_events),
    )
    for method, path, handler in routes:
        router.add_api_route(path, handler, methods=[method])
    return router

