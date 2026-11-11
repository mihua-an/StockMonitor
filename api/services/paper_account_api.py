"""paper_account_api (a part of app_api; no process or factory of its own): simulated accounts and simulated trading, its own ledger (00 section 2)."""
from __future__ import annotations

import asyncio
import logging
import threading
from typing import Any

from fastapi import FastAPI

from api.components import Components
from api.service_host import ServiceHost
from config.observability_contract import metric

SERVICE_ID = "paper_account_api"


# The longest close() waits for a desk build still running (it runs on a thread and cannot be cancelled).
DESK_BUILD_WAIT_S = 10.0
_log = logging.getLogger(__name__)


class Resources:
    def __init__(self, host: ServiceHost) -> None:
        self.host = host
        self.components = Components.for_host(host)
        self._desk_task: asyncio.Future | None = None
        # Starting the desk and stopping the service are one decision each, under one lock: a desk built after the
        # shutdown began is closed, never started, and a started desk is the one the shutdown closes.
        self._desk_gate = threading.Lock()
        self._stopping = False

    def bind(self, app: FastAPI) -> None:
        from api.routes.account_routes import create_paper_wallet_router
        from api.routes.paper_order_routes import create_paper_order_router

        c = self.components
        wallet = c.lazy("paper_wallet")
        # 模擬下單 first: its /orders paths are more specific than the ledger's.
        app.include_router(create_paper_order_router(c.lazy("paper_orders")))
        app.include_router(create_paper_wallet_router(wallet))
        # 模擬庫存 streams (positions/events): only a feed that exists has streams to close.
        self.host.stream_closers.append(lambda: c.built_component("paper_wallet") and wallet.positions_feed.close())
        self.host.stream_closers.append(lambda: c.built_component("paper_orders") and c.paper_orders().feed.close())

    async def start(self) -> None:
        # 模擬下單 reads what the matching writes even with no screen open: a fill reaches the ledger as it happens.
        # Built and started off the event loop (it opens the paper ledger); a failure is the component's recorded state.
        self._desk_task = asyncio.get_running_loop().create_task(asyncio.to_thread(self._build_and_start_desk))

    def _build_and_start_desk(self) -> None:
        try:
            desk = self.components.paper_orders()
        except Exception:  # noqa: BLE001 -- recorded; the order routes answer with the component's failure
            _log.exception("paper orders desk could not be built")
            return
        with self._desk_gate:
            if self._stopping:
                _log.warning("paper orders desk was built after the service began stopping: closed, not started")
                desk.close()
                return
            try:
                desk.start()
            except Exception:  # noqa: BLE001 -- recorded; the order routes answer with the component's failure
                _log.exception("paper orders desk did not start")

    async def close(self) -> None:
        await asyncio.to_thread(self._stop_desk)
        task = self._desk_task
        if task is not None and not task.done():
            done, _ = await asyncio.wait({task}, timeout=DESK_BUILD_WAIT_S)
            if not done:
                _log.warning("paper orders desk build still running after %.0f s at close; it is closed when built", DESK_BUILD_WAIT_S)

    def _stop_desk(self) -> bool:
        """Marks the service stopping and closes the desk if it exists; True when no desk is left running."""
        with self._desk_gate:
            self._stopping = True
            desk = self.components.peek("paper_orders")
            return desk.close() if desk is not None else True

    def metrics(self) -> list[dict[str, Any]]:
        return [metric("components.built", SERVICE_ID, value=len(self.components.built()), unit="components"),
                metric("components.failed", SERVICE_ID, value=len(self.components.failed()), unit="components")]

    def prepare_shutdown(self) -> dict[str, Any]:
        desk_stopped = self._stop_desk()
        wallet = self.components.peek("paper_wallet")
        if wallet is not None:
            wallet.positions_feed.close()
        closer = getattr(wallet, "close", None)
        if callable(closer):
            closer()
        return {"ok": desk_stopped, "paper_orders_stopped": desk_stopped, "paper_wallet_closed": wallet is not None}
