"""A market session (歷史回放 大盤) answers the whole stored day as one `points` list with its 昨收.

It also carried `preview`, the first 200 of the same points; the replay cursor read it, so on a 270-minute day
every cursor past the 200th minute showed that minute's 大盤. And it carried no 昨收, so the replay chart's 加權
overlay (drawn from the index's own 昨收) never appeared on a stored day.
"""
from __future__ import annotations

from types import SimpleNamespace

import pandas as pd

from service.market.projection.market_index_service import MarketIndexService

DAY = "2026-10-23"
MINUTES = pd.date_range(f"{DAY} 09:00:00", f"{DAY} 13:30:00", freq="min").append(pd.DatetimeIndex([f"{DAY} 13:33:00"]))


class _Repository:
    def __init__(self):
        self.reads = []
        self.minute_trend_store = SimpleNamespace(load_date=self._minutes)
        self.session_summary_store = SimpleNamespace(load_any_contract=self._summary)

    def _minutes(self, *, market, trading_date, logical_code, session):
        self.reads.append((market, trading_date, logical_code, session))
        return pd.DataFrame({"minute_timestamp": MINUTES, "price": range(22000, 22000 + len(MINUTES))})

    def _summary(self, *, market, trading_date, session, logical_code):
        assert (market, trading_date, session, logical_code) == ("IDX", DAY, "DAY", "TAIEX")
        return {"prev_close": 21900.0}


def test_the_taiex_history_session_is_the_whole_stored_day_with_its_reference():
    repository = _Repository()
    session = MarketIndexService(history_repository=repository).get_history_session(DAY)
    assert repository.reads == [("IDX", DAY, "TAIEX", "DAY")], "B's minute trend of the IDX DAY partition"
    assert "preview" not in session
    assert session["count"] == len(session["points"]) == 272
    assert session["points"][-1] == {"time": "13:33", "price": float(22000 + 271)}, "the 13:33 close as B stored it"
    assert session["prev_close"] == 21900.0, "the overlay's baseline"
    assert session["coverage"] == "RECORDED"


def test_a_day_with_nothing_stored_is_empty_not_a_failure():
    repository = _Repository()
    repository.minute_trend_store = SimpleNamespace(load_date=lambda **_: pd.DataFrame())
    session = MarketIndexService(history_repository=repository).get_history_session(DAY)
    assert (session["count"], session["coverage"], session["points"]) == (0, "EMPTY", [])


def test_a_failed_read_is_reported_as_one():
    repository = _Repository()

    def broken(**_):
        raise OSError("disk")

    repository.minute_trend_store = SimpleNamespace(load_date=broken)
    session = MarketIndexService(history_repository=repository).get_history_session(DAY)
    assert session["coverage"] == "LOCAL_READ_FAILED" and "disk" in session["error"]
