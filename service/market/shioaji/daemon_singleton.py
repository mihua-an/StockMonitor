from __future__ import annotations

from pathlib import Path
from typing import Any

from service.market.shared.daemon_state import daemon_state_dir
from service.market.shared.daemon_process_identity import classify_owner_metadata
from service.market.shared.daemon_singleton import DaemonSingletonLock, read_owner_metadata


class MarketDaemonSingletonError(RuntimeError):
    def __init__(self, message: str, *, classification: str = "LOCK_HELD", owner: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.classification = str(classification or "LOCK_HELD")
        self.owner = dict(owner or {})


def singleton_owner_metadata_path() -> Path:
    return daemon_state_dir() / "market_daemon_owner.json"


def read_singleton_owner_metadata(path: Path | None = None) -> dict[str, Any]:
    return read_owner_metadata(path or singleton_owner_metadata_path())


def classify_singleton_owner(owner: dict[str, Any] | None = None) -> str:
    payload = dict(owner or read_singleton_owner_metadata())
    return classify_owner_metadata(payload, known_patterns=(
        "run_shioaji_daemon.py", "stock-monitor-market-daemon", "stock_monitor_market_daemon",
    ))


class MarketDaemonSingletonLock(DaemonSingletonLock):
    """Cross-platform lifetime lock plus explicit owner metadata.

    The OS byte/flock remains the authority that prevents two broker owners. The
    metadata is diagnostic/recovery evidence only: it lets startup distinguish a
    live known daemon, a stale owner record, and an unknown process instead of
    collapsing every early child exit into generic LOCK_ERROR.
    """

    def __init__(
        self,
        path: Path | None = None,
        *,
        metadata: dict[str, Any] | None = None,
        metadata_path: Path | None = None,
    ) -> None:
        super().__init__(
            path=path or (daemon_state_dir() / "market_daemon.lock"),
            metadata_path=metadata_path or singleton_owner_metadata_path(),
            metadata=metadata,
            classify_owner=classify_singleton_owner,
            error_type=MarketDaemonSingletonError,
            daemon_label="market daemon",
            heartbeat_thread_name="MarketDaemonSingletonHeartbeat",
            metadata_keys=("project_root",),
        )
