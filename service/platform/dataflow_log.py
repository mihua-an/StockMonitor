"""Intraday dataflow / latency log: one aggregated line per interval, never one per event.

``var/logs/<startup_timestamp>/dataflow-<component>.log`` (JSON Lines, one file per provider process). Fed from the evidence the producers
already maintain -- ``DataFlowHealthLedger``'s per-stage counters and the pipeline/queue
telemetry -- so this file adds a *time series* rather than a second source of truth.

What one line answers: how much arrived, how much Market Runtime accepted and acknowledged, how
deep the queues got, what was dropped, whether sequences gapped or a resync happened, and the
stage-to-stage latency percentiles for the interval.

Deliberately NOT per event. The interval is seconds, and a line is written for an interval only
when something actually moved or something is wrong -- an idle market writes nothing. That is the
whole point: service/platform/logging_setup.py's header records what per-event logging cost here before
(a 201 MB daemon log, and an "error" log that was 18013 copies of one DEBUG frame).
"""
from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Mapping

from service.platform.log_session import log_session_path
from service.platform.atomic_files import append_line, rotate_if_larger
import logging
from service.platform.failure_record import record_failure


_failure_log = logging.getLogger(__name__)

DEFAULT_INTERVAL_SECONDS = 10.0
MAX_BYTES = 16 * 1024 * 1024

_lock = threading.RLock()


def dataflow_log_path(component: str) -> Path:
    """One provider process's file, ``dataflow-<component>.log``: its one writer appends to and rotates it."""
    tag = str(component).strip().lower()
    if not tag or not tag.replace("_", "").isalnum():
        raise ValueError(f"a dataflow log needs its component's name, got {component!r}")
    return log_session_path(f"dataflow-{tag}.log")


def write_dataflow_row(row: Mapping[str, Any]) -> None:
    """Append one interval row to its component's file. Never raises: telemetry must not break the pipeline."""
    try:
        path = dataflow_log_path(str(row.get("component") or ""))
        with _lock:
            rotate_if_larger(path, MAX_BYTES)
            append_line(path, json.dumps(dict(row), ensure_ascii=False, separators=(",", ":")))
    except Exception as exc:
        record_failure(_failure_log, "writing the dataflow log", exc)


def _stage_counts(snapshot: Mapping[str, Any]) -> dict[str, int]:
    stages = snapshot.get("stages")
    if not isinstance(stages, Mapping):
        return {}
    counts: dict[str, int] = {}
    for key, value in stages.items():
        if not isinstance(value, Mapping):
            continue
        stage = str(key).split("|", 1)[0]
        counts[stage] = counts.get(stage, 0) + int(value.get("observed") or 0)
    return counts


class DataFlowIntervalLogger:
    """Turn a producer's dataflow snapshot into an interval time series.

    ``snapshot_provider`` is the same callable the health publisher already uses, so this never
    samples the hot path itself -- it only differences two snapshots.
    """

    def __init__(
        self,
        component: str,
        snapshot_provider: Callable[[], Mapping[str, Any]],
        *,
        interval_seconds: float = DEFAULT_INTERVAL_SECONDS,
        extra_provider: Callable[[], Mapping[str, Any] | None] | None = None,
    ) -> None:
        self.component = str(component)
        self.snapshot_provider = snapshot_provider
        self.extra_provider = extra_provider
        self.interval_seconds = max(1.0, float(interval_seconds))
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lifecycle_lock = threading.RLock()
        self._previous: dict[str, int] = {}
        self._previous_at = 0.0

    def sample_once(self) -> dict[str, Any] | None:
        """Difference this interval against the last one. Returns None for an idle, healthy interval."""
        try:
            snapshot = self.snapshot_provider() or {}
        except Exception as exc:
            record_failure(_failure_log, f"reading the {self.component} dataflow snapshot", exc)
            return {"at": datetime.now().astimezone().isoformat(timespec="milliseconds"),
                    "component": self.component, "error": f"{type(exc).__name__}: {exc}"}
        counts = _stage_counts(snapshot)
        now = time.monotonic()
        elapsed = max(1e-6, now - self._previous_at) if self._previous_at else self.interval_seconds
        deltas = {stage: max(0, counts.get(stage, 0) - self._previous.get(stage, 0)) for stage in counts}
        self._previous, self._previous_at = counts, now

        extra: Mapping[str, Any] = {}
        if self.extra_provider is not None:
            try:
                extra = self.extra_provider() or {}
            except Exception as exc:
                record_failure(_failure_log, "reading the dataflow extra counters", exc)
                extra = {}

        moved = any(value > 0 for value in deltas.values())
        anomaly = any(int(extra.get(key) or 0) > 0 for key in ("dropped", "rejected", "sequence_gaps", "resyncs", "overflow"))
        if not moved and not anomaly:
            return None                       # an idle market writes nothing at all

        return {
            "at": datetime.now().astimezone().isoformat(timespec="milliseconds"),
            "component": self.component,
            "pid": os.getpid(),
            "interval_s": round(elapsed, 3),
            "events": deltas,
            "rates_per_s": {stage: round(value / elapsed, 2) for stage, value in deltas.items()},
            **{key: value for key, value in extra.items()},
        }

    def start(self) -> None:
        with self._lifecycle_lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop.clear()

            def _run() -> None:
                while not self._stop.is_set():
                    # A snapshot this code cannot difference (a counter that is not a number) costs that interval,
                    # never the thread.
                    try:
                        row = self.sample_once()
                    except Exception as exc:
                        record_failure(_failure_log, f"sampling the {self.component} dataflow interval", exc)
                        row = None
                    if row is not None:
                        write_dataflow_row(row)
                    if self._stop.wait(self.interval_seconds):
                        break

            self._thread = threading.Thread(target=_run, daemon=True, name=f"DataFlowLog-{self.component}")
            self._thread.start()

    def stop(self, timeout: float = 2.0) -> None:
        with self._lifecycle_lock:
            self._stop.set()
            thread = self._thread
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=max(0.0, float(timeout)))
