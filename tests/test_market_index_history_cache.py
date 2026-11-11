"""TAIEX history is cached only while the stored data it came from is unchanged.

The cache was keyed by the date alone and kept any answer with a point in it, so a 大盤 history opened during the
session or half-way through a backfill stayed truncated until the App restarted.
"""
from __future__ import annotations

from types import SimpleNamespace

import pandas as pd

from service.market.projection.market_index_service import MarketIndexService

CLOSED_DAY = "2026-09-29"


class _Repository:
    def __init__(self):
        self.rows = [{"minute_timestamp": f"{CLOSED_DAY} 09:00:00", "price": 22000.0}]
        self.version = "v1"
        self.reads = 0
        self.historical = SimpleNamespace(fingerprint=lambda market, day, session: f"{market}:{day}:{session}:{self.version}")
        self.minute_trend_store = SimpleNamespace(load_date=self._minutes)
        self.session_summary_store = SimpleNamespace(load_any_contract=lambda **_: {"prev_close": 21900.0})

    def _minutes(self, **_):
        self.reads += 1
        return pd.DataFrame(self.rows)


def test_a_backfill_after_the_first_read_is_seen():
    repository = _Repository()
    service = MarketIndexService(history_repository=repository)

    assert service.get_history_session(CLOSED_DAY)["count"] == 1
    assert service.get_history_session(CLOSED_DAY)["count"] == 1
    assert repository.reads == 1, "unchanged store: served from the cache"

    repository.rows.append({"minute_timestamp": f"{CLOSED_DAY} 13:30:00", "price": 22100.0})
    repository.version = "v2"  # the backfill rewrote the IDX partition
    assert service.get_history_session(CLOSED_DAY)["count"] == 2
    assert repository.reads == 2


def test_without_a_fingerprint_nothing_is_cached():
    repository = _Repository()
    del repository.historical
    service = MarketIndexService(history_repository=repository)
    service.get_history_session(CLOSED_DAY)
    service.get_history_session(CLOSED_DAY)
    assert repository.reads == 2


def test_an_unknown_constructor_argument_is_refused():
    """R13-24: no catch-all keyword argument hides a misspelt or removed dependency."""
    import pytest

    with pytest.raises(TypeError):
        MarketIndexService(history_repositry=object())
