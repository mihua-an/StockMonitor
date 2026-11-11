"""資料中心 over the Rust historical store.

Every session materialized by the Rust Historical Materializer is in the historical store, which 歷史回放 reads.
``HistoricalEvidenceCatalog`` answers what DataCenterService asks -- each partition lane's identity and record count,
and the partition's size on disk -- from each date's index (``totals.json``, service/platform/historical_totals.py,
written by Rust B): one file per market and date; no manifest or event file is opened.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from service.platform import historical_totals
from service.market.history.historical_store import ORDERBOOK_LANE
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)

# The lanes that are market data. "minute_bar": an index day filled from the broker's history holds only price bars
# (history_fill.py; decisions.md 指數整天沒有分區的日子) -- without it such a partition was left out of 資料中心.
_LANE_KIND = {"trade": "tick", ORDERBOOK_LANE: "bidask", "quote": "quote", "minute_bar": "minute_bar"}
_MARKETS = ("STK", "IDX", "FUT")


class HistoricalEvidenceCatalog:
    """The catalog interface DataCenterService reads, answered from the dates' indexes of the historical store
    (``store``: a ``HistoricalStore``, for its root and source)."""

    def __init__(self, store: Any) -> None:
        self.store = store

    def _market_dir(self, market: str) -> Path:
        return Path(self.store.root) / f"source={self.store.source}" / f"market={market}"

    def _partitions(self, trading_date: str = "", market: str = "") -> list[tuple[str, str, dict[str, Any]]]:
        """(market, trading date, partition) for every committed partition the indexes list. A date whose index
        cannot be read is recorded and left out."""
        if self.store is None:
            return []
        found = []
        for m in ([str(market).upper()] if market else list(_MARKETS)):
            dates = historical_totals.market_date_dirs(self._market_dir(m))
            if trading_date:
                dates = {d: path for d, path in dates.items() if d == str(trading_date)[:10]}
            for date_text, date_dir in dates.items():
                try:
                    partitions = historical_totals.date_partitions(date_dir)
                except (OSError, historical_totals.TotalsUnreadable) as exc:
                    record_failure(_failure_log, f"reading the historical date index of {m} {date_text}", exc)
                    continue
                found.extend((m, date_text, partition) for partition in partitions or ())
        return found

    def raw_part_identities(self, *, kind: str = "", market: str = "", trading_date: str = "") -> list[dict[str, Any]]:
        rows = []
        for market_name, date_text, partition in self._partitions(trading_date, market):
            code = str(partition.get("code") or "").upper()
            identity = {"source": str(self.store.source), "market": market_name, "logical_code": code, "actual_contract": code,
                        "trading_date": date_text, "session": str(partition.get("session") or "").upper(),
                        "completeness": str(partition.get("completeness") or "gap_detected")}
            for lane, events in (partition.get("lanes") or {}).items():
                lane_kind = _LANE_KIND.get(lane)
                if not lane_kind or (kind and lane_kind != kind):
                    continue
                rows.append({**identity, "kind": lane_kind, "row_count": int(events or 0), "part_count": 1,
                             # The partition's events file (all its lanes together): counted once per partition.
                             "partition_bytes": int(partition.get("events_bytes") or 0)})
        return rows
