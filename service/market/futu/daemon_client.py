from __future__ import annotations

import logging
import os
import threading
import uuid
from copy import deepcopy
from typing import Any

_logger = logging.getLogger(__name__)

# Attach outcomes that do not resolve on their own: OpenD is not running, or another program owns the daemon port.
_ATTACH_PERMANENT = frozenset({"OPEND_NOT_RUNNING", "FOREIGN_ENDPOINT"})
# Transient failures retry with backoff for this long, then wait for a manual reconnect.
_ATTACH_GIVE_UP_SECONDS = 15 * 60.0

from service.market.shared.daemon_connection import join_workers
from service.market.shared.daemon_lease import DaemonLease
from service.market.shared.daemon_transport import DaemonHttpTransport, DaemonTransportError
from service.market.futu.daemon_probe import (
    inspect_moomoo_daemon_port_owner,
    is_known_moomoo_daemon_owner,
    moomoo_daemon_port_open,
    probe_moomoo_daemon,
    probe_moomoo_daemon_detailed,
    reprobe_known_moomoo_daemon,
    is_daemon_usable,
)

from service.market.futu.daemon_contract import (
    MOOMOO_DAEMON_IDENTITY,
)
from service.market.futu.daemon_settings import (
    MOOMOO_DAEMON_CLIENT_HEARTBEAT_SECONDS,
    MOOMOO_DAEMON_HOST,
    MOOMOO_DAEMON_PORT,
)
from service.platform.failure_record import record_failure

class MoomooDaemonError(RuntimeError):
    pass


# Electron's own bounded daemon spawn/attach window is ~60-90s. On Windows a
# second Python/OpenD cold start can be expensive; once retrying has run well
# past that window, continuing to log at warning level would misrepresent a
# genuinely stuck attach as routine noise.
MOOMOO_DAEMON_ATTACH_ESCALATION_SECONDS = 90.0
# OPEND_NOT_RUNNING (see opend_lifecycle.py's _opend_port_reachable) is a
# well-known, human-actionable condition, not a startup race -- OpenD will
# not appear on its own between one attempt and the next, so retrying on a
# timer just repeats the same failed HTTP round trip forever and floods the
# log for no benefit. Report it once and stop; the System Connection
# Diagnostics panel's manual "重新檢查連線" button (POST
# /api/futu-daemon/reconnect) is how the user tries again once OpenD is
# actually up, instead of a background thread polling indefinitely.

_transport = DaemonHttpTransport(MOOMOO_DAEMON_HOST, MOOMOO_DAEMON_PORT)


def _port_open(timeout: float = 0.2) -> bool:
    return moomoo_daemon_port_open(timeout)


