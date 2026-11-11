"""Shared daemon health-probe factory.

Shioaji and Futu/Moomoo daemons expose the same `/health` probe shape and the
same lifecycle classification rules; this factory is the single
implementation so per-provider behavior (e.g. the "warnings" field) cannot
drift between them the way two independently hand-copied modules would.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable, Iterable

import logging

from service.market.shared.daemon_connection import port_open
from service.market.shared.daemon_process_identity import inspect_listening_port_owner, matches_process_patterns
from service.market.shared.daemon_transport import DaemonHttpTransport, DaemonTransportError
from service.market.shared.daemon_singleton import record_int
from service.platform.failure_record import record_failure
from service.platform.process_observer import ProcessTableUnavailable, process_exists

_failure_log = logging.getLogger(__name__)

_UNUSABLE_STATES = {"DAEMON_HALF_DEAD", "HALF_DEAD", "STOPPING", "STOPPED"}


@dataclass(frozen=True)
class DaemonProbe:
    is_daemon_usable: Callable[[object], bool]
    probe_detailed: Callable[..., dict[str, Any]]
    probe: Callable[..., dict[str, Any] | None]
    port_open: Callable[..., bool]
    inspect_port_owner: Callable[[], dict[str, Any] | None]
    is_known_owner: Callable[[dict[str, Any] | None], bool]
    reprobe_known: Callable[..., dict[str, Any]]


def build_daemon_probe(
    *,
    host: str,
    port: int,
    is_contract_compatible: Callable[[object], bool],
    known_process_patterns: Iterable[str],
) -> DaemonProbe:
    transport = DaemonHttpTransport(host, port)
    patterns = tuple(known_process_patterns)

    def is_daemon_usable(payload: object) -> bool:
        if not is_contract_compatible(payload):
            return False
        state = str(payload.get("runtime_state") or payload.get("state") or "").upper()
        return state not in _UNUSABLE_STATES and payload.get("server_accepting_clients") is not False

    def probe_detailed(timeout: float = 0.8) -> dict[str, Any]:
        try:
            payload = transport.get("/health", timeout=timeout)
        except DaemonTransportError as exc:
            # not an error: an unanswered /health is the probe's answer (its classification); the caller acts on it
            return {
                "ok": False,
                "classification": exc.classification,
                "status_code": exc.status_code,
                "error": str(exc),
            }
        warnings = [str(payload["last_error"])] if payload.get("last_error") else []
        if not is_contract_compatible(payload):
            classification = "CONTRACT_INCOMPATIBLE"
        elif not is_daemon_usable(payload):
            classification = "RUNTIME_UNUSABLE"
        else:
            classification = "HEALTHY_WITH_WARNINGS" if warnings else "HEALTHY"
        return {"ok": True, "classification": classification, "warnings": warnings, "payload": payload}

    def probe(timeout: float = 0.8) -> dict[str, Any] | None:
        result = probe_detailed(timeout)
        payload = result.get("payload")
        return payload if result.get("ok") and isinstance(payload, dict) else None

    def probe_port_open(timeout: float = 0.2) -> bool:
        return port_open(host, port, timeout)

    def inspect_port_owner() -> dict[str, Any] | None:
        return inspect_listening_port_owner(port)

    def is_known_owner(owner: dict[str, Any] | None) -> bool:
        return matches_process_patterns(owner, patterns)

    def reprobe_known(*, attempts: int = 8, delay: float = 0.2) -> dict[str, Any]:
        result: dict[str, Any] = {"ok": False, "classification": "UNPROBED"}
        for index in range(max(1, int(attempts))):
            if index:
                time.sleep(max(0.01, float(delay)))
            result = probe_detailed(timeout=0.8)
            if result.get("ok") and isinstance(result.get("payload"), dict):
                return result
        return result

    return DaemonProbe(
        is_daemon_usable=is_daemon_usable,
        probe_detailed=probe_detailed,
        probe=probe,
        port_open=probe_port_open,
        inspect_port_owner=inspect_port_owner,
        is_known_owner=is_known_owner,
        reprobe_known=reprobe_known,
    )


def assess_passive_health_snapshot(
    snapshot: object,
    *,
    now_epoch_ns: int,
    max_age_seconds: float,
) -> dict[str, Any]:
    """Validate a locally-written daemon health snapshot's freshness and producer liveness."""
    data = snapshot if isinstance(snapshot, dict) else {}
    process = data.get("process") if isinstance(data.get("process"), dict) else {}
    producer = data.get("producer") if isinstance(data.get("producer"), dict) else {}
    lifecycle = str((data.get("component_state") or {}).get("lifecycle") or "") if isinstance(data.get("component_state"), dict) else ""
    # The snapshot is another process's file: a field of the wrong type makes it unverifiable (not fresh, with the
    # reason), never an exception out of the health loop.
    generated_ns = record_int(data.get("generated_epoch_ns") or 0)
    daemon_pid = record_int(process.get("pid") or producer.get("daemon_pid") or 0)
    problems = [f"{name}={value!r}" for name, value, parsed in (
        ("generated_epoch_ns", data.get("generated_epoch_ns"), generated_ns),
        ("pid", process.get("pid") or producer.get("daemon_pid"), daemon_pid)) if parsed is None]
    snapshot_error = f"unreadable snapshot fields: {', '.join(problems)}" if problems else ""
    if snapshot_error:
        record_failure(_failure_log, "reading the daemon health snapshot", ValueError(snapshot_error))
    age = max(0.0, (int(now_epoch_ns) - generated_ns) / 1_000_000_000) if generated_ns else None
    alive: bool | None
    if daemon_pid is None:
        alive = None
    else:
        try:
            alive = process_exists(daemon_pid)
        except ProcessTableUnavailable:  # not an error: the process table is unavailable: liveness is unknown, never gone
            alive = None   # cannot be verified: not fresh, and said so -- never "the daemon is gone"
    fresh = bool(
        data
        and age is not None
        and age <= max(5.0, float(max_age_seconds))
        and alive
        and lifecycle not in {"STOPPING", "STOPPED"}
    )
    return {
        "snapshot_fresh": fresh,
        "process_state": "UNVERIFIABLE" if alive is None else ("ALIVE" if alive else "GONE"),
        "snapshot_age_seconds": age,
        "daemon_pid": daemon_pid or 0,
        "producer": producer,
        "snapshot_error": snapshot_error,
    }
