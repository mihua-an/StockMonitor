from __future__ import annotations

import asyncio

from service.platform.daemon_auth import DaemonAuthenticationMiddleware


def request(app, *, kind="http", path="/v1/client/attach", headers=None):
    sent = []
    scope = {"type": kind, "path": path, "method": "GET", "headers": headers or []}

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    asyncio.run(app(scope, receive, send))
    return sent


def test_daemon_http_and_websocket_require_capability_but_health_stays_public():
    reached = []

    async def target(scope, _receive, send):
        reached.append(scope["path"])
        if scope["type"] == "http":
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"ok"})

    auth = DaemonAuthenticationMiddleware(target, token="test-daemon-capability")
    assert request(auth, path="/health")[0]["status"] == 200
    assert request(auth)[0]["status"] == 401
    assert request(auth, kind="websocket")[0]["code"] == 4401
    valid = [(b"authorization", b"Bearer test-daemon-capability")]
    assert request(auth, headers=valid)[0]["status"] == 200
    assert reached == ["/health", "/v1/client/attach"]


def test_a_rebound_hostname_is_refused_even_on_health():
    # DNS rebinding reaches 127.0.0.1 with the attacker's hostname in Host.
    async def target(scope, _receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    auth = DaemonAuthenticationMiddleware(target, token="test-daemon-capability")
    for host in (b"evil.example:8031", b"evil.example"):
        assert request(auth, path="/health", headers=[(b"host", host)])[0]["status"] == 421
    assert request(auth, kind="websocket", headers=[(b"host", b"evil.example")])[0]["code"] == 4403
    for host in (b"127.0.0.1:8031", b"localhost:8031", b"[::1]:8031", b"192.168.1.5:8031"):
        assert request(auth, path="/health", headers=[(b"host", host)])[0]["status"] == 200, host
