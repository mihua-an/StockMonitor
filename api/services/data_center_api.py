"""data_center_api (a part of app_api; no process or factory of its own): data catalog, 收盤整理 state and K-bar download jobs (00 section 2).

Jobs return an id quickly; source data comes from the providers. It creates no second WAL and no second session-seal
authority, and shares history_api's storage format and readers.
"""
from __future__ import annotations

from typing import Any

from fastapi import FastAPI

from api.components import Components
from api.service_host import ServiceHost
from config.observability_contract import metric

SERVICE_ID = "data_center_api"


class Resources:
    def __init__(self, host: ServiceHost) -> None:
        self.host = host
        self.components = Components.for_host(host)

    def bind(self, app: FastAPI) -> None:
        from api.routes.history_routes import DataCenterRouteDependencies, create_data_center_router

        c = self.components
        app.include_router(create_data_center_router(DataCenterRouteDependencies(
            runtime=c.lazy("shioaji_provider"), data_center=c.lazy("data_center"))))

    async def start(self) -> None:
        return None

    async def close(self) -> None:
        return None

    def metrics(self) -> list[dict[str, Any]]:
        return [metric("components.built", SERVICE_ID, value=len(self.components.built()), unit="components"),
                metric("components.failed", SERVICE_ID, value=len(self.components.failed()), unit="components")]

    def prepare_shutdown(self) -> dict[str, Any]:
        return {}
