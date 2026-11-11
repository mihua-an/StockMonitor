from __future__ import annotations

import math
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable

STATE_STARTING = "STARTING"
STATE_ACTIVE = "ACTIVE"
STATE_IDLE_GRACE = "IDLE_GRACE"
STATE_STOPPING = "STOPPING"
STATE_STOPPED = "STOPPED"


class MarketDaemonLifecycleError(RuntimeError):
    pass


@dataclass
class ClientLease:
    lease_id: str
    client_id: str
    connection_id: str
    attached_at_epoch: float
    last_heartbeat_epoch: float
    last_heartbeat_monotonic: float
    expires_at_epoch: float | None
    expires_at_monotonic: float | None
    lease_kind: str = "heartbeat"
    state: str = "ACTIVE"
    client_name: str = "fastapi"
    client_pid: int | None = None
    electron_pid: int | None = None


class MarketDaemonLifecycleManager:
    """Race-safe App-client lease and shared eight-minute idle-grace state machine.

    The broker/native/recorder owner stays alive while the daemon is ACTIVE or
    IDLE_GRACE. The last valid client disappearing starts the grace window. A
    successful attach wins only while the daemon has not atomically entered
    STOPPING.
    """

    def __init__(
        self,
        *,
        idle_grace_seconds: float,
        lease_timeout_seconds: float,
        client_heartbeat_seconds: float,
        monotonic_fn: Callable[[], float] = time.monotonic,
        wall_time_fn: Callable[[], float] = time.time,
    ) -> None:
        self.idle_grace_seconds = max(0.01, float(idle_grace_seconds))
        self.client_heartbeat_seconds = max(0.01, float(client_heartbeat_seconds))
        self.lease_timeout_seconds = max(
            self.client_heartbeat_seconds * 2.0,
            float(lease_timeout_seconds),
        )
        self._monotonic = monotonic_fn
        self._wall_time = wall_time_fn
        self._lock = threading.RLock()
        self._changed = threading.Event()
        self._state = STATE_STARTING
        # Lease identity is connection-scoped instead of a lossy integer counter.
        # A FastAPI process normally owns two independent leases:
        #   * control heartbeat lease (short TTL)
        #   * daemon WebSocket lease (connection-bound, no synthetic TTL)
        # The daemon may enter IDLE_GRACE only when this mapping is truly empty.
        self._clients: dict[str, ClientLease] = {}
        self._last_client_attached_at_epoch: float | None = None
        self._last_client_detached_at_epoch: float | None = None
        self._idle_started_monotonic: float | None = None
        self._idle_shutdown_deadline_monotonic: float | None = None
        self._idle_shutdown_deadline_epoch: float | None = None
        self._idle_generation = 0
        self._lease_attach_count = 0
        self._lease_detach_count = 0
        self._lease_expire_count = 0
        self._idle_timer_start_count = 0
        self._idle_timer_cancel_count = 0
        self._stop_reason: str | None = None

    @staticmethod
    def _iso(epoch: float | None) -> str | None:
        if epoch is None:
            return None
        return datetime.fromtimestamp(epoch).isoformat(timespec="seconds")

    @property
    def state(self) -> str:
        with self._lock:
            return self._state

    def _signal(self) -> None:
        self._changed.set()

    def wait_for_change(self, timeout: float) -> None:
        self._changed.wait(timeout=max(0.01, float(timeout)))
        self._changed.clear()

    def _clear_idle_locked(self) -> None:
        # Incrementing the generation invalidates any stale watchdog/timer claim
        # that observed an earlier idle window before a reattach won the lock.
        if self._idle_started_monotonic is not None or self._idle_shutdown_deadline_monotonic is not None:
            self._idle_timer_cancel_count += 1
        self._idle_generation += 1
        self._idle_started_monotonic = None
        self._idle_shutdown_deadline_monotonic = None
        self._idle_shutdown_deadline_epoch = None

    def _enter_idle_grace_locked(self, *, now_mono: float, now_epoch: float) -> bool:
        if self._state in {STATE_STOPPING, STATE_STOPPED}:
            return False
        if self._clients:
            return False
        self._idle_generation += 1
        self._idle_timer_start_count += 1
        self._state = STATE_IDLE_GRACE
        self._last_client_detached_at_epoch = now_epoch
        self._idle_started_monotonic = now_mono
        self._idle_shutdown_deadline_monotonic = now_mono + self.idle_grace_seconds
        self._idle_shutdown_deadline_epoch = now_epoch + self.idle_grace_seconds
        self._signal()
        return True

    @staticmethod
    def _lease_identity(client_id: str, connection_id: str, lease_id: str | None = None) -> str:
        explicit = str(lease_id or "").strip()
        if explicit:
            return explicit
        return f"{str(client_id or '').strip()}:{str(connection_id or 'control').strip() or 'control'}"

    def _find_lease_locked(
        self,
        client_id: str,
        *,
        lease_id: str | None = None,
        connection_id: str = "control",
    ) -> tuple[str, ClientLease | None]:
        key = self._lease_identity(client_id, connection_id, lease_id)
        lease = self._clients.get(key)
        if lease is not None:
            return key, lease
        # A caller that names a lease means that lease: one it does not hold is not found (falling back
        # to the client's only other lease would let a stale detach end the live connection's lease). Only a caller
        # that knows nothing but the client id is matched by it.
        if str(lease_id or "").strip():
            return key, None
        matches = [(item_key, item) for item_key, item in self._clients.items() if item.client_id == str(client_id or "").strip()]
        if len(matches) == 1:
            return matches[0]
        return key, None

    def attach(
        self,
        client_id: str | None = None,
        *,
        lease_id: str | None = None,
        connection_id: str = "control",
        lease_kind: str = "heartbeat",
        expires: bool = True,
        client_name: str = "fastapi",
        client_pid: int | None = None,
        electron_pid: int | None = None,
    ) -> dict[str, Any]:
        now_mono = self._monotonic()
        now_epoch = self._wall_time()
        with self._lock:
            self._expire_leases_locked(now_mono=now_mono, now_epoch=now_epoch)
            if self._state in {STATE_STOPPING, STATE_STOPPED}:
                raise MarketDaemonLifecycleError(f"daemon is {self._state}; attach rejected")
            normalized = str(client_id or "").strip() or uuid.uuid4().hex
            normalized_connection = str(connection_id or "control").strip() or "control"
            normalized_lease_id = self._lease_identity(normalized, normalized_connection, lease_id)
            existing = self._clients.get(normalized_lease_id)
            if existing is None:
                self._lease_attach_count += 1
            attached_epoch = existing.attached_at_epoch if existing is not None else now_epoch
            ttl_enabled = bool(expires)
            self._clients[normalized_lease_id] = ClientLease(
                lease_id=normalized_lease_id,
                client_id=normalized,
                connection_id=normalized_connection,
                attached_at_epoch=attached_epoch,
                last_heartbeat_epoch=now_epoch,
                last_heartbeat_monotonic=now_mono,
                expires_at_epoch=(now_epoch + self.lease_timeout_seconds) if ttl_enabled else None,
                expires_at_monotonic=(now_mono + self.lease_timeout_seconds) if ttl_enabled else None,
                lease_kind=str(lease_kind or "heartbeat"),
                client_name=str(client_name or "fastapi"),
                client_pid=int(client_pid) if client_pid else None,
                electron_pid=int(electron_pid) if electron_pid else None,
            )
            self._last_client_attached_at_epoch = now_epoch
            was_idle = self._state == STATE_IDLE_GRACE
            self._state = STATE_ACTIVE
            self._stop_reason = None
            self._clear_idle_locked()
            self._signal()
            return {
                "ok": True,
                "client_id": normalized,
                "lease_id": normalized_lease_id,
                "connection_id": normalized_connection,
                "client_count": len(self._clients),
                "state": self._state,
                "idle_shutdown_cancelled": was_idle,
            }

    def heartbeat(self, client_id: str, *, lease_id: str | None = None, connection_id: str = "control") -> dict[str, Any]:
        now_mono = self._monotonic()
        now_epoch = self._wall_time()
        normalized = str(client_id or "").strip()
        with self._lock:
            self._expire_leases_locked(now_mono=now_mono, now_epoch=now_epoch)
            if self._state in {STATE_STOPPING, STATE_STOPPED}:
                raise MarketDaemonLifecycleError(f"daemon is {self._state}; heartbeat rejected")
            resolved_lease_id, lease = self._find_lease_locked(normalized, lease_id=lease_id, connection_id=connection_id)
            if lease is None:
                raise MarketDaemonLifecycleError("client lease missing or expired; attach required")
            lease.last_heartbeat_monotonic = now_mono
            lease.last_heartbeat_epoch = now_epoch
            if lease.expires_at_monotonic is not None:
                lease.expires_at_monotonic = now_mono + self.lease_timeout_seconds
                lease.expires_at_epoch = now_epoch + self.lease_timeout_seconds
            return {
                "ok": True,
                "client_id": normalized,
                "lease_id": resolved_lease_id,
                "client_count": len(self._clients),
                "state": self._state,
            }

    def detach(self, client_id: str, *, lease_id: str | None = None, connection_id: str = "control") -> dict[str, Any]:
        now_mono = self._monotonic()
        now_epoch = self._wall_time()
        normalized = str(client_id or "").strip()
        with self._lock:
            self._expire_leases_locked(now_mono=now_mono, now_epoch=now_epoch)
            resolved_lease_id, lease = self._find_lease_locked(normalized, lease_id=lease_id, connection_id=connection_id)
            removed = self._clients.pop(resolved_lease_id, None) is not None if lease is not None else False
            if removed:
                self._lease_detach_count += 1
            entered_idle = False
            if removed and not self._clients and self._state not in {STATE_STOPPING, STATE_STOPPED}:
                entered_idle = self._enter_idle_grace_locked(now_mono=now_mono, now_epoch=now_epoch)
            elif removed:
                self._signal()
            return {
                "ok": True,
                "client_id": normalized,
                "lease_id": resolved_lease_id,
                "detached": removed,
                "client_count": len(self._clients),
                "state": self._state,
                "entered_idle_grace": entered_idle,
            }

    def _expire_leases_locked(self, *, now_mono: float, now_epoch: float) -> list[str]:
        expired_keys = [
            lease_id
            for lease_id, lease in self._clients.items()
            if lease.expires_at_monotonic is not None and now_mono >= lease.expires_at_monotonic
        ]
        if not expired_keys:
            return []
        expired_client_ids: list[str] = []
        self._lease_expire_count += len(expired_keys)
        for lease_id in expired_keys:
            lease = self._clients.pop(lease_id, None)
            if lease is not None:
                expired_client_ids.append(lease.client_id)
        if not self._clients and self._state not in {STATE_STOPPING, STATE_STOPPED}:
            self._enter_idle_grace_locked(now_mono=now_mono, now_epoch=now_epoch)
        else:
            self._signal()
        return expired_client_ids

    def expire_leases(self) -> list[str]:
        now_mono = self._monotonic()
        now_epoch = self._wall_time()
        with self._lock:
            return self._expire_leases_locked(now_mono=now_mono, now_epoch=now_epoch)

    def claim_idle_timeout(self, *, expected_generation: int | None = None) -> bool:
        """Atomically claim the idle timeout and transition to STOPPING.

        If an attach acquired the lock first, the idle deadline is cancelled and
        this returns False. Once this returns True, later attaches are rejected.
        """
        now_mono = self._monotonic()
        now_epoch = self._wall_time()
        with self._lock:
            self._expire_leases_locked(now_mono=now_mono, now_epoch=now_epoch)
            if self._state != STATE_IDLE_GRACE or self._clients:
                return False
            if expected_generation is not None and int(expected_generation) != int(self._idle_generation):
                return False
            deadline = self._idle_shutdown_deadline_monotonic
            if deadline is None or now_mono < deadline:
                return False
            self._state = STATE_STOPPING
            self._stop_reason = "idle_timeout"
            self._signal()
            return True

    def begin_stopping(self, reason: str) -> bool:
        with self._lock:
            if self._state == STATE_STOPPED:
                return False
            if self._state == STATE_STOPPING:
                return self._stop_reason == str(reason or "explicit_stop")
            self._state = STATE_STOPPING
            self._stop_reason = str(reason or "explicit_stop")
            self._clear_idle_locked()
            self._signal()
            return True

    def mark_stopped(self, reason: str | None = None) -> None:
        with self._lock:
            self._state = STATE_STOPPED
            if reason:
                self._stop_reason = str(reason)
            self._clients.clear()
            self._clear_idle_locked()
            self._signal()

    def status(self) -> dict[str, Any]:
        now_mono = self._monotonic()
        now_epoch = self._wall_time()
        with self._lock:
            self._expire_leases_locked(now_mono=now_mono, now_epoch=now_epoch)
            remaining: int | None = None
            if self._state == STATE_IDLE_GRACE and self._idle_shutdown_deadline_monotonic is not None:
                remaining = max(0, int(math.ceil(self._idle_shutdown_deadline_monotonic - now_mono)))
            return {
                "state": self._state,
                "client_count": len(self._clients),
                "active_client_count": len(self._clients),
                "logical_client_count": len({lease.client_id for lease in self._clients.values()}),
                "active_leases": [
                    {
                        "lease_id": lease.lease_id,
                        "client_id": lease.client_id,
                        "connection_id": lease.connection_id,
                        "lease_kind": lease.lease_kind,
                        "attached_at": self._iso(lease.attached_at_epoch),
                        "last_heartbeat_at": self._iso(lease.last_heartbeat_epoch),
                        "expires_at": self._iso(lease.expires_at_epoch),
                        "state": lease.state,
                        "client_name": lease.client_name,
                        "client_pid": lease.client_pid,
                        "electron_pid": lease.electron_pid,
                    }
                    for lease in self._clients.values()
                ],
                "idle_generation": int(self._idle_generation),
                "lease_attach_count": int(self._lease_attach_count),
                "lease_detach_count": int(self._lease_detach_count),
                "lease_expire_count": int(self._lease_expire_count),
                "idle_timer_start_count": int(self._idle_timer_start_count),
                "idle_timer_cancel_count": int(self._idle_timer_cancel_count),
                "last_client_attached_at": self._iso(self._last_client_attached_at_epoch),
                "last_client_detached_at": self._iso(self._last_client_detached_at_epoch),
                "idle_timeout_seconds": int(round(self.idle_grace_seconds)),
                "idle_shutdown_deadline": self._iso(self._idle_shutdown_deadline_epoch),
                "idle_remaining_seconds": remaining,
                "client_lease_timeout_seconds": int(round(self.lease_timeout_seconds)),
                "client_heartbeat_seconds": int(round(self.client_heartbeat_seconds)),
                "stop_reason": self._stop_reason,
            }
