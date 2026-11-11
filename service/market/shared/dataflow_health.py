from __future__ import annotations

import json
import os
import threading
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Mapping

from service.platform import project_root as process_paths
from service.platform.atomic_files import read_bytes_shared, write_json_atomic
import logging
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)


DATAFLOW_HEALTH_SCHEMA = "stock-monitor-dataflow-health-v1"


class DataFlowStage(str, Enum):
    """Stable evidence stages that exist in the TARGET pipeline.

    SDK callback -> live_event_sink admission -> Market Runtime ack, plus the
    daemon-owned raw evidence writes and the renderer-reported stages.
    """

    CALLBACK_RECEIVED = "callback_received"
    INGEST_ACCEPTED = "ingest_accepted"
    MARKET_RUNTIME_ACKED = "market_runtime_acked"
    WAL_DURABLE = "wal_durable"
    PART_PERSISTED = "part_persisted"
    RENDERER_RECEIVED = "renderer_received"
    RENDERER_APPLIED = "renderer_applied"
    COMPONENT_RENDERED = "component_rendered"


@dataclass(frozen=True)
class DataFlowIdentity:
    """Minimal identity carried by diagnostics without changing wire payloads."""

    event_id: str = ""
    stream_id: str = ""
    symbol: str = ""
    sequence: int = 0
    generation: int = 0
    trading_date: str = ""
    session: str = ""
    source_timestamp: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id,
            "stream_id": self.stream_id,
            "symbol": self.symbol,
            "sequence": self.sequence,
            "generation": self.generation,
            "trading_date": self.trading_date,
            "session": self.session,
            "source_timestamp": self.source_timestamp,
        }


