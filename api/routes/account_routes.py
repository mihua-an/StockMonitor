from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from api.models import (
    AccountCapitalRequest,
    ActualAccountConfigRequest,
    ActualTradeDeleteRequest,
    ActualTradeSaveRequest,
)
from service.account.actual_account_bridge import GasBridgeScheduler
from service.account.account_types import ActualAccountError, TradeInfoError
from service.platform.http.errors import internal_error_response
from service.platform.http.safe_json_response import SafeJSONResponse
from service.account.actual_account_service import ActualAccountService
from service.account.actual_account_sync import SYNC_DEADLINE_S, ActualAccountSync
from service.account import mobile_api
from service.account.account_report_publisher import AccountReportPublisher
from service.platform.failure_record import record_failure

logger = logging.getLogger(__name__)
POSITIONS_STREAM_HEARTBEAT_S = 20.0


def _answer(result: Any):
    """An operation that came back with ``ok: false`` is answered as the failure it is, never as HTTP 200:
    409 when the account is not configured, otherwise 500 -- e.g. the sheet took the trade but the local rebuild did
    not finish (``remote_applied`` says which half went through). The body is unchanged."""
    if isinstance(result, dict) and result.get("ok") is False:
        not_configured = result.get("configured") is False
        return SafeJSONResponse(status_code=409 if not_configured else 500,
                                content={"classification": "NOT_CONFIGURED" if not_configured else "OPERATION_INCOMPLETE", **result})
    return result


def _rebuild_answer(ledger: str, result: dict, **extra: Any):
    """A finished rebuild is succeeded only without errors: one whose trades could not all be matched is the
    failure it is -- recorded so, with what it produced, and answered as an incomplete operation."""
    from service.account.account_ledger_service import DERIVED_VERSION

    errors = int(result.get("errors") or 0)
    detail = {"derived_version": DERIVED_VERSION, **{k: result.get(k) for k in (
        "orders", "fills", "legs", "realized_matches", "positions", "positions_changed", "positions_revision", "errors")}}
    _record_manual_rebuild(ledger, "failed" if errors else "succeeded", detail)
    if errors:
        return _answer({"ok": False, **result, **extra,
                        "error": f"重新計算完成，但有 {errors} 筆交易無法配對，請檢查原始交易"})
    return {"ok": True, **result, **extra}


def _record_manual_rebuild(ledger: str, outcome: str, detail: dict) -> None:
    """A ledger rebuild the user asked for -- an explicit operation, never started by an automatic path."""
    try:
        from service.platform.remediation import emitter

        emitter().emit(component="account_routes", mechanism_id="account.manual_rebuild", trigger_reason="user_request",
                       outcome=outcome, detail={"ledger": ledger, **detail})
    except Exception as exc:
        record_failure(logger, "recording the manual ledger rebuild event", exc)


def _add_capital_routes(router: APIRouter, prefix: str, service: ActualAccountService) -> None:
    """`<prefix>/capital`: one ledger's 起始本金 / 每日交易額度 per market and what they come to now."""
    @router.get(f"{prefix}/capital")
    def get_capital():
        return {**service.get_capital_settings(), "capital": service.get_capital()}

    @router.post(f"{prefix}/capital")
    def save_capital(req: AccountCapitalRequest):
        return {**service.save_capital_settings(req.model_dump()), "capital": service.get_capital()}


def _add_ledger_read_routes(router: APIRouter, prefix: str, service: ActualAccountService) -> None:
    """What the account page reads on demand instead of carrying it in the dashboard: one day of one market
    (`<prefix>/day`, 每日明細 / 配對明細), every trade of one market (`<prefix>/trades`, 交易資料) and one stock's or
    one trade type's realized pairs (`<prefix>/pairs`, 個股數據 / 當沖分析)."""

    def bad_request(exc: ValueError):
        return SafeJSONResponse(status_code=400, content={"ok": False, "error": str(exc)})

    @router.get(f"{prefix}/day")
    def get_day(market: str = "", date: str = ""):
        try:
            return service.get_day(market, date)
        except ValueError as exc:  # not an error: a malformed market or date is the caller's 400
            return bad_request(exc)

    @router.get(f"{prefix}/trades")
    def get_market_trades(market: str = ""):
        try:
            return service.get_market_trades(market)
        except ValueError as exc:  # not an error: a malformed market is the caller's 400
            return bad_request(exc)

    @router.get(f"{prefix}/daytrade-analysis")
    def get_daytrade_analysis(market: str = "", mode: str = "overview"):
        try:
            return service.get_daytrade_analysis(market, mode)
        except ValueError as exc:  # not an error: a malformed market or mode is the caller's 400
            return bad_request(exc)

    @router.get(f"{prefix}/pairs")
    def get_pairs(market: str = "", code: str = ""):
        try:
            return service.get_pairs(market, code)
        except ValueError as exc:  # not an error: a malformed market or code is the caller's 400
            return bad_request(exc)


