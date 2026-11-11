"""技術分析's history: one product's local days, a page at a time, newest pages first.

Read-only and local: a day is shown only when this machine holds it, and a query never asks a broker. The one store is
the K-bar store (native/analysis_runtime/src/kbar_store.rs): one file per product, written at the close of each session
and by a download job, each date at the one timeframe its age calls for, its daily bar kept forever.

A date goes out at the timeframe it is held: the renderer makes the other timeframes it can from those rows and the
weekly and monthly candles from the daily bars (features/realtime/technical_series.js), because the live day they join
lives there.
"""
from __future__ import annotations

import json
import logging
import re
from collections import OrderedDict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from threading import Lock
from typing import Any

from config import kbar_retention_settings
from service.market.shared import volume as vol
from service.market.shared.session_identity_contract import session_segments
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)

MINUTE_PAGE_DAYS = 5
MINUTE_MAX_DAYS = 20
DAY_PAGE_BARS = 260
DAY_MAX_BARS = 1000

SOURCE_STORE = "kbar_store"

_FUTU_MARKETS = frozenset({"US", "HK", "SH", "SZ", "CC"})
# Paging through a product reads its one file again and again; a handful of parsed files covers the charts on screen.
_CACHED_FILES = 8
_EMPTY: dict[str, Any] = {"daily": {}, "intraday": {}}

_CODE = re.compile(r"[A-Z0-9][A-Z0-9._-]{0,31}")
_MARKET = re.compile(r"[A-Z]{2,5}")
_SESSION = re.compile(r"[A-Z]{2,12}")


def _taipei_today() -> date:
    return datetime.now(timezone(timedelta(hours=8))).date()


def valid_code(code: str) -> bool:
    return _CODE.fullmatch(code) is not None and ".." not in code


def valid_scope(market: str, session: str) -> bool:
    return _MARKET.fullmatch(market) is not None and _SESSION.fullmatch(session) is not None


def _source_of(market: str) -> str:
    return "futu" if market in _FUTU_MARKETS else "shioaji"


class TechnicalHistoryReader:
    """Pages of one product's minute days and daily bars."""

    def __init__(self, kbar_root: Path) -> None:
        self.kbar_root = Path(kbar_root)
        self._lock = Lock()
        self._files: OrderedDict[Path, tuple[tuple[int, int], dict[str, Any]]] = OrderedDict()
        # Files already reported as unreadable: one failure record per version of a file, not one per request.
        self._reported: set[tuple[str, tuple[int, int]]] = set()

    def _path(self, market: str, code: str) -> Path:
        return self.kbar_root / f"source={_source_of(market)}" / f"market={market}" / f"{code}.json"

    def _report(self, path: Path, stamp: tuple[int, int], exc: Exception) -> None:
        key = (str(path), stamp)
        with self._lock:
            if key in self._reported:
                return
            self._reported.add(key)
        record_failure(_failure_log, f"reading the K-bar file {path}", exc)

    def _sessions(self, market: str, code: str) -> dict[str, Any]:
        path = self._path(market, code)
        try:
            info = path.stat()
        except FileNotFoundError:  # not an error: a product this machine holds no K bars of
            return {}
        stamp = (info.st_mtime_ns, info.st_size)
        with self._lock:
            held = self._files.get(path)
            if held and held[0] == stamp:
                self._files.move_to_end(path)
                return held[1]
        try:
            sessions = json.loads(path.read_bytes())["sessions"]
        except (OSError, ValueError, KeyError, TypeError) as exc:
            self._report(path, stamp, exc)
            return {}
        with self._lock:
            self._files[path] = (stamp, sessions)
            while len(self._files) > _CACHED_FILES:
                self._files.popitem(last=False)
        return sessions

    def _session(self, market: str, session: str, code: str) -> dict[str, Any]:
        return self._sessions(market, code).get(session, _EMPTY)

    def minute_days(self, market: str, session: str, code: str, before: str | None, limit: int | None) -> dict[str, Any]:
        """Up to `limit` trading days before `before` (oldest first), each at the timeframe it is held, and where the
        next older page starts."""
        count = max(1, min(int(limit or MINUTE_PAGE_DAYS), MINUTE_MAX_DAYS))
        intraday = self._session(market, session, code)["intraday"]
        days: list[dict[str, Any]] = []
        next_before = None
        for trading_date in sorted(intraday, reverse=True):
            if before and trading_date >= before:
                continue
            if len(days) == count:
                next_before = days[-1]["trading_date"]
                break
            held = intraday[trading_date]
            days.append({"trading_date": trading_date, "source": SOURCE_STORE, "timeframe": held["timeframe"], "bars": held["bars"]})
        days.reverse()
        return {"code": code, "market": market, "session": session, "resolution": "minute",
                "segments": session_segments(_source_of(market), market, session), "days": days, "next_before": next_before,
                "horizons": kbar_retention_settings.horizons(_taipei_today())}

    def daily_bars(self, market: str, session: str, code: str, before: str | None, limit: int | None) -> dict[str, Any]:
        """Up to `limit` daily bars before `before` (oldest first), and where the next older page starts."""
        count = max(1, min(int(limit or DAY_PAGE_BARS), DAY_MAX_BARS))
        bars: dict[str, dict[str, Any]] = {}
        for trading_date, (open_, high, low, close, volume) in self._session(market, session, code)["daily"].items():
            bars[trading_date] = {"trading_date": trading_date, "open": open_, "high": high, "low": low, "close": close,
                                  "volume": vol.wire(vol.to_volume(volume)), "source": SOURCE_STORE}
        dates = sorted(date for date in bars if not before or date < before)
        page = dates[-count:]
        return {"code": code, "market": market, "session": session, "resolution": "day", "bars": [bars[date] for date in page],
                "next_before": page[0] if len(dates) > count else None}
