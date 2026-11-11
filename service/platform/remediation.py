"""Python side of remediation event emission (the remediation event contract in docs/BACKLOG.md).

Every retry, reconnect, resend, rebuild, fallback or rollback a Python service performs is recorded as a
``stock-monitor-remediation-event-v1`` event in Health's ledger (health/remediation/ledger.js). The registry of
mechanisms is ``config/remediation_registry.json``; the frame and event shape are the ones
``config/js/remediation_contract.js`` defines (a 4-byte little-endian length, then one UTF-8 JSON event; the writer
answers with the cumulative number of frames it has taken, as an 8-byte little-endian integer).

``emitter()`` is this process's emitter. ``emit()`` records a one-shot remediation; ``begin()`` announces one that
runs over time and returns an operation whose ``finish()`` records its single terminal outcome.

Emission never raises into the caller and never blocks it: events go through a bounded queue to one background
thread. What cannot be delivered is counted, and once delivery works again a ``sink.client_loss`` event records how
many were lost, since when and why. Frames written but not acknowledged are sent again after a reconnect; the writer
drops duplicates by event_id.
"""
from __future__ import annotations

import json
import math
import os
import socket
import struct
import sys
import threading
import time
import uuid
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping
import logging
from config.secret_scrub import scrub_text, scrub_value, secret_name
from service.platform.failure_record import record_failure
from service.platform.project_root import project_root

_failure_log = logging.getLogger(__name__)

PIPE_ENV = "STOCK_MONITOR_REMEDIATION_PIPE"
SERVICE_ENV = "STOCK_MONITOR_SERVICE_ID"
# Identity beyond the registry's identity_fields that an emitter may pass (written as detail.identity_extra).
IDENTITY_EXTRA_FIELDS = frozenset({"client_id", "lease_id", "daemon_instance_id", "host", "port", "lane",
                                   "context_generation", "session_generation"})
_RECONNECT_MIN = 0.5
_RECONNECT_MAX = 10.0

_registry: dict[str, Any] | None = None


def registry() -> dict[str, Any]:
    global _registry
    if _registry is None:
        _registry = json.loads((project_root() / "config" / "remediation_registry.json").read_text(encoding="utf-8"))
    return _registry


def local_iso(moment: datetime | None = None) -> str:
    """ISO-8601 with milliseconds and the local offset, e.g. 2026-10-07T15:04:05.123+08:00."""
    value = (moment or datetime.now()).astimezone()
    return value.isoformat(timespec="milliseconds")


def _bounded(value: Any, limit: int) -> str:
    text = str(value)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _scalar_or_text(value: Any, limit: int) -> Any:
    """A detail scalar as written: null/bool/int/finite float kept, a string scrubbed, a nested structure scrubbed at
    every depth and written as JSON, anything else as its scrubbed text -- all bounded to ``limit`` characters."""
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, (Mapping, list, tuple)):
        return _bounded(json.dumps(scrub_value(value, 1), ensure_ascii=False, separators=(",", ":"), default=str), limit)
    return _bounded(scrub_text(str(value)), limit)


def sanitize_detail(detail: Mapping[str, Any] | None) -> dict[str, Any]:
    """Detail as the ledger takes it (scalars and short scalar lists, bounded) with no secret anywhere in it: secret keys
    are dropped at every depth and every string is scrubbed by value (config/secret_scrub.json)."""
    limits = registry()["limits"]
    out: dict[str, Any] = {}
    totals: dict[str, int] = {}
    for key, value in list((detail or {}).items())[: limits["detail_keys"]]:
        key = str(key)
        if secret_name(key):
            continue
        if isinstance(value, (list, tuple)):
            out[key] = [_scalar_or_text(item, 128) for item in list(value)[:16]]
            if len(value) > 16:
                totals[f"{key}_total"] = len(value)
        else:
            out[key] = _scalar_or_text(value, limits["string_chars"])
    # Never a silent cut: how many items a list had when it had more than were kept -- within the key limit Health
    # enforces (an event over it is refused whole).
    for key, total in totals.items():
        if len(out) >= limits["detail_keys"]:
            break
        out.setdefault(key, total)
    return out


