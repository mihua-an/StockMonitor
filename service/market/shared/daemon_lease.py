"""One FastAPI client's lease on a provider daemon (Shioaji's Market Daemon, Futu's Moomoo Daemon).

Both clients hold the same kind of lease: attached once, renewed by a heartbeat, gone with the daemon instance it was
taken from, given back at shutdown. Their copies of that life cycle had drifted (a reattach to a restarted daemon
went unrecorded on one side, a stale lease was offered to a new instance on stop, one background attach retried
every second forever), so it lives here once. A provider supplies only how it reads its daemon's health, how it
makes sure the daemon is there, and its HTTP transport.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from collections.abc import Callable, Collection
from datetime import datetime
from typing import Any

from service.market.shared.daemon_connection import ReconnectBackoff, lease_body
from service.platform.failure_record import record_failure
from service.platform.remediation import Recovery

# Background attach: retry with backoff 1 s doubling to 30 s. A classification in a provider's `permanent` set (a
# foreign program on the daemon's port, OpenD not running) does not resolve between two tries, so it stops the loop.
ATTACH_BACKOFF = (1.0, 30.0)
# Log the first failed attempt and every fifth after it; never one line per retry.
_LOG_EVERY = 5

Post = Callable[[str, dict[str, Any], float], dict[str, Any]]


def exception_chain(exc: BaseException) -> str:
    """The types under `exc`, outermost first, e.g. "MoomooDaemonError <- DaemonTransportError <- ConnectionError <-
    ProtocolError <- ConnectionResetError[10054]": a provider's error keeps only a fixed message, so the record names
    what really failed. OS errors carry their (win)errno; messages are left out (localized, and they name the URL)."""
    names: list[str] = []
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen and len(names) < 12:
        seen.add(id(current))
        name = type(current).__name__
        if isinstance(current, OSError):
            code = getattr(current, "winerror", None) or current.errno
            if code:
                name = f"{name}[{code}]"
        names.append(name)
        current = current.__cause__ or current.__context__
    return " <- ".join(names)


class LeaseRejected(RuntimeError):
    """The daemon answered and refused the attach, heartbeat or detach."""


class DaemonLease:
    """The lease state of one client, and the only place that changes it."""

    def __init__(self, *, provider: str, client_id: str, client_name: str, post: Post, component: str,
                 attach_mechanism: str, reattach_mechanism: str) -> None:
        self.provider = provider
        self.client_id = client_id
        self.client_name = client_name
        self._post = post
        self._lock = threading.RLock()
        self._attached = False
        self._lease_id = ""
        self._instance_id = ""
        self._last_heartbeat_at: str | None = None
        self._last_heartbeat_error: str | None = None
        # FastAPI's attach until the daemon takes the lease (background loop, manual retry), and the keep-alive taking
        # a new lease after the old one was lost (daemon instance changed, heartbeat refused).
        self.attach_recovery = Recovery(component=component, mechanism_id=attach_mechanism)
        self.reattach_recovery = Recovery(component=component, mechanism_id=reattach_mechanism)

    # ------------------------------------------------------------------ state
    @property
    def attached(self) -> bool:
        with self._lock:
            return self._attached

    @property
    def instance_id(self) -> str:
        with self._lock:
            return self._instance_id

    def identity(self) -> dict[str, Any]:
        with self._lock:
            return {"client_id": self.client_id, "lease_id": self._lease_id or None,
                    "daemon_instance_id": self._instance_id or None}

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {"attached": self._attached, "client_id": self.client_id, "lease_id": self._lease_id or None,
                    "attached_daemon_instance_id": self._instance_id or None,
                    "last_heartbeat_at": self._last_heartbeat_at, "last_heartbeat_error": self._last_heartbeat_error}

    def observe(self, instance_id: str) -> None:
        """The daemon answering now is `instance_id`: a lease taken from another instance went away with it."""
        with self._lock:
            if self._attached and instance_id and self._instance_id and instance_id != self._instance_id:
                self._attached = False
                self._lease_id = ""

    def _lost(self, error: str) -> None:
        with self._lock:
            self._attached = False
            self._lease_id = ""
            self._last_heartbeat_error = error

    # ------------------------------------------------------------------ wire
    def attach(self, instance_id: str) -> dict[str, Any]:
        """Take a lease from daemon instance `instance_id`. A lease this client still holds from that same instance is
        renewed under its id; one from another instance is never offered (it went with that instance)."""
        with self._lock:
            lease = self._lease_id if self._instance_id == instance_id else ""
        body: dict[str, Any] = {
            "client_id": self.client_id, "connection_id": "control", "client_name": self.client_name,
            "client_pid": os.getpid(),
            "electron_pid": int(os.environ.get("STOCK_MONITOR_ELECTRON_PID") or 0) or None,
        }
        if lease:
            body["lease_id"] = lease
        payload = self._post("/v1/client/attach", body, 3.0)
        if not payload.get("ok"):
            raise LeaseRejected(str(payload.get("error") or f"{self.provider} daemon refused the attach"))
        with self._lock:
            self._attached = True
            self._lease_id = str(payload.get("lease_id") or lease or "")
            self._instance_id = str(payload.get("daemon_instance_id") or instance_id or "")
            self._last_heartbeat_at = datetime.now().isoformat(timespec="seconds")
            self._last_heartbeat_error = None
        return payload

    def heartbeat(self) -> dict[str, Any]:
        with self._lock:
            lease = self._lease_id
        payload = self._post("/v1/client/heartbeat", lease_body(self.client_id, "control", lease), 2.0)
        if not payload.get("ok"):
            raise LeaseRejected(str(payload.get("error") or f"{self.provider} daemon refused the heartbeat"))
        with self._lock:
            self._last_heartbeat_at = datetime.now().isoformat(timespec="seconds")
            self._last_heartbeat_error = None
        return payload

    def keep(self, instance_id: str | None) -> None:
        """One keep-alive step against daemon instance `instance_id`: renew the lease, or take a new one when none is
        held. Each lost lease is one recorded recovery, failed before it is finished.

        `instance_id` None: the daemon's health could not be read this time (its snapshot file is late, its /health
        did not answer in time). A held lease is renewed all the same -- the heartbeat is this client saying it is
        alive, which reading the daemon's health has nothing to do with; skipping it let the lease expire while both
        processes ran (a disk freeze held the snapshot, a slow /health). Nothing is attached unseen."""
        if instance_id is None:
            if self.attached:
                self._renew(self.instance_id)
            return
        self.observe(instance_id)
        with self._lock:
            attached, previous = self._attached, self._instance_id
        if not attached:
            reason = "instance_changed" if previous and previous != instance_id else "not_attached"
            self.reattach_recovery.failed(reason, identity=self.identity(),
                                          detail={"previous_instance_id": previous or None,
                                                  "daemon_instance_id": instance_id or None})
            try:
                self.attach(instance_id)
            except Exception as exc:
                record_failure(logging.getLogger(__name__), f"reattaching the lease after {reason}", exc)
                self._lost(f"reattach: {exc}")
                return
            self.reattach_recovery.finish("succeeded", identity=self.identity())
            return
        self._renew(instance_id)

    def _renew(self, instance_id: str) -> None:
        try:
            self.heartbeat()
        except Exception as exc:
            # The daemon is the same instance but no longer renews this lease (it expired, or the call failed):
            # attach again under the same lease id -- attach is idempotent on the daemon.
            self.reattach_recovery.failed("heartbeat_failed", identity=self.identity(),
                                          detail={"error": f"{type(exc).__name__}: {exc}"[:300],
                                                  "cause": exception_chain(exc)})
            try:
                self.attach(instance_id)
            except Exception as attach_exc:
                record_failure(logging.getLogger(__name__), "reattaching the lease after a failed heartbeat", attach_exc)
                self._lost(f"heartbeat: {exc}; reattach: {attach_exc}")
                return
            self.reattach_recovery.finish("succeeded", identity=self.identity())

    def detach(self, *, timeout: float = 3.0) -> dict[str, Any]:
        """Give the lease back. Nothing is sent when no lease is held (one lost with its daemon instance is not offered
        to the next); a refusal or a failed call answers ok False, so the shutdown receipt never says detached."""
        with self._lock:
            attached, lease, instance = self._attached, self._lease_id, self._instance_id
        if not attached:
            return {"ok": True, "detached": False}
        what = f"detaching lease {lease or '?'} of client {self.client_id} from {self.provider} daemon {instance or '?'}"
        try:
            payload = self._post("/v1/client/detach", lease_body(self.client_id, "control", lease),
                                 min(3.0, max(0.5, float(timeout))))
        except Exception as exc:
            record_failure(logging.getLogger(__name__), what, exc)
            return {"ok": False, "detached": False, "error": str(exc)}
        if not payload.get("ok"):
            record_failure(logging.getLogger(__name__), f"{what} (refused: {payload.get('error')})")
            return {**payload, "ok": False, "detached": False}
        with self._lock:
            self._attached = False
            self._lease_id = ""
            self._instance_id = ""
        return {**payload, "ok": True, "detached": True}

    # ------------------------------------------------------------------ background attach
    def attach_in_background(self, start: Callable[[], dict[str, Any]], shutdown: threading.Event, *,
                             stop: Callable[[], Any], log: logging.Logger, thread_name: str,
                             initial_delay: float = 0.0, permanent: Collection[str] = (),
                             give_up_seconds: float | None = None, escalation_seconds: float = 90.0,
                             on_attempt: Callable[[int], None] | None = None,
                             on_attached: Callable[[], None] | None = None) -> threading.Thread:
        """Call `start()` until it attaches, in a thread of its own.

        Retries back off (1 s doubling to 30 s). A result classified in `permanent` stops at once -- it will not
        resolve between two tries. After `give_up_seconds` (None: never) the loop stops and waits for a manual retry.
        A shutdown during an attempt gives a late lease straight back (`stop`). `on_attempt(started_ns)` follows
        every attempt; `on_attached()` runs once after a success, and a failure there is recorded without attaching
        again (the lease stands)."""
        label = f"{self.provider} daemon attach"

        def run() -> None:
            if initial_delay and shutdown.wait(initial_delay):
                return
            attempt = 0
            started = time.monotonic()
            escalated = False
            backoff = ReconnectBackoff(*ATTACH_BACKOFF)
            while not shutdown.is_set():
                attempt += 1
                started_ns = time.perf_counter_ns()
                try:
                    result = start()
                except Exception as exc:
                    # not an error: the failed attempt is `result`, recorded below as an attempt of attach_recovery
                    result = {"ok": False, "error": f"{type(exc).__name__}: {exc}", "classification": "ATTACH_ERROR"}
                if on_attempt is not None:
                    on_attempt(started_ns)
                if shutdown.is_set():
                    try:
                        stop()
                    except Exception as exc:
                        record_failure(log, f"giving back the {label} lease taken during shutdown", exc)
                    return
                if result.get("ok"):
                    self.attach_recovery.finish("succeeded", detail={"attempts": attempt})
                    log.info(f"[APP] {label} completed in background attempt={attempt}")
                    if on_attached is not None:
                        try:
                            on_attached()
                        except Exception as exc:
                            record_failure(log, f"the {label} post-attach callback (the attach itself stands)", exc)
                    return
                classification = result.get("classification")
                self.attach_recovery.failed("attach_unavailable", identity={"client_id": self.client_id},
                                            detail={"error": str(result.get("error") or "")[:300],
                                                    "classification": classification})
                elapsed = time.monotonic() - started
                if classification in permanent:
                    self.attach_recovery.finish("failed", detail={"classification": classification, "attempts": attempt})
                    log.error(f"[APP] {label} stopped attempt={attempt} ({classification}): {result.get('error')}; "
                              "it will not resolve by retrying")
                    return
                if attempt == 1 or attempt % _LOG_EVERY == 0:
                    level = log.error if elapsed >= escalation_seconds else log.warning
                    level(f"[APP] {label} unavailable attempt={attempt}: {result.get('error') or 'unknown error'}")
                if not escalated and elapsed >= escalation_seconds:
                    escalated = True
                    log.error(f"[APP] {label} still not attached after {attempt} attempts; "
                              "this is no longer a normal startup race - check Electron/daemon health")
                if give_up_seconds is not None and elapsed >= give_up_seconds:
                    self.attach_recovery.finish("failed", detail={"reason": "gave_up", "attempts": attempt})
                    log.error(f"[APP] {label} given up after {attempt} attempts / {give_up_seconds:.0f} s; "
                              "retry manually from System Connection Diagnostics")
                    return
                shutdown.wait(backoff.next_delay())
            self.attach_recovery.finish("abandoned", detail={"reason": "fastapi_shutdown", "attempts": attempt})

        thread = threading.Thread(target=run, name=thread_name, daemon=True)
        thread.start()
        return thread
