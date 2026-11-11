"""A FUT summary is one partition (DAY or NIGHT); a stock summary carries the day's official limits.

With no session (or FULL) the store returned the first partition's summary alone -- the DAY, without the night's
open, extremes and volume. No reader needs a 全日 summary, so none is derived: asking for one is refused.
"""
from __future__ import annotations

import json

import pytest

from service.market.history.historical_store import HistoricalStore
from service.market.shared.native_values import DEFAULT_PRICE_SCALE as PRICE_SCALE


def _partition(store, trading_date, session, *, summary, bars):
    path = store._dir("FUT", "TXFR1", trading_date, session)
    path.mkdir(parents=True, exist_ok=True)
    (path / "manifest.json").write_text(json.dumps({"completeness": "complete"}), encoding="utf-8")
    scaled = {key: (int(value * PRICE_SCALE) if key != "total_volume" else value) for key, value in summary.items()}
    trend = {str(m): {"minute": m, "close": int(c * PRICE_SCALE), "volume": v} for m, c, v in bars}
    (path / "state.json").write_text(json.dumps({"session": session, "durable_sequence": 7,
                                                 "state": {"summary": scaled, "minute_trend": trend}}), encoding="utf-8")


def test_a_fut_summary_is_one_partition(tmp_path):
    store = HistoricalStore(tmp_path)
    _partition(store, "2026-10-02", "NIGHT", bars=[(900, 101.0, 4)],
               summary={"open": 100.0, "high": 105.0, "low": 98.0, "current": 99.0, "reference_price": 100.0, "total_volume": 10})
    _partition(store, "2026-10-05", "DAY", bars=[(525, 102.0, 3)],
               summary={"open": 102.0, "high": 104.0, "low": 97.0, "current": 103.0, "reference_price": 100.0, "total_volume": 5})
    day = store.summary("TXFR1", "2026-10-05", market="FUT", session="DAY")
    assert (day["open"], day["total_volume"], day["session"]) == (102.0, 5, "DAY")
    for session in ("FULL", ""):
        with pytest.raises(ValueError):
            store.summary("TXFR1", "2026-10-05", market="FUT", session=session)


def test_a_stock_summary_carries_the_official_limits_or_none(tmp_path):
    store = HistoricalStore(tmp_path)
    for code, limits in (("2344", {"limit_up": 132.5, "limit_down": 108.5}), ("2330", {})):
        path = store._dir("STK", code, "2026-11-09", "DAY")
        path.mkdir(parents=True, exist_ok=True)
        (path / "manifest.json").write_text(json.dumps({"completeness": "complete"}), encoding="utf-8")
        summary = {key: int(value * PRICE_SCALE) for key, value in {"current": 132.5, "reference_price": 120.5, **limits}.items()}
        (path / "state.json").write_text(json.dumps({"session": "DAY", "state": {"summary": summary}}), encoding="utf-8")
    official = store.summary("2344", "2026-11-09", market="STK", session="DAY")
    assert (official["limit_up"], official["limit_down"]) == (132.5, 108.5)
    # None published: none shown, never derived from 昨收.
    absent = store.summary("2330", "2026-11-09", market="STK", session="DAY")
    assert (absent["limit_up"], absent["limit_down"]) == (None, None)


def test_the_summary_reference_is_bs_reference_price_and_none_when_the_session_stated_none(tmp_path):
    """B writes the comparison price as `reference_price` (null when none was stated); a 0 read as a 昨收 drew every
    move against zero."""
    store = HistoricalStore(tmp_path)
    for code, reference in (("2344", 120.5), ("2330", None)):
        path = store._dir("STK", code, "2026-11-09", "DAY")
        path.mkdir(parents=True, exist_ok=True)
        (path / "manifest.json").write_text(json.dumps({"completeness": "complete"}), encoding="utf-8")
        summary = {"current": int(132.5 * PRICE_SCALE), "reference_price": None if reference is None else int(reference * PRICE_SCALE)}
        (path / "state.json").write_text(json.dumps({"session": "DAY", "state": {"summary": summary}}), encoding="utf-8")
    assert store.summary("2344", "2026-11-09", market="STK", session="DAY")["prev_close"] == 120.5
    assert store.summary("2330", "2026-11-09", market="STK", session="DAY")["prev_close"] is None