def create_event(*, process: Mapping[str, Any], component: str, mechanism_id: str, trigger_reason: str,
                 identity: Mapping[str, Any] | None = None, attempt: int | None = None, outcome: str,
                 operation_id: str | None = None, related_upstream_event_id: str | None = None,
                 detail: Mapping[str, Any] | None = None) -> dict[str, Any]:
    reg = registry()
    full_identity = {field: None for field in reg["identity_fields"]}
    for field in reg["identity_fields"]:
        value = (identity or {}).get(field)
        if value is not None and value != "":
            full_identity[field] = _bounded(value, 256)
    # Identity a mechanism has beyond the shared fields (client/lease/instance, lane, generation) is kept in the
    # detail: it is what tells one lost lease or connection from another. Only the listed names, only as scalars;
    # anything else is refused (left out, and the refusal recorded), never written as it came.
    extra: dict[str, Any] = {}
    for key, value in (identity or {}).items():
        if key in full_identity or value is None or value == "":
            continue
        if key not in IDENTITY_EXTRA_FIELDS or not isinstance(value, (str, int)) or isinstance(value, bool):
            record_failure(_failure_log, f"refusing identity field {str(key)[:40]!r} of {mechanism_id}",
                           ValueError(f"{type(value).__name__} is not a listed scalar identity field"))
            continue
        extra[key] = scrub_text(value) if isinstance(value, str) else value
    if extra:
        detail = {**(detail or {}), "identity_extra": json.dumps(extra, ensure_ascii=False, separators=(",", ":"))}
    return {
        "schema": reg["event_schema"],
        "event_id": str(uuid.uuid4()),
        "at": local_iso(),
        "process": {"service_id": process["service_id"], "instance_id": process["instance_id"],
                    "pid": process.get("pid"), "runtime": "python"},
        "component": component,
        "mechanism_id": mechanism_id,
        "trigger_reason": trigger_reason,
        "identity": full_identity,
        "attempt": None if attempt is None else int(attempt),
        "outcome": outcome,
        "related_upstream_event_id": related_upstream_event_id,
        "operation_id": operation_id,
        "detail": sanitize_detail(detail),
    }


def encode_frame(event: Mapping[str, Any]) -> bytes:
    body = json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    limit = registry()["limits"]["frame_bytes"]
    if len(body) > limit:
        raise ValueError(f"remediation frame of {len(body)} bytes exceeds {limit}")
    return struct.pack("<I", len(body)) + body


class RemediationOperation:
    """One remediation that runs over time: started on creation, exactly one terminal outcome via finish()."""

    def __init__(self, emitter: "RemediationEmitter", *, component: str, mechanism_id: str, trigger_reason: str,
                 identity: Mapping[str, Any] | None, detail: Mapping[str, Any] | None) -> None:
        self._emitter = emitter
        self._component = component
        self._mechanism_id = mechanism_id
        self._trigger_reason = trigger_reason
        self._identity = dict(identity or {})
        self.operation_id = str(uuid.uuid4())
        self.started_event, self._started_queued = emitter._emit_tracked(
            component=component, mechanism_id=mechanism_id, trigger_reason=trigger_reason, identity=self._identity,
            attempt=0, outcome="started", operation_id=self.operation_id, detail=detail)
        self._finished: dict[str, Any] | None = None
        self._finished_queued = False
        self._lock = threading.Lock()

    def durable(self, timeout: float = 5.0) -> bool:
        """True once Health's ledger has fsync'd what this operation emitted so far (its start, and its terminal outcome
        once finished). An action that must not happen unrecorded (moving a database aside) waits for this."""
        events = [(self.started_event, self._started_queued)]
        if self._finished is not None:
            events.append((self._finished, self._finished_queued))
        deadline = time.monotonic() + timeout
        return all(queued and self._emitter.wait_delivered(event["event_id"], max(0.0, deadline - time.monotonic()))
                   for event, queued in events)

    @property
    def finished(self) -> bool:
        return self._finished is not None

    def finish(self, outcome: str, *, attempt: int | None = None, detail: Mapping[str, Any] | None = None,
               identity: Mapping[str, Any] | None = None) -> dict[str, Any]:
        with self._lock:
            if self._finished is not None:
                return self._finished
            self._finished, self._finished_queued = self._emitter._emit_tracked(
                component=self._component, mechanism_id=self._mechanism_id, trigger_reason=self._trigger_reason,
                identity=identity if identity is not None else self._identity, attempt=attempt, outcome=outcome,
                operation_id=self.operation_id, related_upstream_event_id=self.started_event["event_id"], detail=detail)
            return self._finished


