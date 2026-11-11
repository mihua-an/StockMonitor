from __future__ import annotations

from pathlib import Path
from typing import Any

from service.market.shared.daemon_state import daemon_state_dir
from service.market.shared.daemon_process_identity import classify_owner_metadata
from service.market.shared.daemon_singleton import DaemonSingletonLock, read_owner_metadata as read_shared_owner_metadata


class MoomooDaemonSingletonError(RuntimeError):
    def __init__(self, message: str, *, classification: str = "LOCK_HELD", owner: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.classification = str(classification or "LOCK_HELD")
        self.owner = dict(owner or {})


def owner_metadata_path() -> Path:
    return daemon_state_dir() / "moomoo_daemon_owner.json"


def read_owner_metadata(path: Path | None = None) -> dict[str, Any]:
    return read_shared_owner_metadata(path or owner_metadata_path())


def classify_owner(owner: dict[str, Any] | None = None) -> str:
    payload = dict(owner or read_owner_metadata())
    return classify_owner_metadata(payload, known_patterns=(
        "run_futu_daemon.py", "stock-monitor-moomoo-daemon", "stock_monitor_moomoo_daemon",
    ))


class MoomooDaemonSingletonLock(DaemonSingletonLock):
    def __init__(self, *, metadata: dict[str, Any] | None = None) -> None:
        state = daemon_state_dir()
        super().__init__(
            path=state / "moomoo_daemon.lock",
            metadata_path=state / "moomoo_daemon_owner.json",
            metadata=metadata,
            classify_owner=classify_owner,
            error_type=MoomooDaemonSingletonError,
            daemon_label="moomoo daemon",
            heartbeat_thread_name="MoomooDaemonSingletonHeartbeat",
            metadata_keys=("project_root",),
        )
