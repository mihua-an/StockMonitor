"""Historical data / data-center / kbars routes of the Shioaji daemon.

``HistoryRouteDependencies`` carries the running service, the data-center service and the historical route-work
pool's ``route_key`` / ``await_route_work`` of the daemon's DaemonContext, handed in by the composition root
(``backend/shioaji/server.py``). The pool is also torn down by the daemon's stop, so it is never duplicated here.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Callable

from fastapi import APIRouter

from service.platform.http.errors import NotFoundError, ServiceUnavailableError
from backend.shioaji.models import (
    KbarActionRequest,
    KbarOlderRequest,
    KbarDownloadRequest,
)


@dataclass(frozen=True)
class HistoryRouteDependencies:
    app_provider: Callable[[], Any]
    data_center_service_provider: Callable[[], Any]
    route_key: Callable[..., str]
    await_route_work: Callable[..., Any]


def create_history_router(deps: HistoryRouteDependencies) -> APIRouter:
    app_provider = deps.app_provider
    data_center_service_provider = deps.data_center_service_provider
    router = APIRouter()

    @router.get('/v1/data-center/dates')
    async def data_center_dates():
        try:
            service = data_center_service_provider()
            return await asyncio.to_thread(service.dates)
        except RuntimeError as exc:
            # data_center_service_provider() raises a plain RuntimeError for the
            # "market recorder/runtime metadata not ready" startup race; anything
            # else is unexpected and should reach the logged catch-all instead.
            raise ServiceUnavailableError(str(exc), classification="DATA_CENTER_UNAVAILABLE")

    @router.get('/v1/data-center/date')
    async def data_center_date(date: str):
        try:
            service = data_center_service_provider()
            return await asyncio.to_thread(service.date_categories, date)
        except RuntimeError as exc:
            raise ServiceUnavailableError(str(exc), classification="DATA_CENTER_UNAVAILABLE")

    # 收盤整理: where the newest trading day's close is (資料中心's top card). Read from the records alone: it needs no
    # catalog, so it answers while the data-center service is still starting.
    @router.get('/v1/data-center/closing')
    async def data_center_closing():
        from service.market.lifecycle.closing_progress import closing_progress
        return await asyncio.to_thread(closing_progress)

    def kbar_manager():
        """The daemon's K-bar download manager, or 503 while the runtime starts (one lookup for every K-bar route)."""
        app = app_provider()
        manager = getattr(app, "kbar_download_manager", None) if app is not None else None
        if manager is None:
            raise ServiceUnavailableError("daemon runtime not ready", classification="DAEMON_RUNTIME_NOT_READY")
        return manager

    @router.post('/v1/history/kbars/preview')
    def history_kbars_preview(req: KbarDownloadRequest):
        manager = kbar_manager()
        return manager.preview(req.code, req.start_date, req.end_date,
                               user_budget_bytes=req.user_budget_bytes,
                               safety_reserve_bytes=req.safety_reserve_bytes,
                               refresh_usage=True)

    @router.post('/v1/history/kbars/jobs')
    def history_kbars_create_job(req: KbarDownloadRequest):
        manager = kbar_manager()
        return {"ok": True, **manager.create_job(req.code, req.start_date, req.end_date,
                                                   user_budget_bytes=req.user_budget_bytes,
                                                   safety_reserve_bytes=req.safety_reserve_bytes,
                                                   auto_resume=req.auto_resume)}

    @router.get('/v1/history/kbars/jobs')
    def history_kbars_list_jobs(limit: int = 50):
        manager = kbar_manager()
        return {"ok": True, "jobs": manager.list_jobs(limit)}

    @router.get('/v1/history/kbars/jobs/{job_id}')
    def history_kbars_job(job_id: str):
        manager = kbar_manager()
        payload = manager.job(job_id)
        if not payload:
            raise NotFoundError("job_not_found")
        return {"ok": True, **payload}

    @router.post('/v1/history/kbars/jobs/{job_id}/action')
    def history_kbars_job_action(job_id: str, req: KbarActionRequest):
        manager = kbar_manager()
        return {"ok": True, **manager.set_action(job_id, req.action)}

    @router.post('/v1/history/kbars/older')
    def history_kbars_request_older(req: KbarOlderRequest):
        return kbar_manager().request_older(req.code, req.before)

    @router.get('/v1/history/kbars/older')
    def history_kbars_older_status(code: str):
        return kbar_manager().older_status(code)

    return router


__all__ = [
    "HistoryRouteDependencies",
    "create_history_router",
]