class Recovery:
    """A remediation that opens at a failure and stays open across retries: the first failure starts it, every later
    failure before it ends is one more attempt, and it ends once (succeeded / failed / abandoned). The loops that
    reconnect or reattach hold one of these each instead of counting in prose."""

    def __init__(self, *, component: str, mechanism_id: str) -> None:
        self.component = component
        self.mechanism_id = mechanism_id
        self._operation: RemediationOperation | None = None
        self._attempts = 0
        self._lock = threading.Lock()

    @property
    def open(self) -> bool:
        return self._operation is not None

    def failed(self, trigger_reason: str, *, identity: Mapping[str, Any] | None = None,
               detail: Mapping[str, Any] | None = None) -> None:
        with self._lock:
            if self._operation is not None:
                self._attempts += 1
                return
            self._attempts = 1
            self._operation = emitter().begin(component=self.component, mechanism_id=self.mechanism_id,
                                              trigger_reason=trigger_reason, identity=identity, detail=detail)

    def finish(self, outcome: str, *, detail: Mapping[str, Any] | None = None,
               identity: Mapping[str, Any] | None = None) -> bool:
        """Ends the open recovery; False when none was open (nothing had failed)."""
        with self._lock:
            operation, self._operation = self._operation, None
            attempts = self._attempts
        if operation is None:
            return False
        operation.finish(outcome, attempt=attempts, detail=detail, identity=identity)
        return True