def _add_positions_routes(router: APIRouter, prefix: str, service: ActualAccountService) -> None:
    """`<prefix>/positions` and `<prefix>/positions/events` for one ledger (actual or paper)."""

    @router.get(f"{prefix}/positions")
    def get_positions():
        """Small read model for dynamic product pages.

        Product-list consumers do not need trades, realized P/L, dashboard
        charts, or GAS status.  Keeping this endpoint narrow also makes it safe
        to refresh while the live quote page is open.
        """
        positions = service.get_positions()
        revision = service.get_positions_revision()
        return {"ok": True, "positions": positions, "count": len(positions), "revision": revision}

    @router.get(f"{prefix}/positions/events")
    async def stream_position_changes():
        """Server-Sent Events: the positions revision now, then one `positions.changed` per change.

        The live holdings on the quote screens re-read `<prefix>/positions` when the revision moves, so a
        new trade or a background GAS sync reaches every open window without a poll. A comment line every
        POSITIONS_STREAM_HEARTBEAT_S lets a dead connection be noticed; the stream ends when the service drains."""
        feed = service.positions_feed
        queue = feed.subscribe()  # before reading the revision: a change in between is still delivered

        async def events():
            try:
                current = {"revision": service.get_positions_revision()}
                yield f"event: positions.changed\ndata: {json.dumps(current)}\n\n"
                while True:
                    try:
                        payload = await asyncio.wait_for(queue.get(), POSITIONS_STREAM_HEARTBEAT_S)
                    except asyncio.TimeoutError:  # not an error: the heartbeat interval passed with no change: a heartbeat is sent
                        yield ": heartbeat\n\n"
                        continue
                    if payload is None:
                        return
                    yield f"event: positions.changed\ndata: {json.dumps(payload)}\n\n"
            finally:
                feed.unsubscribe(queue)

        return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-store"})


