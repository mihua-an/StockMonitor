"""Provider-neutral daemon lifetime lock and its durable owner record.

The OS lock is what keeps a second broker owner out. Beside it the owner keeps one record (``*_owner.json``) that
says, without anyone having to guess from ports and probes: which process owns the daemon (pid + its OS creation
time, so a reused pid is not it), which generation of ownership this is, and where it is in its life --
STARTING -> READY -> STOPPING (``publish_lifecycle``). Health's startup and stop read that record.

When the owner ends it writes a stop receipt (``*_owner_stop_receipt.json``) bound to its instance and generation:
whether its own stop was clean, and why not. Health takes a stop as clean only on that receipt of that instance.
"""
from __future__ import annotations

import json
import os
import sys
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, BinaryIO, Callable
from service.platform.atomic_files import read_bytes_shared, write_json_atomic
import logging
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)


OWNER_SCHEMA = "stock-monitor-daemon-owner-v2"
RECEIPT_SCHEMA = "stock-monitor-daemon-stop-receipt-v1"
LIFECYCLES = ("STARTING", "READY", "STOPPING")
_current: "DaemonSingletonLock | None" = None


def publish_lifecycle(state: str) -> None:
    """The running daemon's lifecycle, into its owner record (no-op in a process that holds no daemon lock)."""
    owner = _current
    if owner is not None:
        owner.set_lifecycle(state)


def receipt_path_for(metadata_path: Path) -> Path:
    return metadata_path.with_name(f"{metadata_path.stem}_stop_receipt.json")


def _created_ns() -> int | None:
    try:
        from service.platform.process_observer import process_created_epoch_ns

        return process_created_epoch_ns(os.getpid())
    except Exception as exc:
        record_failure(_failure_log, "reading this process's creation time", exc)
        return None


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    write_json_atomic(path, payload, indent=2)


def read_owner_metadata(path: Path) -> dict[str, Any]:
    """The record as it is now. Read with delete sharing: a plain open() held the file against the owner's own
    rewrite of it, and the daemon died on that PermissionError at startup (the API polls this record then)."""
    try:
        payload = json.loads(read_bytes_shared(path).decode("utf-8"))
        return payload if isinstance(payload, dict) else {}
    except FileNotFoundError:   # not an error: no owner has written a record (or the last one removed it)
        return {}
    except Exception as exc:
        record_failure(_failure_log, "reading the daemon owner metadata", exc)
        return {}


# The owner's recorded creation time and the OS's may differ by rounding (Health uses the same tolerance).
_CREATED_TOLERANCE_NS = 1_000_000_000


def record_int(value: Any) -> int | None:
    """A non-negative integer field of a JSON record another process wrote (owner record, health snapshot); None
    when the field holds anything else (a string, a float, a bool, a negative number). The caller decides what an
    unreadable field means -- never an exception out of a monitoring loop."""
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def owner_ready(metadata_path: Path) -> bool:
    """Whether the record names a READY daemon whose own process still runs: a READY left behind by a daemon that
    died (or a reused pid) is not one."""
    from service.platform.process_observer import process_created_epoch_ns, process_exists

    record = read_owner_metadata(metadata_path)
    if record.get("lifecycle") != "READY":
        return False
    pid, recorded = record_int(record.get("owner_pid")), record_int(record.get("owner_created_ns") or 0)
    if not pid or recorded is None:
        # OWNER_UNVERIFIABLE: a READY record whose identity fields are unreadable names no process.
        record_failure(_failure_log, f"verifying the daemon owner in {metadata_path.name}", ValueError(
            f"owner_pid={record.get('owner_pid')!r} owner_created_ns={record.get('owner_created_ns')!r}"))
        return False
    if os.name != "nt":
        return process_exists(pid)
    created = process_created_epoch_ns(pid)
    return recorded > 0 and created is not None and abs(created - recorded) <= _CREATED_TOLERANCE_NS


