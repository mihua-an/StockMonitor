"""Shared state machine for concurrent daemon shutdown requests."""

from __future__ import annotations

import threading
from datetime import datetime
from typing import Any


class DaemonShutdownState:
    """Own shutdown state, lock and completion event for one daemon process."""

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.complete_event = threading.Event()
        self.state: dict[str, Any] = {
            "stopping": False,
            "stopped": False,
            "reason": None,
            "started_at": None,
            "finished_at": None,
            "error": None,
            "phases": [],
            "shutdown_forced_abandon_count": 0,
        }

    def begin(self, reason: str) -> tuple[bool, str]:
        with self.lock:
            if self.state.get("stopped"):
                return False, str(self.state.get("reason") or reason)
            if self.state.get("stopping"):
                return True, str(self.state.get("reason") or reason)
            self.complete_event.clear()
            self.state.update({
                "stopping": True,
                "reason": reason,
                "started_at": datetime.now().astimezone().isoformat(timespec="seconds"),
                "finished_at": None,
                "error": None,
                "phases": [],
                "shutdown_forced_abandon_count": 0,
            })
            return False, reason

    def complete(self, **values: Any) -> None:
        with self.lock:
            self.state.update({
                "stopping": False,
                "stopped": True,
                "finished_at": datetime.now().astimezone().isoformat(timespec="seconds"),
                **values,
            })
        self.complete_event.set()

    def fail(self, error: Any, **values: Any) -> None:
        with self.lock:
            self.state.update({
                "stopping": False,
                "stopped": False,
                **values,
                "error": str(error),
            })
        self.complete_event.set()

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return dict(self.state)
