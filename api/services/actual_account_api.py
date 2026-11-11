"""actual_account_api (a part of app_api; no process or factory of its own): the actual account ledger, trade records, positions, P&L and sync (00 section 2).

The one writer of the actual-account ledger. It reads no market price: 未實現損益 is computed on the screen from
Market Runtime's price over the WS.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI

from api.components import Components
from api.service_host import ServiceHost
from config.observability_contract import metric

SERVICE_ID = "actual_account_api"
logger = logging.getLogger(__name__)


class Resources:
    def __init__(self, host: ServiceHost) -> None:
        self.host = host
        self.components = Components.for_host(host)

    def bind(self, app: FastAPI) -> None:
        from api.routes.account_routes import create_actual_account_router

        c = self.components
        service = c.lazy("actual_account")
        app.include_router(create_actual_account_router(service, c.gas_bridge(),
                                                        c.lazy("actual_account.sync_service", lambda: service.sync_service),
                                                        c.lazy("actual_account.report_publisher", lambda: service.report_publisher)))
        # Only a feed that exists has streams to close: never build the account service on the way out.
        self.host.stream_closers.append(lambda: c.built_component("actual_account") and service.positions_feed.close())

    async def start(self) -> None:
        scheduler = self.components.gas_bridge()
        starter = getattr(scheduler, "start", None)
        if callable(starter):
            starter()

    async def close(self) -> None:
        # The shutdown itself runs once, through ServiceHost.shutdown_resources.
        return None

    def metrics(self) -> list[dict[str, Any]]:
        return [metric("components.built", SERVICE_ID, value=len(self.components.built()), unit="components"),
                metric("components.failed", SERVICE_ID, value=len(self.components.failed()), unit="components")]

    def prepare_shutdown(self) -> dict[str, Any]:
        receipt: dict[str, Any] = {}
        scheduler = self.components.peek("gas_bridge")
        if scheduler is not None and callable(getattr(scheduler, "stop", None)):
            scheduler.stop()
            receipt["gas_bridge"] = "stopped"
        service = self.components.peek("actual_account")
        if service is not None:
            service.positions_feed.close()
        if service is not None:
            # Drain the ledger's SQLite owners and checkpoint its WAL (without it, production shutdown neither drained
            # nor checkpointed). Its receipt is reported.
            receipt["actual_account"] = service.shutdown()
        return receipt
