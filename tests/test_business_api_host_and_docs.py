"""The business APIs serve no generated docs or schema (they were readable without the client token), and refuse a
request whose Host is a name other than localhost -- the DNS-rebinding check the provider daemons already had, now one
shared function (service.platform.daemon_auth.host_is_direct)."""
import inspect

from api import client_auth
from service.platform import daemon_auth
from tests.support.service_app_asgi import create_app, request

TOKEN = [(b"authorization", b"Bearer fake-client-token")]


def test_generated_docs_and_schema_are_not_served():
    app = create_app(client_token="fake-client-token")
    assert app.openapi_url is None and app.docs_url is None and app.redoc_url is None
    for path in ("/docs", "/redoc", "/openapi.json", "/docs/oauth2-redirect"):
        for headers in ([], TOKEN):
            assert request(app, "GET", headers=headers, path=path)[0]["status"] == 404, path


def test_a_rebound_hostname_is_refused_before_any_route():
    app = create_app(client_token="fake-client-token")
    for host in (b"evil.example", b"evil.example:8000", b"127.0.0.1.nip.io:8000"):
        for path in ("/api/diagnostics/heartbeat", "/api/service/identity", "/api/settings/shioaji/credentials"):
            answer = request(app, "GET", headers=[(b"host", host), *TOKEN], path=path)
            assert answer[0]["status"] == 421, (host, path)
        assert request(app, kind="websocket", headers=[(b"host", host), *TOKEN], path="/any")[0] == {
            "type": "websocket.close", "code": 4403}
    # An IP literal or localhost reaches the routes as before.
    for host in (b"127.0.0.1:8000", b"localhost:8000", b"[::1]:8000"):
        assert request(app, "GET", headers=[(b"host", host)], path="/api/diagnostics/heartbeat")[0]["status"] != 421, host


def test_daemons_and_business_apis_share_one_host_check():
    assert client_auth.host_is_direct is daemon_auth.host_is_direct
    assert "host_is_direct(scope)" in inspect.getsource(client_auth.DirectHostMiddleware)
    assert "host_is_direct(scope)" in inspect.getsource(daemon_auth.DaemonAuthenticationMiddleware)
    assert not hasattr(daemon_auth, "_host_is_direct")