class DataFlowHealthLedger:
    """Process-local dataflow evidence with a bounded callback-safe ingress.

    ``pulse_hot`` only appends a compact tuple to a bounded ``deque``. It never
    acquires this class' lock, performs I/O, serializes JSON, calls another
    service, or waits for capacity. Normal worker threads use ``observe`` for
    exact counters. Snapshot publication drains hot pulses away from callback
    threads and performs all aggregation and serialization there.
    """

    DEFAULT_HOT_CAPACITY = 16_384
    DEFAULT_RECORD_CAPACITY = 1_024

    def __init__(
        self,
        *,
        component: str = "unassigned",
        instance_id: str = "",
        hot_capacity: int = DEFAULT_HOT_CAPACITY,
        record_capacity: int = DEFAULT_RECORD_CAPACITY,
    ) -> None:
        self._lock = threading.RLock()
        self._component = str(component or "unassigned")
        self._instance_id = str(instance_id or "")
        self._started_epoch_ns = time.time_ns()
        self._revision = 0
        self._records: dict[str, dict[str, Any]] = {}
        self._context: dict[str, Any] = {}
        self._component_state: dict[str, Any] = {}
        self._hot_capacity = max(128, int(hot_capacity))
        self._record_capacity = max(32, int(record_capacity))
        # Losing an old diagnostic pulse under extreme pressure is acceptable; market data itself continues through
        # its own lossless path, and every pulse pushed out is counted in overflow_count. _hot_lock makes "full?
        # count, append" one step for concurrent callbacks (it guards an append, never I/O).
        self._hot_lock = threading.Lock()
        self._hot_pulses: deque[tuple[Any, ...]] = deque(maxlen=self._hot_capacity)
        self._hot_high_watermark = 0
        self._hot_overflow_count = 0

    @property
    def component(self) -> str:
        return self._component

    def assign_process(self, component: str, *, instance_id: str = "") -> None:
        with self._lock:
            self._component = str(component or "unassigned")
            self._instance_id = str(instance_id or "")
            self._revision += 1

    def set_context(self, **values: Any) -> None:
        allowed = {
            "generation",
            "trading_date",
            "session",
            "market",
            "expected_activity",
            "expected_lanes",
            "market_sessions",
        }
        with self._lock:
            for key, value in values.items():
                if key in allowed:
                    self._context[key] = value
            self._revision += 1

    def set_component_state(self, **values: Any) -> None:
        with self._lock:
            self._component_state.update(values)
            self._revision += 1

    @staticmethod
    def _stage_value(stage: DataFlowStage | str) -> str:
        return stage.value if isinstance(stage, DataFlowStage) else str(stage or "").strip().lower()

    @staticmethod
    def _record_key(stage: str, lane: str) -> str:
        return f"{stage}|{lane or 'default'}"

    def pulse_hot(
        self,
        stage: DataFlowStage | str,
        *,
        lane: str,
        identity: DataFlowIdentity | None = None,
        accepted: bool = True,
        error: str = "",
        observed_epoch_ns: int | None = None,
    ) -> None:
        """Append one bounded diagnostic pulse from a provider callback."""

        self._push_hot((
            self._stage_value(stage),
            str(lane or "default"),
            identity or DataFlowIdentity(),
            bool(accepted),
            str(error or ""),
            int(observed_epoch_ns or time.time_ns()),
            "",
            0,
            "",
        ))

    def _push_hot(self, pulse: tuple[Any, ...]) -> None:
        with self._hot_lock:
            if len(self._hot_pulses) >= self._hot_capacity:
                self._hot_overflow_count += 1
            self._hot_pulses.append(pulse)

    def pulse_hot_fields(
        self,
        stage: DataFlowStage | str,
        *,
        lane: str,
        symbol: str = "",
        sequence: int = 0,
        source_timestamp: Any = "",
        accepted: bool = True,
        error: str = "",
        observed_epoch_ns: int | None = None,
    ) -> None:
        """Primitive-only callback ingress; identity objects are built on drain."""

        self._push_hot((
            self._stage_value(stage),
            str(lane or "default"),
            None,
            bool(accepted),
            str(error or ""),
            int(observed_epoch_ns or time.time_ns()),
            str(symbol or ""),
            int(sequence or 0),
            str(source_timestamp or ""),
        ))

    def observe(
        self,
        stage: DataFlowStage | str,
        *,
        lane: str,
        identity: DataFlowIdentity | None = None,
        accepted: bool = True,
        error: str = "",
        observed_epoch_ns: int | None = None,
        count: int = 1,
        detail: Mapping[str, Any] | None = None,
    ) -> None:
        with self._lock:
            self._apply(
                self._stage_value(stage),
                str(lane or "default"),
                identity or DataFlowIdentity(),
                bool(accepted),
                str(error or ""),
                int(observed_epoch_ns or time.time_ns()),
                max(1, int(count)),
                detail,
            )

    def _apply(
        self,
        stage: str,
        lane: str,
        identity: DataFlowIdentity,
        accepted: bool,
        error: str,
        observed_epoch_ns: int,
        count: int,
        detail: Mapping[str, Any] | None,
    ) -> None:
        key = self._record_key(stage, lane)
        record = self._records.get(key)
        if record is None:
            record = {
                "stage": stage,
                "lane": lane,
                "observed": 0,
                "accepted": 0,
                "failed": 0,
                "first_observed_epoch_ns": observed_epoch_ns,
                "last_observed_epoch_ns": observed_epoch_ns,
                "last_error": None,
            }
            self._records[key] = record
        record["observed"] = int(record["observed"]) + count
        record["accepted"] = int(record["accepted"]) + (count if accepted else 0)
        record["failed"] = int(record["failed"]) + (0 if accepted else count)
        record["last_observed_epoch_ns"] = max(
            int(record.get("last_observed_epoch_ns") or 0), observed_epoch_ns
        )
        record.update(identity.as_dict())
        if error:
            record["last_error"] = error[:1000]
        if detail:
            record["detail"] = dict(detail)
        if len(self._records) > self._record_capacity:
            oldest_key = min(
                self._records,
                key=lambda item: int(self._records[item].get("last_observed_epoch_ns") or 0),
            )
            self._records.pop(oldest_key, None)
        self._revision += 1

    def _drain_hot(self) -> int:
        with self._hot_lock:
            drained = list(self._hot_pulses)
            self._hot_pulses.clear()
        if not drained:
            return 0
        with self._lock:
            for stage, lane, identity, accepted, error, observed_epoch_ns, symbol, sequence, source_timestamp in drained:
                if identity is None:
                    normalized_symbol = str(symbol or "").strip().upper()
                    identity = DataFlowIdentity(
                        event_id=f"{lane}:{normalized_symbol}:{int(sequence or 0)}",
                        stream_id=f"{lane}:{normalized_symbol}",
                        symbol=normalized_symbol,
                        sequence=int(sequence or 0),
                        source_timestamp=str(source_timestamp or ""),
                    )
                self._apply(
                    stage,
                    lane,
                    identity,
                    accepted,
                    error,
                    observed_epoch_ns,
                    1,
                    None,
                )
        return len(drained)

    def snapshot(self) -> dict[str, Any]:
        with self._hot_lock:
            self._hot_high_watermark = max(self._hot_high_watermark, len(self._hot_pulses))
        drained = self._drain_hot()
        now_ns = time.time_ns()
        with self._lock:
            stages: dict[str, dict[str, Any]] = {}
            for key, source in self._records.items():
                row = dict(source)
                last_ns = int(row.get("last_observed_epoch_ns") or 0)
                row["age_seconds"] = round(max(0, now_ns - last_ns) / 1_000_000_000, 3) if last_ns else None
                stages[key] = row
            return {
                "schema": DATAFLOW_HEALTH_SCHEMA,
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "generated_epoch_ns": now_ns,
                "process": {
                    "component": self._component,
                    "instance_id": self._instance_id,
                    "pid": os.getpid(),
                    "started_epoch_ns": self._started_epoch_ns,
                },
                "revision": self._revision,
                "context": dict(self._context),
                "component_state": dict(self._component_state),
                "hot_path": {
                    "capacity": self._hot_capacity,
                    "drained": drained,
                    "pending": len(self._hot_pulses),
                    "high_watermark": self._hot_high_watermark,
                    "overflow_count": self._hot_overflow_count,
                    "non_blocking": True,
                },
                "record_path": {
                    "capacity": self._record_capacity,
                    "count": len(self._records),
                    "bounded": True,
                },
                "stages": stages,
            }


