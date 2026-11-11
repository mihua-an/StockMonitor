"""Every credential does only its role's work, and a process started by Health holds only what it was granted.

Both directions are tested: the role's holder gets through, every other credential is refused.
"""
from __future__ import annotations

import asyncio
import hashlib

import pytest

from service.platform import daemon_auth
from service.platform.daemon_auth import CredentialNotGranted, DaemonAuthenticationMiddleware

DAEMON = "d" * 64
MANAGEMENT = "m" * 64
CLIENT = "c" * 64


def sha(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def call(app, path, token=None, kind="http", method="POST"):
    sent = []
    headers = [(b"authorization", f"Bearer {token}".encode())] if token else []
    scope = {"type": kind, "path": path, "method": method, "headers": headers}

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    asyncio.run(app(scope, receive, send))
    first = sent[0]
    return first.get("status") if kind == "http" else first.get("code")


async def ok_app(scope, _receive, send):
    if scope["type"] == "http":
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"{}"})
    else:
        await send({"type": "websocket.accept"})


@pytest.fixture
def no_grants(tmp_path, monkeypatch):
    for name in ("STOCK_MONITOR_DAEMON_TOKEN", "STOCK_MONITOR_DAEMON_TOKEN_SHA256", "STOCK_MONITOR_MANAGEMENT_TOKEN_SHA256",
                 "STOCK_MONITOR_CLIENT_TOKEN", "STOCK_MONITOR_CLIENT_TOKEN_SHA256", "STOCK_MONITOR_DAEMON_TOKEN_FILE",
                 "STOCK_MONITOR_MANAGEMENT_TOKEN_FILE", "STOCK_MONITOR_MANAGED_BY_HEALTH"):
        monkeypatch.delenv(name, raising=False)
    auth_root = tmp_path / "auth"
    monkeypatch.setenv("STOCK_MONITOR_AUTH_ROOT", str(auth_root))
    import service.platform.project_root as project_root
    monkeypatch.setattr(project_root, "_AUTH_ROOT", auth_root, raising=False)
    return auth_root


def test_daemon_data_routes_take_only_the_daemon_credential(no_grants):
    app = DaemonAuthenticationMiddleware(ok_app, token=DAEMON, management_token=MANAGEMENT)
    assert call(app, "/v1/client/attach", DAEMON) == 200
    assert call(app, "/v1/stream", DAEMON, kind="websocket") is None          # accepted (no close code)
    assert call(app, "/v1/client/attach", MANAGEMENT) == 401
    assert call(app, "/v1/stream", MANAGEMENT, kind="websocket") == 4401
    assert call(app, "/v1/client/attach", CLIENT) == 401


def test_stopping_a_daemon_takes_only_the_management_credential(no_grants):
    app = DaemonAuthenticationMiddleware(ok_app, token=DAEMON, management_token=MANAGEMENT)
    assert call(app, "/v1/control/stop", MANAGEMENT) == 200
    # An API holds the daemon token to read market data; that same token must not stop the daemon.
    assert call(app, "/v1/control/stop", DAEMON) == 401
    assert call(app, "/v1/control/stop") == 401
    # Other control routes stay ordinary daemon-client calls (app_api tells the daemon credentials changed).
    assert call(app, "/v1/control/credentials-changed", DAEMON) == 200


def test_a_managed_daemon_verifies_from_granted_digests_and_reads_no_token_file(no_grants, monkeypatch):
    monkeypatch.setenv("STOCK_MONITOR_MANAGED_BY_HEALTH", "1")
    monkeypatch.setenv("STOCK_MONITOR_DAEMON_TOKEN_SHA256", sha(DAEMON))
    monkeypatch.setenv("STOCK_MONITOR_MANAGEMENT_TOKEN_SHA256", sha(MANAGEMENT))
    app = DaemonAuthenticationMiddleware(ok_app)
    assert call(app, "/v1/client/attach", DAEMON) == 200
    assert call(app, "/v1/control/stop", MANAGEMENT) == 200
    assert call(app, "/v1/control/stop", DAEMON) == 401
    # A verifier was given digests only: it cannot present the daemon credential itself.
    with pytest.raises(CredentialNotGranted):
        daemon_auth.authorization_headers()
    with pytest.raises(CredentialNotGranted):
        daemon_auth.load_or_create_management_token()
    assert not no_grants.exists(), "a managed process must not mint or read token files it was not granted"


