from __future__ import annotations

import os
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Any

from config.observability_contract import metric, service_metrics_document


class RuntimeProfiler:
    """Low-overhead startup/realtime timing recorder.

    Keeps bounded in-memory samples only. No parquet/pandas/file I/O is performed on the realtime path. The snapshot is
    a service metrics document (config/observability_contract.py): each timing a ``histogram`` metric in ms carrying
    its sample window (``samples`` kept now, ``window_ms`` they span) apart from ``total_count`` (every observation since
    the process started), and each startup mark a ``gauge``.
    """

    def __init__(self, max_samples_per_metric: int = 500) -> None:
        self._lock = threading.RLock()
        self._process_started_ns = time.perf_counter_ns()
        self._startup: dict[str, dict[str, Any]] = {}
        # name -> (perf_counter_ns at observation, duration ms)
        self._samples: dict[str, deque[tuple[int, float]]] = defaultdict(lambda: deque(maxlen=max_samples_per_metric))
        self._totals: dict[str, int] = defaultdict(int)
        self._last: dict[str, dict[str, Any]] = {}

    def startup_mark(self, name: str, *, elapsed_ms: float | None = None, detail: Any = None) -> None:
        if elapsed_ms is None:
            elapsed_ms = (time.perf_counter_ns() - self._process_started_ns) / 1_000_000
        with self._lock:
            self._startup[str(name)] = {
                "elapsed_ms": round(float(elapsed_ms), 3),
                "at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                "detail": detail,
            }

    def observe(self, name: str, duration_ms: float, *, detail: Any = None) -> None:
        value = max(0.0, float(duration_ms))
        with self._lock:
            self._samples[str(name)].append((time.perf_counter_ns(), value))
            self._totals[str(name)] += 1
            self._last[str(name)] = {
                "duration_ms": round(value, 3),
                "at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                "detail": detail,
            }

    def observe_ns(self, name: str, started_ns: int, *, detail: Any = None) -> None:
        self.observe(name, (time.perf_counter_ns() - int(started_ns)) / 1_000_000, detail=detail)

    def snapshot(self, *, service_id: str, instance_id: str) -> dict[str, Any]:
        with self._lock:
            metrics: list[dict[str, Any]] = []
            for name, entries in self._samples.items():
                if not entries:
                    continue
                ordered = sorted(value for _at, value in entries)

                def percentile(q: float) -> float:
                    index = max(0, min(len(ordered) - 1, int(round((len(ordered) - 1) * q))))
                    return round(ordered[index], 3)

                metrics.append(metric(
                    f"timing.{name}", service_id, instance_id=instance_id, value=percentile(0.50), unit="ms",
                    kind="histogram", window_ms=int((entries[-1][0] - entries[0][0]) // 1_000_000),
                    samples=len(ordered), total_count=self._totals[name], avg=round(sum(ordered) / len(ordered), 3),
                    p50=percentile(0.50), p95=percentile(0.95), p99=percentile(0.99), max=round(ordered[-1], 3),
                    last=self._last.get(name)))
            for name, mark in self._startup.items():
                metrics.append(metric(f"startup.{name}", service_id, instance_id=instance_id, value=mark["elapsed_ms"],
                                      unit="ms", kind="gauge", at=mark["at"], detail=mark["detail"]))
        return service_metrics_document(service_id, instance_id, metrics, pid=os.getpid())


runtime_profiler = RuntimeProfiler()
