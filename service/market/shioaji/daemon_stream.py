"""Shioaji daemon WebSocket lifecycle; domain routing stays provider-specific."""
from __future__ import annotations

import json
import logging
import time
import uuid
from collections.abc import Callable
from threading import Event
from typing import Any

from service.market.shared.daemon_connection import ReconnectBackoff
from service.platform.remediation import Recovery
from service.platform.daemon_auth import authorization_headers
from service.platform.failure_record import record_failure
from service.market.shioaji.daemon_settings import MARKET_DAEMON_HOST, MARKET_DAEMON_PORT

_failure_log = logging.getLogger(__name__)


class MarketDaemonStream:
    """Connect/decode/ping/reconnect only; the supplied router owns semantics."""

    def __init__(
        self,
        *,
        client_id: str,
        heartbeat_seconds: float,
        prepare_connection: Callable[[], None],
        route: Callable[[dict[str, Any]], bool | None],
        failed: Callable[[str], None],
        decode_error: Callable[[], None] | None = None,
    ) -> None:
        self.client_id = client_id
        self.heartbeat_seconds = heartbeat_seconds
        self._prepare_connection = prepare_connection
        self._route = route
        self._failed = failed
        self._decode_error = decode_error
        # A stream this client did not end is one recorded recovery, open until a new connection is established
        # (why it closed -- code, reason, connection -- is recorded with it).
        self.recovery = Recovery(component="market_daemon_stream", mechanism_id="client.shioaji_stream_reconnect")

    def run(self, running: Event) -> None:
        from websockets.sync.client import connect

        backoff = ReconnectBackoff(0.5, 8.0, 2.0)
        first = True
        while running.is_set():
            # Every reconnect goes through the backoff -- a normal close too. `running` is set while
            # the stream should run, so running.wait() returned at once and a refused connection retried in a
            # tight loop; the pause polls the flag instead.
            if not first:
                _pause_while(running, backoff.next_delay())
                if not running.is_set():
                    break
            first = False
            connection_id = f"stream-{uuid.uuid4().hex}"
            uri = (
                f"ws://{MARKET_DAEMON_HOST}:{MARKET_DAEMON_PORT}/v1/stream"
                f"?client_id={self.client_id}&connection_id={connection_id}"
            )
            identity = {"client_id": self.client_id, "connection_id": connection_id}
            opened = False
            try:
                with connect(uri, additional_headers=authorization_headers(), open_timeout=3, close_timeout=1, max_size=16 * 1024 * 1024, ping_interval=None) as websocket:
                    opened = True
                    next_ping = time.monotonic() + self.heartbeat_seconds
                    self._prepare_connection()
                    attached = False
                    while running.is_set():
                        try:
                            raw = websocket.recv(timeout=1.0)
                        except TimeoutError:  # not an error: no message within a second: a ping is sent when due and the loop waits again
                            if time.monotonic() >= next_ping:
                                websocket.send(json.dumps({"type": "client.ping", "payload": {"at": time.time()}}))
                                next_ping = time.monotonic() + self.heartbeat_seconds
                            continue
                        if raw is None:
                            break
                        try:
                            message = json.loads(raw)
                        except Exception as exc:
                            # A single malformed frame is not a connection failure: it must not trigger _failed()'s
                            # reconnect/backoff path. record_failure writes the first one per minute and counts the
                            # rest, since this stream can carry Tick/BidAsk frames at high frequency.
                            record_failure(_failure_log, f"decoding a market daemon frame on {connection_id}", exc)
                            if self._decode_error is not None:
                                self._decode_error()
                            continue
                        # A connection that delivers is healthy: the next disconnect starts from the short delay.
                        backoff.reset()
                        if isinstance(message, dict):
                            routed = self._route(message)
                            # The daemon's authoritative attached frame, not the open socket, ends the recovery
                            # -- and only one the router accepted: a frame refused for its identity or protocol is one
                            # more failed attempt, never a recovered stream.
                            if not attached and message.get("type") == "system.market_daemon.attached":
                                if routed is True:
                                    attached = True
                                    self.recovery.finish("succeeded", identity=identity)
                                else:
                                    self.recovery.failed("attach_refused", identity=identity,
                                                         detail={"payload_identity": str((message.get("payload") or {}).get("identity") or "")[:120]})
                    if running.is_set():
                        self.recovery.failed("connection_closed", identity=identity, detail=_close_detail(websocket))
            except Exception as exc:
                self._failed(str(exc))
                if running.is_set():
                    detail = {"error": f"{type(exc).__name__}: {exc}"[:300]}
                    close = getattr(exc, "rcvd", None)
                    if close is not None:
                        detail.update({"code": getattr(close, "code", None), "reason": str(getattr(close, "reason", ""))[:200]})
                    self.recovery.failed("stream_error" if opened else "connect_failed", identity=identity, detail=detail)
        self.recovery.finish("abandoned", detail={"reason": "client_stop"})


def _close_detail(websocket: Any) -> dict[str, Any]:
    close = getattr(websocket, "close_rcvd", None)
    return {"code": getattr(close, "code", None), "reason": str(getattr(close, "reason", "") or "")[:200]}


def _pause_while(running: Event, seconds: float) -> None:
    deadline = time.monotonic() + max(0.0, seconds)
    while running.is_set():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        time.sleep(min(0.1, remaining))
