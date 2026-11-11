"""A02: real ASGI admission with fake credential operations, never real storage.

Every business API process shares api.service_host's middleware stack, so the admission rules are pinned on a bare
service app (no resources): what one service admits, all of them admit.
"""
import asyncio
from types import SimpleNamespace

from api.service_host import create_service_app
from api.routes.settings_routes import SettingsRouteDependencies, create_settings_router


def create_app(*, client_token):
    return create_service_app("settings_api", lambda app, host: None, client_token=client_token)


def request(app, method="DELETE", headers=(), path="/api/settings/shioaji/credentials", kind="http", query=b""):
    async def run():
        output = []
        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}
        async def send(message):
            output.append(message)
        await app({"type": kind, "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method,
                   "scheme": "http", "path": path, "raw_path": path.encode(), "root_path": "",
                   "query_string": query, "headers": list(headers), "client": ("127.0.0.1", 123),
                   "server": ("127.0.0.1", 8000)}, receive, send)
        return output
    return asyncio.run(run())


def test_sensitive_operations_require_launch_token_even_for_null_origin():
    calls = []
    app = create_app(client_token="fake-client-token")
    app.include_router(create_settings_router(SettingsRouteDependencies(
        credentials=SimpleNamespace(delete_shioaji_credentials=lambda: calls.append("delete")), shioaji_app=lambda: None)))
    for headers in [[], [(b"origin", b"null")], [(b"authorization", b"Bearer wrong")],
                    [(b"authorization", b"Bearer fake-client-token"), (b"authorization", b"Bearer fake-client-token")]]:
        assert request(app, headers=headers)[0]["status"] == 401
        assert not calls
    assert request(app, headers=[(b"authorization", b"Bearer fake-client-token"), (b"origin", b"null")])[0]["status"] == 200
    assert calls == ["delete"]


def test_preflight_is_not_authorization_and_token_is_never_accepted_from_url():
    app = create_app(client_token="fake-client-token")
    result = request(app, "OPTIONS", [(b"origin", b"null"), (b"access-control-request-method", b"DELETE"),
                                      (b"access-control-request-headers", b"authorization")])
    assert result[0]["status"] == 200
    assert request(app, query=b"token=fake-client-token")[0]["status"] == 401
    assert request(app, headers=[(b"origin", b"https://untrusted.invalid")], method="OPTIONS")[0]["status"] != 200


def test_websocket_auth_rejected_before_handshake_and_valid_client_accepted():
    app = create_app(client_token="fake-client-token")
    @app.websocket("/audit-stream")
    async def stream(socket: __import__("fastapi").WebSocket):
        await socket.accept()
        await socket.close()
    assert request(app, kind="websocket", path="/audit-stream")[0] == {"type": "websocket.close", "code": 4401}
    assert request(app, kind="websocket", path="/audit-stream", query=b"token=fake-client-token")[0]["code"] == 4401
    # The middleware's successful path is exercised separately without network.
    from api.client_auth import ClientAuthenticationMiddleware
    reached = []
    async def target(scope, receive, send):
        reached.append(scope["type"])
    auth = ClientAuthenticationMiddleware(target, token="fake-client-token")
    request(auth, kind="websocket", headers=[(b"authorization", b"Bearer fake-client-token")])
    assert reached == ["websocket"]


def test_unconfigured_backend_fails_closed_and_health_remains_read_only():
    app = create_app(client_token="")
    assert request(app)[0]["status"] == 401
    assert request(app, method="GET", path="/api/actual-account/status")[0]["status"] == 401
    assert request(app, method="GET", path="/api/diagnostics/client-auth")[0]["status"] == 401
    assert request(app, method="GET", path="/api/market/watchlist")[0]["status"] == 401
    assert request(app, method="GET", path="/api/diagnostics/readiness")[0]["status"] == 404
    assert request(app, method="GET", path="/api/diagnostics/heartbeat")[0]["status"] == 404
    assert request(app, method="GET", path="/missing-public-health")[0]["status"] == 404


def test_market_get_requires_token_and_authorized_null_origin_keeps_desktop_cors():
    app = create_app(client_token="fake-client-token")

    @app.get("/api/market/audit")
    def market_audit():
        return {"ok": True}

    assert request(app, method="GET", path="/api/market/audit", headers=[(b"origin", b"null")])[0]["status"] == 401
    result = request(app, method="GET", path="/api/market/audit", headers=[
        (b"origin", b"null"),
        (b"authorization", b"Bearer fake-client-token"),
    ])
    assert result[0]["status"] == 200
    headers = dict(result[0]["headers"])
    assert headers[b"access-control-allow-origin"] == b"null"

    untrusted = request(app, method="GET", path="/api/market/audit", headers=[
        (b"origin", b"https://untrusted.invalid"),
        (b"authorization", b"Bearer fake-client-token"),
    ])
    assert untrusted[0]["status"] == 200
    assert b"access-control-allow-origin" not in dict(untrusted[0]["headers"])
