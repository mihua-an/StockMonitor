"""Direct read of Market Runtime's own current-market view protocol (M8/M9).

Per docs/system-architecture/00_services_and_ports.md §2 (盤中報價／商品切換: snapshot ... 直接走 A), FastAPI's current-market reads go straight
to Market Runtime instead of via the daemon's retired `_daemon_hub` relay. This module is read-only and on-demand
(`view.snapshot`) -- it never
calls `event.ingest`, never subscribes to a continuous push, and can never
mutate live state.

Wire protocol confirmed by reading
native/market_runtime/src/bin/market_runtime_daemon.rs in full this session
(not guessed): a real RFC6455 WebSocket handshake (so the standard
`websockets` library works, no hand-rolled framing needed -- mirrors
the Rust event ingest client, which already talks to this same server for
a different command). `view.snapshot`'s payload accepts either `symbol` or
`market`+`code` (+ optional `source`, auto-inferred from market otherwise);
the response is `{"type":"view.snapshot","payload":{...}}` where payload is
`null` when the symbol has no resident state, or the full snapshot_wire()
shape (summary/trend/trades/orderbook/tradeflow/price_volume) otherwise.
"""
from __future__ import annotations

import json
import time
from typing import Any
import logging
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)


class RustViewClientError(RuntimeError):
    pass


MAX_MESSAGE_BYTES = 16 * 1024 * 1024


