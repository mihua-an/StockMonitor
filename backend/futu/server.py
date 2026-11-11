"""Futu daemon HTTP server: the composition root of the sole Futu runtime process owner.

``FutuDaemon`` owns this process's state -- the Futu runtime, the client-lease lifecycle, the shutdown state and
the server-exit callback -- and ``create_daemon_app`` builds the FastAPI app over one. The module builds exactly one
of each for run_futu_daemon.py; tests build their own.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import uuid
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any, Callable

from fastapi import FastAPI
from config.network_settings import NETWORK_REVISION
from service.market.shared.daemon_singleton import publish_lifecycle
from service.market.shared.dataflow_health import dataflow_health_ledger
from service.platform.daemon_auth import DaemonAuthenticationMiddleware, managed_by_health

from service.platform.http.errors import ServiceUnavailableError, logged_error, register_error_handlers
from service.platform.http.safe_json_response import SafeJSONResponse
from service.market.lifecycle.daemon import MarketDaemonLifecycleManager
from service.market.futu.daemon_contract import (
    MOOMOO_DAEMON_IDENTITY,
    MOOMOO_DAEMON_PROTOCOL_VERSION,
    MOOMOO_DAEMON_RUNTIME_VERSION,
)
from service.market.futu.daemon_settings import (
    MOOMOO_DAEMON_CLIENT_HEARTBEAT_SECONDS,
    MOOMOO_DAEMON_CLIENT_LEASE_SECONDS,
    MOOMOO_DAEMON_HOST,
    MOOMOO_DAEMON_IDLE_GRACE_SECONDS,
    MOOMOO_DAEMON_PORT,
)
from backend.futu.runtime import FutuRuntime
from backend.futu.routes import FutuRouteDependencies, create_futu_router
from backend.shared.client_lease_routes import create_client_lease_router

logger = logging.getLogger(__name__)


class FutuDaemon:
    def __init__(self, runtime: FutuRuntime, *, managed_by_health: bool = False) -> None:
        self.runtime = runtime
        # Under Health the provider keeps maintaining the background list with or without an attached client: only
        # Health decides its lifecycle (docs/system-architecture/00 section 3), so the idle timeout does not apply.
        self.managed_by_health = managed_by_health
        self.instance_id = uuid.uuid4().hex
        self.lifecycle = MarketDaemonLifecycleManager(
            idle_grace_seconds=MOOMOO_DAEMON_IDLE_GRACE_SECONDS,
            lease_timeout_seconds=MOOMOO_DAEMON_CLIENT_LEASE_SECONDS,
            client_heartbeat_seconds=MOOMOO_DAEMON_CLIENT_HEARTBEAT_SECONDS,
        )
        self.shutdown_lock = threading.RLock()
        self.shutdown_state: dict[str, Any] = {
            "stopping": False, "stopped": False, "reason": None, "started_at": None, "finished_at": None, "error": None,
        }
        self.shutdown_complete = threading.Event()
        self.server_exit_callback: Callable[[], None] | None = None
        self.idle_watchdog_thread: threading.Thread | None = None

    def request_server_exit(self) -> None:
        callback = self.server_exit_callback
        if callback is None:
            return
        try:
            callback()
        except Exception as exc:
            logger.error(f"[FUTU DAEMON] server exit callback failed: {exc}")

    def health(self) -> dict[str, Any]:
        lifecycle = self.lifecycle.status()
        service = self.runtime.status()
        worker_alive = bool(service.get("worker_alive"))
        lifecycle_state = str(lifecycle.get("state") or "STARTING")
        # `worker_alive` is the OpenD quote-polling thread: the daemon's work.
        sink = service.get("event_sink") if isinstance(service.get("event_sink"), dict) else {}
        ingress_accepting = bool(sink.get("accepting"))
        half_dead = bool(
            lifecycle_state not in {"STARTING", "STOPPING", "STOPPED"}
            and not worker_alive
        )
        runtime_state = "DAEMON_HALF_DEAD" if half_dead else lifecycle_state
        return {
            "ok": True,
                "identity": MOOMOO_DAEMON_IDENTITY,
            "daemon_instance_id": self.instance_id,
            "daemon_pid": os.getpid(),
            "protocol_version": MOOMOO_DAEMON_PROTOCOL_VERSION,
            "daemon_runtime_version": MOOMOO_DAEMON_RUNTIME_VERSION,
            "host": MOOMOO_DAEMON_HOST,
            "port": MOOMOO_DAEMON_PORT,
            # The network revision this daemon resolved its endpoint from: Health's applier requires it equal.
            "config_revision": NETWORK_REVISION,
            **lifecycle,
            "runtime_state": runtime_state,
            "half_dead": half_dead,
            "server_accepting_clients": bool(
                lifecycle_state not in {"STOPPING", "STOPPED"}
                and not self.shutdown_state.get("stopping")
            ),
            "source": "futu",
            "source_status": service.get("source_status"),
            "opend_connected": bool(service.get("connected")),
            # None until the first reachability probe runs; False specifically means
            # OpenD's port refused/timed out a plain TCP connect -- OpenD itself is
            # not running/listening, distinct from every other connection problem
            # (see service/market/futu/opend_lifecycle.py's _opend_port_reachable).
            "opend_reachable": service.get("opend_reachable"),
            "acquisition_mode": service.get("acquisition_mode") or "push",
            "focused_code": service.get("focused_code") or "",
            "last_push_at": service.get("last_push_at"),
            "context_generation": service.get("context_generation"),
            "worker_alive": worker_alive,
            # Same shape the Shioaji daemon publishes, so Health judges both sources on the one fact
            # that decides whether anything they admit can reach Market Runtime.
            "live_ingress": {
                "ready": ingress_accepting,
                "running": ingress_accepting,
                "accepting_hydration": ingress_accepting,
                "acked": sink.get("acked"),   # this source's own Market Runtime acknowledgements (連線診斷)
                # The sink's queue to Market Runtime (rust_live.py stats()), shown as 事件佇列 for both providers.
                "queue_depth": sink.get("queue_depth"), "capacity": sink.get("capacity"),
                "authority": {
                    "schema": "live-ingress-health-v1",
                    "authority": "RustDaemonEventSink",
                    "role": "FUTU_DAEMON_LIVE_INGRESS_HEALTH",
                    "live_state_authority": False,
                    "note": "Market Runtime (external process) is the sole live authority",
                },
            },
            "service": service,
            "last_error": (
                "DAEMON_HALF_DEAD: Futu OpenD worker is not alive while daemon server is alive"
                if half_dead else service.get("last_error")
            ),
            "server_time": datetime.now().astimezone().isoformat(timespec="seconds"),
        }

    def shutdown(self, reason: str, *, idle_claimed: bool = False) -> dict[str, Any]:
        reason = str(reason or "explicit_stop")
        with self.shutdown_lock:
            if self.shutdown_state.get("stopped"):
                return {"ok": True, **self.shutdown_state}
            if self.shutdown_state.get("stopping"):
                existing = True
            else:
                existing = False
                self.shutdown_state.update({
                    "stopping": True,
                    "reason": reason,
                    "started_at": datetime.now().isoformat(timespec="seconds"),
                    "error": None,
                })
                self.shutdown_complete.clear()
        if existing:
            self.shutdown_complete.wait(timeout=2.0)
            with self.shutdown_lock:
                return {"ok": bool(self.shutdown_state.get("stopped") and not self.shutdown_state.get("error")), **self.shutdown_state}

        try:
            if not idle_claimed:
                self.lifecycle.begin_stopping(reason)
            publish_lifecycle("STOPPING")
            logger.info(f"[FUTU DAEMON] graceful stop reason={reason}")
            # 5 s, not 1.5: callbacks already admitted get time to reach the Rust sink before the stop is judged.
            # An incomplete stop is reported, never claimed as stopped.
            service_result = self.runtime.stop(timeout=5.0)
            if not service_result.get("ok"):
                raise RuntimeError(str(service_result.get("error") or "Futu service stop incomplete"))
            self.lifecycle.mark_stopped(reason)
            with self.shutdown_lock:
                self.shutdown_state.update({
                    "stopping": False,
                    "stopped": True,
                    "finished_at": datetime.now().isoformat(timespec="seconds"),
                    "service": service_result,
                })
            logger.info("[FUTU DAEMON] stopped")
            return {"ok": True, **self.shutdown_state}
        except Exception as exc:
            with self.shutdown_lock:
                self.shutdown_state.update({
                    "stopping": False,
                    "stopped": False,
                    "error": logged_error("futu daemon shutdown", exc, log=logger),
                    "finished_at": datetime.now().isoformat(timespec="seconds"),
                })
            return {"ok": False, **self.shutdown_state}
        finally:
            with self.shutdown_lock:
                stopped = bool(self.shutdown_state.get("stopped"))
            if stopped:
                self._close_master_streams()
            self.shutdown_complete.set()

    def _close_master_streams(self) -> None:
        # The open security-master streams (app_api) end only once the stop succeeded and the process exits (the
        # server must not wait on them); a failed stop leaves a live daemon whose stream still works.
        from service.market.reference import security_master_feed

        try:
            security_master_feed.FEED.close()
        except Exception as exc:  # noqa: BLE001 -- recorded in the stop's state; the stop itself finished
            with self.shutdown_lock:
                self.shutdown_state["stream_close_error"] = logged_error("futu daemon closing the security-master streams",
                                                                         exc, log=logger)

    def idle_watchdog(self) -> None:
        last_state = ""
        while True:
            with self.shutdown_lock:
                if self.shutdown_state.get("stopped") or self.shutdown_state.get("stopping"):
                    return
            self.lifecycle.expire_leases()
            status = self.lifecycle.status()
            state = str(status.get("state") or "")
            if state != last_state:
                if state == "IDLE_GRACE":
                    logger.info(
                        f"[FUTU DAEMON] entering idle grace timeout={status.get('idle_timeout_seconds')}s"
                    )
                last_state = state
            generation = int(status.get("idle_generation") or 0)
            # Under Health the provider keeps maintaining the background list with or without an attached client:
            # only Health decides its lifecycle (docs/system-architecture/00 section 3).
            if not self.managed_by_health and self.lifecycle.claim_idle_timeout(expected_generation=generation):
                logger.info("[FUTU DAEMON] idle timeout reached; graceful shutdown")
                self.shutdown("idle_timeout", idle_claimed=True)
                self.request_server_exit()
                return
            self.lifecycle.wait_for_change(1.0)

    def stop_account(self) -> dict[str, Any]:
        """This daemon's own verdict on its stop, for the owner's stop receipt."""
        with self.shutdown_lock:
            state = dict(self.shutdown_state)
        clean = bool(state.get("stopped") and not state.get("error"))
        return {"clean": clean, "reason": state.get("reason"), "error": state.get("error") or (None if clean else "the stop did not finish")}


def create_daemon_app(daemon: FutuDaemon) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        dataflow_health_ledger.set_component_state(lifecycle="STARTING")
        daemon.runtime.start()
        daemon.idle_watchdog_thread = threading.Thread(target=daemon.idle_watchdog, name="FutuDaemonIdleWatchdog", daemon=True)
        daemon.idle_watchdog_thread.start()
        logger.info(f"[FUTU DAEMON] started instance={daemon.instance_id} port={MOOMOO_DAEMON_PORT} mode=push")
        dataflow_health_ledger.set_component_state(lifecycle="RUNNING")
        try:
            yield
        finally:
            dataflow_health_ledger.set_component_state(lifecycle="STOPPING")
            with daemon.shutdown_lock:
                already_stopped = bool(daemon.shutdown_state.get("stopped"))
            if not already_stopped:
                await asyncio.to_thread(daemon.shutdown, "server_shutdown")
            watchdog = daemon.idle_watchdog_thread
            if watchdog is not None and watchdog is not threading.current_thread():
                await asyncio.to_thread(watchdog.join, 2.0)
                if watchdog.is_alive():
                    logger.warning("[Shutdown][TIMEOUT] Futu idle watchdog did not stop within 2s")
            daemon.idle_watchdog_thread = None
            dataflow_health_ledger.set_component_state(lifecycle="STOPPED")

    api = FastAPI(title="Stock Monitor Futu Daemon", lifespan=lifespan, default_response_class=SafeJSONResponse)
    api.add_middleware(DaemonAuthenticationMiddleware)
    register_error_handlers(api)

    @api.get("/health")
    def health():
        return daemon.health()

    @api.post("/v1/control/stop")
    async def stop_daemon(reason: str = "explicit_stop"):
        result = await asyncio.to_thread(daemon.shutdown, reason)
        if not result.get("ok"):
            # FutuDaemon.shutdown's dict-return contract stays for its internal callers (the idle watchdog, the
            # lifespan's finally); only this HTTP endpoint turns a failed stop into an error status.
            raise ServiceUnavailableError(
                str(result.get("error") or "Futu daemon stop failed"),
                classification="FUTU_DAEMON_STOP_FAILED",
            )
        asyncio.get_running_loop().call_later(0.20, daemon.request_server_exit)
        return {**result, "server_exit_requested": daemon.server_exit_callback is not None}

    # The client-lease routes (shared with the Shioaji daemon) and this daemon's own routes (backend/futu/routes.py).
    api.include_router(create_client_lease_router(label="FUTU DAEMON", daemon_instance_id=daemon.instance_id,
                                                  lifecycle_provider=lambda: daemon.lifecycle))
    api.include_router(create_futu_router(FutuRouteDependencies(runtime=daemon.runtime, daemon_health=daemon.health)))
    return api


# The process's one daemon and app. run_futu_daemon.py serves `api` and reads `futu_daemon`.
futu_daemon = FutuDaemon(FutuRuntime(), managed_by_health=managed_by_health())
api = create_daemon_app(futu_daemon)
