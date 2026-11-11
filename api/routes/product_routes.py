from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from service.market.reference import sector_indexes
from service.market.shared.provider_contract import ProviderContractError
from service.platform.change_feed import revision_events
from service.platform.http.errors import ValidationError, internal_error
from service.platform.http.safe_json_response import SafeJSONResponse


CATALOG_STREAM_HEARTBEAT_S = 20.0


# The Shioaji security master written now (an explicit refresh): through the running provider when there is one, else
# the local master. Today's master is the provider login's to write; nothing asks for it at the desktop's start.
def refresh_shioaji_master(security_master: Any, shioaji_app: Callable[[], Any | None]):
    try:
        app = shioaji_app()
        if app is None:
            result = security_master.update_master()
        else:
            result = app.refresh_security_master()
    except Exception as exc:
        result = {
            "ok": False,
            "count": len(security_master.load_master()),
            "errors": [internal_error("[SECURITY MASTER] Shioaji refresh", exc)["error"]],
            "preserved_existing": True,
        }
    if isinstance(result, dict) and result.get("ok") is False:
        # The provider's catalog could not be fetched; the existing catalog stays (not an HTTP 200).
        return SafeJSONResponse(status_code=502, content={"classification": "CATALOG_REFRESH_FAILED", **result})
    return result


@dataclass(frozen=True)
class SecurityMasterRouteDependencies:
    security_master: Any
    shioaji_app: Callable[[], Any | None]


def create_security_master_router(deps: SecurityMasterRouteDependencies) -> APIRouter:
    """quote_api's Shioaji security-master routes."""
    router = APIRouter()

    @router.get("/api/security-master/search")
    def search_security_master(q: str = "", limit: int = 50):
        return {"items": deps.security_master.search(q, limit=limit)}

    @router.get("/api/security-master/{code}")
    def get_security_by_code(code: str):
        item = deps.security_master.find_by_code(code)
        return {"found": False, "code": code} if item is None else {"found": True, "item": item.__dict__}

    return router


@dataclass(frozen=True)
class ProductCatalogRouteDependencies:
    security_master: Any
    product_catalog: Any
    watch_pages: Any
    shioaji_app: Callable[[], Any | None]
    futu_proxy: Callable[..., Any]
    source_enabled: Callable[[str], bool]
    disabled_source: Callable[[str], dict[str, Any]]
    run_blocking_read: Callable[[Callable[[], Any]], Awaitable[Any]]


def create_product_catalog_router(deps: ProductCatalogRouteDependencies) -> APIRouter:
    """settings_api's product-catalog and watch-page routes.

    This domain coordinates provider catalog refreshes but never owns either
    broker connection.  Both providers are injected as bounded capabilities.
    """
    router = APIRouter()

    @router.get("/api/product-catalog/bootstrap")
    async def product_catalog_bootstrap():
        def read():
            rows = deps.product_catalog.rows()
            status = deps.product_catalog.status()
            return {"ok": not bool(status.get("last_error")), "items": rows, "count": len(rows), "status": status}
        return await deps.run_blocking_read(read)

    @router.get("/api/product-catalog/events")
    async def stream_catalog_changes():
        """Server-Sent Events: the catalog revision now, then one `catalog.changed` per catalog file written (a provider
        wrote its master, the start check, a manual refresh). Electron main reloads its search copy when it moves."""
        feed = await deps.run_blocking_read(lambda: deps.product_catalog.feed)   # the first use builds the catalog
        return StreamingResponse(
            revision_events(feed, "catalog.changed", lambda: {"revision": deps.product_catalog.revision()},
                            CATALOG_STREAM_HEARTBEAT_S),
            media_type="text/event-stream", headers={"Cache-Control": "no-store"})

    @router.get("/api/product-catalog/search")
    def search_product_catalog(source: str, q: str = "", market: str = "", limit: int = 50):
        try:
            rows = deps.product_catalog.search(source, q, market=market, limit=limit)
        except ProviderContractError as exc:
            raise ValidationError(str(exc), classification=exc.code) from exc
        status = deps.product_catalog.status()
        # `ok` follows the catalog's own state: a literal True would make a search over a catalog with no sources on
        # disk return ok=true with zero items.
        return {"ok": status.get("state") != "DEGRADED", "items": rows, "count": len(rows),
                "source": source, "market": market, "status": status}

    @router.get("/api/product-catalog/status")
    def product_catalog_status():
        status = deps.product_catalog.ensure_current(force=False)
        return {"ok": bool(status.get("ok", True)), **deps.product_catalog.status()}

    @router.post("/api/product-catalog/refresh")
    def refresh_product_catalog():
        def refresh_shioaji():
            return (refresh_shioaji_master(deps.security_master, deps.shioaji_app) if deps.source_enabled("shioaji")
                    else deps.disabled_source("shioaji"))

        def refresh_futu():
            if not deps.source_enabled("futu"):
                return deps.disabled_source("futu")
            try:
                return deps.futu_proxy("POST", "/v1/futu/security-master/update", timeout=35.0)
            except Exception as exc:  # not an error: recorded by internal_error, which logs it and answers it to the caller
                return internal_error("[SECURITY MASTER] Futu refresh", exc)

        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="ProductCatalogRefresh") as pool:
            shioaji_future = pool.submit(refresh_shioaji)
            futu_future = pool.submit(refresh_futu)
            providers = {"shioaji": shioaji_future.result(), "futu": futu_future.result()}
        catalog = deps.product_catalog.ensure_current(force=True)

        # A disabled source is not a failure; a provider that failed, or a catalog that did not rebuild, is answered
        # with an error status, never HTTP 200 carrying ok:false.
        def provider_failed(result: Any) -> bool:
            if not isinstance(result, dict):
                return True   # an error response (internal_error) in place of a result
            return result.get("ok") is False and result.get("error") != "SOURCE_DISABLED"

        failed = sorted(name for name, result in providers.items() if provider_failed(result))
        body = {"ok": bool(catalog.get("ok")) and not failed, "providers": {
            name: (result if isinstance(result, dict) else {"ok": False, "error": "REFRESH_FAILED"}) for name, result in providers.items()},
            "catalog": catalog, "failed_providers": failed}
        if not body["ok"]:
            return SafeJSONResponse(status_code=502, content={"classification": "CATALOG_REFRESH_FAILED", **body})
        return body

    @router.get("/api/watch-pages")
    def get_watch_pages():
        # The pages hold the user's data; each product's name and type are the catalog's, read now.
        pages = deps.product_catalog.with_metadata(deps.watch_pages.list_pages())
        return {"ok": True, "pages": pages, "count": len(pages), "catalog_revision": deps.product_catalog.revision()}

    # 即時報價's 產業指數 pages: the indexes of config/tw_industry_indexes.json, and one stock's index -- the security
    # master's industry and market through sector_indexes.py, the one owner of that mapping (it also brings the indexes
    # onto the background list).
    @router.get("/api/product-catalog/industry-indexes")
    def list_industry_indexes():
        items = sector_indexes.industry_indexes()
        return {"ok": True, "items": items, "count": len(items)}

    @router.get("/api/product-catalog/industry-indexes/stock/{code}")
    async def stock_industry_index(code: str):
        normalized = str(code or "").strip().upper()
        info = await deps.run_blocking_read(lambda: deps.security_master.find_by_code(normalized))
        return {"ok": True, **sector_indexes.stock_industry_index(normalized, info)}

    return router
