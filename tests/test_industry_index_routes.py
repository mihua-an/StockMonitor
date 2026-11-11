"""即時報價's 產業指數 pages read their indexes and one stock's index from app_api (BACKLOG 1v): the list is the table's
indexes under their own market, and a stock maps through its security-master industry and market -- an OTC stock to
its industry's OTC index or the TSE one; 00, an industry without an index and an unknown stock have none."""
from types import SimpleNamespace

from fastapi import FastAPI

from api.routes.product_routes import ProductCatalogRouteDependencies, create_product_catalog_router
from config import tw_industry_indexes
from service.market.reference import sector_indexes as si
from service.market.shared.source_runtime import disabled_source
from tests.asgi_client import AsgiClient

MASTER = {
    "2330": SimpleNamespace(industry_code="24", industry_name="半導體業", market="tse"),
    "3105": SimpleNamespace(industry_code="24", industry_name="半導體業", market="otc"),
    "1101": SimpleNamespace(industry_code="01", industry_name="水泥工業", market="otc"),
    "0050": SimpleNamespace(industry_code="00", industry_name="", market="tse"),
    "1234": SimpleNamespace(industry_code="33", industry_name="農業科技", market="tse"),
}


async def _run(read):
    return read()


def _app():
    deps = ProductCatalogRouteDependencies(
        security_master=SimpleNamespace(find_by_code=lambda code: MASTER.get(code)),
        product_catalog=None, watch_pages=None, shioaji_app=lambda: None, futu_proxy=lambda *a, **k: None,
        source_enabled=lambda source: True, disabled_source=disabled_source, run_blocking_read=_run)
    app = FastAPI()
    app.include_router(create_product_catalog_router(deps))
    return app


def _get(path):
    with AsgiClient(_app()) as client:
        response = client.get(path)
    assert response.status_code == 200
    return response.json()


def test_the_list_is_every_table_index_once_under_its_own_market():
    body = _get("/api/product-catalog/industry-indexes")
    items = body["items"]
    codes = [item["code"] for item in items]
    assert len(codes) == len(set(codes)) == body["count"]
    by_code = {item["code"]: item for item in items}
    assert by_code["IX0028"] == {"code": "IX0028", "name": "半導體類指數", "market": "tse"}
    assert by_code["IX0053"]["market"] == "otc" and by_code["IX0053"]["name"] == "櫃買半導體類指數"
    # IX0011 is the OTC 食品 side's proxy: still a TSE index, listed once.
    assert by_code["IX0011"]["market"] == "tse"
    markets = [item["market"] for item in items]
    assert markets == sorted(markets, key=lambda market: market != "tse"), "上市 first, then 上櫃"
    assert "IX0001" not in by_code, "加權 is 加權走勢's, not an industry index"


def test_a_stock_takes_its_markets_industry_index():
    tse = _get("/api/product-catalog/industry-indexes/stock/2330")
    assert tse["found"] is True and tse["industry_code"] == "24" and tse["market"] == "tse"
    assert tse["index"] == {"code": "IX0028", "name": "半導體類指數", "market": "tse"}
    assert _get("/api/product-catalog/industry-indexes/stock/3105")["index"]["code"] == "IX0053"
    # OTC cement has no OTC index: the TSE 水泥 index.
    assert _get("/api/product-catalog/industry-indexes/stock/1101")["index"]["code"] == "IX0010"


def test_no_industry_no_index_and_unknown_stock_have_none():
    etf = _get("/api/product-catalog/industry-indexes/stock/0050")
    assert etf["found"] is True and etf["industry_code"] == "00" and etf["index"] is None
    assert _get("/api/product-catalog/industry-indexes/stock/1234")["index"] is None
    unknown = _get("/api/product-catalog/industry-indexes/stock/9999")
    assert unknown["found"] is False and unknown["index"] is None


def test_the_list_maps_every_stock_index_of_the_background_list():
    # The page lists every index a stock can map to, so a stock's index is always one the user could also pick.
    listed = {item["code"] for item in si.industry_indexes()}
    for code in tw_industry_indexes.table().by_industry:
        for market in ("tse", "otc"):
            index = si.index_for(code, market)
            assert index is None or index in listed, (code, market, index)
