"""資料中心 lists the Rust historical store's sessions -- the store 歷史回放 reads, and the only one -- from each date's
index (totals.json, written by Rust B), one file per market and date: no partition manifest is read."""
from __future__ import annotations

import json
from types import SimpleNamespace

from service.market.query.data_center_service import DataCenterService
from service.market.query.historical_catalog import HistoricalEvidenceCatalog

DATE = "2026-09-30"


def write_index(root, market, date, partitions):
    """A date's index as Rust B writes it (native/market_runtime/src/historical_totals.rs)."""
    date_dir = root / "source=shioaji" / f"market={market}" / f"trading_date={date}"
    date_dir.mkdir(parents=True, exist_ok=True)
    doc = {"schema": "historical-date-totals-v3", "trading_date": date, "partitions": [
        {"session": "DAY", "stamp_ns": 1, "events": sum(p["lanes"].values()), "events_bytes": 0, "bytes": 0, **p} for p in partitions]}
    (date_dir / "totals.json").write_text(json.dumps(doc), encoding="utf-8")
    return date_dir


def catalog(root):
    return HistoricalEvidenceCatalog(SimpleNamespace(root=root, source="shioaji"))


STOCK = {"code": "3481", "lanes": {"trade": 3, "orderbook": 5, "source_status": 1}, "events_bytes": 4096}


def test_historical_dates_are_listed_with_their_streams(tmp_path):
    write_index(tmp_path, "STK", DATE, [STOCK])
    service = DataCenterService(catalog(tmp_path))
    result = service.dates()
    assert [item["date"] for item in result["items"]] == [DATE]
    assert "index_status" not in result and "historical_store" not in result
    rows = {row["kind"]: row for row in service.metadata.raw_part_identities(trading_date=DATE)}
    assert (rows["tick"]["logical_code"], rows["tick"]["row_count"], rows["bidask"]["row_count"]) == ("3481", 3, 5)
    assert set(rows["tick"]) == {"source", "market", "logical_code", "actual_contract", "trading_date", "session",
                                 "kind", "row_count", "part_count", "partition_bytes", "completeness"}


def test_each_day_reports_its_records_by_kind_and_its_size_on_disk(tmp_path):
    """每日資料總覽 judges a day by 筆數 and 空間 (user 10-13): records per kind and bytes, per market and in all.
    A historical partition's size covers all its lanes, so it is counted once, not once per lane."""
    write_index(tmp_path, "STK", DATE, [STOCK])
    by_date = {item["date"]: item["storage"] for item in DataCenterService(catalog(tmp_path)).dates()["items"]}
    assert by_date[DATE]["ALL"] == {"products": 1, "rows": {"tick": 3, "bidask": 5}, "industry_index_rows": 0, "bytes": 4096}
    assert by_date[DATE]["STK"] == by_date[DATE]["ALL"]


def test_each_day_counts_the_records_of_its_industry_indexes(tmp_path):
    """產業筆數 (user 10-28): the records of the day's industry indexes -- the sector indexes of
    config/tw_industry_indexes.json -- per scope; 加權 (TAIEX) is an index but not an industry index."""
    from config import tw_industry_indexes

    industry = tw_industry_indexes.all_index_codes()[0]
    write_index(tmp_path, "STK", DATE, [STOCK])
    write_index(tmp_path, "IDX", DATE, [{"code": "TAIEX", "lanes": {"quote": 11}}, {"code": industry, "lanes": {"quote": 7}}])
    storage = {item["date"]: item["storage"] for item in DataCenterService(catalog(tmp_path)).dates()["items"]}[DATE]
    assert storage["IDX"]["industry_index_rows"] == 7 and storage["ALL"]["industry_index_rows"] == 7
    assert storage["IDX"]["rows"]["quote"] == 18, "TAIEX's records are the market's, not an industry index's"
    assert storage["STK"]["industry_index_rows"] == 0