def test_a_managed_process_without_grants_lets_nothing_through(no_grants, monkeypatch):
    monkeypatch.setenv("STOCK_MONITOR_MANAGED_BY_HEALTH", "1")
    app = DaemonAuthenticationMiddleware(ok_app)
    for token in (DAEMON, MANAGEMENT, None):
        assert call(app, "/v1/client/attach", token) == 401
        assert call(app, "/v1/control/stop", token) == 401
    assert not no_grants.exists()


def test_a_managed_api_calls_daemons_with_its_granted_token(no_grants, monkeypatch):
    monkeypatch.setenv("STOCK_MONITOR_MANAGED_BY_HEALTH", "1")
    monkeypatch.setenv("STOCK_MONITOR_DAEMON_TOKEN", DAEMON)
    assert daemon_auth.authorization_headers() == {"Authorization": f"Bearer {DAEMON}"}
    assert not no_grants.exists()


def test_tokens_are_never_exported_into_the_environment(no_grants, monkeypatch):
    # Standalone (not managed): the token comes from the file, and is NOT copied into os.environ any more, where every
    # subprocess of this one would have inherited it.
    token = daemon_auth.load_or_create_daemon_token()
    assert len(token) == 64
    assert "STOCK_MONITOR_DAEMON_TOKEN" not in daemon_auth.os.environ
    assert daemon_auth.load_or_create_daemon_token() == token


def test_api_client_middleware_verifies_the_client_digest_only(no_grants, monkeypatch):
    from api.client_auth import ClientAuthenticationMiddleware

    monkeypatch.setenv("STOCK_MONITOR_CLIENT_TOKEN_SHA256", sha(CLIENT))
    app = ClientAuthenticationMiddleware(ok_app)
    assert call(app, "/api/status", CLIENT, method="GET") == 200
    assert call(app, "/api/status", DAEMON, method="GET") == 401
    assert call(app, "/api/status", MANAGEMENT, method="GET") == 401
    assert call(app, "/api/status", method="GET") == 401
    assert call(app, "/api/diagnostics/heartbeat", method="GET") == 200


def test_service_management_routes_refuse_the_daemon_and_client_tokens(no_grants, monkeypatch):
    from api.service_host import ServiceHost, ServiceHostMiddleware

    monkeypatch.setenv("STOCK_MONITOR_MANAGED_BY_HEALTH", "1")
    monkeypatch.setenv("STOCK_MONITOR_MANAGEMENT_TOKEN_SHA256", sha(MANAGEMENT))
    host = ServiceHost("app_api", port=None, config_revision=None)
    app = ServiceHostMiddleware(ok_app, host=host)
    assert call(app, "/api/service/identity", MANAGEMENT, method="GET") == 200
    # With the daemon token as the management check, every API holds it: one API could stop another.
    assert call(app, "/api/service/identity", DAEMON, method="GET") == 401
    assert call(app, "/api/service/stop", CLIENT) == 401
    assert call(app, "/api/service/stop") == 401


def test_a_daemon_given_only_the_raw_daemon_token_still_verifies_it_but_never_the_management_role(no_grants, monkeypatch):
    # A daemon restarted by an older Health inherits the raw daemon token and no digests: holding the token, it can
    # verify the daemon role; it was granted nothing for management, so stopping it needs a Health that grants roles.
    monkeypatch.setenv("STOCK_MONITOR_MANAGED_BY_HEALTH", "1")
    monkeypatch.setenv("STOCK_MONITOR_DAEMON_TOKEN", DAEMON)
    app = DaemonAuthenticationMiddleware(ok_app)
    assert call(app, "/v1/client/attach", DAEMON) == 200
    assert call(app, "/v1/control/stop", DAEMON) == 401
    assert call(app, "/v1/control/stop", MANAGEMENT) == 401
    assert not no_grants.exists()
