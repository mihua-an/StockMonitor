"""The Shioaji daemon's state, owned in one place.

``DaemonContext`` holds what this process owns: the Shioaji runtime, the attach/control hub, the client-lease
lifecycle, the shutdown state, the session-rollover owner, the historical route-work pool and the load-test
universe. ``backend.shioaji.server`` builds exactly one (the composition root); the health projection
(``daemon_health.py``), the stop (``daemon_shutdown.py``) and every route family receive it, or callables bound to
it, explicitly -- never a module global they look up by name.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

from backend.shioaji.runtime import ShioajiRuntime
from backend.shioaji.stream_hub import DaemonStreamHub
from service.market.history.historical_work_coordinator import HistoricalWorkCoordinator, HistoricalWorkRejected
from service.market.lifecycle.daemon import MarketDaemonLifecycleManager
from service.market.lifecycle.rollover import SessionOrchestrator
from service.market.shared.daemon_shutdown_state import DaemonShutdownState
from service.market.shioaji.daemon_settings import (
    MARKET_DAEMON_CLIENT_HEARTBEAT_SECONDS,
    MARKET_DAEMON_CLIENT_LEASE_SECONDS,
    MARKET_DAEMON_IDLE_GRACE_SECONDS,
)
from service.market.storage.market_storage_layout import process_market_layout
from service.platform.daemon_auth import managed_by_health
from service.platform.failure_record import record_failure

logger = logging.getLogger(__name__)

_ROUTE_WORK_NOT_STARTED = {
    "started": 0, "active": 0, "queued": 0, "inflight": 0, "accepting": False,
    "worker_count": 0, "worker_threads_alive": 0, "state": "NOT_STARTED",
}


def safe_call(default: Any, func: Callable[[], Any]) -> Any:
    """A diagnostic read that fails is recorded and answered with ``default``."""
    try:
        return func()
    except Exception as exc:
        record_failure(logger, "a diagnostic read for the daemon status", exc)
        return default


@dataclass
class DaemonContext:
    runtime: Any
    hub: Any
    lifecycle: Any
    shutdown: DaemonShutdownState
    instance_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    # Under Health the provider keeps maintaining the background list with or without an attached client: only
    # Health decides its lifecycle (docs/system-architecture/00 section 3), so the idle timeout does not apply.
    managed_by_health: bool = False
    session_rollover_coordinator: SessionOrchestrator | None = None
    route_work: HistoricalWorkCoordinator | None = None
    server_exit_callback: Callable[[], Any] | None = None
    idle_watchdog_thread: threading.Thread | None = None
    route_work_lock: threading.RLock = field(default_factory=threading.RLock)
    _data_center: dict[int, Any] = field(default_factory=dict)

    # -- the running market service ---------------------------------------------------------------------------------
    def app(self) -> Any:
        return self.runtime.service

    def session_rollover(self) -> SessionOrchestrator:
        if self.session_rollover_coordinator is None:
            self.session_rollover_coordinator = SessionOrchestrator(
                app_provider=self.app,
                manifest_dir=process_market_layout().session_finalization,
                wal_retention=True,
                fill_gaps=True,
            )
        return self.session_rollover_coordinator

    def data_center_service(self) -> Any:
        """資料中心 answers from the Rust historical store only; one service per store (its catalog caches)."""
        from service.market.query.data_center_service import DataCenterService

        app = self.app()
        historical = getattr(getattr(app, "historical_repository", None), "historical", None) if app is not None else None
        if historical is None:
            raise RuntimeError("historical store not ready")
        key = id(historical)
        service = self._data_center.get(key)
        if service is None:
            from service.market.query.historical_catalog import HistoricalEvidenceCatalog
            service = DataCenterService(HistoricalEvidenceCatalog(historical))
            self._data_center.clear()
            self._data_center[key] = service
        return service

    # -- server exit ------------------------------------------------------------------------------------------------
    def request_server_exit(self) -> bool:
        callback = self.server_exit_callback
        if callback is None:
            return False
        try:
            callback()
            return True
        except Exception as exc:
            logger.error(f"[SHIOAJI DAEMON] server exit callback failed: {exc}")
            return False

    # -- historical route work --------------------------------------------------------------------------------------
    def start_route_work(self) -> HistoricalWorkCoordinator:
        """The daemon-owned history workers exist only during the ASGI lifespan."""
        with self.route_work_lock:
            if self.route_work is None:
                self.route_work = HistoricalWorkCoordinator(name="CanonicalHistoryRoute", max_workers=2, queue_size=64)
            return self.route_work

    def route_work_metrics(self) -> dict[str, Any]:
        coordinator = self.route_work
        return dict(_ROUTE_WORK_NOT_STARTED) if coordinator is None else coordinator.metrics()

    @staticmethod
    def route_key(name: str, *parts: Any) -> str:
        return ":".join([str(name)] + [str(part or "") for part in parts])

    async def await_route_work(self, key: str, func: Callable[[], Any], *, timeout: float = 45.0) -> Any:
        """Expensive history work runs on the route-work pool, outside AnyIO's request worker pool."""
        if self.shutdown.state.get("stopping"):
            raise HistoricalWorkRejected("DAEMON_STOPPING: historical route work is frozen")
        coordinator = self.route_work
        if coordinator is None:
            raise HistoricalWorkRejected("DAEMON_NOT_STARTED: historical route work is unavailable")
        wrapped = asyncio.wrap_future(coordinator.submit(key, func))
        try:
            return await asyncio.wait_for(asyncio.shield(wrapped), timeout=max(0.1, float(timeout)))
        except asyncio.TimeoutError as exc:
            raise TimeoutError(f"historical route timed out: {key}") from exc


def create_daemon_context(*, runtime: Any = None, env: dict[str, str] | None = None) -> DaemonContext:
    """The process's one context; ``runtime`` is given only by tests that stand in for the Shioaji runtime."""
    env = os.environ if env is None else env
    return DaemonContext(
        runtime=runtime if runtime is not None else ShioajiRuntime(),
        # Market Runtime (market_runtime_daemon.exe) is the only live market authority: this process keeps no
        # canonical view of its own; the hub is only the attach/control channel.
        hub=DaemonStreamHub(),
        lifecycle=MarketDaemonLifecycleManager(
            idle_grace_seconds=MARKET_DAEMON_IDLE_GRACE_SECONDS,
            lease_timeout_seconds=MARKET_DAEMON_CLIENT_LEASE_SECONDS,
            client_heartbeat_seconds=MARKET_DAEMON_CLIENT_HEARTBEAT_SECONDS,
        ),
        shutdown=DaemonShutdownState(),
        managed_by_health=managed_by_health(env),
    )
