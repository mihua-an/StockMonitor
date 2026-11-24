from __future__ import annotations

from dataclasses import dataclass
from typing import Any
import logging
from fastapi import APIRouter
from service.platform.http.errors import ServiceUnavailableError, ValidationError
from service.platform.http.safe_json_response import SafeJSONResponse
from api.routes.dependencies import DataCatalog, DayTradeLedger, ProviderApp, ReplayService
from service.market.history.technical_history import valid_code
from service.market.shared.session_identity_contract import iso_trading_date

logger = logging.getLogger(__name__)


def product_code(value: Any) -> str:
    """A K-bar request's product code as the K-bar store names its file (valid_code), else the caller's 400."""
    code = str(value or "").strip().upper()
    if not valid_code(code):
        raise ValidationError("invalid code")
    return code


def _daemon_app(runtime: ProviderApp, method: str):
    """The provider runtime when it answers `method` (the Market Daemon's K-bar calls), else 503 while it starts."""
    app = runtime.app
    if app is None or not hasattr(app, method):
        raise ServiceUnavailableError("Market Daemon client 尚未初始化", classification="MONITOR_RUNTIME_NOT_READY")
    return app


@dataclass(frozen=True)
class HistoryRouteDependencies:
    """history_api's routes: the provider runtime, the replay service and the actual-account ledger (交易明細)."""
    runtime: ProviderApp
    replay: ReplayService
    account: DayTradeLedger


@dataclass(frozen=True)
class DataCenterRouteDependencies:
    """data_center_api's routes: the provider runtime, else the local data catalog."""
    runtime: ProviderApp
    # None when this process has no local catalog (a lazily built one resolves on first use).
    data_center: DataCatalog | None


def create_history_router(deps: HistoryRouteDependencies) -> APIRouter:
    runtime = deps.runtime
    history_replay_service = deps.replay
    actual_account_service = deps.account
    router = APIRouter()

    # There is no /api/market/taiex: the TAIEX day Market Runtime holds is read over the WS
    # (即時報價 subscribes it; 歷史回放 reads one snapshot for a day not stored yet).
    @router.get('/api/history/taiex-session')
    def get_history_taiex_session(date: str):
        if runtime.app is None:
            raise ServiceUnavailableError("Market Daemon client 尚未初始化", classification="MONITOR_RUNTIME_NOT_READY")
        try:
            payload = runtime.app.get_market_index_history_session(date)
            return {"ok": True, **payload}
        except ValueError:
            raise ValidationError("invalid date")

    @router.get('/api/history/dates')
    def get_history_dates():
        dates = history_replay_service.list_dates()
        return {
            "ok": True,
            "count": len(dates),
            "dates": dates,
        }

    @router.get('/api/history/pair-indexes')
    def get_history_pair_indexes(date: str, code: str):
        """帳務 配對回放's 走勢資訊: the day's stored TAIEX and the stock's 產業指數 minute points."""
        try:
            return {"ok": True, **history_replay_service.get_pair_indexes(date, code)}
        except ValueError:
            raise ValidationError("invalid date or code")

    @router.get('/api/history/kline')
    def get_history_kline(code: str, market: str = "STK", session: str = "DAY", resolution: str = "day", before: str | None = None, limit: int | None = None):
        """技術分析's history, local only: one page of minute days (`minute`) or daily bars (`day`) before `before`,
        and `next_before` for the next older page (null: nothing older here)."""
        try:
            result = history_replay_service.get_kline(code, market, session, resolution, before, limit)
        except ValueError:
            raise ValidationError("invalid code, market, session, resolution or date")
        return {"ok": True, **result}

    @router.post('/api/history/kline/older')
    def request_older_kline(payload: dict[str, Any]):
        """技術分析 scrolled to its oldest local bar: earlier bars from the broker, into the store /api/history/kline reads."""
        code = product_code((payload or {}).get("code"))
        try:
            before = iso_trading_date((payload or {}).get("before") or "")
        except ValueError:
            raise ValidationError("invalid date")
        return _daemon_app(runtime, "request_older_kbars").request_older_kbars(code, before)

    @router.get('/api/history/kline/older')
    def older_kline_status(code: str):
        return _daemon_app(runtime, "older_kbars_status").older_kbars_status(product_code(code))

    @router.get('/api/history/stocks')
    def get_history_stocks(date: str, summary: bool = True):
        try:
            stocks = history_replay_service.list_stocks(date, include_summaries=summary)
            return {
                "ok": True,
                "date": date,
                "count": len(stocks),
                "stocks": stocks,
                "timing": dict(history_replay_service.status().get("timing") or {}),
            }
        except ValueError:
            raise ValidationError("invalid date")

    @router.get('/api/history/txf-session')
    def get_history_txf_session(date: str):
        try:
            payload = history_replay_service.get_reference_tick_session(date)
            return {"ok": True, **payload}
        except ValueError:
            raise ValidationError("invalid date")

    @router.get('/api/history/daytrades')
    def get_history_daytrades():
        """Every paired day trade of 台股, newest first."""
        items = actual_account_service.get_daytrade_history(market="台股")
        return {"ok": True, "count": len(items), "items": items}

    @router.get('/api/history/daytrade-markers')
    def get_history_daytrade_markers(date: str, code: str):
        items = actual_account_service.get_daytrade_symbol_date_rows(date, code, market="台股")
        return {"ok": True, "date": date, "code": code, "count": len(items), "items": items}

    return router


