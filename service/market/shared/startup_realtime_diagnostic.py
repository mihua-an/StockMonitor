from __future__ import annotations

import threading
import time
from collections import Counter, deque
from datetime import datetime, timezone
from typing import Any


# The stages the daemon marks, in startup order (the order the snapshot measures stage durations in).
STARTUP_STAGES = (
    "DAEMON_PROCESS_STARTED",
    "DAEMON_HTTP_READY",
    "DAEMON_RUNTIME_ACTIVE",
    "SHIOAJI_LOGIN_START",
    "SHIOAJI_LOGIN_OK",
    "SUBSCRIPTION_SYNC_START",
    "SUBSCRIPTION_SYNC_OK",
)


class StartupRealtimeDiagnostic:
    """Bounded, thread-safe startup/freshness trace.

    This intentionally performs no file I/O on callback paths. A diagnostic tool
    can read the snapshot through the daemon/FastAPI endpoints and persist JSON.
    Wall-clock timestamps are UTC ISO-8601 so Electron/FastAPI/daemon traces can
    be merged without guessing a timezone; exchange timestamps remain untouched
    market-time values in the event payload.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._process_started_ns = time.perf_counter_ns()
        self._process_started_at = datetime.now(timezone.utc)
        self._trace: deque[dict[str, Any]] = deque(maxlen=512)
        self._once: set[str] = set()
        self._ws_counts: Counter[str] = Counter()
        self.mark("DAEMON_PROCESS_STARTED", once=True)

    @staticmethod
    def _now_iso() -> str:
        return datetime.now(timezone.utc).isoformat(timespec="milliseconds")

    def mark(self, stage: str, *, detail: dict[str, Any] | None = None, once: bool = False, once_key: str | None = None) -> dict[str, Any] | None:
        name = str(stage or "").strip().upper()
        if not name:
            return None
        key = str(once_key or name)
        with self._lock:
            if once and key in self._once:
                return None
            if once:
                self._once.add(key)
            row = {
                "stage": name,
                "timestamp": self._now_iso(),
                "elapsed_ms_from_daemon_process_start": round((time.perf_counter_ns() - self._process_started_ns) / 1_000_000, 3),
                "detail": dict(detail or {}),
            }
            self._trace.append(row)
            return dict(row)

    def observe_websocket(self, event: str) -> None:
        name = str(event or "").strip().lower()
        if not name:
            return
        with self._lock:
            self._ws_counts[name] += 1

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            trace = [dict(item) for item in self._trace]
            ws = dict(self._ws_counts)

        stage_first: dict[str, dict[str, Any]] = {}
        for row in trace:
            stage_first.setdefault(str(row.get("stage") or ""), row)
        slow_rows = sorted(
            [row for row in trace if row.get("stage") in STARTUP_STAGES],
            key=lambda row: float(row.get("elapsed_ms_from_daemon_process_start") or 0),
        )
        deltas: list[dict[str, Any]] = []
        previous = None
        for row in slow_rows:
            if previous is not None:
                delta = float(row.get("elapsed_ms_from_daemon_process_start") or 0) - float(previous.get("elapsed_ms_from_daemon_process_start") or 0)
                deltas.append({"from": previous.get("stage"), "to": row.get("stage"), "duration_ms": round(max(0.0, delta), 3)})
            previous = row
        slowest = max(deltas, key=lambda item: item["duration_ms"], default=None)
        return {
            "schema": "startup-realtime-freshness-v1",
            "process_started_at": self._process_started_at.isoformat(timespec="milliseconds"),
            "trace": trace,
            "stage_first": stage_first,
            "stage_durations": deltas,
            "slowest_stage": slowest,
            "stages_over_100ms": [item for item in deltas if item["duration_ms"] > 100],
            "stages_over_500ms": [item for item in deltas if item["duration_ms"] > 500],
            "stages_over_2000ms": [item for item in deltas if item["duration_ms"] > 2000],
            "websocket": ws,
        }


startup_realtime_diagnostic = StartupRealtimeDiagnostic()
