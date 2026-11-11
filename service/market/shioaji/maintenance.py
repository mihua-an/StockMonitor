"""Background market metadata maintenance."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from threading import Lock, RLock, Thread
from typing import Any

from service.market.reference.security_master_service import SecurityMasterService
from service.market.storage.market_storage_layout import process_market_layout

logger = logging.getLogger(__name__)


class MarketMaintenanceCoordinator:
    """Coordinate broker-backed security-master refreshes without blocking ingest."""

    def __init__(self, *, retry_backoff: timedelta = timedelta(minutes=30)) -> None:
        self._lock = RLock()
        # One writer of the security master at a time (the file is replaced whole; two writes at once collide).
        self._write_lock = Lock()
        self._active_thread: Thread | None = None
        self._current_day = ""
        self._last_attempt_at: datetime | None = None
        self._retry_backoff = retry_backoff
        self._accepting = True
        # The last refresh's outcome is the artifact's stated state, and a failed day is one
        # recorded refetch until a refresh succeeds.
        self._last_result: dict[str, Any] | None = None
        from service.platform.remediation import Recovery

        self._recovery = Recovery(component="security_master", mechanism_id="provider.metadata_refetch")

    def refresh_connected(self, api: Any, *, day: str | None = None) -> dict[str, Any]:
        """Rewrite the security master from the broker's contracts now (an explicit refresh, the daily one)."""
        with self._write_lock:
            return self._refresh(api, day or datetime.now().strftime("%Y-%m-%d"))

    def ensure_current(self, api: Any, *, day: str | None = None) -> dict[str, Any]:
        """The security master is today's: written once per day, whoever asks first (the login, the desktop's
        start). A caller that comes while it is being written waits for that write instead of starting a second."""
        day = day or datetime.now().strftime("%Y-%m-%d")
        with self._write_lock:
            with self._lock:
                current = self._current_day == day
            if not current:
                return self._refresh(api, day)
            service = SecurityMasterService(process_market_layout().shioaji_security_master)
            return {"ok": True, "current": True, "day": day, "count": len(service.load_master()), "file": str(service.master_file)}

    def _refresh(self, api: Any, day: str) -> dict[str, Any]:
        from service.market.reference import futures_contracts

        # The futures contract table first: the master's write notice (security_master_feed) is what brings the
        # background list's futures months up to date, and it must read today's table.
        futures = futures_contracts.update_from_api(api)
        result = SecurityMasterService(process_market_layout().shioaji_security_master, api_provider=lambda: api).update_master(api)
        result = {**result, "futures_contracts": futures}
        if not futures.get("ok"):
            # Recorded; the table on disk stays (its months until the next day's refresh), and the master's day is
            # its own: one listing that failed does not write the master again.
            logger.error("[SHIOAJI CONTRACTS] futures contract table not written: %s", futures.get("error"))
        if result.get("ok"):
            with self._lock:
                self._current_day = day
        return result

    def schedule_daily(self, *, now: datetime, connected: bool, api: Any | None) -> dict[str, Any]:
        day = now.strftime("%Y-%m-%d")
        if not connected:
            return {"scheduled": False, "reason": "shioaji_not_connected", "day": day}
        with self._lock:
            if not self._accepting:
                return {"scheduled": False, "reason": "shutting_down", "day": day}
            if self._current_day == day:
                return {"scheduled": False, "reason": "already_current", "day": day}
            if self._active_thread is not None and self._active_thread.is_alive():
                return {"scheduled": False, "reason": "already_running", "day": day}
            if self._last_attempt_at is not None and now - self._last_attempt_at < self._retry_backoff:
                return {"scheduled": False, "reason": "retry_backoff", "day": day}
            if api is None:
                return {"scheduled": False, "reason": "api_unavailable", "day": day}
            self._last_attempt_at = now

            def refresh() -> None:
                try:
                    result = self.refresh_connected(api, day=day)
                except Exception as exc:  # noqa: BLE001 -- the outcome is recorded, not lost in a thread
                    result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:300]}
                with self._lock:
                    self._last_result = {"ok": bool(result.get("ok")), "day": day, "count": result.get("count", 0),
                                         "error": result.get("error"), "at": datetime.now().isoformat(timespec="seconds")}
                if result.get("ok"):
                    self._recovery.finish("succeeded", detail={"day": day, "rows": result.get("count", 0)})
                else:
                    self._recovery.failed("security_master_failed", detail={"day": day, "error": str(result.get("error") or "")[:300],
                                                                            "retry_seconds": self._retry_backoff.total_seconds()})
                logger.info(
                    f"[SHIOAJI CONTRACTS] daily security master ok={bool(result.get('ok'))} "
                    f"rows={result.get('count', 0)} day={day}"
                )

            self._active_thread = Thread(
                target=refresh, name="TaiwanSecurityMasterDailyRefresh", daemon=True
            )
            self._active_thread.start()
        return {"scheduled": True, "day": day}

    def shutdown(self, timeout: float = 5.0) -> dict[str, Any]:
        """Stop scheduling refreshes and wait (bounded) for one in flight: it must not keep calling the broker or
        writing the security master after logout."""
        with self._lock:
            self._accepting = False
            thread = self._active_thread
        if thread is not None and thread.is_alive():
            thread.join(max(0.0, float(timeout)))
        running = bool(thread is not None and thread.is_alive())
        return {"ok": not running, "running": running}

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "current_day": self._current_day,
                "running": bool(self._active_thread and self._active_thread.is_alive()),
                "last_attempt_at": self._last_attempt_at.isoformat() if self._last_attempt_at else None,
                "last_result": dict(self._last_result) if self._last_result else None,
                "refetch_open": self._recovery.open,
            }
