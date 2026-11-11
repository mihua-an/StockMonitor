"""The Futu daemon's own HTTP routes: product catalog and watchlist.

Composed like the Shioaji daemon's backend/shioaji/routes/: backend/futu/server.py stays the sole owner of the
runtime and lifecycle and hands them in; the client-lease routes come from backend/shared/client_lease_routes.py.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from fastapi import APIRouter

from service.market.futu.api_contracts import WatchlistRequest


@dataclass(frozen=True)
class FutuRouteDependencies:
    runtime: Any
    daemon_health: Callable[[], dict[str, Any]]


def create_futu_router(deps: FutuRouteDependencies) -> APIRouter:
    router = APIRouter()

    @router.get("/v1/futu/status")
    def futu_status():
        return {"ok": True, **deps.runtime.status(), "daemon": deps.daemon_health()}


    # 設定 → 訂閱管理's Futu quota (service.py subscription_quota): OpenD's capacity and what this connection holds.
    @router.get("/v1/futu/subscription-quota")
    def subscription_quota():
        return deps.runtime.service.subscription_quota()

    @router.get("/v1/futu/watchlist")
    def watchlist():
        items = deps.runtime.product_catalog.watchlist()
        return {"ok": True, "items": items, "count": len(items)}


    @router.put("/v1/futu/watchlist")
    def replace_watchlist(req: WatchlistRequest):
        items = deps.runtime.product_catalog.replace_watchlist(req.items)
        rejected = deps.runtime.product_catalog.last_rejected_codes()
        return {"ok": True, "items": items, "count": len(items), "rejected_codes": rejected}


    @router.get("/v1/futu/security-master/search")
    def security_master_search(q: str = "", limit: int = 50):
        rows = deps.runtime.product_catalog.search_security_master(q, limit=limit)
        return {
            "ok": True,
            "items": rows,
            "count": len(rows),
            "status": deps.runtime.status().get("security_master", {}),
        }


    @router.post("/v1/futu/security-master/update")
    def security_master_update():
        return deps.runtime.product_catalog.refresh_security_master(timeout=30.0)


    # app_api follows this master's writes here and rebuilds the product catalog (security_master_feed.py).
    @router.get("/v1/futu/security-master/events")
    def security_master_events():
        from service.market.reference import security_master_feed

        return security_master_feed.events_response("futu", deps.runtime.product_catalog.security_master_path)


    @router.post("/v1/futu/security-master/ensure")
    def security_master_ensure():
        return deps.runtime.product_catalog.ensure_security_master_current(timeout=30.0)

    return router
