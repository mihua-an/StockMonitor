"""Health and diagnostic routes of the Shioaji daemon, built over its DaemonContext."""

from __future__ import annotations

import asyncio
import os
import sys
import threading
import traceback

from fastapi import APIRouter

from backend.shioaji.daemon_context import DaemonContext, safe_call
from backend.shioaji.daemon_health import daemon_health, daemon_health_summary, lightweight_health_payload
from service.market.shared.startup_realtime_diagnostic import startup_realtime_diagnostic
from service.monitoring.runtime_profiler import runtime_profiler



def create_health_router(ctx: DaemonContext) -> APIRouter:
    router = APIRouter()

    @router.get("/v1/diagnostics/thread-stacks")
    async def diagnostic_thread_stacks():
        """Event-loop-safe stack snapshot for diagnosing worker starvation."""
        frames = sys._current_frames()
        rows = []
        for thread in threading.enumerate():
            frame = frames.get(thread.ident)
            rows.append({"name": thread.name, "ident": thread.ident,
                         "stack": traceback.format_stack(frame)[-18:] if frame is not None else []})
        tasks = [
            {"name": task.get_name(), "done": task.done(),
             "stack": [f"{frame.f_code.co_filename}:{frame.f_lineno}:{frame.f_code.co_name}" for frame in task.get_stack(limit=4)]}
            for task in asyncio.all_tasks()
        ]
        return {"ok": True, "threads": rows, "tasks": tasks, "hub": ctx.hub.stats()}

    @router.get("/health")
    async def get_health():
        return lightweight_health_payload(ctx)

    @router.get("/v1/health")
    def get_health_v1():
        return daemon_health_summary(ctx)

    # Explicit, on-demand deep dump only. Never used by heartbeat/status polling.
    @router.get("/v1/diagnostics/full")
    def get_diagnostics_full():
        return daemon_health(ctx)

    @router.get("/v1/diagnostics/startup-realtime-freshness")
    def get_startup_realtime_freshness_diagnostic():
        app = ctx.app()
        return {
            "ok": True,
            "daemon_instance_id": ctx.instance_id,
            "daemon_pid": os.getpid(),
            "diagnostic": startup_realtime_diagnostic.snapshot(),
            "shioaji": safe_call({}, lambda: app.broker_service.status()) if app is not None else {},
            "lifecycle": ctx.lifecycle.status(),
            "runtime_profiler": runtime_profiler.snapshot(service_id="provider_shioaji", instance_id=ctx.instance_id),
        }

    @router.get("/v1/profiling")
    def profiling():
        return {"ok": True, "daemon": daemon_health(ctx), "runtime_profiler": runtime_profiler.snapshot(service_id="provider_shioaji", instance_id=ctx.instance_id)}

    return router


__all__ = ["create_health_router"]
