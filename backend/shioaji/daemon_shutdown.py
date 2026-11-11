"""The Shioaji daemon's stop: one ordered, recorded shutdown of everything its DaemonContext owns, the idle
watchdog that may start it, and the daemon's own verdict on it (stop_account)."""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime
from typing import Any

from backend.shioaji.daemon_context import DaemonContext
from service.market.shared.daemon_singleton import publish_lifecycle
from service.platform.http.errors import logged_error

logger = logging.getLogger(__name__)


def record_shutdown_phase(ctx: DaemonContext, name: str, func=None) -> Any:
    phase = {
        "phase": str(name),
        "started_at": datetime.now().isoformat(timespec="milliseconds"),
        "finished_at": None,
        "duration_ms": None,
        "pending_jobs": None,
        "active_threads": threading.active_count(),
        "error": None,
    }
    started = time.perf_counter()
    with ctx.shutdown.lock:
        ctx.shutdown.state.setdefault("phases", []).append(phase)
    try:
        result = func() if func is not None else None
        return result
    except Exception as exc:
        phase["error"] = logged_error(f"shioaji daemon shutdown phase {phase.get('phase')}", exc, log=logger)
        raise
    finally:
        phase["finished_at"] = datetime.now().isoformat(timespec="milliseconds")
        phase["duration_ms"] = round((time.perf_counter() - started) * 1000.0, 3)
        route = ctx.route_work_metrics()
        # M8/M9: canonical/ retired -- it ran no hydration/snapshot work to
        # wait on during shutdown even before removal (unfed since this
        # session's earlier closure), so these are now fixed at 0.
        phase["pending_jobs"] = {
            "route": int(route.get("active") or 0) + int(route.get("queued") or 0),
            "hydration": 0,
            "snapshot": 0,
        }
        phase["active_threads"] = threading.active_count()


def shutdown_daemon(ctx: DaemonContext, reason: str, *, idle_claimed: bool = False) -> dict[str, Any]:
    reason = str(reason or "explicit_stop")
    wait_for_existing, existing_reason = ctx.shutdown.begin(reason)
    with ctx.shutdown.lock:
        if ctx.shutdown.state.get("stopped"):
            return {"ok": True, **ctx.shutdown.state}
    if wait_for_existing:
        completed = ctx.shutdown.complete_event.wait(timeout=70.0)
        with ctx.shutdown.lock:
            return {
                "ok": bool(completed and ctx.shutdown.state.get("stopped") and not ctx.shutdown.state.get("error")),
                "waited_for_existing_shutdown": True,
                "existing_reason": existing_reason,
                **ctx.shutdown.state,
            }
    if not idle_claimed:
        ctx.lifecycle.begin_stopping(reason)
    publish_lifecycle("STOPPING")
    record_shutdown_phase(ctx, "STOP_REQUESTED")
    logger.info(f"[SHIOAJI DAEMON] graceful stop reason={reason}")
    # STOPPING rejects new clients through the lifecycle gates below. Do not ask
    # Uvicorn to exit before Raw durability has been proven: a busy recorder may
    # need longer than one HTTP health interval to drain its accepted FIFO.
    try:
        app = ctx.app()
        if ctx.session_rollover_coordinator is not None:
            record_shutdown_phase(ctx, "STOP_SESSION_ROLLOVER", lambda: ctx.session_rollover_coordinator.stop(timeout=3.0))

        def _freeze() -> dict[str, Any]:
            route = (
                ctx.route_work.freeze_new_work(cancel_queued=True)
                if ctx.route_work is not None
                else {"not_started": True, **ctx.route_work_metrics()}
            )
            # M8/M9: canonical/ retired -- nothing to freeze there anymore.
            history = app.historical_repository.freeze_historical_work() if app is not None else {}
            return {"route": route, "history": history}

        freeze_result = record_shutdown_phase(ctx, "FREEZE_NEW_WORK", _freeze)
        record_shutdown_phase(ctx, "CANCEL_QUEUED_HYDRATION")

        def _wait_hydration() -> dict[str, Any]:
            # Rebuildable history work is abandoned/background-repaired. It is
            # never part of the live daemon's bounded shutdown barrier.
            route_idle = ctx.route_work.wait_for_idle(0.1) if ctx.route_work is not None else True
            canonical_idle = True
            history_idle = True
            return {"route_idle": route_idle, "canonical_idle": canonical_idle, "history_idle": history_idle}

        hydration_wait = record_shutdown_phase(ctx, "WAIT_INFLIGHT_HYDRATION", _wait_hydration)

        # ShioajiMarketService owns the proven producer -> native -> egress -> recorder
        # dependency order. It freezes/unsubscribes broker producers, drains native
        # workers and flushes the raw recorder while deferring the final logout.
        # The whole of that stop, its steps included: a Windows session end leaves the App about 5 s, and Market Runtime
        # (stopped after this daemon) needs its share of them.
        result = record_shutdown_phase(ctx,
            "STOP_NATIVE",
            lambda: ctx.runtime.stop(wait=True, timeout=3.0, defer_broker_logout=True),
        )
        record_shutdown_phase(ctx, "UNSUBSCRIBE_SHIOAJI")
        record_shutdown_phase(ctx, "FLUSH_RECORDER")

        history_shutdown = app.historical_repository.shutdown_historical_work(timeout=4.0) if app is not None else {}
        route_shutdown = (
            ctx.route_work.shutdown(timeout=4.0)
            if ctx.route_work is not None
            else {"not_started": True, **ctx.route_work_metrics()}
        )
        forced = int(history_shutdown.get("forced_abandon_count") or 0) + int(route_shutdown.get("forced_abandon_count") or 0)
        with ctx.shutdown.lock:
            ctx.shutdown.state["shutdown_forced_abandon_count"] = forced

        # Logout only when nothing that calls the broker is still running: history or route work abandoned
        # past its timeout, and the runtime's own stop not finished, each keep the session until the process ends.
        still_running = [name for name, receipt in (("history_work", history_shutdown), ("route_work", route_shutdown))
                         if int((receipt or {}).get("forced_abandon_count") or 0)]
        logout = record_shutdown_phase(ctx, "LOGOUT_SHIOAJI", lambda: ctx.runtime.finalize_broker_logout(busy=still_running))
        # The singleton is owned by backend/shioaji/run_shioaji_daemon.py and is released in
        # its finally block only after uvicorn.Server.run() returns. Do not claim
        # it has already been released while this process is still executing.
        record_shutdown_phase(ctx, "RELEASE_SINGLETON_ON_PROCESS_EXIT")
        record_shutdown_phase(ctx, "PROCESS_EXIT_REQUESTED")
        runtime_ok = bool(result.get("ok", False)) if isinstance(result, dict) else False
        # Reported as they are, never hard-coded True. The runtime's stop is ok only
        # when every admitted callback reached the Rust WAL (live_event_sink.close) and its threads exited.
        recorder_durable = runtime_ok
        pipeline_drained = runtime_ok
        # The process exits either way: a logged-out daemon kept alive by a failed stop would survive 完整關閉
        # and make the next launch refuse to start a replacement next to it (no Shioaji
        # at the open). What changes is the answer: a stop with any part not finished is not a clean stop.
        shutdown_warnings = [w for w in (
            None if runtime_ok else "native runtime stop reported not ok",
            f"{forced} rebuildable background job(s) abandoned" if forced else None,
            None if (logout or {}).get("ok") else f"broker logout not done: {(logout or {}).get('skipped') or (logout or {}).get('error')}",
        ) if w]
        clean = not shutdown_warnings
        shutdown_values = dict(
            runtime=result,
            clean=clean,
            durable_handoff_complete=recorder_durable,
            pipeline_drained=pipeline_drained,
            history_shutdown=history_shutdown,
            route_shutdown=route_shutdown,
            freeze=freeze_result,
            hydration_wait=hydration_wait,
            shutdown_warnings=shutdown_warnings,
        )
        for warning in shutdown_warnings:
            logger.warning(f"[SHIOAJI DAEMON] stop not clean: {warning}")

        def _close_master_streams() -> None:
            # The open security-master streams (app_api) end only now that the process is certain to exit (Uvicorn
            # must not wait on them): a stop that failed above leaves a live daemon whose stream still works.
            from service.market.reference import security_master_feed

            security_master_feed.FEED.close()

        record_shutdown_phase(ctx, "CLOSE_SECURITY_MASTER_STREAMS", _close_master_streams)
        ctx.lifecycle.mark_stopped(reason)
        ctx.shutdown.complete(**shutdown_values, error=None if clean else "; ".join(shutdown_warnings))
        record_shutdown_phase(ctx, "STOP_UVICORN", ctx.request_server_exit)
        # ok = the daemon stopped and exits; `clean` (and the durability flags Health checks) say whether every part
        # of it finished.
        return {"ok": True, **ctx.shutdown.state}
    except Exception as exc:
        ctx.shutdown.fail(exc)
        return {"ok": False, **ctx.shutdown.state}


