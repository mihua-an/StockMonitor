"""The provider/client reconnect and retry loops are recorded remediations -- one operation per
loss, every further failed try an attempt of it, exactly one terminal outcome."""
from __future__ import annotations

import threading
from types import SimpleNamespace

import pytest

from service.market.futu import subscriptions as futu_subscriptions
from service.market.futu.subscriptions import FutuSubscriptionManager
from service.platform import remediation


@pytest.fixture
def events(monkeypatch):
    recorded: list[dict] = []
    emitter = remediation.RemediationEmitter(service_id="test", pipe_path="")
    original = emitter._emit_tracked

    def emit(**kwargs):
        event, queued = original(**kwargs)
        recorded.append(event)
        return event, queued

    monkeypatch.setattr(emitter, "_emit_tracked", emit)
    monkeypatch.setattr(remediation, "emitter", lambda: emitter)
    return recorded


def _outcomes(events, mechanism):
    return [(e["outcome"], e["attempt"]) for e in events if e["mechanism_id"] == mechanism]


def test_recovery_opens_once_counts_attempts_and_ends_once(events):
    recovery = remediation.Recovery(component="c", mechanism_id="provider.futu_opend_reconnect")
    assert recovery.finish("succeeded") is False          # nothing failed: nothing recorded
    recovery.failed("opend_unreachable", identity={"host": "127.0.0.1", "source": "futu"})
    recovery.failed("connection_lost")
    recovery.failed("connection_lost")
    assert recovery.finish("succeeded") is True
    assert recovery.finish("succeeded") is False
    assert _outcomes(events, "provider.futu_opend_reconnect") == [("started", 0), ("succeeded", 3)]
    started = events[0]
    assert started["trigger_reason"] == "opend_unreachable"
    # Identity beyond the shared fields is kept in the detail, not dropped.
    assert started["identity"]["source"] == "futu"
    assert "127.0.0.1" in started["detail"]["identity_extra"]


class _Sdk:
    SubType = SimpleNamespace(QUOTE="QUOTE", RT_DATA="RT_DATA", TICKER="TICKER", ORDER_BOOK="ORDER_BOOK")


