"""A closed session fetched for a view, kept on disk so it is fetched once (decisions.md 收盤後看任何商品都要有資料).

``<storage location>/query-cache/<trading date>/<SESSION>/<MARKET>_<CODE>.json.gz``: the prints from the broker, the
book and closing state, and the 昨收. A later view of that session, after a restart too, is shown from here with no
request to the broker or TWSE. This is what a view showed, never the historical store: nothing reads it as history,
and each session's materialization removes the dates past 設定 → 資料儲存 → 查詢快取 (config/query_cache_settings.py).
"""
from __future__ import annotations

import gzip
import json
import logging
import re
import shutil
from dataclasses import asdict, dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from service.platform.atomic_files import write_bytes_atomic
from service.platform.failure_record import record_failure

_log = logging.getLogger(__name__)
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
_NAME = re.compile(r"[A-Z0-9_.]+")


@dataclass(frozen=True)
class ClosingState:
    """A stock's closing state from the exchange (service/market/shioaji/closing_state_source.py)."""

    prev_close: float | None
    limit_up: float | None
    limit_down: float | None
    bids: list[tuple[float, float]]
    asks: list[tuple[float, float]]


@dataclass(frozen=True)
class CachedSession:
    prints: list[tuple[int, float, float, int]]
    book: tuple[int, float, float, float, float] | None
    closing: ClosingState | None
    prev_close: float | None


class QueryCache:
    def __init__(self, root: Path) -> None:
        self._root = Path(root)

    def _path(self, gap: Any) -> Path | None:
        names = (gap.session, gap.market, gap.code)
        if not _DATE.fullmatch(gap.trading_date) or not all(_NAME.fullmatch(name) for name in names):
            return None
        return self._root / gap.trading_date / gap.session / f"{gap.market}_{gap.code}.json.gz"

    def load(self, gap: Any) -> CachedSession | None:
        path = self._path(gap)
        if path is None:
            return None
        try:
            with gzip.open(path, "rt", encoding="utf-8") as stream:
                body = json.load(stream)
            closing = body["closing"]
            return CachedSession(
                prints=[tuple(row) for row in body["prints"]], book=tuple(body["book"]) if body["book"] else None,
                closing=None if closing is None else ClosingState(prev_close=closing["prev_close"], limit_up=closing["limit_up"], limit_down=closing["limit_down"],
                                                                  bids=[tuple(l) for l in closing["bids"]], asks=[tuple(l) for l in closing["asks"]]),
                prev_close=body["prev_close"])
        except FileNotFoundError:  # not an error: this session of this code was not fetched yet
            return None
        except (OSError, ValueError, KeyError, TypeError) as exc:
            record_failure(_log, f"reading the query cache {path}", exc)
            return None

    def save(self, gap: Any, *, prints: list[Any], book: Any, closing: ClosingState | None, prev_close: float | None) -> None:
        """Written whole or not at all. A failure leaves the next view to fetch again."""
        path = self._path(gap)
        if path is None:
            return
        document = {"prints": prints, "book": book, "closing": None if closing is None else asdict(closing), "prev_close": prev_close}
        try:
            write_bytes_atomic(path, gzip.compress(json.dumps(document, separators=(",", ":")).encode("utf-8")))
        except OSError as exc:
            record_failure(_log, f"writing the query cache {path}", exc)

    def prune(self, days: int, today: date) -> list[str]:
        """Removes the trading dates more than `days` calendar days before `today`; their names."""
        if not self._root.is_dir():
            return []
        cutoff = today - timedelta(days=days)
        removed = []
        for folder in sorted(self._root.iterdir()):
            if folder.is_dir() and _DATE.fullmatch(folder.name) and date.fromisoformat(folder.name) < cutoff:
                shutil.rmtree(folder)
                removed.append(folder.name)
        return removed