def runtime_health_dir() -> Path:
    return process_paths.STATE_ROOT / "health"


def dataflow_snapshot_path(component: str, *, directory: Path | None = None) -> Path:
    normalized = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in str(component or "process"))
    return (directory or runtime_health_dir()) / f"{normalized}.json"


def atomic_write_snapshot(path: Path, payload: Mapping[str, Any]) -> None:
    write_json_atomic(path, dict(payload), compact=True)


def read_dataflow_snapshot(path: Path) -> dict[str, Any]:
    """Read a producer-owned snapshot without contacting that process (with delete sharing, so the producer's next
    replace of it goes through)."""

    try:
        payload = json.loads(read_bytes_shared(path).decode("utf-8"))
    except FileNotFoundError:  # not an error: no dataflow health snapshot yet
        return {}
    except (OSError, ValueError, TypeError) as exc:
        record_failure(_failure_log, "reading the dataflow health snapshot", exc)
        return {}
    if not isinstance(payload, dict) or payload.get("schema") != DATAFLOW_HEALTH_SCHEMA:
        return {}
    return payload


class DataFlowSnapshotPublisher:
    """Periodic producer-side publisher; all filesystem work stays off hot paths."""

    def __init__(
        self,
        ledger: DataFlowHealthLedger,
        *,
        component: str | None = None,
        path: Path | None = None,
        interval_seconds: float = 1.0,
        enrich: Callable[[], Mapping[str, Any] | None] | None = None,
    ) -> None:
        self.ledger = ledger
        self.component = str(component or ledger.component)
        self.path = path or dataflow_snapshot_path(self.component)
        self.interval_seconds = max(0.2, float(interval_seconds))
        self.enrich = enrich
        self._stop = threading.Event()
        self._lifecycle_lock = threading.RLock()
        self._thread: threading.Thread | None = None
        self._last_error: str | None = None

    def publish_once(self) -> dict[str, Any]:
        payload = self.ledger.snapshot()
        if self.enrich is not None:
            try:
                extra = self.enrich()
                if isinstance(extra, Mapping):
                    payload["producer"] = dict(extra)
            except Exception as exc:
                record_failure(_failure_log, f"enriching the {self.component} dataflow snapshot", exc)
                payload["producer_error"] = f"{type(exc).__name__}: {exc}"
        atomic_write_snapshot(self.path, payload)
        self._last_error = None
        return payload

    def start(self) -> None:
        with self._lifecycle_lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop.clear()

            def _run() -> None:
                while not self._stop.is_set():
                    try:
                        self.publish_once()
                    except Exception as exc:
                        record_failure(_failure_log, f"publishing the {self.component} dataflow snapshot", exc)
                        self._last_error = f"{type(exc).__name__}: {exc}"
                    if self._stop.wait(self.interval_seconds):
                        break

            self._thread = threading.Thread(
                target=_run,
                daemon=True,
                name=f"DataFlowHealth-{self.component}",
            )
            self._thread.start()

    def stop(self, timeout: float = 2.0) -> None:
        with self._lifecycle_lock:
            self._stop.set()
            thread = self._thread
            if thread is not None and thread.is_alive() and thread is not threading.current_thread():
                thread.join(timeout=max(0.0, float(timeout)))
            if thread is not None and thread.is_alive():
                self._last_error = f"publisher thread did not stop within {max(0.0, float(timeout))}s"
                record_failure(_failure_log, f"stopping the {self.component} dataflow publisher ({self._last_error})")
                return
            self._thread = None
        try:
            self.publish_once()
        except Exception as exc:
            record_failure(_failure_log, f"publishing the final {self.component} dataflow snapshot", exc)
            self._last_error = f"{type(exc).__name__}: {exc}"

    def status(self) -> dict[str, Any]:
        return {
            "component": self.component,
            "path": str(self.path),
            "running": bool(self._thread is not None and self._thread.is_alive()),
            "interval_seconds": self.interval_seconds,
            "last_error": self._last_error,
        }


dataflow_health_ledger = DataFlowHealthLedger()
