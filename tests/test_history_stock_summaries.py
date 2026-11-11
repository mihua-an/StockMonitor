from collections import OrderedDict
from threading import RLock
from types import SimpleNamespace

import pandas as pd

from service.market.history.history_replay_service import HistoryReplayService


class _Historical:
    """Stand-in for the Rust historical store boundary (HistoricalStore)."""

    codes = ("2330",)

    def list_partitions(self, market, date):
        return [{"logical_code": code, "event_count": 1, "session": "DAY", "lane_report": {}} for code in self.codes]

    def list_dates(self, market=None):
        return ["2026-09-04", "2026-09-03"]

    def manifest(self, market, code, date, session=""):
        return {"completeness": "complete"}


class _Repository:
    historical = _Historical()
    minute_trend_store = SimpleNamespace(load_date=lambda **_kwargs: pd.DataFrame())

    def date_fingerprint(self, date):
        return ""


def _service(repository):
    service = object.__new__(HistoryReplayService)
    service.repository_provider = lambda: repository
    service.code_provider = lambda: []
    service.metadata_provider = lambda code: SimpleNamespace(name="台積電") if code == "2330" else None
    service._sessions = OrderedDict()
    service._stock_summaries = {}
    service._stock_lists = OrderedDict()
    service._lock = RLock()
    service._cache_cleanup = {"last_run_at": "", "removed": 0}
    service._timing = {"product_list_total_ms": 0.0, "product_list_count": 0}
    return service


def test_real_daily_projection_builds_sidebar_without_per_product_trade_scans():
    class Repository(_Repository):
        session_summary_store = SimpleNamespace(list_date=lambda **_kwargs: [{
            "logical_code": "2330", "actual_contract": "2330", "trading_date": "2026-09-04", "session": "DAY",
            "open": 100.0, "high": 102.0, "low": 100.0, "close": 101.0,
            "prev_close": 99.0, "volume": 6, "total_volume": 6,
        }])

    row = _service(Repository()).list_stocks("2026-09-04")[0]

    assert row["close"] == 101.0
    assert row["change_pct"] == 2.0202020202020203


def test_sidebar_does_not_write_missing_post_close_daily_bars():
    projection_rows = [{
        "logical_code": "2330", "actual_contract": "2330", "trading_date": "2026-09-04", "session": "DAY",
        "open": 100.0, "high": 102.0, "low": 100.0, "close": 101.0, "prev_close": 99.0,
    }]

    class TwoCodes(_Historical):
        codes = ("2330", "2317")

    class Repository:
        historical = TwoCodes()
        minute_trend_store = SimpleNamespace(load_date=lambda **_kwargs: pd.DataFrame())
        session_summary_store = SimpleNamespace(list_date=lambda **_kwargs: list(projection_rows))

        def date_fingerprint(self, date):
            return ""
        ensured = []

        def ensure_daily_kbars(self, date, codes):
            raise AssertionError("opening replay must not write daily bars")

    repository = Repository()
    rows = _service(repository).list_stocks("2026-09-04")

    assert repository.ensured == []
    assert {row["code"]: row["close"] for row in rows} == {"2317": None, "2330": 101.0}
    assert next(row for row in rows if row["code"] == "2330")["summary_state"] == "READY"

