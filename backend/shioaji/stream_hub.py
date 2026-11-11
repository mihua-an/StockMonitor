"""Control-plane channel from the Shioaji daemon to attached FastAPI clients.

Carries only the attach handshake and the ping/pong replies: no live market data (Market Runtime is
the sole live authority and the renderer reads it directly), and no analytics fanout, since its only
client (daemon_client.MarketDaemonStream) would drop it.
"""
from __future__ import annotations

import asyncio
from typing import Any

from fastapi import WebSocket

from service.platform import remediation
from service.platform.json_safety import strict_json_dumps
import logging
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)


class DaemonStreamHub:
    CLIENT_QUEUE_SIZE = 256

    def __init__(self) -> None:
        self._queues: dict[WebSocket, asyncio.Queue[str]] = {}
        self._senders: dict[WebSocket, asyncio.Task] = {}
        self._lock = asyncio.Lock()
        self._running = False
        self._sent = 0
        self._lag_disconnects = 0

    async def start(self) -> None:
        self._running = True

    async def stop(self) -> None:
        self._running = False
        async with self._lock:
            sockets = list(self._queues)
            senders = list(self._senders.values())
            self._queues.clear()
            self._senders.clear()
        for sender in senders:
            sender.cancel()
        for websocket in sockets:
            try:
                await websocket.close(code=1001, reason="backend shutdown")
            except Exception as exc:
                record_failure(_failure_log, "closing a stream websocket at shutdown", exc)

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=self.CLIENT_QUEUE_SIZE)
        async with self._lock:
            self._queues[websocket] = queue
            self._senders[websocket] = asyncio.create_task(
                self._sender_loop(websocket, queue), name=f"daemon-stream-sender-{id(websocket)}")

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._queues.pop(websocket, None)
            sender = self._senders.pop(websocket, None)
        if sender and sender is not asyncio.current_task():
            sender.cancel()
            try:
                await sender
            except (asyncio.CancelledError, Exception):  # not an error: the sender task was cancelled to stop it; its end is the goal
                pass

    async def send_json(self, websocket: WebSocket, payload: Any) -> bool:
        return await self._enqueue(websocket, strict_json_dumps(payload))

    async def _enqueue(self, websocket: WebSocket, message: str) -> bool:
        async with self._lock:
            queue = self._queues.get(websocket)
        if queue is None:
            return False
        try:
            queue.put_nowait(message)
            return True
        except asyncio.QueueFull:
            # A consumer that cannot keep up is dropped so it reconnects and
            # re-reads the attach snapshot; it never stalls other clients.
            self._lag_disconnects += 1
            # Recorded; the client's reconnect that follows is its own recovery (client.shioaji_stream_reconnect).
            params = getattr(websocket, "query_params", None) or {}
            remediation.emitter().emit(
                component="daemon_stream_hub", mechanism_id="daemon.stream_consumer_drop", trigger_reason="consumer_lagged",
                identity={"client_id": params.get("client_id"), "connection_id": params.get("connection_id")},
                outcome="succeeded", detail={"queue_size": self.CLIENT_QUEUE_SIZE, "close_code": 1013})
            await self.disconnect(websocket)
            try:
                await websocket.close(code=1013, reason="daemon stream consumer lagged")
            except Exception as exc:
                record_failure(_failure_log, "closing a lagging stream consumer", exc)
            return False

    async def _sender_loop(self, websocket: WebSocket, queue: asyncio.Queue[str]) -> None:
        try:
            while self._running:
                message = await queue.get()
                try:
                    await websocket.send_text(message)
                    self._sent += 1
                finally:
                    queue.task_done()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            record_failure(_failure_log, "sending to a stream websocket", exc)
        finally:
            async with self._lock:
                if self._queues.get(websocket) is queue:
                    self._queues.pop(websocket, None)
                self._senders.pop(websocket, None)

    def stats(self) -> dict[str, Any]:
        queues = list(self._queues.values())
        return {
            "clients": len(queues),
            "wire_send_success": self._sent,
            "lag_disconnects": self._lag_disconnects,
            "client_queue_capacity": self.CLIENT_QUEUE_SIZE,
            "client_queue_depths": [queue.qsize() for queue in queues],
        }
