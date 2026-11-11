"""A reconnect that failed after saving/deleting Shioaji credentials was swallowed."""
from __future__ import annotations

from types import SimpleNamespace

from api.routes.settings_routes import SettingsRouteDependencies, create_settings_router


def _handler(router, method, path):
    return next(route.endpoint for route in router.routes if route.path == path and method in route.methods)


def test_a_failed_reconnect_is_reported_with_the_credential_change():
    credentials = SimpleNamespace(delete_shioaji_credentials=lambda: None)

    def reconnect(reason=""):
        # The daemon is told why its broker session restarts (recorded as provider.broker_session_reconnect).
        assert reason == "credentials_changed"
        raise RuntimeError("session still logged in")

    app = SimpleNamespace(broker_service=SimpleNamespace(reconnect=reconnect))
    router = create_settings_router(SettingsRouteDependencies(credentials=credentials, shioaji_app=lambda: app))
    result = _handler(router, "DELETE", "/api/settings/shioaji/credentials")()
    assert result["ok"] is True and result["configured"] is False
    assert result["reconnect_ok"] is False and "error_id=" in result["reconnect_error"]
    # The broker SDK's own exception text goes to the log, not to the client.
    assert "session still logged in" not in result["reconnect_error"]


def _settings_router_over_the_real_client(transport_answer):
    """settings_api's composition: the broker service is the proxy over a ProviderHttpClient; only the wire is faked."""
    from api.provider_http_client import ProviderHttpClient
    from service.market.shioaji.daemon_client import DaemonShioajiProxy

    client = ProviderHttpClient("provider_shioaji")
    posts = []

    def post(path, json_body=None, params=None, timeout=0.0):
        posts.append(path)
        return transport_answer

    client._transport = SimpleNamespace(post=post)
    app = SimpleNamespace(broker_service=DaemonShioajiProxy(client))
    credentials = SimpleNamespace(delete_shioaji_credentials=lambda: None)
    return create_settings_router(SettingsRouteDependencies(credentials=credentials, shioaji_app=lambda: app)), posts


def test_clearing_the_credentials_reaches_the_daemon_through_the_real_client():
    router, posts = _settings_router_over_the_real_client({"ok": True, "message": "已要求 Shioaji 重新連線"})
    assert _handler(router, "DELETE", "/api/settings/shioaji/credentials")() == \
        {"ok": True, "configured": False, "reconnect_ok": True}
    assert posts == ["/v1/control/credentials-changed"]


def test_a_daemon_that_refuses_the_reconnect_is_reported():
    refusal = {"ok": False, "accepted": False, "message": "Shioaji 正在關閉"}
    router, _posts = _settings_router_over_the_real_client(refusal)
    result = _handler(router, "DELETE", "/api/settings/shioaji/credentials")()
    assert result["reconnect_ok"] is False and result["reconnect_error"] == "Shioaji 正在關閉"


def test_no_running_app_means_no_reconnect_claim():
    credentials = SimpleNamespace(delete_shioaji_credentials=lambda: None)
    router = create_settings_router(SettingsRouteDependencies(credentials=credentials, shioaji_app=lambda: None))
    assert _handler(router, "DELETE", "/api/settings/shioaji/credentials")() == {"ok": True, "configured": False}