def create_data_center_router(deps: DataCenterRouteDependencies) -> APIRouter:
    runtime = deps.runtime
    router = APIRouter()

    def local_data_center():
        service = deps.data_center
        if service is None:
            return None
        return service.get() if hasattr(service, "get") else service

    @router.get('/api/data-center/dates')
    def get_data_center_dates():
        if runtime.app is not None:
            return runtime.app.get_data_center_dates()
        service = local_data_center()
        if service is None:
            raise ServiceUnavailableError("Market Daemon client 尚未初始化", classification="MONITOR_RUNTIME_NOT_READY")
        return service.dates()

    @router.get('/api/data-center/date')
    def get_data_center_date(date: str):
        if runtime.app is not None:
            return runtime.app.get_data_center_date(date)
        service = local_data_center()
        if service is None:
            raise ServiceUnavailableError("Market Daemon client 尚未初始化", classification="MONITOR_RUNTIME_NOT_READY")
        return service.date_categories(date)

    @router.get('/api/data-center/closing')
    def get_data_center_closing():
        if runtime.app is not None:
            return runtime.app.get_data_center_closing()
        from service.market.lifecycle.closing_progress import closing_progress
        return closing_progress()

    @router.post('/api/data-center/kbars/preview')
    def preview_kbar_download(payload: dict[str, Any]):
        # The code is checked here as for the older-K-bar routes: a code the store cannot name is the caller's 400,
        # not a provider failure (the daemon refuses it too, but its 400 reaches this process only as a failed call).
        body = {**dict(payload or {}), "code": product_code((payload or {}).get("code"))}
        return _daemon_app(runtime, "preview_kbar_download").preview_kbar_download(body)

    @router.post('/api/data-center/kbars/jobs')
    def create_kbar_download_job(payload: dict[str, Any]):
        body = {**dict(payload or {}), "code": product_code((payload or {}).get("code"))}
        return _daemon_app(runtime, "create_kbar_download_job").create_kbar_download_job(body)

    @router.get('/api/data-center/kbars/jobs')
    def list_kbar_download_jobs(limit: int = 50):
        app = _daemon_app(runtime, "list_kbar_download_jobs")
        try:
            return app.list_kbar_download_jobs(limit)
        except Exception as exc:
            # Daemon upgrades briefly release port 8010.  A read-only status
            # panel must degrade to a retryable payload, never an HTTP 500.
            # The exception text is not returned; this is polled, so it is logged at debug only.
            logger.debug("[KBAR] job list unavailable: %r", exc)
            # 503 with the same retryable body: unavailable is not an HTTP 200.
            return SafeJSONResponse(status_code=503, content={"ok": False, "jobs": [], "reason": "MARKET_DAEMON_STARTING",
                                                              "classification": "MARKET_DAEMON_STARTING",
                                                              "error": "Market Daemon 暫時無法回應"})

    @router.get('/api/data-center/kbars/jobs/{job_id}')
    def get_kbar_download_job(job_id: str):
        return _daemon_app(runtime, "get_kbar_download_job").get_kbar_download_job(job_id)

    @router.post('/api/data-center/kbars/jobs/{job_id}/action')
    def action_kbar_download_job(job_id: str, payload: dict[str, Any]):
        return _daemon_app(runtime, "action_kbar_download_job").action_kbar_download_job(job_id, str((payload or {}).get("action") or ""))

    return router
