"""Read-only archive of Rust B's intraday rule events (docs/system-architecture/02 section 5).

Rust B owns the events and appends every new or revised record to ``<analysis_events>/<trading_date>.jsonl`` under the
storage location (config/var_layout.json "storage"; Health passes the same folder to B as ``--events-dir``).
Readers keep the newest revision per event_id, so an update or a revocation replaces the earlier record instead of
listing it twice. Nothing here writes.
"""
from __future__ import annotations

import json
import re
import threading
import time
from collections import OrderedDict
from datetime import date
from pathlib import Path
from typing import Any
import logging
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)

# A last line without its newline in a file untouched this long is a write that never finished, not one in progress.
TORN_LINE_AFTER_S = 10.0

_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


def _valid_trading_date(text: str) -> bool:
    """A real calendar date written YYYY-MM-DD, nothing else: the value becomes a file name
    (`?date=../x` would read a sibling .jsonl outside the events directory)."""
    if not _DATE.fullmatch(text):
        return False
    try:
        date.fromisoformat(text)
    except ValueError:  # not an error: validator: text that is not an ISO date is answered False
        return False
    return True


def default_root() -> Path:
    from config.storage_settings import storage_paths

    return storage_paths().analysis_events


class AnalysisEventArchive:
    # A day's file is parsed once per version (size + mtime) and kept for the few most recently read days: a
    # past day is not appended to any more, so re-reading it -- the tape's ARCHIVE view, 歷史回放 -- does not scan
    # the whole file again. Today's file changes, so its signature changes and it is parsed again.
    CACHE_DAYS = 8

    def __init__(self, root: Path | None = None) -> None:
        self.root = root or default_root()
        self._cache: OrderedDict[Path, tuple[tuple[int, int], list[dict[str, Any]], int]] = OrderedDict()
        self._lock = threading.Lock()

    def _newest_first(self, path: Path) -> tuple[list[dict[str, Any]], int]:
        """The day's events newest first, and how many lines were damaged (not JSON, not an object, no event_id). A
        last line without its newline is one B is still writing while the file is fresh (not read yet); in a file
        untouched for longer it is a write that never finished, and counts as damage."""
        try:
            stat = path.stat()
        except FileNotFoundError:  # not an error: no archive for that day yet
            return [], 0
        signature = (stat.st_size, stat.st_mtime_ns)
        with self._lock:
            hit = self._cache.get(path)
            if hit and hit[0] == signature:
                self._cache.move_to_end(path)
                return hit[1], hit[2]
        latest: dict[str, dict[str, Any]] = {}
        # Line number of each event's kept revision: a later revision of an older event is as new as its line.
        position: dict[str, int] = {}
        line_number = 0
        damaged = 0
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if not line.endswith("\n"):
                    if time.time() - stat.st_mtime > TORN_LINE_AFTER_S:
                        damaged += 1
                        record_failure(_failure_log, "reading an analysis event archive", ValueError("its last line never finished"))
                    break
                if not line.strip():
                    continue
                line_number += 1
                try:
                    record = json.loads(line)
                except ValueError as exc:
                    damaged += 1
                    record_failure(_failure_log, "decoding an analysis event archive line", exc)
                    continue
                event_id = str(record.get("event_id") or "") if isinstance(record, dict) else ""
                if not event_id:
                    damaged += 1
                    record_failure(_failure_log, "reading an analysis event archive line", ValueError("no event_id"))
                    continue
                previous = latest.get(event_id)
                if previous is None or int(record.get("revision") or 0) >= int(previous.get("revision") or 0):
                    latest[event_id] = record
                    position[event_id] = line_number
        events = [latest[e] for e in sorted(latest, key=position.__getitem__, reverse=True)]
        with self._lock:
            self._cache[path] = (signature, events, damaged)
            self._cache.move_to_end(path)
            while len(self._cache) > self.CACHE_DAYS:
                self._cache.popitem(last=False)
        return events, damaged

    def read(self, date_text: str, limit: int = 500) -> dict[str, Any]:
        date_text = str(date_text or "").strip()
        if not _valid_trading_date(date_text):
            return {"ok": False, "error": "INVALID_DATE", "date": None, "events": [], "count": 0,
                    "authority": "analysis_runtime", "source": "analysis_event_archive"}
        root = self.root.resolve()
        path = (root / f"{date_text}.jsonl").resolve()
        if path.parent != root:
            return {"ok": False, "error": "INVALID_DATE", "date": None, "events": [], "count": 0,
                    "authority": "analysis_runtime", "source": "analysis_event_archive"}
        # Newest first, like the live tape; bounded to the newest `limit`.
        events, damaged = self._newest_first(path)
        events = events[:max(1, int(limit))]
        # Whether B wrote this day's archive at all: a day archived with no events is not a missing archive. Damaged
        # lines say the events read are not all the day had.
        return {"ok": True, "date": date_text, "events": events, "count": len(events), "archived": path.is_file(),
                "damaged_lines": damaged, "authority": "analysis_runtime", "source": "analysis_event_archive"}
