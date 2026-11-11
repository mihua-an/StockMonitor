"""A failed product-catalog refresh is an HTTP error, not 200 carrying ok:false; a disabled source is not a failure."""
from types import SimpleNamespace

from fastapi import FastAPI

from api.routes.product_routes import ProductCatalogRouteDependencies, create_product_catalog_router
from service.market.shared.source_runtime import disabled_source
from tests.asgi_client import AsgiClient


def _client(catalog_ok: bool, futu_result):
    deps = ProductCatalogRouteDependencies(
        security_master=SimpleNamespace(update_master=lambda: {"ok": True}),
        product_catalog=SimpleNamespace(ensure_current=lambda force=False: {"ok": catalog_ok}, status=lambda: {}),
        watch_pages=None, shioaji_app=lambda: None,
        futu_proxy=lambda *a, **k: futu_result, source_enabled=lambda source: source == "shioaji" or futu_result is not None,
        disabled_source=disabled_source, run_blocking_read=None)
    app = FastAPI()
    app.include_router(create_product_catalog_router(deps))
    return app


def _post(app):
    with AsgiClient(app) as client:
        return client.post("/api/product-catalog/refresh")


def test_refresh_status_follows_its_outcome():
    ok = _post(_client(True, None))
    assert ok.status_code == 200 and ok.json()["ok"] is True, "futu disabled: not a failure"
    broken = _post(_client(True, {"ok": False, "error": "OPEND_DOWN"}))
    assert broken.status_code == 502 and broken.json()["failed_providers"] == ["futu"]
    stale = _post(_client(False, None))
    assert stale.status_code == 502
