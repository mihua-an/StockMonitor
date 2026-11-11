"""Daemon-owned Futu composition. Importing this module never loads a broker."""

from __future__ import annotations

import threading
from config.source_settings import source_enabled
from service.market.shared.source_runtime import disabled_source
from service.market.shared.source_runtime import source_status
from typing import Any, Callable, TYPE_CHECKING

if TYPE_CHECKING:
    from service.market.futu.service import FutuMarketService


class FutuRuntime:
    """Own one OpenD service; the daemon still owns leases and recovery policy.

    Construction and status before start are passive. The launcher must select
    its process-local native package before start imports the service graph.
    """

    source = "futu"

    def __init__(self, *, service_factory: Callable[[], Any] | None = None) -> None:
        self._service: FutuMarketService | None = None
        self._service_factory = service_factory
        self._lock = threading.RLock()
        self._started = False
        self._stopped = False
        self._stop_result: dict[str, Any] | None = None
        self._lifecycle = "stopped"
        self._last_error = None

    @property
    def service(self) -> FutuMarketService:
        if self._service is None:
            raise RuntimeError("FutuRuntime.start() must be called by the daemon before service access")
        return self._service

    @property
    def product_catalog(self):
        return self.service.product_catalog

    def start(self) -> dict[str, Any]:
        if not source_enabled(self.source):
            return disabled_source(self.source)
        with self._lock:
            if self._stopped and not (self._stop_result or {}).get("ok"):
                return {"ok": False, "source": self.source, "accepted": False,
                        "lifecycle": self._lifecycle,
                        "error": "runtime stop incomplete; daemon recovery required",
                        "source_status": self.status()["source_status"]}
            if self._started:
                return {"ok": True, "source": self.source, "accepted": True, "already_started": True, "source_status": self.status()["source_status"]}
            self._stopped = False
            self._stop_result = None
            self._lifecycle = "starting"
            self._last_error = None
            try:
                if self._service is None:
                    if self._service_factory is None:
                        from service.market.futu.service import FutuMarketService
                        self._service = FutuMarketService()
                    else:
                        self._service = self._service_factory()
                self.service.start()
                self._started = True
                self._lifecycle = "started"
            except Exception as exc:
                from service.platform.http.errors import logged_error
                self._last_error = logged_error("futu runtime start", exc)
                self.stop()
                if self._lifecycle != "stop_failed":
                    self._lifecycle = "start_failed"
                raise
            return {"ok": True, "source": self.source, "accepted": True, "started": True, "source_status": self.status()["source_status"]}

    def stop(self, *, timeout: float = 25.0) -> dict[str, Any]:
        with self._lock:
            if self._stop_result is not None and self._stop_result.get("ok"):
                return dict(self._stop_result)
            self._stopped = True
            self._started = False
            self._lifecycle = "stopping"
            try:
                result = self.service.stop(timeout=timeout) if self._service is not None else {"ok": True, "not_started": True}
            except Exception as exc:
                from service.platform.http.errors import logged_error
                result = {"ok": False, "error": logged_error("futu runtime stop", exc)}
            self._lifecycle = "stopped" if result.get("ok") else "stop_failed"
            if not result.get("ok"):
                self._last_error = str(result.get("error") or "service shutdown incomplete")
            provider = self._service.status() if self._service is not None else {}
            self._stop_result = {**result, "source": self.source, "lifecycle": self._lifecycle,
                                 "source_status": source_status(self.source, self._lifecycle, provider,
                                                                services_started=False, error=self._last_error)}
            return dict(self._stop_result)

    def status(self) -> dict[str, Any]:
        if not source_enabled(self.source):
            return disabled_source(self.source)
        # Preserve the service status fields used by /health and /api/futu/*.
        status = self.service.status() if self._service is not None else {
            "provider": self.source, "connected": False, "worker_alive": False,
        }
        return {
            **status, "source": self.source,
            "source_status": source_status(self.source, self._lifecycle, status, services_started=self._started, error=self._last_error),
            "running": bool(status.get("worker_alive") and status.get("connected") and not self._stopped),
        }
