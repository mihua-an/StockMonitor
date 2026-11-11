from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from fastapi import APIRouter

from service.market.futu.api_contracts import WatchlistRequest


ProxyCall = Callable[..., Any]
AsyncReader = Callable[[Callable[[], Any]], Awaitable[Any]]


@dataclass(frozen=True)
class FutuRouteDependencies:
    """The Futu HTTP bridge capabilities used by the /api/futu/* routes.

    The daemon client remains owned by the FastAPI composition root.  Keeping
    only these two call capabilities here prevents a route module from reaching
    back into api_server globals or ever constructing an OpenD owner.
    """

    proxy: ProxyCall
    run_blocking_read: AsyncReader
    client_stats: Callable[[], dict[str, Any]]


def create_futu_router(deps: FutuRouteDependencies) -> APIRouter:
    router = APIRouter()

    @router.get("/api/futu/status")
    async def get_futu_status():
        payload = await deps.run_blocking_read(
            lambda: deps.proxy("GET", "/v1/futu/status", timeout=2.0)
        )
        if isinstance(payload, dict) and payload.get("ok"):
            payload["client"] = deps.client_stats()
        return payload

    @router.get("/api/futu/watchlist")
    def get_watchlist():
        return deps.proxy("GET", "/v1/futu/watchlist")

    @router.put("/api/futu/watchlist")
    def put_watchlist(req: WatchlistRequest):
        return deps.proxy("PUT", "/v1/futu/watchlist", body={"items": req.items})

    @router.get("/api/futu/security-master/search")
    def search_security_master(q: str = "", limit: int = 50):
        return deps.proxy("GET", "/v1/futu/security-master/search", params={"q": q, "limit": limit})

    @router.post("/api/futu/security-master/update")
    def update_security_master():
        return deps.proxy("POST", "/v1/futu/security-master/update", timeout=35.0)

    @router.post("/api/futu/security-master/ensure")
    def ensure_security_master():
        return deps.proxy("POST", "/v1/futu/security-master/ensure", timeout=35.0)

    return router
