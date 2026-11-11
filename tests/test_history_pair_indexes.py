"""帳務 配對回放's 走勢資訊 reads the day's stored TAIEX and the stock's 產業指數 (/api/history/pair-indexes): B's minute
trend of the IDX partition and the session summary's 昨收, the index chosen by sector_indexes.py from the security master."""
from types import SimpleNamespace

import pandas as pd
import pytest

from service.market.history.history_replay_service import HistoryReplayService
from service.market.reference import sector_indexes


def _day(minutes, prev_close):
    return pd.DataFrame([{"minute_timestamp": pd.Timestamp(stamp), "price": price} for stamp, price in minutes]), prev_close


def _repo(store):
    """A repository whose IDX DAY minute trend and session summary are `store`'s (code -> (minutes, 昨收))."""
    def minutes(*, market, trading_date, logical_code, session):
        assert (market, session) == ("IDX", "DAY")
        return store.get(logical_code, (pd.DataFrame(), None))[0]

    def summary(*, market, trading_date, session, logical_code):
        assert (market, session) == ("IDX", "DAY")
        return {"prev_close": store[logical_code][1]} if logical_code in store else {}

    return SimpleNamespace(minute_trend_store=SimpleNamespace(load_date=minutes),
                           session_summary_store=SimpleNamespace(load_any_contract=summary))


def _service(store, metadata):
    repo = _repo(store)
    return HistoryReplayService(lambda: repo, metadata_provider=lambda code: metadata.get(code))


def _semiconductor():
    """A TSE stock in the 半導體業 industry and the index config/tw_industry_indexes.json gives it."""
    info = SimpleNamespace(industry_code="24", industry_name="半導體業", market="tse")
    index = sector_indexes.stock_industry_index("2330", info)["index"]
    assert index, "the TSE 半導體業 has an index"
    return info, index


def test_the_day_s_taiex_and_the_stock_s_industry_index_by_minute():
    info, index = _semiconductor()
    store = {
        "TAIEX": _day([("2026-10-15 09:00", 20020), ("2026-10-15 09:01", 20100), ("2026-10-15 13:33", 20150)], 20000),
        index["code"]: _day([("2026-10-15 09:00", 990)], 1000),
    }
    result = _service(store, {"2330": info}).get_pair_indexes("2026-10-15", "2330")

    assert result["market"]["points"] == [{"time": "09:00", "price": 20020.0}, {"time": "09:01", "price": 20100.0},
                                          {"time": "13:33", "price": 20150.0}], "B's minutes as stored, none rebuilt here"
    assert result["market"]["prev_close"] == 20000
    assert (result["industry"]["code"], result["industry"]["name"]) == (index["code"], index["name"])
    assert result["industry"]["points"] == [{"time": "09:00", "price": 990.0}]
    assert result["industry"]["prev_close"] == 1000 and result["industry"]["reason"] == ""


def test_an_index_not_stored_that_day_has_no_points_and_a_stock_without_one_says_so():
    info, index = _semiconductor()
    service = _service({}, {"2330": info})
    result = service.get_pair_indexes("2026-10-15", "2330")
    assert result["market"]["points"] == [] and result["market"]["prev_close"] is None
    assert result["industry"]["code"] == index["code"] and result["industry"]["points"] == [], "the renderer reads A's view of it"

    unknown = service.get_pair_indexes("2026-10-15", "9999")
    assert (unknown["industry"]["code"], unknown["industry"]["reason"]) == ("", "NO_INDUSTRY_INDEX")


def test_a_bad_date_or_no_code_is_refused():
    service = _service({}, {})
    with pytest.raises(ValueError):
        service.get_pair_indexes("2026/10/15", "2330")
    with pytest.raises(ValueError):
        service.get_pair_indexes("2026-10-15", "")