class MoomooDaemonClient:
    """FastAPI-side control/read client for the persistent OpenD owner.

    The client owns only a short lease and HTTP proxy calls.  It never opens an
    OpenQuoteContext or writes the Moomoo SQLite store itself.
    """

    def __init__(self) -> None:
        self.client_id = f"fastapi-moomoo-{os.getpid()}-{uuid.uuid4().hex[:8]}"
        self.connection_id = "control"
        self._lease = DaemonLease(
            provider="futu", client_id=self.client_id, client_name="fastapi-moomoo",
            post=lambda path, body, timeout: self._request("POST", path, json_body=body, timeout=timeout,
                                                           require_compatible=False),
            component="moomoo_daemon_client", attach_mechanism="client.futu_daemon_attach",
            reattach_mechanism="client.futu_lease_reattach")
        self._lock = threading.RLock()
        self._lifecycle_lock = threading.RLock()
        self._stopping = False
        self._health: dict[str, Any] = {}
        self._stop = threading.Event()
        self._heartbeat_thread: threading.Thread | None = None

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
        timeout: float = 3.0,
        require_compatible: bool = True,
    ) -> dict[str, Any]:
        try:
            payload = _transport.request(method, path, params=params, json_body=json_body, timeout=timeout)
        except DaemonTransportError as exc:
            raise MoomooDaemonError(str(exc)) from exc
        if require_compatible and path == "/health" and not is_daemon_usable(payload):
            raise MoomooDaemonError("incompatible Moomoo daemon")
        return payload


    def ensure_daemon(self) -> dict[str, Any]:
        payload = probe_moomoo_daemon(timeout=0.6)
        if payload:
            identity = str(payload.get("identity") or "")
            if identity != MOOMOO_DAEMON_IDENTITY:
                return {"ok": False, "classification": "FOREIGN_ENDPOINT",
                        "error": f"port {MOOMOO_DAEMON_PORT} is not the Stock Monitor Moomoo Daemon"}
            if is_daemon_usable(payload):
                with self._lock:
                    self._health = dict(payload)
                return {"ok": True, "action": "reuse", "health": payload}
            if payload.get("opend_reachable") is False:
                # Cache the probe even though attach failed: cached_health() is
                # what the /api/futu/status 503 body and /api/futu-daemon/status
                # both surface to the renderer, so the dock/diagnostics UI can show
                # a definitive "OpenD not running" instead of an indefinite
                # "confirming" state while the daemon itself is reachable.
                with self._lock:
                    self._health = dict(payload)
                return {
                    "ok": False, "classification": "OPEND_NOT_RUNNING",
                    "error": "Futu OpenD 未啟動或無法連線，請先啟動 OpenD 並登入後再重試",
                }
            return {"ok": False, "classification": "RUNTIME_UNUSABLE", "error": "Moomoo daemon contract or runtime is unusable; external recovery is required"}
        detailed = probe_moomoo_daemon_detailed(timeout=0.8)
        if _port_open():
            owner = inspect_moomoo_daemon_port_owner()
            if is_known_moomoo_daemon_owner(owner):
                recovered = reprobe_known_moomoo_daemon()
                recovered_payload = recovered.get("payload") if recovered.get("ok") else None
                if isinstance(recovered_payload, dict) and is_daemon_usable(recovered_payload):
                    with self._lock:
                        self._health = dict(recovered_payload)
                    return {"ok": True, "action": "reuse", "health": recovered_payload, "probe_recovered": True, "owner": owner}
                return {
                    "ok": False,
                    "classification": str(recovered.get("classification") or "KNOWN_DAEMON_OWNER"),
                    "error": "known Moomoo daemon owns the port but health remains unavailable or unusable",
                    "owner": owner,
                }
            if isinstance(owner, dict) and (owner.get("pid") or owner.get("commandLine") or owner.get("executablePath")):
                return {"ok": False, "classification": "FOREIGN_ENDPOINT", "error": f"port {MOOMOO_DAEMON_PORT} is owned by a foreign endpoint", "owner": owner}
            return {
                "ok": False,
                "classification": "OWNERSHIP_UNRESOLVED",
                "error": f"port {MOOMOO_DAEMON_PORT} is open but ownership is unresolved after {detailed.get('classification')}",
            }
        return {
            "ok": False,
            "classification": str(detailed.get("classification") or "CONNECTION_REFUSED"),
            "error": "Moomoo daemon is not running; Electron startup coordination is required",
        }

    def _attach_to_current_daemon(self, health: dict[str, Any]) -> dict[str, Any]:
        attached = self._lease.attach(str(health.get("daemon_instance_id") or ""))
        with self._lock:
            self._health = dict(health)
        return attached

    def start(self) -> dict[str, Any]:
        with self._lifecycle_lock:
            if self._stopping:
                return {"ok": False, "attached": False, "error": "client_stop_incomplete"}
            try:
                return self._start_locked()
            except Exception as exc:
                # not an error: the failure is start()'s answer; its callers record it as an attempt of their attach
                # recovery (DaemonLease.attach_in_background, manual_reattach)
                self._stopping = True
                cleanup = self._stop_locked(wait=True, timeout=8.0)
                return {"ok": False, "attached": False, "error": str(exc), "cleanup": cleanup}

    def manual_reattach(self) -> dict[str, Any]:
        """The diagnostics panel's 重新檢查 Futu 連線: one attach. The user's own action, not a remediation
        (docs/decisions.md 什麼算補救): its outcome goes to the operation log. An open background attach recovery is
        ended by it too -- whichever attach succeeds closes the one recovery."""
        result = self.start()
        if result.get("ok"):
            _logger.info("[FUTU] 重新檢查 requested by the user: attached (client %s)", self.client_id)
        else:
            _logger.warning("[FUTU] 重新檢查 requested by the user: not attached (%s): %s", result.get("classification"),
                            str(result.get("error") or "")[:300])
        if result.get("ok"):
            self._lease.attach_recovery.finish("succeeded", detail={"by": "manual_request"})
        return result

    def attach_in_background(self, shutdown_requested: threading.Event, *,
                              on_attached=None, logger: logging.Logger | None = None) -> threading.Thread:
        """Attach in a background thread until it succeeds (DaemonLease.attach_in_background).

        Electron is the only Moomoo daemon startup owner. On Windows a second
        Python/OpenD cold start can be expensive, so this must not probe/retry
        8011 during the FastAPI readiness-critical path -- the initial delay
        guarantees readiness wins the control-plane race first. A permanent
        classification (OpenD not running, a foreign port owner) stops at once and
        transient failures give up after 15 minutes: the System Connection
        Diagnostics panel's manual reconnect tries again. ``on_attached()`` runs
        once right after a successful attach (e.g. to restore watchlist subscriptions).
        """
        return self._lease.attach_in_background(
            self.start, shutdown_requested, stop=lambda: self.stop(wait=False, timeout=1.0),
            log=logger or _logger, thread_name="FastAPIMoomooDaemonAttach", initial_delay=1.0,
            permanent=_ATTACH_PERMANENT, give_up_seconds=_ATTACH_GIVE_UP_SECONDS,
            escalation_seconds=MOOMOO_DAEMON_ATTACH_ESCALATION_SECONDS, on_attached=on_attached)

    def _start_locked(self) -> dict[str, Any]:
        with self._lock:
            heartbeat_alive = bool(not self._stop.is_set() and self._heartbeat_thread and self._heartbeat_thread.is_alive())
        attached_instance = self._lease.instance_id if self._lease.attached else ""
        if heartbeat_alive and attached_instance:
            # Reused only when this client is attached to the daemon instance running NOW (a live
            # heartbeat thread alone would return success after a reattach to a restarted daemon had failed).
            health = probe_moomoo_daemon(timeout=0.8)
            if health and is_daemon_usable(health) and str(health.get("daemon_instance_id") or "") == attached_instance:
                with self._lock:
                    self._health = dict(health)
                return {"ok": True, "attached": True, "reused_client_lease": True, "health": deepcopy(health)}
        ensured = self.ensure_daemon()
        if not ensured.get("ok"):
            return ensured
        health = dict(ensured.get("health") or {})
        try:
            attached = self._attach_to_current_daemon(health)
        except Exception as exc:
            record_failure(_logger, "attaching to the current Futu daemon", exc)
            return {"ok": False, "error": str(exc)}
        self._stop.clear()
        self._start_heartbeat()
        return {"ok": True, "attached": True, "health": self.cached_health(), **attached}

    # The lease is an expiring one (MOOMOO_DAEMON_CLIENT_LEASE_SECONDS), renewed by this loop. The /v1/stream
    # WebSocket that once held a non-expiring lease carried no data (the daemon sent two greeting frames, and no
    # listener was ever set), so there is none.
    def _start_heartbeat(self) -> None:
        if self._heartbeat_thread and self._heartbeat_thread.is_alive():
            return

        def _loop() -> None:
            while not self._stop.wait(MOOMOO_DAEMON_CLIENT_HEARTBEAT_SECONDS):
                health = probe_moomoo_daemon(timeout=0.8)
                if not health:
                    # A /health that did not answer in time says nothing about the lease: the held one is renewed all
                    # the same (skipping it let the lease expire under a slow /health), and no second lease is made;
                    # if the daemon really restarted, the next answered probe shows another instance.
                    self._lease.keep(None)
                    continue
                if not is_daemon_usable(health):
                    with self._lock:
                        self._health = dict(health)
                    continue
                with self._lock:
                    self._health = dict(health)
                self._lease.keep(str(health.get("daemon_instance_id") or ""))

        self._heartbeat_thread = threading.Thread(target=_loop, name="FastAPIMoomooDaemonHeartbeat", daemon=True)
        self._heartbeat_thread.start()

    def stop(self, *, wait: bool = True, timeout: float = 5.0) -> dict[str, Any]:
        with self._lifecycle_lock:
            self._stopping = True
            return self._stop_locked(wait=wait, timeout=timeout)

    def _stop_locked(self, *, wait: bool = True, timeout: float = 5.0) -> dict[str, Any]:
        self._stop.set()
        alive = join_workers([self._heartbeat_thread], wait=wait, timeout=timeout)
        if alive:
            if wait:
                record_failure(_logger, f"stopping the Futu daemon client workers {alive} within {timeout}s")
            return {"ok": False, "detached": False, "error": "client_stop_incomplete", "workers_alive": alive, "daemon_kept_alive": True}
        health = probe_moomoo_daemon(timeout=0.5) or self.cached_health()
        # A lease taken from a daemon instance that is gone is not offered to the one answering now.
        if isinstance(health, dict):
            self._lease.observe(str(health.get("daemon_instance_id") or ""))
        detached = self._lease.detach(timeout=timeout)
        self._stopping = not bool(detached.get("ok"))
        return {
            **detached,
            "daemon_kept_alive": bool(health),
            "daemon_pid": health.get("daemon_pid") if isinstance(health, dict) else None,
            "daemon_instance_id": health.get("daemon_instance_id") if isinstance(health, dict) else None,
            "idle_shutdown_deadline": health.get("idle_shutdown_deadline") if isinstance(health, dict) else None,
        }

    def health(self, *, refresh: bool = True) -> dict[str, Any]:
        if not refresh:
            return self.cached_health()
        payload = probe_moomoo_daemon(timeout=0.8)
        if payload:
            with self._lock:
                self._health = dict(payload)
            return payload
        return self.cached_health()

    def status(self) -> dict[str, Any]:
        """Return the provider-supervisor snapshot without blocking its poll."""
        return self.cached_health()

    def cached_health(self) -> dict[str, Any]:
        with self._lock:
            return deepcopy(self._health)

    def stats(self) -> dict[str, Any]:
        return {**self._lease.snapshot(),
                "heartbeat_thread_alive": bool(self._heartbeat_thread and self._heartbeat_thread.is_alive())}

    def call(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
        timeout: float = 5.0,
    ) -> dict[str, Any]:
        return self._request(method, path, params=params, json_body=json_body, timeout=timeout, require_compatible=False)

