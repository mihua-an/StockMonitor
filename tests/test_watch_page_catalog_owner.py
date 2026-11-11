"""A product's name, industry, market and type have one owner, the product catalog: watch_pages.csv keeps the user's
data only (pages, source, code, order, alerts) and every reader joins the catalog's metadata when it shows the pages.
Before, the CSV kept its own copy and a reader filled only blank fields from the security master, so a product the
master renamed or retyped kept its old name and type on the product pages for good."""
from __future__ import annotations

import csv
import os
import time
from pathlib import Path

import pytest

from service.market.reference.watch_page_service import WatchPageService

# A file written before the name/type columns were dropped (user data the App must keep reading).
OLD_HEADER = "page_id,page_name,page_source,page_order,code,code_order,code_name,industry_name,market,security_type,source,lower_alert,upper_alert\n"
MASTER_HEADER = "code,name,market,type,industry_name,source\n"


def _old_file(path: Path) -> None:
    path.write_text(OLD_HEADER
                    + "p1,台股,shioaji,0,2330,1,台積電舊名,舊產業,otc,etf,shioaji,500,1200\n"
                    + "p1,台股,shioaji,0,2317,0,,,,,shioaji,,\n"
                    + "p2,美股,futu,1,US.AAPL,0,Apple舊名,,us,stock,futu,,250.5\n", encoding="utf-8-sig")


def _master(path: Path, rows: str) -> None:
    path.write_text(MASTER_HEADER + rows, encoding="utf-8")
    later = time.time() + 5
    os.utime(path, (later, later))


def _catalog(tmp_path: Path):
    pytest.importorskip("pyarrow")
    from service.market.projection.product_catalog_service import ProductCatalogService

    shioaji, futu = tmp_path / "shioaji.csv", tmp_path / "futu.csv"
    _master(shioaji, "2330,台積電,tse,stock,半導體業,shioaji\n2317,鴻海,tse,stock,其他電子業,shioaji\n")
    _master(futu, "US.AAPL,Apple Inc,us,stock,,futu\n")
    service = ProductCatalogService(tmp_path / "catalog.parquet", shioaji_master_file=shioaji, futu_master_file=futu)
    assert service.ensure_current()["ok"]
    return service, shioaji


def test_the_csv_keeps_only_the_users_data_and_an_old_file_loses_nothing(tmp_path: Path) -> None:
    path = tmp_path / "watch_pages.csv"
    _old_file(path)
    service = WatchPageService(path)
    pages = service.list_pages()
    # Pages, their order, each item's order and alerts are kept; the old name/type columns are not read.
    assert [(p["id"], p["name"], p["source"], p["codes"]) for p in pages] == [
        ("p1", "台股", "shioaji", ["2317", "2330"]), ("p2", "美股", "futu", ["US.AAPL"])]
    assert pages[0]["items"][1] == {"code": "2330", "source": "shioaji", "lower_alert": 500.0, "upper_alert": 1200.0}
    assert pages[1]["items"][0] == {"code": "US.AAPL", "source": "futu", "lower_alert": None, "upper_alert": 250.5}
    # A save writes the user's columns only, under the same names; nothing of the pages is lost.
    service.save_pages(pages)
    with path.open(encoding="utf-8-sig", newline="") as fh:
        header = next(csv.reader(fh))
    assert header == ["page_id", "page_name", "page_source", "page_order", "code", "code_order", "source", "lower_alert", "upper_alert"]
    assert WatchPageService(path).list_pages() == service.list_pages()


def test_the_pages_show_the_catalogs_metadata_now_and_follow_a_rename(tmp_path: Path) -> None:
    path = tmp_path / "watch_pages.csv"
    _old_file(path)
    catalog, shioaji = _catalog(tmp_path)
    pages = catalog.with_metadata(WatchPageService(path).list_pages())
    by_code = {item["code"]: item for page in pages for item in page["items"]}
    # Not the CSV's stale 台積電舊名／otc／etf: the catalog's, for every field.
    assert {k: by_code["2330"][k] for k in ("name", "industry_name", "market", "type")} == {
        "name": "台積電", "industry_name": "半導體業", "market": "tse", "type": "stock"}
    assert by_code["2330"]["upper_alert"] == 1200.0, "the user's data stays"
    assert by_code["US.AAPL"]["name"] == "Apple Inc"
    # The master renames and retypes a product: the pages show it at the next read, with no write to the pages.
    revision = catalog.revision()
    _master(shioaji, "2330,台灣積體電路,tse,etf,半導體業,shioaji\n2317,鴻海,tse,stock,其他電子業,shioaji\n")
    assert catalog.ensure_current()["rebuilt"] is True
    assert catalog.revision() != revision
    renamed = {item["code"]: item for page in catalog.with_metadata(WatchPageService(path).list_pages()) for item in page["items"]}
    assert (renamed["2330"]["name"], renamed["2330"]["type"]) == ("台灣積體電路", "etf")
    assert catalog.metadata("shioaji", "9999") == {"name": "", "industry_name": "", "market": "", "type": ""}


def test_settings_rows_and_pages_take_names_from_the_catalog(tmp_path: Path, monkeypatch) -> None:
    from service.market.reference import background_demand as bd
    from service.market.reference import futures_contracts as fc
    from service.market.reference.subscription_ops import SubscriptionState

    monkeypatch.setattr("config.source_settings.source_enabled", lambda source: True)
    txf = [fc.FuturesMonth(code=f"TXF{ym[-2:]}X", symbol=f"TXF{ym}", category="TXF", name="TXF", underlying_code="", unit=200,
                           delivery_month=ym, delivery_date=f"{ym[:4]}-{ym[4:]}-15") for ym in ("202611", "202612")]
    monkeypatch.setattr(bd, "_futures_table", lambda: fc.FuturesTable(txf))
    monkeypatch.setattr("service.market.reference.sector_indexes._master", lambda: {})
    monkeypatch.setattr("config.broker_connection_settings.shioaji",
                        lambda config_root=None: {"connections": 1, "per_connection_limit": 20, "revision": None})
    path = tmp_path / "watch_pages.csv"
    _old_file(path)
    catalog, _shioaji = _catalog(tmp_path)
    snapshot = SubscriptionState(tmp_path / "config", path, {}, catalog=catalog).snapshot()
    rows = {row["code"]: row["name"] for row in snapshot["instruments"]}
    assert rows == {"2317": "鴻海", "2330": "台積電", "US.AAPL": "Apple Inc"}
    items = {item["code"]: item["name"] for page in snapshot["pages"] for item in page["items"]}
    assert items == rows
    # An item added from the settings windows is written as its code: its name is the catalog's.
    saved = SubscriptionState(tmp_path / "config", path, {}, catalog=catalog).apply(
        {"batch_id": "b1", "ops": [{"op": "item.add", "page_id": "p1", "code": "2330X", "after_code": "", "name": "自己取的名"}]})
    assert saved["ok"], saved
    with path.open(encoding="utf-8-sig", newline="") as fh:
        assert "自己取的名" not in fh.read()
