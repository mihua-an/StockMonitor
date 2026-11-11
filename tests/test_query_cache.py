"""The query cache's files, its retention setting and what expiry removes."""
from __future__ import annotations

from datetime import date
from types import SimpleNamespace

from config import query_cache_settings as settings
from config.config_revisions import ConfigRevisionStore
from service.market.history.query_cache import QueryCache
from service.market.shioaji.closing_state_source import ClosingState


def gap(code="2912", trading_date="2026-11-06"):
    return SimpleNamespace(market="STK", code=code, trading_date=trading_date, session="DAY")


def test_a_session_round_trips(tmp_path):
    cache = QueryCache(tmp_path)
    closing = ClosingState(prev_close=214.5, limit_up=235.5, limit_down=193.5, bids=[(210.5, 29.0)], asks=[(211.0, 30.0)])
    cache.save(gap(), prints=[(1, 210.5, 2.0, 1)], book=(1, 210.5, 29.0, 211.0, 30.0), closing=closing, prev_close=214.5)
    loaded = cache.load(gap())
    assert (loaded.prints, loaded.book, loaded.closing, loaded.prev_close) == ([(1, 210.5, 2.0, 1)], (1, 210.5, 29.0, 211.0, 30.0), closing, 214.5)
    assert cache.load(gap("2330")) is None
    assert not list(tmp_path.rglob("*.tmp"))


def test_a_damaged_file_is_fetched_again(tmp_path):
    cache = QueryCache(tmp_path)
    cache.save(gap(), prints=[(1, 1.0, 1.0, 1)], book=None, closing=None, prev_close=None)
    next(tmp_path.rglob("*.gz")).write_bytes(b"not gzip")
    assert cache.load(gap()) is None


def test_a_name_that_is_not_a_code_never_becomes_a_path(tmp_path):
    cache = QueryCache(tmp_path)
    cache.save(gap("../X"), prints=[(1, 1.0, 1.0, 1)], book=None, closing=None, prev_close=None)
    assert cache.load(gap("../X")) is None and not list(tmp_path.rglob("*.gz"))


def test_expiry_removes_only_dates_past_the_days(tmp_path):
    cache = QueryCache(tmp_path)
    for day in ("2026-10-30", "2026-11-02", "2026-11-06"):
        cache.save(gap(trading_date=day), prints=[(1, 1.0, 1.0, 1)], book=None, closing=None, prev_close=None)
    (tmp_path / "not-a-date").mkdir()
    assert cache.prune(7, date(2026, 11, 9)) == ["2026-10-30"]
    assert sorted(p.name for p in tmp_path.iterdir()) == ["2026-11-02", "2026-11-06", "not-a-date"]
    assert QueryCache(tmp_path / "absent").prune(7, date(2026, 11, 9)) == []


def test_the_setting_is_validated_and_defaults_to_seven_days(tmp_path):
    assert settings.retention_days(tmp_path) == 7
    assert settings.validate({"retention_days": 30}) == []
    for bad in ({"retention_days": 0}, {"retention_days": True}, {"retention_days": "7"}, {}):
        assert settings.validate(bad)
    assert settings.validate({"retention_days": 7, "other": 1})[0]["code"] == "UNKNOWN_FIELD"
    store = ConfigRevisionStore(tmp_path, "query_cache")
    store.save({"retention_days": 30}, expected_revision=None, source="test", activate=True)
    assert settings.retention_days(tmp_path) == 30
