"""The host's request latency is request received -> response started (http.latency end=response_started).

It was timed to the end of the response, so a stream -- 實際庫存's positions/events SSE -- counted as one request
as long as it stayed open: 系統連線診斷 showed App API's P95 as 1,336,212 ms (10-19).
"""
from __future__ import annotations

import asyncio

from fastapi import FastAPI
from fastapi.responses import StreamingResponse

from api.service_host import ServiceHost, ServiceHostMiddleware

STREAM_OPEN_S = 0.6


def _host_app():
    host = ServiceHost("probe", port=None, config_revision=None)
    app = FastAPI()

    @app.get("/api/actual-account/positions/events")
    async def events():
        async def chunks():
            yield b"data: first\n\n"
            await asyncio.sleep(STREAM_OPEN_S)
            yield b"data: later\n\n"
        return StreamingResponse(chunks(), media_type="text/event-stream")

    @app.get("/api/actual-account/positions")
    def positions():
        return {"ok": True, "positions": []}

    return ServiceHostMiddleware(app, host=host), host


def _get(asgi, path):
    asked = []

    async def receive():
        # The request once; after that a streaming response listens for the client to disconnect, which this client
        # never does (answering again at once would spin that listener and never let the stream run).
        if asked:
            await asyncio.Event().wait()
        asked.append(True)
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(_message):
        return None

    scope = {"type": "http", "method": "GET", "path": path, "raw_path": path.encode(), "query_string": b"",
             "headers": [], "http_version": "1.1", "scheme": "http", "server": ("test", 80), "client": ("t", 1),
             "root_path": "", "app": None}
    asyncio.run(asgi(scope, receive, send))


def test_a_stream_counts_until_its_response_started_not_while_it_stays_open():
    asgi, host = _host_app()
    _get(asgi, "/api/actual-account/positions/events")
    _get(asgi, "/api/actual-account/positions")
    latency = [m for m in host.requests.document("probe") if m["name"].startswith("http.latency")]
    assert latency, "a latency histogram is reported"
    assert sum(m["samples"] for m in latency) == 2, "both requests are samples"
    worst_us = max(m["max"] for m in latency)
    assert worst_us < STREAM_OPEN_S * 1e6 / 2, f"the stream's open time leaked into the latency: {worst_us:.0f} us"
    assert all(m["end"] == "response_started" for m in latency)
