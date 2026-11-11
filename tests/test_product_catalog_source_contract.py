"""A product search names a canonical provider source; an unknown one (a typo, "moomoo") is refused with
SOURCE_UNKNOWN, never filed under another provider (service/market/shared/provider_contract.py)."""
from types import SimpleNamespace

import pytest
from fastapi import FastAPI

from api.routes.product_routes import ProductCatalogRouteDependencies, create_product_catalog_router
from service.market.projection.product_catalog_service import ProductCatalogService
from service.market.shared.provider_contract import ProviderContractError
from service.market.shared.source_runtime import disabled_source
from service.platform.http.errors import register_error_handlers
from tests.asgi_client import AsgiClient


def _catalog(tmp_path):
    catalog = ProductCatalogService.__new__(ProductCatalogService)
    catalog._lock = __import__("threading").Lock()
    catalog._rows = [{"source": "futu", "code": "AAPL", "name": "Apple", "market": "us", "type": "stock"},
                     {"source": "shioaji", "code": "2330", "name": "TSMC", "market": "tw", "type": "stock"}]
    return catalog


def test_search_takes_canonical_sources_and_refuses_others(tmp_path):
    catalog = _catalog(tmp_path)
    assert [row["code"] for row in catalog.search("futu", "")] == ["AAPL"]
    assert [row["code"] for row in catalog.search("", "")] == ["2330"], "no source: the contract's default"
    for unknown in ("moomoo", "us", "shiaoji"):
        with pytest.raises(ProviderContractError) as caught:
            catalog.search(unknown, "")
        assert caught.value.code == "SOURCE_UNKNOWN"


def test_the_search_route_answers_an_unknown_source_with_400(tmp_path):
    deps = ProductCatalogRouteDependencies(
        security_master=None, product_catalog=SimpleNamespace(search=_catalog(tmp_path).search, status=lambda: {}),
        watch_pages=None, shioaji_app=lambda: None, futu_proxy=lambda *a, **k: None,
        source_enabled=lambda source: True, disabled_source=disabled_source, run_blocking_read=None)
    app = FastAPI()
    register_error_handlers(app)
    app.include_router(create_product_catalog_router(deps))
    with AsgiClient(app) as client:
        bad = client.get("/api/product-catalog/search?source=moomoo&q=a")
        good = client.get("/api/product-catalog/search?source=futu&q=")
    assert bad.status_code == 400 and bad.json()["classification"] == "SOURCE_UNKNOWN"
    assert good.status_code == 200 and good.json()["count"] == 1