def create_actual_account_router(
    actual_account_service: ActualAccountService,
    gas_bridge_scheduler: GasBridgeScheduler,
    account_sync: ActualAccountSync,
    report_publisher: AccountReportPublisher,
) -> APIRouter:
    """actual_account_api's routes around its long-lived services: /api/actual-account/* and its SQLite diagnostics.

    The dashboards carry the ledger's positions only: 未實現損益 is computed on the screen from Market Runtime's price
    over the WS; this API does not read A once per holding."""
    router = APIRouter()

    @router.get("/api/actual-account/status")
    def get_actual_account_status():
        value = actual_account_service.get_status()
        value["bridge_scheduler"] = gas_bridge_scheduler.status()
        return value

    @router.get("/api/diagnostics/account-sqlite")
    def get_account_sqlite_diagnostics():
        # Diagnostics are memory-only and safe to poll while
        # proving that /api/status does not indirectly open either account DB.
        return {
            "ok": True,
            "actual_account": actual_account_service.sqlite_runtime_diagnostics(),
            "bridge_scheduler": gas_bridge_scheduler.status(),
        }

    @router.get("/api/actual-account/bridge/status")
    def get_actual_account_bridge_status():
        return {
            "ok": True,
            "bridge": account_sync.bridge_status(),
            "scheduler": gas_bridge_scheduler.status(),
            "mobile_publish": report_publisher.status(),
        }

    @router.post("/api/actual-account/mobile-publish/schedule")
    def schedule_actual_account_mobile_publish():
        try:
            return report_publisher.schedule(
                "desktop_google_form_create",
                delay_minutes=30,
            )
        except Exception as exc:  # not an error: recorded by internal_error_response, which logs it and answers 500
            return internal_error_response("[MOBILE PUBLISH] schedule", exc, log=logger)

    @router.get("/api/actual-account/mobile-preview")
    def preview_actual_account_mobile_data():
        try:
            return report_publisher.preview_mobile_data()
        except (ActualAccountError, TradeInfoError):
            raise  # stated failures answer with their own status
        except Exception as exc:  # not an error: recorded by internal_error_response, which logs it and answers 500
            return internal_error_response("[MOBILE PUBLISH] preview", exc, log=logger)

    # 模擬帳務's 手機卡片: the same cards over the paper wallet, for the desktop only -- never published to the phone.

    @router.post("/api/actual-account/mobile-publish/now")
    def publish_actual_account_mobile_now():
        try:
            return _answer(report_publisher.publish_now())
        except (ActualAccountError, TradeInfoError):
            raise  # stated failures answer with their own status
        except Exception as exc:  # not an error: recorded by internal_error_response, which logs it and answers 500
            return internal_error_response("[MOBILE PUBLISH] manual publish", exc, log=logger)

    @router.post("/api/actual-account/bridge/check")
    def check_actual_account_bridge():
        try:
            return _answer(account_sync.poll_once(source="manual_bridge_check"))
        except (ActualAccountError, TradeInfoError):
            raise  # stated failures answer with their own status
        except Exception as exc:  # not an error: recorded by internal_error_response, which logs it and answers 500
            return internal_error_response("[GAS BRIDGE] manual check", exc, log=logger)

    @router.get("/api/actual-account/config")
    def get_actual_account_config():
        config = account_sync.get_config()
        return {
            "gas_url": config.get("gas_url") or "",
            "gas_token": "",
            "has_token": bool(config.get("gas_token")),
            "auto_sync_on_page_open": bool(config.get("auto_sync_on_page_open")),
            "google_form_prefill_url": config.get("google_form_prefill_url") or "",
            "google_form_param_trade_date": config.get("google_form_param_trade_date") or "",
            "google_form_param_market": config.get("google_form_param_market") or "",
            "google_form_param_action": config.get("google_form_param_action") or "",
            "google_form_param_code": config.get("google_form_param_code") or "",
            "google_form_param_trade_info": config.get("google_form_param_trade_info") or "",
            "google_form_param_trade_time": config.get("google_form_param_trade_time") or "",
            "config_error": config.get("config_error") or "",
            # How long a sync may take (every GAS request with its retries): the page's deadline for it.
            "sync_deadline_s": SYNC_DEADLINE_S,
        }

    @router.post("/api/actual-account/config")
    def save_actual_account_config(req: ActualAccountConfigRequest):
        previous = account_sync.get_config()
        token = req.gas_token.strip() if req.gas_token.strip() else str(previous.get("gas_token") or "")
        value = account_sync.save_config(
            gas_url=req.gas_url,
            gas_token=token,
            auto_sync_on_page_open=req.auto_sync_on_page_open,
            google_form_prefill_url=req.google_form_prefill_url,
            google_form_param_trade_date=req.google_form_param_trade_date,
            google_form_param_market=req.google_form_param_market,
            google_form_param_action=req.google_form_param_action,
            google_form_param_code=req.google_form_param_code,
            google_form_param_trade_info=req.google_form_param_trade_info,
            google_form_param_trade_time=req.google_form_param_trade_time,
        )
        return {
            "ok": True,
            "gas_url": value.get("gas_url") or "",
            "has_token": bool(value.get("gas_token")),
            "auto_sync_on_page_open": bool(value.get("auto_sync_on_page_open")),
            "google_form_prefill_url": value.get("google_form_prefill_url") or "",
            "google_form_param_trade_date": value.get("google_form_param_trade_date") or "",
            "google_form_param_market": value.get("google_form_param_market") or "",
            "google_form_param_action": value.get("google_form_param_action") or "",
            "google_form_param_code": value.get("google_form_param_code") or "",
            "google_form_param_trade_info": value.get("google_form_param_trade_info") or "",
            "google_form_param_trade_time": value.get("google_form_param_trade_time") or "",
        }

    @router.get("/api/actual-account/dashboard")
    def get_actual_account_dashboard():
        return actual_account_service.get_dashboard()

    @router.post("/api/actual-account/sync")
    def sync_actual_account():
        try:
            return _answer(account_sync.sync())
        except (ActualAccountError, TradeInfoError):
            raise  # stated failures answer with their own status
        except Exception as exc:  # not an error: recorded by internal_error_response, which logs it and answers 500
            return internal_error_response("[ACTUAL ACCOUNT] sync", exc, log=logger)

    @router.post("/api/actual-account/rebuild")
    def rebuild_actual_account():
        try:
            result = actual_account_service.rebuild()
        except Exception as exc:
            _record_manual_rebuild("actual_account", "failed", {"error": type(exc).__name__})
            if isinstance(exc, (ActualAccountError, TradeInfoError)):
                raise
            return internal_error_response("[ACTUAL ACCOUNT] rebuild", exc, log=logger)
        return _rebuild_answer("actual_account", result)

    @router.post("/api/actual-account/trade/save")
    def save_actual_trade(req: ActualTradeSaveRequest):
        try:
            return _answer(account_sync.save_trade(req.model_dump()))
        except (ActualAccountError, TradeInfoError):
            raise  # stated failures answer with their own status
        except Exception as exc:  # not an error: recorded by internal_error_response, which logs it and answers 500
            return internal_error_response("[ACTUAL ACCOUNT] save trade", exc, log=logger)

    @router.post("/api/actual-account/trade/delete")
    def delete_actual_trade(req: ActualTradeDeleteRequest):
        try:
            return _answer(account_sync.delete_trade(req.trade_id))
        except (ActualAccountError, TradeInfoError):
            raise  # stated failures answer with their own status
        except Exception as exc:  # not an error: recorded by internal_error_response, which logs it and answers 500
            return internal_error_response("[ACTUAL ACCOUNT] delete trade", exc, log=logger)

    # 實際庫存: the read routes shared with the paper wallet.
    _add_positions_routes(router, "/api/actual-account", actual_account_service)
    _add_capital_routes(router, "/api/actual-account", actual_account_service)
    _add_ledger_read_routes(router, "/api/actual-account", actual_account_service)
    return router


