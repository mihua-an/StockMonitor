"""The test ASGI client follows the ASGI HTTP lifecycle: request once, then disconnect (R18-01)."""
from __future__ import annotations

import asyncio
import json

from tests.asgi_client import AsgiClient


async def _receive_three_times(scope, receive, send):
    received = [await receive() for _ in range(3)]
    body = json.dumps([{"type": m["type"], "body": m.get("body", b"").decode()} for m in received]).encode()
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": body})


def test_receive_after_the_request_returns_disconnect_instead_of_hanging():
    response = asyncio.run(asyncio.wait_for(
        AsgiClient(_receive_three_times).request("POST", "/x", json_body={"a": 1}), timeout=5))

    assert response.status_code == 200
    assert response.json() == [
        {"type": "http.request", "body": '{"a": 1}'},
        {"type": "http.disconnect", "body": ""},
        {"type": "http.disconnect", "body": ""},
    ]