class RemediationEmitter:
    """The per-process emitter: bounded queue -> one daemon thread -> Health's ledger pipe."""

    def __init__(self, *, service_id: str, pipe_path: str | None, instance_id: str | None = None) -> None:
        self.process = {"service_id": service_id, "pid": os.getpid(),
                        "instance_id": instance_id or f"{service_id}-{os.getpid()}-{time.time_ns()}"}
        self._pipe_path = pipe_path or ""
        self._limit = int(registry()["limits"]["client_queue_events"])
        # A writer that took the connection but stopped acknowledging is treated as gone: reconnect, send again.
        self._ack_timeout = int(registry()["limits"]["client_ack_timeout_ms"]) / 1000.0
        self._queue: deque[tuple[str, bytes]] = deque()
        self._queued_ids: set[str] = set()      # event ids in the queue: not yet acknowledged (fsync'd) by the ledger
        self._cond = threading.Condition()
        self._loss: dict[str, Any] | None = None
        self._stats = {"emitted": 0, "delivered": 0, "dropped_total": 0, "reconnects": 0, "ack_timeouts": 0}
        self._last_ack_at: str | None = None
        self._connected = False
        self._last_error: str | None = None
        self._closed = False
        self._warned = False
        self._thread: threading.Thread | None = None

    # ------------------------------------------------------------------ public
    def emit(self, *, component: str, mechanism_id: str, trigger_reason: str, identity: Mapping[str, Any] | None = None,
             attempt: int | None = None, outcome: str, operation_id: str | None = None,
             related_upstream_event_id: str | None = None, detail: Mapping[str, Any] | None = None) -> dict[str, Any]:
        return self._emit_tracked(component=component, mechanism_id=mechanism_id, trigger_reason=trigger_reason,
                                  identity=identity, attempt=attempt, outcome=outcome, operation_id=operation_id,
                                  related_upstream_event_id=related_upstream_event_id, detail=detail)[0]

    def _emit_tracked(self, **fields: Any) -> tuple[dict[str, Any], bool]:
        """The event, and whether it was queued for the ledger (False: counted as lost, never to be acknowledged)."""
        event = create_event(process=self.process, **fields)
        try:
            return event, self._enqueue(event)
        except Exception as exc:
            record_failure(_failure_log, "queueing a remediation event", exc)
            return event, False

    def wait_delivered(self, event_id: str, timeout: float) -> bool:
        """True once a queued event has been acknowledged by the ledger (written and fsync'd)."""
        deadline = time.monotonic() + timeout
        with self._cond:
            while event_id in self._queued_ids:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._cond.wait(remaining)
            return True

    def begin(self, *, component: str, mechanism_id: str, trigger_reason: str,
              identity: Mapping[str, Any] | None = None, detail: Mapping[str, Any] | None = None) -> RemediationOperation:
        return RemediationOperation(self, component=component, mechanism_id=mechanism_id, trigger_reason=trigger_reason,
                                    identity=identity, detail=detail)

    def status(self) -> dict[str, Any]:
        with self._cond:
            return {"configured": bool(self._pipe_path), "connected": self._connected, "queued": len(self._queue),
                    **self._stats, "unreported_loss": (self._loss or {}).get("count", 0), "last_error": self._last_error,
                    "last_ack_at": self._last_ack_at}

    def flush(self, timeout: float = 2.0) -> bool:
        """True when everything emitted so far was acknowledged by the writer."""
        deadline = time.monotonic() + timeout
        with self._cond:
            while self._queue:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not self._pipe_path:
                    return False
                self._cond.wait(remaining)
            return True

    def close(self) -> None:
        with self._cond:
            self._closed = True
            self._cond.notify_all()

    # ------------------------------------------------------------------ internals
    def _record_loss(self, reason: str, error: str | None = None) -> None:
        self._stats["dropped_total"] += 1
        if self._loss is None:
            self._loss = {"count": 0, "since": local_iso(), "reason": reason, "last_error": None}
        self._loss["count"] += 1
        self._loss["reason"] = reason
        if error:
            self._loss["last_error"] = error[:300]

    def _enqueue(self, event: dict[str, Any]) -> bool:
        with self._cond:
            self._stats["emitted"] += 1
            if not self._pipe_path:
                self._record_loss("sink_unconfigured")
                if not self._warned:
                    self._warned = True
                    print(f"[REMEDIATION] {PIPE_ENV} is not set; remediation events of {self.process['service_id']} "
                          "are counted, not recorded", file=sys.stderr, flush=True)
                return False
            try:
                frame = encode_frame(event)
            except ValueError as exc:
                self._record_loss("frame_too_large", str(exc))
                return False
            if len(self._queue) >= self._limit:
                self._record_loss("queue_full" if self._connected else "sink_unreachable", self._last_error)
                return False
            self._queue.append((event["event_id"], frame))
            self._queued_ids.add(event["event_id"])
            if self._thread is None:
                self._thread = threading.Thread(target=self._run, name="remediation-emitter", daemon=True)
                self._thread.start()
            self._cond.notify_all()
            return True

    def _loss_marker(self) -> tuple[str, bytes] | None:
        loss, self._loss = self._loss, None
        if not loss:
            return None
        marker = create_event(process=self.process, component="remediation_client", mechanism_id="sink.client_loss",
                              trigger_reason=loss["reason"], outcome="failed",
                              detail={"lost_events": loss["count"], "lost_since": loss["since"], "last_error": loss["last_error"]})
        return marker["event_id"], encode_frame(marker)

    def _run(self) -> None:
        delay = _RECONNECT_MIN
        while True:
            with self._cond:
                while not self._queue and not self._closed:
                    self._cond.wait(1.0)
                if self._closed and not self._queue:
                    return
            try:
                channel = _open_channel(self._pipe_path)
            except OSError as exc:
                # The events stay queued and are sent once the pipe opens; the failure itself goes to the log.
                record_failure(_failure_log, "opening the remediation pipe to Health", exc)
                with self._cond:
                    self._last_error = f"{type(exc).__name__}: {exc}"[:300]
                time.sleep(delay)
                delay = min(_RECONNECT_MAX, delay * 2)
                continue
            delay = _RECONNECT_MIN
            sent_on_connection = 0
            try:
                with self._cond:
                    self._connected = True
                    marker = self._loss_marker()
                    if marker:
                        self._queue.appendleft(marker)
                while True:
                    with self._cond:
                        while not self._queue and not self._closed:
                            self._cond.wait(1.0)
                        if not self._queue:
                            return
                        _event_id, frame = self._queue[0]
                    channel.write(frame)
                    sent_on_connection += 1
                    deadline = time.monotonic() + self._ack_timeout
                    while channel.read_ack(deadline) < sent_on_connection:
                        pass
                    with self._cond:
                        self._last_ack_at = local_iso()
                        # Acknowledged: only now does it leave the queue (a lost connection sends it again).
                        if self._queue and self._queue[0][1] is frame:
                            self._queue.popleft()
                            self._queued_ids.discard(_event_id)
                        self._stats["delivered"] += 1
                        self._cond.notify_all()
            except (OSError, EOFError) as exc:
                record_failure(_failure_log, "sending remediation events to Health (unacknowledged ones are sent again)", exc)
                with self._cond:
                    self._connected = False
                    self._stats["reconnects"] += 1
                    if isinstance(exc, AckTimeout):
                        self._stats["ack_timeouts"] += 1
                    self._last_error = f"{type(exc).__name__}: {exc}"[:300]
            finally:
                channel.close()
                with self._cond:
                    self._connected = False


