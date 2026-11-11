"""R12-16: a reconnect asked for while the broker login is still running (重新連線, or credentials saved in those
seconds) found no session yet, logged out nothing, and the login with the old credentials then stood as connected --
a reconnect that answered ok and never happened. The login now holds the sync mutex, so the reconnect waits for it
and tears it down. The SDK threads of several connections append broker events under the lock, and a failed
post-login initialization is recorded, not only warned."""
from __future__ import annotations

import sys
import threading
import types
from unittest.mock import MagicMock

import pytest

from config import broker_connection_settings
from service.market.shioaji import session as shioaji


@pytest.fixture
def svc(monkeypatch):
    monkeypatch.setattr(broker_connection_settings, "shioaji", lambda config_root=None: {
        "connections": 1, "per_connection_limit": 200, "revision": 1})
    monkeypatch.setitem(sys.modules, "shioaji", types.SimpleNamespace(__version__="test"))
    monkeypatch.setattr(shioaji, "configure_shioaji_log_path", lambda: None)
    monkeypatch.setattr(shioaji, "ensure_shioaji_log_rotation", lambda: None)
    monkeypatch.setattr(shioaji, "_advance_generation_seed", lambda value: value)
    service = shioaji.ShioajiBrokerService(event_sink=MagicMock(), credential_service=MagicMock())
    service.provider_backend = MagicMock()
    service._running.set()          # the session thread is "running": reconnect must not start a real one
    return service


def test_a_reconnect_during_the_login_waits_for_it_and_logs_that_session_out(svc, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    apis = []

    def login(sj, generation, reason):
        api = MagicMock(name=f"login{len(apis) + 1}")
        apis.append(api)
        if len(apis) == 1:
            entered.set()
            assert release.wait(5)
        return api

    monkeypatch.setattr(svc, "_login", login)
    connecting = threading.Thread(target=svc._connect)
    connecting.start()
    assert entered.wait(5)
    answers = []
    reconnecting = threading.Thread(target=lambda: answers.append(svc.reconnect("credentials_changed")))
    reconnecting.start()
    reconnecting.join(0.3)
    assert reconnecting.is_alive(), "the reconnect waits for the login in progress"
    release.set()
    connecting.join(5)
    reconnecting.join(5)
    assert answers and answers[0]["ok"]
    apis[0].logout.assert_called_once()
    assert not svc._connected.is_set() and svc._api is None, "the old-credential session does not stand"
    # The session thread's next pass logs in again (with the credentials saved meanwhile).
    svc._connect()
    assert svc._api is apis[1] and svc._connected.is_set()


def test_a_reconnect_completes_when_logout_waits_for_the_sdk_event_thread(svc, monkeypatch):
    # 10-27 03:01: the SDK's logout waits for its event thread, which delivers the unsubscribe answers through
    # _on_broker_event; reconnect held _lock across the logout, so both waited forever and Shioaji never came back.
    delivered = []

    def logout():
        sdk = threading.Thread(target=svc._on_broker_event, daemon=True,
                               args=("200", 16, "QUO/v2/FOP/*/TFE/TXFK6", "Subscribe or Unsubscribe ok"))
        sdk.start()
        sdk.join(2)
        delivered.append(not sdk.is_alive())

    monkeypatch.setattr(svc, "_login", lambda sj, generation, reason: MagicMock(logout=logout))
    svc._connect()
    answers = []
    reconnecting = threading.Thread(target=lambda: answers.append(svc.reconnect()))
    reconnecting.start()
    reconnecting.join(5)
    assert not reconnecting.is_alive() and answers and answers[0]["ok"]
    assert delivered == [True], "the SDK event thread was blocked on the session lock during logout"
    assert svc._api is None and not svc._connected.is_set()
    assert svc._broker_events[-1]["event"][2] == "QUO/v2/FOP/*/TFE/TXFK6"


def test_a_broker_event_waits_for_the_lock_so_no_event_is_lost(svc):
    with svc._lock:
        sdk = threading.Thread(target=svc._on_broker_event, args=(0, 13, "Session Up", ""), kwargs={"connection": 1})
        sdk.start()
        sdk.join(0.3)
        assert sdk.is_alive() and svc._broker_events == [], "the append waits for the lock"
    sdk.join(5)
    assert [event["connection"] for event in svc._broker_events] == [2]


def test_a_failed_post_login_initialization_is_recorded(svc, monkeypatch):
    recorded = []
    monkeypatch.setattr(svc, "_login", lambda sj, generation, reason: MagicMock())
    monkeypatch.setattr(shioaji, "record_failure", lambda log, what, exc: recorded.append((what, str(exc))))

    def boom(api):
        raise RuntimeError("catalog unavailable")

    svc.on_connected = boom
    svc._connect()
    assert svc._connected.is_set()
    assert recorded == [("the Shioaji post-login initialization", "catalog unavailable")]


def test_the_users_reconnect_and_the_daily_relogin_are_not_remediations(svc, monkeypatch, caplog):
    # docs/decisions.md 什麼算補救: 重新連線, a credential change and the scheduled daily re-login are logged, never a
    # provider.broker_session_reconnect; a login that then fails still is one.
    from datetime import datetime

    from service.platform import remediation

    recorded = []
    emitter = remediation.RemediationEmitter(service_id="test", pipe_path="")
    original = emitter._emit_tracked

    def emit(**kwargs):
        event, queued = original(**kwargs)
        recorded.append(event)
        return event, queued

    monkeypatch.setattr(emitter, "_emit_tracked", emit)
    monkeypatch.setattr(remediation, "emitter", lambda: emitter)
    with caplog.at_level("INFO", logger=shioaji.__name__):
        assert svc.reconnect("manual_request")["ok"]
        assert svc.reconnect("credentials_changed")["ok"]
    assert [e for e in recorded if e["mechanism_id"] == "provider.broker_session_reconnect"] == []
    messages = [r.getMessage() for r in caplog.records]
    assert any("reconnect requested by the user (manual_request)" in m for m in messages)
    assert any("reconnect requested by the user (credentials_changed)" in m for m in messages)

    # The session thread finds the daily re-login due: it logs and replaces the session, recording nothing.
    svc._connected.set()
    svc._logged_in_at = datetime(2026, 10, 12, 9, 0)
    monkeypatch.setattr(svc, "_apply_connection_settings", lambda: None)
    monkeypatch.setattr(svc, "_session_replacement_reason", lambda _now: "daily_relogin")

    def disconnect():
        svc._connected.clear()
        svc._running.clear()

    monkeypatch.setattr(svc, "_disconnect", disconnect)
    with caplog.at_level("INFO", logger=shioaji.__name__):
        svc._run()
    assert [e for e in recorded if e["mechanism_id"] == "provider.broker_session_reconnect"] == []
    assert any("daily re-login before the open" in r.getMessage() for r in caplog.records)

    # A login that fails is a fault the session recovers from: that is a remediation.
    svc._begin_session_recovery("login_failed", RuntimeError("timeout"))
    assert [(e["outcome"], e["trigger_reason"]) for e in recorded
            if e["mechanism_id"] == "provider.broker_session_reconnect"] == [("started", "login_failed")]