def wait_until_owner_ready(metadata_path: Path, shutdown: threading.Event, *, label: str,
                           logger: logging.Logger, poll_s: float = 0.25) -> bool:
    """Until the daemon is READY (True) or the process is shutting down (False). Waiting for a daemon Health is still
    starting is the startup order, not a failure: a client that tried to attach before it was READY counted each
    try as a failed attach, and Futu took a daemon not yet connected to OpenD for "OpenD not running" and gave up."""
    import time

    started = time.monotonic()
    waited = False
    while not shutdown.is_set():
        if owner_ready(metadata_path):
            if waited:
                logger.info("[APP] %s daemon READY after %.1f s; attaching", label, time.monotonic() - started)
            return True
        if not waited:
            waited = True
            logger.info("[APP] waiting for the %s daemon to be READY before attaching (%s)", label, metadata_path)
        shutdown.wait(poll_s)
    return False


class DaemonSingletonLock:
    """Cross-platform OS lock; JSON metadata is diagnostic evidence only."""

    def __init__(
        self,
        *,
        path: Path,
        metadata_path: Path,
        metadata: dict[str, Any] | None,
        classify_owner: Callable[[dict[str, Any]], str],
        error_type: type[RuntimeError],
        daemon_label: str,
        heartbeat_thread_name: str,
        metadata_keys: tuple[str, ...] = (),
    ) -> None:
        self.path = path
        self.metadata_path = metadata_path
        self._metadata = dict(metadata or {})
        self._classify_owner = classify_owner
        self._error_type = error_type
        self._daemon_label = daemon_label
        self._heartbeat_thread_name = heartbeat_thread_name
        self._metadata_keys = metadata_keys
        self._file: BinaryIO | None = None
        self._write_lock = threading.Lock()
        self._heartbeat_stop = threading.Event()
        self._heartbeat_thread: threading.Thread | None = None

    @staticmethod
    def _try_lock(fh: BinaryIO) -> None:
        fh.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

    @staticmethod
    def _unlock(fh: BinaryIO) -> None:
        fh.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)

    def _write_metadata(self) -> None:
        payload = {
            "schema": OWNER_SCHEMA,
            "owner_pid": os.getpid(),
            "owner_created_ns": self._metadata.get("owner_created_ns"),
            "generation": self._metadata.get("generation"),
            "lifecycle": self._metadata.get("lifecycle") or "STARTING",
            "lifecycle_at": self._metadata.get("lifecycle_at"),
            "owner_started_at": self._metadata.get("owner_started_at") or datetime.now().astimezone().isoformat(timespec="seconds"),
            "daemon_instance_id": self._metadata.get("daemon_instance_id"),
            "runtime_version": self._metadata.get("runtime_version"),
            "protocol_version": self._metadata.get("protocol_version"),
            "port": self._metadata.get("port"),
            "last_heartbeat_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "executable": sys.executable,
            "command_line": " ".join(str(part) for part in sys.argv),
        }
        for key in self._metadata_keys:
            payload[key] = self._metadata.get(key)
        with self._write_lock:
            if self._file is None and self._metadata.get("lifecycle") == "STOPPED":
                return   # released: a late heartbeat never brings the record back
            self._metadata = payload
            _atomic_json(self.metadata_path, payload)

    def set_lifecycle(self, state: str) -> None:
        if state not in LIFECYCLES:
            raise ValueError(f"unknown daemon lifecycle {state!r}")
        self._metadata["lifecycle"] = state
        self._metadata["lifecycle_at"] = datetime.now().astimezone().isoformat(timespec="milliseconds")
        if self._file is not None:
            self._write_metadata()

    def _next_generation(self) -> int:
        counter = self.path.with_suffix(".generation")
        try:
            previous = int(counter.read_text(encoding="utf-8").strip() or 0)
        except FileNotFoundError:   # not an error: the first owner of this lock starts at generation 1
            previous = 0
        except (OSError, ValueError) as exc:
            record_failure(_failure_log, "reading the daemon generation counter (restarting it at 1)", exc)
            previous = 0
        generation = previous + 1
        counter.write_text(str(generation), encoding="utf-8")
        return generation

    def _open_and_lock(self) -> BinaryIO:
        fh = self.path.open("a+b", buffering=0)
        if os.fstat(fh.fileno()).st_size < 1:
            fh.seek(0, os.SEEK_END)
            fh.write(b"0")
        try:
            self._try_lock(fh)
        except BaseException:
            fh.close()
            raise
        return fh

    def acquire(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            fh = self._open_and_lock()
        except (OSError, IOError) as exc:
            owner = read_owner_metadata(self.metadata_path)
            classification = self._classify_owner(owner)
            if classification != "STALE_SINGLETON_NO_PROCESS":
                raise self._error_type(
                    f"{self._daemon_label} singleton already held",
                    classification=classification,
                    owner=owner,
                ) from exc
            record_failure(_failure_log, f"taking the {self._daemon_label} singleton lock: its owner process is gone, "
                                         "the stale lock is cleared and taken again", exc)
            try:
                self.metadata_path.unlink(missing_ok=True)
            except Exception as exc:
                record_failure(_failure_log, "removing the stale daemon owner metadata", exc)
            try:
                fh = self._open_and_lock()
            except (OSError, IOError) as retry_exc:
                raise self._error_type(
                    f"{self._daemon_label} singleton remains held after stale-owner cleanup",
                    classification="LOCK_HELD_UNKNOWN",
                    owner=owner,
                ) from retry_exc
        global _current
        self._file = fh
        # Under the lock: the generation counter and the record are this owner's alone.
        self._metadata.update(generation=self._next_generation(), owner_created_ns=_created_ns(), lifecycle="STARTING",
                              lifecycle_at=datetime.now().astimezone().isoformat(timespec="milliseconds"))
        self._write_metadata()
        _current = self

    def start_heartbeat(self, interval_seconds: float = 5.0) -> None:
        if self._heartbeat_thread and self._heartbeat_thread.is_alive():
            return
        self._heartbeat_stop.clear()

        def loop() -> None:
            while not self._heartbeat_stop.wait(max(1.0, float(interval_seconds))):
                if self._file is None:
                    return
                try:
                    self._write_metadata()
                except Exception as exc:
                    record_failure(_failure_log, "daemon owner heartbeat write", exc)

        self._heartbeat_thread = threading.Thread(target=loop, name=self._heartbeat_thread_name, daemon=True)
        self._heartbeat_thread.start()

    def release(self, *, receipt: dict[str, Any] | None = None) -> None:
        """End ownership. `receipt` -- the daemon's own account of its stop ({clean, reason, error, exit_code}) --
        is written bound to this instance and generation before the lock goes."""
        global _current
        if self._file is not None:
            _atomic_json(receipt_path_for(self.metadata_path), {
                "schema": RECEIPT_SCHEMA, "daemon_instance_id": self._metadata.get("daemon_instance_id"),
                "owner_pid": os.getpid(), "owner_created_ns": self._metadata.get("owner_created_ns"),
                "generation": self._metadata.get("generation"),
                "completed_at": datetime.now().astimezone().isoformat(timespec="milliseconds"),
                "clean": bool((receipt or {}).get("clean")), "reason": (receipt or {}).get("reason"),
                "error": (receipt or {}).get("error"), "exit_code": (receipt or {}).get("exit_code"),
            })
        self._metadata["lifecycle"] = "STOPPED"
        if _current is self:
            _current = None
        self._heartbeat_stop.set()
        thread = self._heartbeat_thread
        if thread and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=1.0)
        self._heartbeat_thread = None
        fh, self._file = self._file, None
        if fh is not None:
            try:
                self._unlock(fh)
            finally:
                fh.close()
        try:
            owner = read_owner_metadata(self.metadata_path)
            if record_int(owner.get("owner_pid")) == os.getpid():
                self.metadata_path.unlink(missing_ok=True)
        except Exception as exc:
            record_failure(_failure_log, "removing the daemon owner metadata at release", exc)

    def __enter__(self) -> "DaemonSingletonLock":
        self.acquire()
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        self.release()
