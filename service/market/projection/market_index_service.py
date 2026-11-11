from __future__ import annotations

from collections import OrderedDict
from copy import deepcopy
from datetime import datetime
from zoneinfo import ZoneInfo
from threading import RLock
from typing import Any, Callable

import logging

from service.market.history.index_day import index_day
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)



class MarketIndexService:
    """Shioaji TAIEX history facade (歷史頁加權走勢).

    A stored day is read through ``index_day`` (B's minute trend and session summary of the IDX partition). Live TAIEX is Market
    Runtime's (WS); the in-memory live copy and the index feature rows the retired Python inference read are gone.
    """

    # The instrument code the historical store names the weighted index by.
    CODE = "TAIEX"

    def __init__(
        self,
        *,
        # The Shioaji historical repository, injected by its owner: projection never imports a provider.
        history_repository: Any | None = None,
        repository_provider: Callable[[], Any | None] | None = None,
    ) -> None:
        self._history_repository = history_repository
        self._repository_provider = repository_provider
        self._lock = RLock()
        # Keep a small materialized-session cache so repeated history requests do not re-read the same date.
        self._history_cache: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._history_cache_limit = 16

    def set_history_repository(self, repository: Any) -> None:
        self._history_repository = repository
        with self._lock:
            self._history_cache.clear()

    def get_history_session(self, date_text: str) -> dict[str, Any]:
        normalized = datetime.strptime(str(date_text), "%Y-%m-%d").strftime("%Y-%m-%d")
        repository = self._history_repository or (self._repository_provider() if self._repository_provider else None)
        # A cached answer is served only while the stored data it was built from is unchanged: an answer built
        # mid-session or mid-backfill must not stay forever, keyed by the date alone.
        fingerprint = self._history_fingerprint(repository, normalized)
        with self._lock:
            cached = self._history_cache.get(normalized)
            if cached is not None and fingerprint is not None and cached.get("fingerprint") == fingerprint:
                self._history_cache.move_to_end(normalized)
                return deepcopy(cached["result"])
        if repository is None:
            return {
                "date": normalized, "count": 0, "points": [],
                "error": "Shioaji historical repository 尚未就緒",
                "capability_gap": "加權指數歷史資料需本機已物化的 IDX 分區。",
            }

        try:
            day = index_day(repository, normalized, self.CODE)
        except Exception as exc:  # noqa: BLE001 -- recorded, and surfaced in the answer
            record_failure(_failure_log, f"reading the stored TAIEX day of {normalized}", exc)
            return {
                "date": normalized, "count": 0, "points": [], "prev_close": None, "source": None,
                "coverage": "LOCAL_READ_FAILED", "error": f"stored TAIEX day unreadable: {type(exc).__name__}: {exc}"[:300],
            }
        points = day["points"]
        result = {
            "date": normalized, "count": len(points), "points": points, "prev_close": day["prev_close"],
            "source": "rust_historical_store" if points else None, "coverage": "RECORDED" if points else "EMPTY",
        }
        today = datetime.now(ZoneInfo("Asia/Taipei")).strftime("%Y-%m-%d")
        if points and fingerprint is not None and normalized < today:
            with self._lock:
                self._history_cache[normalized] = {"fingerprint": fingerprint, "result": deepcopy(result)}
                self._history_cache.move_to_end(normalized)
                while len(self._history_cache) > self._history_cache_limit:
                    self._history_cache.popitem(last=False)
        return result

    @staticmethod
    def _history_fingerprint(repository: Any, trading_date: str) -> str | None:
        """Digest of the materialized IDX partitions of the date (None: cannot tell, so never cache)."""
        store = getattr(repository, "historical", None)
        if store is None:
            return None
        try:
            return str(store.fingerprint("IDX", trading_date, "DAY"))
        except Exception as exc:
            record_failure(_failure_log, "reading the IDX store fingerprint", exc)
            return None
