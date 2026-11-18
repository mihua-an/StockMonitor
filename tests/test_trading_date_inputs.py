"""A trading date given as text is read by one rule (session_identity_contract.iso_trading_date): a real calendar date
written YYYY-MM-DD. A value that only looks like one (2026-02-30) or carries more (a time) is refused as bad input
where it enters, never a 500 further in."""
from __future__ import annotations

from datetime import date

import pytest

from service.account.account_types import ActualAccountError
from service.market.history.query_cache import QueryCache
from service.market.history.rust_historical_store_reader import partition_dir
from service.market.projection.analysis_event_archive import AnalysisEventArchive
from service.market.shioaji import history_download
from tests.support.paper_desk import make_desk

NOT_DATES = ["2026-02-30", "2026-13-01", "2026-11-16T09:00", "20261116", "../x"]


@pytest.mark.parametrize("value", NOT_DATES)
def test_the_paper_order_history_refuses_it_as_input(tmp_path, value):
    desk, _ledger, _clock = make_desk(tmp_path)
    with pytest.raises(ActualAccountError, match="日期格式") as caught:
        desk.history(value, "2026-10-16")
    assert caught.value.status_code == 422


@pytest.mark.parametrize("value", NOT_DATES)
def test_the_event_archive_refuses_it(tmp_path, value):
    with pytest.raises(ValueError):
        AnalysisEventArchive(tmp_path).read(value)


@pytest.mark.parametrize("value", NOT_DATES)
def test_a_partition_path_refuses_it(tmp_path, value):
    with pytest.raises(ValueError, match="trading_date"):
        partition_dir(source="shioaji", market="STK", logical_code="2330", trading_date=value, session="DAY",
                      historical_root=tmp_path)


@pytest.mark.parametrize("value", NOT_DATES)
def test_a_kbar_download_range_refuses_it(value):
    with pytest.raises(ValueError):
        history_download._date(value)


def test_the_query_cache_expiry_passes_over_a_folder_that_is_not_a_date(tmp_path):
    (tmp_path / "2026-02-30").mkdir()
    (tmp_path / "2026-01-02").mkdir()
    assert QueryCache(tmp_path).prune(10, date(2026, 11, 16)) == ["2026-01-02"]
    assert (tmp_path / "2026-02-30").is_dir()
