"""The TXFR1 全日 replay overlay is the business day: the night before it plus its day.

``get_reference_tick_session`` loaded the minute trend with no session, so the store returned the date's DAY
partition and the NIGHT that opens that evening -- the next trading date's -- and never the night the date rolls
into. On a Monday that dropped Friday 15:00-05:00 and appended Monday evening after the close.
"""
from __future__ import annotations

import json
from types import SimpleNamespace

from service.market.history.historical_store import HistoricalMinuteTrendReader, HistoricalStore, HistoricalSummaryReader
from service.market.shared.native_values import DEFAULT_PRICE_SCALE as PRICE_SCALE
from service.market.history.history_replay_service import HistoryReplayService


def _partition(store: HistoricalStore, trading_date: str, session: str, minute: int, close: float,
               reference: float | None = None) -> None:
    path = store._dir("FUT", "TXFR1", trading_date, session)
    path.mkdir(parents=True, exist_ok=True)
    (path / "manifest.json").write_text(json.dumps({"trading_date": trading_date, "session": session}), encoding="utf-8")
    bars = {str(minute): {"minute": minute, "close": int(close * PRICE_SCALE), "volume": 1}}
    (path / "state.json").write_text(json.dumps({"session": session, "durable_sequence": 1, "state": {"minute_trend": bars, "summary": {"reference_price": None if reference is None else int(reference * PRICE_SCALE)}}}),
                                     encoding="utf-8")


def test_a_monday_overlay_starts_with_fridays_night_and_ends_with_its_own_day(tmp_path):
    store = HistoricalStore(tmp_path)
    _partition(store, "2026-10-02", "NIGHT", 900, 100.0)    # Friday 15:00: rolls into Monday
    _partition(store, "2026-10-05", "DAY", 525, 200.0, reference=190.0)  # Monday 08:45; 參考價 190
    _partition(store, "2026-10-05", "NIGHT", 900, 300.0)    # Monday 15:00: Tuesday's business day
    repository = SimpleNamespace(minute_trend_store=HistoricalMinuteTrendReader(store),
                                 session_summary_store=HistoricalSummaryReader(store))
    service = HistoryReplayService(lambda: repository)

    overlay = service.get_reference_tick_session("2026-10-05")

    assert [(p["datetime"], p["price"]) for p in overlay["points"]] == [
        ("2026-10-02T15:00:00", 100.0),
        ("2026-10-05T08:45:00", 200.0),
    ]
    # The overlay is drawn from the DAY 參考價, not from the first (night) print.
    assert overlay["reference_price"] == 190.0