def test_the_orderbook_lane_counts_as_bidask(tmp_path):
    """Rust B's lane key is "orderbook"; reading the earlier name left every newer day's 五檔 out of 資料中心."""
    write_index(tmp_path, "STK", DATE, [{"code": "3481", "lanes": {"trade": 3, "orderbook": 7}}])
    rows = catalog(tmp_path).raw_part_identities(trading_date=DATE)
    assert {row["kind"]: row["row_count"] for row in rows} == {"tick": 3, "bidask": 7}


def test_the_date_list_reads_one_index_per_market_and_date_and_no_manifest(tmp_path, monkeypatch):
    """The date list used to read every partition's manifest (~990 on the HDD, slow on a cold cache each time
    資料中心 opened); it reads each date's one index now. A partition folder's manifest is never opened."""
    from service.platform import historical_totals

    for date in ("2026-09-29", DATE):
        date_dir = write_index(tmp_path, "STK", date, [STOCK, {"code": "2330", "lanes": {"trade": 2}, "events_bytes": 10}])
        for code in ("3481", "2330"):
            # What a manifest would say is not what the index says: only the index is read.
            (date_dir / "session=DAY" / code).mkdir(parents=True)
            (date_dir / "session=DAY" / code / "manifest.json").write_text("{not read", encoding="utf-8")
    read = []
    real = historical_totals.date_partitions
    monkeypatch.setattr(historical_totals, "date_partitions", lambda d: read.append(d.name) or real(d))
    items = DataCenterService(catalog(tmp_path)).dates()["items"]
    assert [item["date"] for item in items] == [DATE, "2026-09-29"]
    assert items[0]["storage"]["ALL"] == {"products": 2, "rows": {"tick": 5, "bidask": 5}, "industry_index_rows": 0, "bytes": 4106}
    assert sorted(read) == ["trading_date=2026-09-29", f"trading_date={DATE}"]


def test_an_unreadable_index_leaves_its_date_out_and_is_recorded(tmp_path, monkeypatch):
    from service.market.query import historical_catalog

    write_index(tmp_path, "STK", DATE, [STOCK])
    stale = tmp_path / "source=shioaji" / "market=STK" / "trading_date=2026-09-29"
    stale.mkdir(parents=True)
    # The earlier schema is not read: Rust B rewrites it at its first start after the upgrade.
    (stale / "totals.json").write_text(json.dumps({"schema": "historical-date-totals-v1", "events": 5, "sessions": {}}), encoding="utf-8")
    recorded = []
    monkeypatch.setattr(historical_catalog, "record_failure", lambda _log, what, exc: recorded.append((what, str(exc))))
    items = DataCenterService(catalog(tmp_path)).dates()["items"]
    assert [item["date"] for item in items] == [DATE]
    assert len(recorded) == 1 and "2026-09-29" in recorded[0][0] and "historical-date-totals-v3" in recorded[0][1]


def test_an_index_day_filled_from_history_is_listed_by_its_minute_bars(tmp_path):
    """decisions.md 指數整天沒有分區的日子: the fill holds only price bars and a Reference; the date still lists the
    index with its partition's size and completeness (a reference or status event is no market data)."""
    write_index(tmp_path, "IDX", DATE, [{"code": "TAIEX", "lanes": {"minute_bar": 267, "reference": 1}, "events_bytes": 900,
                                         "completeness": "repaired"}])
    rows = catalog(tmp_path).raw_part_identities(trading_date=DATE)
    assert [(r["kind"], r["row_count"], r["partition_bytes"], r["completeness"]) for r in rows] == [("minute_bar", 267, 900, "repaired")]
    categories = {c["id"]: c for c in DataCenterService(catalog(tmp_path)).date_categories(DATE)["categories"]}
    assert (categories["taiex"]["products"], categories["taiex"]["bytes"], categories["taiex"]["completeness"]["repaired"]) == (1, 900, 1)
