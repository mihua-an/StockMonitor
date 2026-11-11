"""模擬下單 routes (paper_account_api): orders, their fills, the reservation, and one change stream.

The 委託台 (service/account/paper_orders.py) checks and writes each order; Rust B matches it. A screen keeps
``/api/paper-wallet/orders/events`` open and re-reads ``/api/paper-wallet/orders`` when the revision moves (an order
placed, read, entered, filled, finished, or its queue estimate changed); no screen polls.

"""
from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

STREAM_HEARTBEAT_S = 20.0


class PaperOrderRequest(BaseModel):
    code: str
    side: str
    qty: float | int | str
    price: float | int | str | None = None
    price_type: str = "limit"
    tif: str = "ROD"
    # A market order's reservation price (the limit-up for a buy, limit-down for a sell) the screen shows.
    reserve_price: float | int | str | None = None


class PaperReduceRequest(BaseModel):
    qty: float | int | str


class PaperReplaceRequest(BaseModel):
    price: float | int | str


def _change_stream(desk: Any) -> StreamingResponse:
    """Server-Sent Events: the revision now, then one `orders.changed` per change; a comment line every
    STREAM_HEARTBEAT_S lets a dead connection be noticed; the stream ends when the desk closes."""
    feed = desk.feed
    queue = feed.subscribe()

    async def events():
        try:
            yield f"event: orders.changed\ndata: {json.dumps({'revision': desk.revision})}\n\n"
            while True:
                try:
                    payload = await asyncio.wait_for(queue.get(), STREAM_HEARTBEAT_S)
                except asyncio.TimeoutError:  # not an error: the heartbeat interval passed with no change
                    yield ": heartbeat\n\n"
                    continue
                if payload is None:
                    return
                yield f"event: orders.changed\ndata: {json.dumps(payload)}\n\n"
        finally:
            feed.unsubscribe(queue)

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-store"})


def create_paper_order_router(desk: Any) -> APIRouter:
    router = APIRouter()
    # The live ledger's only (registered first: `funds` is not an order id): the reservation against the ledger's
    # money, and deleting a finished order with its fills.
    @router.get("/api/paper-wallet/orders/funds")
    def funds():
        return desk.funds()

    @router.post("/api/paper-wallet/orders/{order_id}/delete")
    def delete_order(order_id: str):
        return desk.delete(order_id)

    # 帳務 → 模擬帳務 → 委託紀錄: the orders of a range of trading days with their fills and 經過.
    @router.get("/api/paper-wallet/orders/history")
    def order_history(start: str, end: str):
        return desk.history(start, end)

    base = "/api/paper-wallet/orders"

    @router.get(base)
    def list_orders(date: str | None = None):
        return desk.orders(date)

    @router.post(base)
    def place_order(req: PaperOrderRequest):
        return desk.place(req.model_dump())

    @router.post(f"{base}/cancel-all")
    def cancel_all():
        return desk.cancel_all()

    @router.get(f"{base}/fills")
    def fills(date: str | None = None):
        return desk.fills(date)

    @router.get(f"{base}/events")
    async def stream_order_changes():
        return _change_stream(desk)

    @router.post(base + "/{order_id}/cancel")
    def cancel_order(order_id: str):
        return desk.cancel(order_id)

    @router.post(base + "/{order_id}/reduce")
    def reduce_order(order_id: str, req: PaperReduceRequest):
        return desk.reduce(order_id, req.qty)

    @router.post(base + "/{order_id}/replace")
    def replace_order(order_id: str, req: PaperReplaceRequest):
        return desk.replace(order_id, req.price)

    return router
