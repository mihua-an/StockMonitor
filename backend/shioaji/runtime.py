from __future__ import annotations
import logging

import threading
import time
from config.source_settings import source_enabled
from service.market.shared.source_runtime import disabled_source
from service.market.shared.source_runtime import source_status
from datetime import datetime
from typing import Any, Callable, TYPE_CHECKING

if TYPE_CHECKING:
    from service.market.shioaji.service import ShioajiMarketService
from service.monitoring.runtime_profiler import runtime_profiler
from service.market.shared.startup_realtime_diagnostic import startup_realtime_diagnostic
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)


class ShioajiRuntime:
    """Own the Shioaji service graph and its maintenance heartbeat.

    Leases, canonical/session ownership and recovery remain daemon concerns.
    Heavy services are imported and assembled only in the owner thread.
    """

    source = "shioaji"

    def __init__(self, credential_service: Any | None = None, *, service_factory: Callable[..., Any] | None = None) -> None:
        self.service: "ShioajiMarketService | None" = None
        # Called with the built service graph BEFORE it starts (broker login, the first callbacks): the owner of the
        # market-session generation installs its listener here, so no event can precede it.
        self.on_service_built: Callable[[Any], None] | None = None
        self._service_factory = service_factory
        self.thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._lock = threading.RLock()
        self._defer_broker_logout = False
        # stop()'s deadline (time.monotonic()), which the service's own shutdown steps share; None until a stop.
        self._stop_deadline: float | None = None
        self.credential_service = credential_service
        self.started_at: str | None = None
        self.last_error: str | None = None
        self.last_result: dict[str, Any] | None = None
        self._lifecycle = "stopped"
        self._services_started = False
        self._shutdown_lock = threading.Lock()
        self._shutdown_launch_lock = threading.Lock()
        self._shutdown_result = None
        self._shutdown_worker = None

    @property
    def app(self):
        """Service graph access used by daemon route adapters."""
        return self.service

    def start(self) -> dict[str, Any]:
        if not source_enabled(self.source):
            return disabled_source(self.source)
        with self._lock:
            if self._lifecycle in {"stopping", "stop_failed"}:
                return {"ok": False, "source": self.source, "accepted": False, "error": "runtime stop incomplete; daemon recovery required", "lifecycle": self._lifecycle}
            if self.thread and self.thread.is_alive():
                return {"ok": True, "source": self.source, "accepted": True, "already_started": True, "running": self.running}
            self.service = None
            self._shutdown_result = None
            self._shutdown_worker = None
            self._lifecycle = "starting"
            self._services_started = False
            self._stop_event.clear()
            self._defer_broker_logout = False
            self._stop_deadline = None
            self.started_at = datetime.now().isoformat(timespec="seconds")
            self.last_error = None
            self.thread = threading.Thread(target=self._run_loop, name="ShioajiRuntimeOwner", daemon=True)
            try:
                self.thread.start()
            except Exception as exc:
                from service.platform.http.errors import logged_error
                self.last_error = logged_error("shioaji runtime thread start", exc)
                self._lifecycle = "start_failed"
                raise
        return {"ok": True, "source": self.source, "accepted": True, "message": "Shioaji daemon 已受理啟動", "running": False, "started_at": self.started_at, "source_status": self.status()["source_status"]}

    @property
    def running(self) -> bool:
        return bool(self.thread and self.thread.is_alive() and not self._stop_event.is_set())

    def _shutdown_once(self) -> dict[str, Any]:
        with self._shutdown_lock:
            if self._shutdown_result is None and self.service is not None:
                try:
                    self._shutdown_result = self.service.shutdown_background_processing(
                        defer_broker_logout=self._defer_broker_logout, deadline=self._stop_deadline)
                except Exception as exc:
                    from service.platform.http.errors import logged_error
                    self._shutdown_result = {"ok": False, "error": logged_error("shioaji runtime shutdown", exc)}
            return self._shutdown_result or {"ok": True, "not_started": True}

    def stop(self, *, wait: bool = True, timeout: float = 25.0, defer_broker_logout: bool = False) -> dict[str, Any]:
        deadline = time.monotonic() + max(0.0, timeout)
        # Cancellation must be visible during slow service assembly/start.
        self._defer_broker_logout = self._defer_broker_logout or defer_broker_logout
        self._stop_deadline = deadline
        self._stop_event.set()
        if self._lifecycle != "stop_failed":
            self._lifecycle = "stopping"

        def teardown():
            # Serialise against service.start; exactly one cleanup per graph.
            with self._lock:
                self._shutdown_once()

        # A separate gate permits stop during start without blocking the caller.
        with self._shutdown_launch_lock:
            if self.service is not None and self._shutdown_worker is None:
                self._shutdown_worker = threading.Thread(target=teardown, name="ShioajiRuntimeShutdown", daemon=True)
                self._shutdown_worker.start()
        if wait:
            for worker in (self._shutdown_worker, self.thread):
                if worker is not None and worker is not threading.current_thread():
                    worker.join(max(0.0, deadline - time.monotonic()))
        alive = bool(self.thread and self.thread.is_alive())
        cleaning = bool(self._shutdown_worker and self._shutdown_worker.is_alive())
        result = self._shutdown_result or {"ok": True, "not_started": self.service is None}
        ok = not alive and not cleaning and bool(result.get("ok"))
        if ok:
            self._lifecycle = "stopped"
        elif wait or not result.get("ok"):
            self._lifecycle = "stop_failed"
            self.last_error = str(result.get("error") or "runtime shutdown incomplete or timed out")
        provider = self.status().get("provider_status") or {}
        return {"ok": ok, "source": self.source, "accepted": True,
                "lifecycle": self._lifecycle, "running": self.running,
                "thread_alive": alive, "shutdown": result,
                "source_status": source_status(self.source, self._lifecycle, provider,
                                               services_started=False, error=self.last_error)}

    def finalize_broker_logout(self, *, busy: tuple[str, ...] | list[str] = ()) -> dict[str, Any]:
        app = self.service
        if app is None:
            return {"ok": True, "logged_out": False, "not_started": True}
        # The service's own shutdown runs on the shutdown worker (holding the service's shutdown lock): while it has
        # not finished, its verdict on the broker's workers does not exist yet, so nothing is logged out under them.
        if self._shutdown_worker is not None and self._shutdown_worker.is_alive():
            reason = "the runtime's shutdown is still running"
            _failure_log.warning(f"[Shutdown] Shioaji logout skipped: {reason}")
            return {"ok": False, "logged_out": False, "skipped": reason}
        return app.finalize_broker_logout(busy=busy)

    def lightweight_source_status(self) -> dict[str, Any]:
        """The same source_status() verdict status() gives, from the lock-light broker view.

        The passive DataFlow snapshot -- the only thing FastAPI's cached_health() and so
        /api/status are built from -- must carry it; it cannot call status(), whose full
        broker_service.status() walks subscriptions under locks. Without it /api/status fell back
        to a placeholder "starting / DAEMON_STATUS_UNAVAILABLE" while ticks were flowing.
        """
        if not source_enabled(self.source):
            return disabled_source(self.source)["source_status"]
        provider: dict[str, Any] = {}
        if self.service is not None:
            try:
                provider = dict(self.service.broker_service.lightweight_status())
                sink = getattr(self.service, "live_event_sink", None)
                if sink is not None:
                    provider["readiness"] = {**(provider.get("readiness") or {}),
                                             "canonical_ready": bool(sink.health().get("running"))}
            except Exception as exc:
                record_failure(_failure_log, "reading the Shioaji provider status", exc)
                provider = {}
        return source_status(self.source, self._lifecycle, provider,
                             services_started=self._services_started, error=self.last_error)

    def status(self) -> dict[str, Any]:
        if not source_enabled(self.source):
            return disabled_source(self.source)
        alive = bool(self.thread and self.thread.is_alive())
        connected = False
        provider = {}
        if self.service is not None:
            try:
                provider = self.service.broker_service.status()
                connected = bool(provider.get("connected"))
                sink = getattr(self.service, "live_event_sink", None)
                if sink is not None:
                    provider = {**provider, "readiness": {**(provider.get("readiness") or {}),
                        "canonical_ready": bool(sink.health().get("running"))}}
            except Exception as exc:
                record_failure(_failure_log, "reading the Shioaji connection state", exc)
                connected = False
        state = "running" if alive and connected and not self._stop_event.is_set() else ("standby" if alive and not self._stop_event.is_set() else "need_restart")
        return {
            "ok": True,
            "source": self.source,
            "source_status": source_status(self.source, self._lifecycle, provider, services_started=self._services_started, error=self.last_error),
            "provider_status": provider,
            "connected": connected,
            "owner": "persistent_market_daemon",
            "thread_alive": alive,
            "monitor_state": state,
            "monitor_state_text": {"running": "運行中", "standby": "等待永豐連線", "need_restart": "需重啟"}[state],
            "running": state == "running",
            "need_restart": state == "need_restart",
            "last_result": self.last_result,
            "last_error": self.last_error,
        }

    def _run_loop(self) -> None:
        try:
            # Daemon-only imports stay out of the FastAPI client process import
            # graph.  ShioajiMarketService pulls market/storage/pandas modules that the
            # FastAPI control plane does not need before port 8000 is ready.
            factory = self._service_factory
            service_kwargs = {"credential_service": self.credential_service}
            if factory is None:
                from service.market.shioaji.service import ShioajiMarketService
                from service.market.storage.market_storage_layout import require_market_storage_ready
                require_market_storage_ready()
                factory = ShioajiMarketService
            started = time.perf_counter_ns()
            service = factory(**service_kwargs)
            # Serialise publication/start with stop so teardown cannot race a
            # broker start, including a stop requested during slow assembly.
            with self._lock:
                self.service = service
                if self._stop_event.is_set():
                    return
                if self.on_service_built is not None:
                    self.on_service_built(service)
                service.start()
                self._services_started = True
                if not self._stop_event.is_set():
                    self._lifecycle = "started"
            runtime_profiler.observe_ns("monitor_runtime_init", started)
            runtime_profiler.startup_mark("monitor_runtime_ready")
            startup_realtime_diagnostic.mark(
                "DAEMON_RUNTIME_ACTIVE",
                detail={"runtime": "ShioajiMarketService", "thread": "ShioajiRuntimeOwner"},
                once=True,
            )
            while not self._stop_event.wait(1.0):
                try:
                    self.last_result = self.service.run_once()
                    self.last_error = None
                except Exception as exc:
                    from service.platform.http.errors import logged_error
                    self.last_error = logged_error("shioaji runtime heartbeat", exc)
        except Exception as exc:
            from service.platform.http.errors import logged_error
            self.last_error = logged_error("shioaji runtime start", exc)
            self._lifecycle = "start_failed"
        finally:
            result = self._shutdown_once()
            self._services_started = False
            if not result.get("ok"):
                self._lifecycle = "stop_failed"
                self.last_error = str(result.get("error") or "runtime shutdown incomplete")
            elif self._lifecycle not in {"start_failed", "stop_failed"}:
                self._lifecycle = "stopped"
            self._stop_event.set()
            print("[SHIOAJI RUNTIME] stopped")