def test_futu_pair_subscribe_retry_is_one_operation_until_it_succeeds(events, monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(futu_subscriptions.time, "monotonic", lambda: clock[0])
    manager = FutuSubscriptionManager(minimum_subscription_seconds=0)
    manager.observe_quota({"total_used": 0, "remain": 1000, "own_used": 0})  # OpenD's quota, read before a context subscribes
    manager.replace_plan([{"market": "US", "code": "US.AAPL", "kinds": ["quote"]}])
    failing = [True]

    def call(_context, operation, codes, subtypes, **_kwargs):
        if operation == "subscribe" and failing[0]:
            raise RuntimeError("quota")

    manager.sync(object(), _Sdk, session_current=lambda: True, call=call)
    clock[0] += 60
    manager.sync(object(), _Sdk, session_current=lambda: True, call=call)
    failing[0] = False
    clock[0] += 60
    manager.sync(object(), _Sdk, session_current=lambda: True, call=call)
    rows = _outcomes(events, "provider.futu_subscribe_retry")
    pairs = len(manager.desired_pairs())
    # One operation per (code, subtype) pair, each ended once after its two failed tries.
    assert sorted(rows) == sorted([("started", 0)] * pairs + [("succeeded", 2)] * pairs)


def test_futu_pair_retry_is_abandoned_when_the_plan_drops_it_or_the_context_resets(events):
    manager = FutuSubscriptionManager(minimum_subscription_seconds=0)
    manager.observe_quota({"total_used": 0, "remain": 1000, "own_used": 0})  # OpenD's quota, read before a context subscribes
    manager.replace_plan([{"market": "US", "code": "US.AAPL", "kinds": ["quote"]}])

    def call(*_args, **_kwargs):
        raise RuntimeError("quota")

    manager.sync(object(), _Sdk, session_current=lambda: True, call=call)
    pairs = len(manager.desired_pairs())
    manager.replace_plan([])
    manager.sync(object(), _Sdk, session_current=lambda: True, call=call)
    rows = _outcomes(events, "provider.futu_subscribe_retry")
    assert sorted(rows) == sorted([("started", 0)] * pairs + [("abandoned", 1)] * pairs)

    manager.replace_plan([{"market": "US", "code": "US.MSFT", "kinds": ["quote"]}])
    manager.sync(object(), _Sdk, session_current=lambda: True, call=call)
    manager.reset_session()
    finished = [e for e in events if e["mechanism_id"] == "provider.futu_subscribe_retry" and e["outcome"] == "abandoned"]
    assert finished[-1]["detail"]["reason"] == "session_reset"


def test_shioaji_session_recovery_records_trigger_and_resubscribe(events, monkeypatch):
    from service.market.shioaji.session import ShioajiBrokerService

    service = ShioajiBrokerService.__new__(ShioajiBrokerService)
    service._session_recovery = None
    service._session_recovery_attempts = 0
    service._session_generation = 4
    service.credential_service = SimpleNamespace(redact_text=lambda exc, *_a: str(exc))
    service._begin_session_recovery("subscription_sync_failed", RuntimeError("lane refused"))
    service._begin_session_recovery("login_failed", RuntimeError("timeout"))
    service._finish_session_recovery("succeeded", {"resubscribed_lanes": 12})
    rows = [e for e in events if e["mechanism_id"] == "provider.broker_session_reconnect"]
    assert [(e["outcome"], e["attempt"]) for e in rows] == [("started", 0), ("succeeded", 2)]
    assert rows[0]["trigger_reason"] == "subscription_sync_failed"
    assert rows[1]["detail"]["resubscribed_lanes"] == 12


def test_futu_manual_recheck_is_the_users_action_not_a_remediation(events, monkeypatch, caplog):
    # docs/decisions.md 什麼算補救: 重新檢查 is the user's action; its outcome goes to the operation log.
    from service.market.futu import daemon_client as futu

    client = futu.MoomooDaemonClient()
    monkeypatch.setattr(client, "start", lambda: {"ok": False, "error": "OpenD not running",
                                                  "classification": "OPEND_NOT_RUNNING"})
    with caplog.at_level("INFO", logger=futu.__name__):
        assert client.manual_reattach()["ok"] is False
    assert [e for e in events if e["mechanism_id"] == "client.futu_daemon_attach"] == []
    assert any("重新檢查 requested by the user" in r.getMessage() and "OPEND_NOT_RUNNING" in r.getMessage()
               for r in caplog.records)


def test_daemon_stream_records_a_refused_connection_and_abandons_on_stop(events, monkeypatch):
    from service.market.shioaji import daemon_stream

    running = threading.Event()
    running.set()
    tries = []

    def connect(*_args, **_kwargs):
        tries.append(1)
        if len(tries) >= 2:
            running.clear()
        raise ConnectionRefusedError("refused")

    import websockets.sync.client as ws_client
    monkeypatch.setattr(ws_client, "connect", connect)
    monkeypatch.setattr(daemon_stream, "_pause_while", lambda *_a: None)
    stream = daemon_stream.MarketDaemonStream(client_id="c1", heartbeat_seconds=5.0, prepare_connection=lambda: None,
                                              route=lambda _m: None, failed=lambda _m: None)
    stream.run(running)
    rows = _outcomes(events, "client.shioaji_stream_reconnect")
    assert rows == [("started", 0), ("abandoned", 1)]
    assert events[0]["trigger_reason"] == "connect_failed"


def test_daemon_stream_recovers_only_on_an_attached_frame_the_router_accepted(events, monkeypatch):
    """The stream ended its recovery on the attached frame's type alone, even when the router had
    refused it for a wrong daemon identity."""
    import json

    from service.market.shioaji import daemon_stream

    running = threading.Event()
    running.set()
    frames = [{"type": "system.market_daemon.attached", "payload": {"identity": "someone-else"}},
              {"type": "system.market_daemon.attached", "payload": {"identity": "ours"}}]

    class Socket:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def recv(self, timeout=None):
            if not frames:
                running.clear()
                return None
            return json.dumps(frames.pop(0))

        def send(self, _raw):
            pass

    connections = []

    def connect(*_args, **_kwargs):
        connections.append(1)
        if len(connections) == 1:
            raise ConnectionRefusedError("refused")   # the loss that opens the recovery
        return Socket()

    import websockets.sync.client as ws_client
    monkeypatch.setattr(ws_client, "connect", connect)
    monkeypatch.setattr(daemon_stream, "_pause_while", lambda *_a: None)
    stream = daemon_stream.MarketDaemonStream(
        client_id="c1", heartbeat_seconds=5.0, prepare_connection=lambda: None,
        route=lambda m: m.get("type") == "system.market_daemon.attached" and m["payload"]["identity"] == "ours",
        failed=lambda _m: None)
    stream.run(running)
    rows = _outcomes(events, "client.shioaji_stream_reconnect")
    # One recovery: opened by the refused connection, the refused attached frame one more attempt, ended by the
    # accepted one (it used to end at attempt 1, on the refused frame).
    assert rows == [("started", 0), ("succeeded", 2)], rows
