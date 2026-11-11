"""Minimal in-process ASGI client for tests (no httpx dependency): lifespan + JSON requests."""
from __future__ import annotations

import asyncio
import json
from typing import Any
from urllib.parse import urlsplit


class Response:
    def __init__(self, status: int, body: bytes) -> None:
        self.status_code = status
        self._body = body

    def json(self) -> Any:
        return json.loads(self._body.decode("utf-8")) if self._body else None


class AsgiClient:
    def __init__(self, app) -> None:
        self.app = app

    async def request(self, method: str, url: str, *, headers: dict[str, str] | None = None, json_body: Any = None) -> Response:
        parts = urlsplit(url)
        body = json.dumps(json_body).encode("utf-8") if json_body is not None else b""
        raw_headers = [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in (headers or {}).items()]
        if json_body is not None:
            raw_headers.append((b"content-type", b"application/json"))
        raw_headers.append((b"content-length", str(len(body)).encode()))
        scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method.upper(), "scheme": "http",
                 "path": parts.path, "raw_path": parts.path.encode(), "query_string": parts.query.encode(), "headers": raw_headers,
                 "client": ("127.0.0.1", 50000), "server": ("127.0.0.1", 80), "root_path": ""}
        messages: list[dict[str, Any]] = []
        # ASGI HTTP lifecycle: one http.request carrying the whole body, then http.disconnect for every later receive()
        # (the client has nothing more to send once the response is done).
        incoming = [{"type": "http.request", "body": body, "more_body": False}]

        async def receive():
            return incoming.pop(0) if incoming else {"type": "http.disconnect"}

        async def send(message):
            messages.append(message)

        await self.app(scope, receive, send)
        status = next((m["status"] for m in messages if m["type"] == "http.response.start"), 500)
        payload = b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body")
        return Response(status, payload)

    def get(self, url, **kw):
        return self._loop.run_until_complete(self.request("GET", url, headers=kw.get("headers")))

    def post(self, url, **kw):
        return self._loop.run_until_complete(self.request("POST", url, headers=kw.get("headers"), json_body=kw.get("json")))

    def put(self, url, **kw):
        return self._loop.run_until_complete(self.request("PUT", url, headers=kw.get("headers"), json_body=kw.get("json")))

    def __enter__(self):
        self._loop = asyncio.new_event_loop()
        self._lifespan = self.app.router.lifespan_context(self.app)
        self._loop.run_until_complete(self._lifespan.__aenter__())
        return self

    def __exit__(self, *exc):
        try:
            self._loop.run_until_complete(self._lifespan.__aexit__(None, None, None))
        finally:
            self._loop.close()
        return False
