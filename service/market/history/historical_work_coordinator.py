from __future__ import annotations

import queue
import threading
import time
from concurrent.futures import Future, TimeoutError as FutureTimeoutError
from dataclasses import dataclass
from typing import Any, Callable
import logging
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)


class HistoricalWorkRejected(RuntimeError):
    """Raised when expensive historical work is rejected during daemon shutdown."""


@dataclass
class _WorkItem:
    key: str
    func: Callable[[], Any]
    future: Future
    submitted_at: float


_STOP = object()


class HistoricalWorkCoordinator:
    """Bounded daemon-thread executor with same-key single-flight.

    This coordinator runs low-priority historical/cache work so a
    request burst cannot consume the entire AnyIO worker pool.  Same-key callers
    share one Future.  Workers are daemon threads deliberately: shutdown first
    freezes/cancels/awaits them for a bounded grace period, but a pathological
    broker-history call cannot keep the whole Market Daemon PID alive forever
    after ownership/port teardown.
    """

    def __init__(self, *, name: str, max_workers: int = 3, queue_size: int = 256) -> None:
        self.name = str(name or "HistoricalWork")
        self.max_workers = max(1, int(max_workers))
        self._queue: queue.Queue[_WorkItem | object] = queue.Queue(maxsize=max(self.max_workers, int(queue_size)))
        self._lock = threading.RLock()
        self._inflight: dict[str, Future] = {}
        self._accepting = True
        self._stopping = False
        self._threads: list[threading.Thread] = []
        self._thread_local = threading.local()
        self._metrics: dict[str, int | float | str | None] = {
            "started": 0,
            "joined": 0,
            "completed": 0,
            "failed": 0,
            "cancelled": 0,
            "rejected": 0,
            "active": 0,
            "queued": 0,
            "waiters": 0,
            "inflight": 0,
            "max_parallel": 0,
            "parallel_peak": 0,
            "latency_ms_total": 0.0,
            "last_error": None,
            "forced_abandon_count": 0,
        }
        for index in range(self.max_workers):
            thread = threading.Thread(
                target=self._worker,
                name=f"{self.name}-{index + 1}",
                daemon=True,
            )
            thread.start()
            self._threads.append(thread)

    @property
    def accepting(self) -> bool:
        with self._lock:
            return bool(self._accepting and not self._stopping)

    def _update_counts_locked(self) -> None:
        self._metrics["queued"] = self._queue.qsize()
        self._metrics["inflight"] = len(self._inflight)
        self._metrics["parallel_peak"] = max(
            int(self._metrics.get("parallel_peak") or 0),
            int(self._metrics.get("active") or 0),
        )
        self._metrics["max_parallel"] = self._metrics["parallel_peak"]

    def submit(self, key: str, func: Callable[[], Any]) -> Future:
        request_key = str(key or "").strip()
        if not request_key:
            raise ValueError("historical work key is required")
        # Nested repository calls from a coordinator worker execute inline. This
        # avoids deadlocking the fixed pool when a job calls another repository
        # read while all workers are occupied by parent jobs.
        if getattr(self._thread_local, "inside_worker", False):
            future: Future = Future()
            if not self.accepting:
                future.set_exception(HistoricalWorkRejected("historical work is stopping"))
                return future
            try:
                future.set_result(func())
            except BaseException as exc:  # Future must preserve original error
                future.set_exception(exc)
            return future

        with self._lock:
            existing = self._inflight.get(request_key)
            # Future.set_result wakes run() before the worker's finally block
            # removes the entry. A same-key read issued immediately afterwards
            # must start fresh instead of briefly reusing stale completed data.
            if existing is not None and existing.done():
                self._inflight.pop(request_key, None)
                existing = None
            if existing is not None:
                self._metrics["joined"] = int(self._metrics.get("joined") or 0) + 1
                self._metrics["waiters"] = int(self._metrics.get("waiters") or 0) + 1
                self._update_counts_locked()

                def _joined_done(_future: Future) -> None:
                    with self._lock:
                        self._metrics["waiters"] = max(0, int(self._metrics.get("waiters") or 0) - 1)

                existing.add_done_callback(_joined_done)
                return existing
            if not self._accepting or self._stopping:
                self._metrics["rejected"] = int(self._metrics.get("rejected") or 0) + 1
                raise HistoricalWorkRejected("historical work is stopping")
            future = Future()
            item = _WorkItem(request_key, func, future, time.perf_counter())
            self._inflight[request_key] = future
            self._metrics["started"] = int(self._metrics.get("started") or 0) + 1
            self._update_counts_locked()
        try:
            self._queue.put_nowait(item)
        except queue.Full as exc:
            with self._lock:
                self._release_locked(request_key, future)
                self._metrics["rejected"] = int(self._metrics.get("rejected") or 0) + 1
                self._update_counts_locked()
            future.set_exception(HistoricalWorkRejected("historical work queue is full"))
            raise HistoricalWorkRejected("historical work queue is full") from exc
        with self._lock:
            self._update_counts_locked()
        return future

    def _release_locked(self, key: str, future: Future) -> None:
        """Drop `key` from the in-flight map only if it still names THIS job: a finished job's worker popping the
        key unconditionally would remove a newer job submitted for it meanwhile, so a third caller would start a
        duplicate instead of joining it."""
        if self._inflight.get(key) is future:
            del self._inflight[key]

    def run(self, key: str, func: Callable[[], Any], *, timeout: float | None = None) -> Any:
        future = self.submit(key, func)
        try:
            return future.result(timeout=timeout)
        except FutureTimeoutError as exc:
            raise TimeoutError(f"historical work timed out: {key}") from exc

    def _worker(self) -> None:
        self._thread_local.inside_worker = True
        while True:
            item = self._queue.get()
            if item is _STOP:
                self._queue.task_done()
                return
            assert isinstance(item, _WorkItem)
            future = item.future
            if future.cancelled():
                with self._lock:
                    self._release_locked(item.key, item.future)
                    self._metrics["cancelled"] = int(self._metrics.get("cancelled") or 0) + 1
                    self._update_counts_locked()
                self._queue.task_done()
                continue
            started = time.perf_counter()
            with self._lock:
                self._metrics["active"] = int(self._metrics.get("active") or 0) + 1
                self._update_counts_locked()
            try:
                result = item.func()
                if not future.cancelled():
                    future.set_result(result)
                with self._lock:
                    self._metrics["completed"] = int(self._metrics.get("completed") or 0) + 1
            except BaseException as exc:
                if future.cancelled():
                    # Its caller is gone: nobody receives the failure, so it is recorded here.
                    record_failure(_failure_log, "historical work whose caller had cancelled it", exc)
                else:
                    future.set_exception(exc)
                with self._lock:
                    self._metrics["failed"] = int(self._metrics.get("failed") or 0) + 1
                    self._metrics["last_error"] = str(exc)
            finally:
                elapsed_ms = (time.perf_counter() - started) * 1000.0
                with self._lock:
                    self._metrics["latency_ms_total"] = float(self._metrics.get("latency_ms_total") or 0.0) + elapsed_ms
                    self._metrics["active"] = max(0, int(self._metrics.get("active") or 0) - 1)
                    self._release_locked(item.key, item.future)
                    self._update_counts_locked()
                self._queue.task_done()

    def freeze_new_work(self, *, cancel_queued: bool = True) -> dict[str, Any]:
        with self._lock:
            self._accepting = False
            self._stopping = True
        cancelled = 0
        if cancel_queued:
            retained: list[object] = []
            while True:
                try:
                    item = self._queue.get_nowait()
                except queue.Empty:  # not an error: the queue is drained
                    break
                try:
                    if item is _STOP:
                        retained.append(item)
                        continue
                    assert isinstance(item, _WorkItem)
                    if item.future.cancel():
                        cancelled += 1
                    with self._lock:
                        self._release_locked(item.key, item.future)
                finally:
                    self._queue.task_done()
            for item in retained:
                try:
                    self._queue.put_nowait(item)
                except queue.Full as exc:
                    record_failure(_failure_log, "re-queueing retained historical work (queue full)", exc)
                    break
        with self._lock:
            self._metrics["cancelled"] = int(self._metrics.get("cancelled") or 0) + cancelled
            self._update_counts_locked()
            return self.metrics()

    def wait_for_idle(self, timeout: float) -> bool:
        deadline = time.monotonic() + max(0.0, float(timeout))
        while time.monotonic() < deadline:
            with self._lock:
                if int(self._metrics.get("active") or 0) == 0 and self._queue.empty():
                    return True
            time.sleep(0.025)
        with self._lock:
            return int(self._metrics.get("active") or 0) == 0 and self._queue.empty()

    def shutdown(self, *, timeout: float = 8.0) -> dict[str, Any]:
        self.freeze_new_work(cancel_queued=True)
        idle = self.wait_for_idle(timeout=max(0.0, float(timeout)))
        if not idle:
            with self._lock:
                self._metrics["forced_abandon_count"] = int(self._metrics.get("forced_abandon_count") or 0) + int(self._metrics.get("active") or 0)
        for _thread in self._threads:
            try:
                self._queue.put_nowait(_STOP)
            except queue.Full:  # not an error: a full queue already wakes every worker, which then see the stop flag
                break
        deadline = time.monotonic() + max(0.0, float(timeout))
        for thread in self._threads:
            remaining = max(0.0, deadline - time.monotonic())
            thread.join(timeout=remaining)
        with self._lock:
            result = self.metrics()
            result["idle_before_shutdown"] = idle
            result["worker_threads_alive"] = sum(1 for thread in self._threads if thread.is_alive())
            return result

    def metrics(self) -> dict[str, Any]:
        with self._lock:
            result = dict(self._metrics)
            started = int(result.get("completed") or 0) + int(result.get("failed") or 0)
            result["average_latency_ms"] = (float(result.get("latency_ms_total") or 0.0) / started) if started else 0.0
            result["accepting"] = bool(self._accepting and not self._stopping)
            result["worker_count"] = len(self._threads)
            result["worker_threads_alive"] = sum(1 for thread in self._threads if thread.is_alive())
            result["queued"] = self._queue.qsize()
            result["inflight"] = len(self._inflight)
            return result
