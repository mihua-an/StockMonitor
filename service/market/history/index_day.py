"""One stored index day (加權, 產業指數): its minute levels and its 昨收, as every history reader shows it.

The minutes are Rust B's minute trend of the IDX partition (state.json): B owns which minutes a session has and which
level closes each one, so no reader here buckets quotes into minutes again. The 昨收 is the session summary's
comparison price, as the futures overlay reads its own (history_replay_service.get_reference_tick_session).
"""
from __future__ import annotations

import logging
from typing import Any

import pandas as pd

from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)


def day_reference_price(repo: Any, market: str, code: str, trading_date: str) -> float | None:
    """The date's DAY 參考價 of ``code`` from the session summary (None when the date has none)."""
    try:
        summary = repo.session_summary_store.load_any_contract(market=market, trading_date=trading_date,
                                                               session="DAY", logical_code=code) or {}
    except Exception as exc:
        record_failure(_failure_log, f"reading the {market} {code} session summary of {trading_date} for its reference", exc)
        return None
    value = pd.to_numeric(pd.Series([summary.get("prev_close")]), errors="coerce").iloc[0]
    return float(value) if pd.notna(value) and value > 0 else None


def index_day(repo: Any, trading_date: str, code: str) -> dict[str, Any]:
    """``{"points": [{"time": "HH:MM", "price": level}, ...], "prev_close": 昨收 or None}`` of one stored index day.

    A day with no stored minutes has no points (a reader shows Market Runtime's view of it instead). A failed read
    raises: it is not a day with nothing stored."""
    frame = repo.minute_trend_store.load_date(market="IDX", trading_date=trading_date, logical_code=code, session="DAY")
    points: list[dict[str, Any]] = []
    if frame is not None and not frame.empty:
        stamps = pd.to_datetime(frame["minute_timestamp"], errors="coerce")
        prices = pd.to_numeric(frame["price"], errors="coerce")
        for stamp, price in zip(stamps, prices):
            if pd.notna(stamp) and pd.notna(price):
                points.append({"time": stamp.strftime("%H:%M"), "price": float(price)})
    return {"points": points, "prev_close": day_reference_price(repo, "IDX", code, trading_date)}
