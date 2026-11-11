"""Transport mechanics only; no broker, process launch or recovery decisions."""
from __future__ import annotations

import socket
import threading
import time
from collections.abc import Iterable


def matches_contract(payload: object, *, identity: str, protocol: int, runtime: str) -> bool:
    if not isinstance(payload, dict):
        return False
    # Do not coerce floats/bools into a valid protocol or raise on hostile health.
    version = payload.get("protocol_version")
    return (
        payload.get("ok") is True
        and payload.get("identity") == identity
        and type(version) in (int, str)
        and str(version) == str(protocol)
        and payload.get("daemon_runtime_version") == runtime
    )


def port_open(host: str, port: int, timeout: float) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        return sock.connect_ex((host, port)) == 0


def lease_body(client_id: str, connection_id: str, lease_id: str | None) -> dict:
    """Wire identity shared by heartbeat and detach; attach metadata stays local."""
    return {"client_id": client_id, "connection_id": connection_id, "lease_id": lease_id}


def join_workers(threads: Iterable[threading.Thread | None], *, wait: bool, timeout: float) -> list[str]:
    """One deadline; callers retain references until all workers actually exit."""
    workers = tuple(thread for thread in threads if thread is not None)
    deadline = time.monotonic() + max(0.0, float(timeout))
    if wait:
        for thread in workers:
            if thread.is_alive() and thread is not threading.current_thread():
                thread.join(timeout=max(0.0, deadline - time.monotonic()))
    return [thread.name for thread in workers if thread.is_alive()]


class ReconnectBackoff:
    """Delay arithmetic, never a decision to restart a daemon or its source."""

    # Exponential by default: a multiplier of 1.0 made "backoff" a fixed 0.5 s retry forever.
    def __init__(self, initial: float, maximum: float, multiplier: float = 2.0):
        self.initial, self.maximum, self.multiplier = initial, maximum, multiplier
        self.reset()

    def reset(self) -> None:
        self.delay = self.initial

    def next_delay(self) -> float:
        delay = self.delay
        self.delay = min(self.maximum, self.delay * self.multiplier)
        return delay
