"""資料中心 第五版 (user 10-28): a date by category -- 加權指數, 期貨指數 (日盤／夜盤), 產業指數, 上市, 上櫃 -- with each
category's records, disk use and 收盤整理, and the date's 補救事件 from Health's daily summary."""
from __future__ import annotations


from service.market.query.data_center_service import DataCenterService

DATE = "2026-10-28"


def part(market, code, kind, rows, size, session="DAY", contract="", completeness="complete"):
    return {"market": market, "logical_code": code, "actual_contract": contract or code, "session": session, "kind": kind,
            "row_count": rows, "partition_bytes": size, "trading_date": DATE, "part_count": 1, "completeness": completeness}


class FakeCatalog:
    def __init__(self, rows):
        self.rows = rows

    def raw_part_identities(self, trading_date="", market=""):
        return [row for row in self.rows if not trading_date or row["trading_date"] == trading_date]


ROWS = [
    part("IDX", "TAIEX", "quote", 5402, 1000),
    part("IDX", "IX0028", "quote", 4000, 300),
    part("IDX", "IX0012", "quote", 3000, 200),
    part("FUT", "TXFR1", "bidask", 300, 600, "DAY", "TXFK6"),
    part("FUT", "TXFR1", "quote", 30, 600, "DAY", "TXFK6"),       # same partition: its size counts once
    part("FUT", "TXFR1", "bidask", 100, 250, "NIGHT", "TXFK6"),
    part("FUT", "TXFR1", "quote", 10, 99, "CLOSED", "TXFK6"),     # out-of-session bucket: not a session
    part("STK", "2330", "tick", 251, 5000),
    part("STK", "2330", "bidask", 1400, 5000),
    part("STK", "6488", "tick", 86, 2000, completeness="repaired"),
    part("STK", "9999", "tick", 1, 10),                           # not in the security master
]


def service(tmp_path, statuses=None, complete=None):
    statuses = statuses or {}
    return DataCenterService(FakeCatalog(ROWS), stock_markets=lambda: {"2330": "tse", "6488": "otc"},
                             materialization_status=lambda market, date, session="": statuses.get((market, session), {"state": "none"}),
                             day_complete=lambda date: (complete or {}).get(date))


def test_a_date_is_listed_by_category_in_the_users_order(tmp_path):
    result = service(tmp_path).date_categories(DATE)
    by_id = {item["id"]: item for item in result["categories"]}
    assert [item["id"] for item in result["categories"]] == ["taiex", "futures", "industry", "tse", "otc", "other"]
    assert by_id["taiex"] == {"id": "taiex", "products": 1, "rows": {"tick": 0, "bidask": 0, "quote": 5402}, "bytes": 1000,
                              "completeness": {"complete": 1, "repaired": 0, "gap_detected": 0}, "materialization": {"state": "none"}}
    assert by_id["otc"]["completeness"] == {"complete": 0, "repaired": 1, "gap_detected": 0}, "物化結果: each product's partition once"
    assert by_id["futures"]["completeness"]["complete"] == 2 and by_id["futures"]["sessions"][0]["completeness"]["complete"] == 1
    assert by_id["industry"]["products"] == 2 and by_id["industry"]["rows"]["quote"] == 7000 and by_id["industry"]["bytes"] == 500
    assert by_id["tse"]["rows"] == {"tick": 251, "bidask": 1400, "quote": 0} and by_id["tse"]["bytes"] == 5000
    assert by_id["otc"]["products"] == 1 and by_id["other"]["products"] == 1
    futures = by_id["futures"]
    assert futures["products"] == 1 and futures["rows"]["bidask"] == 400 and futures["bytes"] == 850
    assert [(s["id"], s["rows"]["bidask"], s["bytes"]) for s in futures["sessions"]] == [("DAY", 300, 600), ("NIGHT", 100, 250)]


def test_each_category_reads_the_materialization_of_its_session(tmp_path):
    statuses = {("STK", ""): {"state": "failed_retryable", "next_attempt_at": 1.0}, ("IDX", ""): {"state": "succeeded"},
                ("FUT", "DAY"): {"state": "succeeded"}, ("FUT", "NIGHT"): {"state": "running"}}
    by_id = {item["id"]: item for item in service(tmp_path, statuses).date_categories(DATE)["categories"]}
    assert by_id["tse"]["materialization"]["state"] == by_id["otc"]["materialization"]["state"] == "failed_retryable"
    assert by_id["taiex"]["materialization"]["state"] == by_id["industry"]["materialization"]["state"] == "succeeded"
    assert [s["materialization"]["state"] for s in by_id["futures"]["sessions"]] == ["succeeded", "running"]


def test_the_date_list_carries_each_days_completeness(tmp_path):
    # 完整 is the day's daily-summary verdict, passed through as it is: None (no summary) is unknown, never complete.
    rows = service(tmp_path, complete={DATE: True}).dates()["items"]
    assert [(row["date"], row["complete"]) for row in rows] == [(DATE, True)]
    assert [row["complete"] for row in service(tmp_path, complete={DATE: False}).dates()["items"]] == [False]
    assert [row["complete"] for row in service(tmp_path).dates()["items"]] == [None]
    assert "remediation" not in service(tmp_path).date_categories(DATE), "補救事件 is no longer shown (user 10-28)"