class RustViewClient:
    """Synchronous, on-demand current-market snapshot reader.

    One short-lived WebSocket connection per call by default (simplicity and
    failure-isolation over connection reuse -- this is a low-frequency,
    request/response read path, not the high-frequency live push path). A
    caller that needs many snapshots in quick succession may pass
    ``reuse=True`` to keep the connection open across calls; ``close()`` must
    then be called when done.
    """

    def __init__(self, *, url: str | None = None, token: str | None = None, reuse: bool = False) -> None:
        if url is None:
            from config.network_settings import LIVE_ENGINE_WS_URL
            url = LIVE_ENGINE_WS_URL
        if token is None:
            # The viewer role: snapshot/view reads only -- it cannot ingest, publish or stop anything.
            from service.platform.runtime_credentials import require_token
            try:
                token = require_token("viewer")
            except RuntimeError as exc:
                # Same error type as an unreachable runtime: readers already degrade on it.
                raise RustViewClientError(str(exc)) from exc
        self._url = url
        # In a header, never in the URL.
        self._headers = {"Authorization": f"Bearer {token}"}
        self._reuse = bool(reuse)
        self._websocket = None

    def close(self) -> None:
        websocket, self._websocket = self._websocket, None
        if websocket is not None:
            try:
                websocket.close()
            except Exception as exc:
                record_failure(_failure_log, "closing the Rust view websocket", exc)

    def _close_local_or_reused(self, websocket) -> None:
        # On a mid-call failure, the connection is unusable either way -- close
        # whichever object the caller actually used (the reuse-mode
        # self._websocket, or a fresh non-reused one) rather than relying on
        # close() alone, which only ever knows about self._websocket and
        # would otherwise leak a non-reused connection on error.
        if self._reuse:
            self.close()
        else:
            try:
                websocket.close()
            except Exception as exc:
                record_failure(_failure_log, "closing the Rust view websocket", exc)

    def _connection(self, timeout: float):
        from websockets.sync.client import connect

        if self._reuse and self._websocket is not None:
            return self._websocket
        # A FUT NIGHT snapshot or the whole signal list passes websockets' 1 MiB default (2 MB seen).
        websocket = connect(self._url, additional_headers=self._headers, open_timeout=max(0.1, timeout), close_timeout=0.1,
                            proxy=None, max_size=MAX_MESSAGE_BYTES)
        if self._reuse:
            self._websocket = websocket
        return websocket

    def get_snapshot(
        self, *, market: str, code: str, source: str = "",
        trading_date: str = "", session: str = "", timeout: float = 5.0,
    ) -> dict[str, Any] | None:
        """Return the snapshot of one symbol's session partition, or None if untracked.

        ``trading_date``/``session`` address the session partition the caller is
        actually displaying. They are part of `view.snapshot`'s identity on the
        wire (market_runtime_daemon.rs::identity_field, which treats an empty
        string as *unspecified*, not as a literal value) and resolve through
        Market Runtime's view snapshot matching (native/market_runtime/src/server.rs):

        * both given    -> exactly that partition;
        * one given     -> newest resident trading date that matches;
        * neither given -> the engine's ``current`` pointer, i.e. whichever
          partition last received an event. That is the right answer only for a
          caller that genuinely means "the live one"; a caller rendering a named
          trading_date/session MUST pass it, or it can silently be handed a
          foreign partition's numbers.

        Never raises for "symbol not tracked yet" (a legitimate, common
        state -- e.g. a code that hasn't received its first live event this
        session) -- only for a genuine connection/protocol failure.
        """
        payload: dict[str, Any] = {"market": str(market).upper(), "code": str(code).upper()}
        if source:
            payload["source"] = str(source).lower()
        date_text = str(trading_date or "").strip()
        if date_text:
            payload["trading_date"] = date_text
        session_text = str(session or "").strip().upper()
        if session_text:
            payload["session"] = session_text
        websocket = None
        try:
            websocket = self._connection(timeout)
            websocket.send(json.dumps({"type": "view.snapshot", "payload": payload}, separators=(",", ":")))
            # A view.snapshot request is answered by exactly one view.snapshot frame.
            message = _receive_reply(websocket, "view.snapshot", timeout)
        except Exception as exc:
            if websocket is not None:
                self._close_local_or_reused(websocket)
            raise RustViewClientError(f"view.snapshot failed: {exc}") from exc
        if not self._reuse:
            try:
                websocket.close()
            except Exception as exc:
                record_failure(_failure_log, "closing the Rust view websocket", exc)
        result = message.get("payload")
        return dict(result) if isinstance(result, dict) else None

    def trade_page(self, payload: dict[str, Any], *, timeout: float = 10.0) -> dict[str, Any]:
        """One page of a session's trade tape (`trades.page`, native/market_runtime/src/trade_pages.rs), as Market
        Runtime answers it: rows newest first, the counts and where they came from (`coverage`)."""
        websocket = None
        try:
            websocket = self._connection(timeout)
            websocket.send(json.dumps({"type": "trades.page", "payload": payload}, separators=(",", ":")))
            message = _receive_reply(websocket, "trades.page", timeout)
        except Exception as exc:
            if websocket is not None:
                self._close_local_or_reused(websocket)
            raise RustViewClientError(f"trades.page failed: {exc}") from exc
        if not self._reuse:
            try:
                websocket.close()
            except Exception as exc:
                record_failure(_failure_log, "closing the Rust view websocket", exc)
        return dict(message.get("payload") or {})

    def health(self, *, timeout: float = 3.0) -> dict[str, Any]:
        """Read-only liveness/identity check -- never a control command."""
        websocket = None
        try:
            websocket = self._connection(timeout)
            websocket.send(json.dumps({"type": "health", "payload": {}}, separators=(",", ":")))
            # Market Runtime pushes the session on every viewer connection: the reply is the health frame,
            # whatever precedes it.
            message = _receive_reply(websocket, "health", timeout)
        except Exception as exc:
            if websocket is not None:
                self._close_local_or_reused(websocket)
            raise RustViewClientError(f"health check failed: {exc}") from exc
        if not self._reuse:
            try:
                websocket.close()
            except Exception as exc:
                record_failure(_failure_log, "closing the Rust view websocket", exc)
        return dict(message.get("payload") or {})


# Unrelated frames (a delta for another view on a reused connection) are skipped, but within one overall deadline
# and a frame cap: a per-recv timeout alone let a steady stream of them extend the wait without end.
_MAX_SKIPPED_FRAMES = 10_000


def _receive_reply(websocket: Any, wanted: str, timeout: float) -> dict[str, Any]:
    deadline = time.monotonic() + max(0.1, float(timeout))
    for _ in range(_MAX_SKIPPED_FRAMES):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        raw = websocket.recv(timeout=remaining)
        message = json.loads(raw.decode("utf-8") if isinstance(raw, bytes) else raw)
        kind = str(message.get("type") or "") if isinstance(message, dict) else ""
        if kind == wanted:
            return message
        if kind == "error":
            raise RustViewClientError(f"Market Runtime refused {wanted}: {message.get('error')}")
    raise TimeoutError(f"no {wanted} reply within {timeout} s")
