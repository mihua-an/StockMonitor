"""An exception this code did not raise on purpose never reaches the client as text.

Unexpected exceptions (the catch-all, a third-party library inside a route) answer a fixed message with an error_id,
and the full text is in the log under that id. Messages this code writes for the user on purpose still pass through.
"""
from __future__ import annotations

import asyncio
import json
import logging

import pytest
import requests

SECRET_TEXT = r"C:\Users\someone\AppData\db.sqlite3 at http://127.0.0.1:8020/v1/x?token=abc"


def _call(app, path):
    import asyncio

    sent = []
    scope = {"type": "http", "path": path, "method": "GET", "headers": [], "query_string": b"", "raw_path": path.encode(),
             "scheme": "http", "server": ("127.0.0.1", 8000), "client": ("127.0.0.1", 5000), "root_path": "", "http_version": "1.1"}

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    try:
        asyncio.run(app(scope, receive, send))
    except OSError:
        pass  # Starlette re-raises an unhandled exception to the server after the 500 handler answered
    status = next(m["status"] for m in sent if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    import json

    return status, json.loads(body)


def test_the_catch_all_answers_a_fixed_message_and_logs_the_text(caplog):
    from fastapi import FastAPI

    from service.platform.http.errors import AppError, register_error_handlers

    app = FastAPI()
    register_error_handlers(app)

    @app.get("/boom")
    def boom():
        raise OSError(SECRET_TEXT)

    @app.get("/ours")
    def ours():
        raise AppError("找不到這筆交易")

    with caplog.at_level(logging.ERROR):
        status, body = _call(app, "/boom")
    assert status == 500
    assert body["classification"] == "INTERNAL_ERROR" and len(body["error_id"]) == 12
    assert "sqlite3" not in str(body) and "token" not in str(body) and "127.0.0.1" not in str(body)
    assert body["error_id"] in body["error"]
    logged = "\n".join(r.getMessage() + (r.exc_text or "") for r in caplog.records)
    assert body["error_id"] in logged and "sqlite3" in "".join(
        str(r.exc_info[1]) for r in caplog.records if r.exc_info), "the full text is in the log"
    # A message this code raised on purpose is still shown.
    status, body = _call(app, "/ours")
    assert body["error"] == "找不到這筆交易"


def test_account_routes_keep_their_own_messages_but_hide_third_party_text(tmp_path, monkeypatch):
    from api.routes import account_routes
    from service.account.account_types import ActualAccountError

    class Sync:
        mode = "third_party"

        def sync(self):
            if self.mode == "ours":
                raise ActualAccountError("尚未設定 GAS Web App URL")
            raise requests.ConnectionError(SECRET_TEXT)

    sync = Sync()
    handlers = {}

    class Router:
        def __getattr__(self, _name):
            def register(path, *a, **k):
                def wrap(fn):
                    handlers[path] = fn
                    return fn
                return wrap
            return register

    monkeypatch.setattr(account_routes, "APIRouter", lambda *a, **k: Router())
    import inspect

    params = inspect.signature(account_routes.create_actual_account_router).parameters
    kwargs = {name: object() for name in params}
    for name in params:
        if "sync" in name:
            kwargs[name] = sync
    account_routes.create_actual_account_router(**kwargs)
    route = handlers["/api/actual-account/sync"]
    response = route()
    body = json.loads(response.body)
    assert response.status_code == 500, "a failure is never an implicit HTTP 200 (R08-12)"
    assert body["ok"] is False and body["classification"] == "INTERNAL_ERROR"
    assert "127.0.0.1" not in str(body) and "token" not in str(body) and "sqlite3" not in str(body)
    sync.mode = "ours"
    # Our own message propagates to the app's handler, which answers with the status it names.
    with pytest.raises(ActualAccountError) as raised:
        route()
    assert str(raised.value) == "尚未設定 GAS Web App URL" and raised.value.status_code == 502


def test_stated_errors_answer_with_their_own_status():
    """The app's handlers turn the domain's stated errors into their status, with the message kept."""
    from fastapi import FastAPI
    from tests.asgi_client import AsgiClient

    from service.account.account_types import ActualAccountError, TradeInfoError, invalid_account_input
    from service.platform.credential_service import CredentialError
    from service.platform.http.errors import register_error_handlers

    app = FastAPI()
    register_error_handlers(app)
    errors = {
        "remote": ActualAccountError("GAS 操作失敗"),
        "input": invalid_account_input("缺少 trade_id"),
        "config": ActualAccountError("尚未設定 GAS Web App URL", classification="NOT_CONFIGURED", status_code=409),
        "trade": TradeInfoError("交易資訊格式錯誤"),
        "cred": CredentialError("invalid_input", "API Key 與 Secret Key 都必須輸入"),
    }

    @app.get("/{kind}")
    def fail(kind: str):
        raise errors[kind]

    expected = {"remote": 502, "input": 422, "config": 409, "trade": 422, "cred": 422}
    for kind, status in expected.items():
        response = asyncio.run(AsgiClient(app).request("GET", f"/{kind}"))
        assert response.status_code == status, kind
        assert response.json()["ok"] is False and response.json()["error"] == str(errors[kind])


def test_daemon_transport_errors_carry_no_library_text():
    from service.market.shared.daemon_transport import DaemonHttpTransport, DaemonTransportError

    class Session:
        def __init__(self, error):
            self.error = error

        def request(self, *a, **k):
            raise self.error

    for error, classification in ((requests.ConnectTimeout(SECRET_TEXT), "TIMEOUT"),
                                  (requests.ConnectionError(ConnectionRefusedError(10061, SECRET_TEXT)), "CONNECTION_REFUSED"),
                                  (requests.ConnectionError("actively refused " + SECRET_TEXT), "NETWORK_UNREACHABLE"),
                                  (requests.ConnectionError(SECRET_TEXT), "NETWORK_UNREACHABLE"),
                                  (requests.TooManyRedirects(SECRET_TEXT), "NETWORK_ERROR")):
        transport = DaemonHttpTransport("127.0.0.1", 8020, session=Session(error))
        with pytest.raises(DaemonTransportError) as caught:
            transport.get("/v1/session/status")
        assert caught.value.classification == classification
        assert "sqlite3" not in str(caught.value) and "token" not in str(caught.value)
        assert "sqlite3" in caught.value.detail, "the library text is kept for the log"


def test_a_real_refused_connection_is_classified_from_the_os_error_not_its_text():
    """Windows words the refusal in the system's language (中文: 無法連線，因為目標電腦拒絕連線): only the error
    number is read."""
    import socket

    from service.market.shared.daemon_transport import DaemonHttpTransport, DaemonTransportError

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]          # bound, never listening: a connect to it is refused
        with pytest.raises(DaemonTransportError) as caught:
            DaemonHttpTransport("127.0.0.1", port).get("/health", timeout=10.0)
    assert caught.value.classification == "CONNECTION_REFUSED"