class AckTimeout(TimeoutError):
    """The writer took a frame and did not acknowledge it by the deadline."""


class _Channel:
    """A connected pipe: a Windows named pipe opened as a file, or a Unix socket elsewhere. Reads wait until a
    deadline: on Windows by polling PeekNamedPipe (a synchronous pipe read cannot time out), elsewhere by a socket
    timeout."""

    def __init__(self, path: str) -> None:
        self._file = None
        self._sock = None
        if os.name == "nt":
            self._file = open(path, "r+b", buffering=0)  # noqa: SIM115 -- closed by close()
        else:
            self._sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self._sock.connect(path)

    def write(self, data: bytes) -> None:
        if self._file is not None:
            self._file.write(data)
        else:
            self._sock.sendall(data)

    def _wait_readable(self, deadline: float) -> None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AckTimeout("remediation ledger did not acknowledge in time")
        if self._sock is not None:
            self._sock.settimeout(remaining)
            return
        import ctypes
        import msvcrt
        from ctypes import wintypes
        handle = msvcrt.get_osfhandle(self._file.fileno())
        available = wintypes.DWORD(0)
        pause = 0.001
        while True:
            if not ctypes.windll.kernel32.PeekNamedPipe(wintypes.HANDLE(handle), None, 0, None, ctypes.byref(available), None):
                raise ctypes.WinError()
            if available.value:
                return
            if time.monotonic() >= deadline:
                raise AckTimeout("remediation ledger did not acknowledge in time")
            time.sleep(pause)
            pause = min(0.02, pause * 2)

    def _read_exact(self, size: int, deadline: float) -> bytes:
        out = b""
        while len(out) < size:
            self._wait_readable(deadline)
            try:
                chunk = self._file.read(size - len(out)) if self._file is not None else self._sock.recv(size - len(out))
            except socket.timeout:
                raise AckTimeout("remediation ledger did not acknowledge in time") from None
            if not chunk:
                raise EOFError("remediation ledger closed the pipe")
            out += chunk
        return out

    def read_ack(self, deadline: float) -> int:
        return struct.unpack("<Q", self._read_exact(8, deadline))[0]

    def close(self) -> None:
        for handle in (self._file, self._sock):
            try:
                if handle is not None:
                    handle.close()
            except OSError as exc:
                record_failure(_failure_log, "closing the remediation pipe", exc)


def _open_channel(path: str) -> _Channel:
    return _Channel(path)


_emitter: RemediationEmitter | None = None
_emitter_lock = threading.Lock()


def emitter() -> RemediationEmitter:
    """This process's emitter (service id from STOCK_MONITOR_SERVICE_ID, set by Health for every service it spawns)."""
    global _emitter
    with _emitter_lock:
        if _emitter is None:
            service_id = str(os.environ.get(SERVICE_ENV) or "").strip() or f"python:{Path(sys.argv[0] or 'python').stem}"
            _emitter = RemediationEmitter(service_id=service_id, pipe_path=os.environ.get(PIPE_ENV))
        return _emitter