def idle_watchdog(ctx: DaemonContext) -> None:
    """Low-cost lease expiry / shared eight-minute idle timeout watcher.

    The timeout claim is atomic with client attach. Once STOPPING is claimed, a
    concurrent reattach is rejected and the App will wait for a clean new daemon.
    """
    while True:
        expired = ctx.lifecycle.expire_leases()
        if expired and ctx.lifecycle.state == "IDLE_GRACE":
            status = ctx.lifecycle.status()
            logger.info(
                "[SHIOAJI DAEMON] client lease expired; clients=0; "
                f"entering idle grace timeout={status.get('idle_timeout_seconds')}s"
            )
        status = ctx.lifecycle.status()
        generation = int(status.get("idle_generation") or 0)
        # Under Health the provider keeps maintaining the background list with or without an attached client:
        # only Health decides its lifecycle (docs/system-architecture/00 section 3).
        if not ctx.managed_by_health and ctx.lifecycle.claim_idle_timeout(expected_generation=generation):
            logger.info("[SHIOAJI DAEMON] idle timeout reached; graceful shutdown")
            shutdown_daemon(ctx, "idle_timeout", idle_claimed=True)
            return
        state = ctx.lifecycle.state
        if state == "STOPPED":
            return
        ctx.lifecycle.wait_for_change(1.0)


def stop_account(ctx: DaemonContext) -> dict[str, Any]:
    """This daemon's own verdict on its stop, for the owner's stop receipt: clean only when every part of
    the stop finished and the durable handoff completed."""
    with ctx.shutdown.lock:
        state = dict(ctx.shutdown.state)
    clean = bool(state.get("stopped") and state.get("clean") is not False and state.get("durable_handoff_complete")
                 and state.get("pipeline_drained") and not state.get("error"))
    return {"clean": clean, "reason": state.get("reason"), "error": state.get("error")
            or (None if clean else "the stop did not finish (no durable handoff)")}
