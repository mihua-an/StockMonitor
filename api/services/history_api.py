"""history_api (a part of app_api; no process or factory of its own): local history queries and replay sessions (00 section 2).

Replay has its own clock/cursor/speed/back-pressure and never writes the live WAL, never changes live subscriptions
and never broadcasts through market_runtime's intraday WebSocket. Missing data answers with its integrity state; a
query never starts a repair.
"""
from __future__ import annotations

from typing import Any

from fastapi import FastAPI

from api.components import Components
from api.service_host import ServiceHost
from config.observability_contract import metric
import logging
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)

SERVICE_ID = "history_api"


class Resources:
    def __init__(self, host: ServiceHost) -> None:
        self.host = host
        self.components = Components.for_host(host)

    def bind(self, app: FastAPI) -> None:
        from api.routes.history_routes import HistoryRouteDependencies, create_history_router

        c = self.components
        router = create_history_router(HistoryRouteDependencies(
            runtime=c.lazy("shioaji_provider"), replay=c.lazy("history_replay"),
            # The day-trade list reads the actual-account ledger. History and actual_account are parts of
            # one process (app_api) and share one service; as separate processes the replay page's
            # 交易明細 always failed with "trade records belongs to actual_account_api".
            account=c.lazy("actual_account")))
        app.include_router(router)

        @app.get("/api/replay/status")
        def replay_status():
            service = c.history_replay()
            status = getattr(service, "status", None)
            return {"ok": True, **(status() if callable(status) else {})}

    async def start(self) -> None:
        return None

    async def close(self) -> None:
        return None

    def metrics(self) -> list[dict[str, Any]]:
        out = [metric("components.built", SERVICE_ID, value=len(self.components.built()), unit="components"),
                metric("components.failed", SERVICE_ID, value=len(self.components.failed()), unit="components")]
        replay = self.components.peek("history_replay")
        status = getattr(replay, "status", None)
        if callable(status):
            try:
                s = status() or {}
                sessions = s.get("sessions") or s.get("active_sessions")
                if isinstance(sessions, (int, list)):
                    out.append(metric("replay.sessions", SERVICE_ID, value=len(sessions) if isinstance(sessions, list) else sessions, unit="sessions"))
            except Exception as exc:
                record_failure(_failure_log, "reading replay metrics", exc)
        return out

    def prepare_shutdown(self) -> dict[str, Any]:
        return {}