def create_paper_wallet_router(paper_wallet_service: ActualAccountService) -> APIRouter:
    """paper_account_api's ledger routes: /api/paper-wallet/* (its order desk has its own router)."""
    router = APIRouter()

    @router.get("/api/paper-wallet/mobile-preview")
    def preview_paper_wallet_mobile_data():
        try:
            return mobile_api.preview(paper_wallet_service)
        except (ActualAccountError, TradeInfoError):
            raise  # stated failures answer with their own status
        except Exception as exc:  # not an error: recorded by internal_error_response, which logs it and answers 500
            return internal_error_response("[MOBILE CARDS] paper preview", exc, log=logger)

    @router.get("/api/paper-wallet/status")
    def get_paper_wallet_status():
        value = paper_wallet_service.get_status()
        value["local_only"] = True
        value["configured"] = True
        value["gas_url"] = ""
        value["has_token"] = False
        value["auto_sync_on_page_open"] = False
        return value

    @router.get("/api/paper-wallet/dashboard")
    def get_paper_wallet_dashboard():
        value = paper_wallet_service.get_dashboard()
        value["paper_wallet"] = True
        if isinstance(value.get("status"), dict):
            value["status"]["local_only"] = True
            value["status"]["configured"] = True
            value["status"]["gas_url"] = ""
            value["status"]["has_token"] = False
            value["status"]["auto_sync_on_page_open"] = False
        return value

    @router.post("/api/paper-wallet/rebuild")
    def rebuild_paper_wallet():
        try:
            result = paper_wallet_service.rebuild()
        except Exception as exc:
            _record_manual_rebuild("paper_wallet", "failed", {"error": type(exc).__name__})
            if isinstance(exc, (ActualAccountError, TradeInfoError)):
                raise
            return internal_error_response("[PAPER WALLET] rebuild", exc, log=logger)
        return _rebuild_answer("paper_wallet", result, local_only=True)

    @router.post("/api/paper-wallet/trade/save")
    def save_paper_wallet_trade(req: ActualTradeSaveRequest):
        try:
            return _answer(paper_wallet_service.local_save_trade(req.model_dump()))
        except (ActualAccountError, TradeInfoError):
            raise  # stated failures answer with their own status
        except Exception as exc:  # not an error: recorded by internal_error_response, which logs it and answers 500
            return internal_error_response("[PAPER WALLET] save trade", exc, log=logger)

    @router.post("/api/paper-wallet/trade/delete")
    def delete_paper_wallet_trade(req: ActualTradeDeleteRequest):
        try:
            return _answer(paper_wallet_service.local_delete_trade(req.trade_id))
        except (ActualAccountError, TradeInfoError):
            raise  # stated failures answer with their own status
        except Exception as exc:  # not an error: recorded by internal_error_response, which logs it and answers 500
            return internal_error_response("[PAPER WALLET] delete trade", exc, log=logger)

    # 模擬庫存: the read routes shared with the actual account.
    _add_positions_routes(router, "/api/paper-wallet", paper_wallet_service)
    _add_capital_routes(router, "/api/paper-wallet", paper_wallet_service)
    _add_ledger_read_routes(router, "/api/paper-wallet", paper_wallet_service)
    return router
