from __future__ import annotations

import logging
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from service.market.shared.broker_operation_log import (
    broker_operation, broker_operation_batch,
)
from service.market.shioaji import session as shioaji
from service.market.futu import opend_lifecycle as futu
from service.market.futu.service import FutuMarketService


def records(caplog):
    return [r.getMessage() for r in caplog.records
            if r.name == "service.market.shared.broker_operation_log"]


def broker(monkeypatch):
    svc = shioaji.ShioajiBrokerService(event_sink=MagicMock(), credential_service=MagicMock())
    svc._session_generation = 42
    # The on-disk seed is not under test here: the next generation is the requested one (generation_seed has its own).
    monkeypatch.setattr(shioaji, "_advance_generation_seed", lambda value: value)
    svc._api = MagicMock()
    svc._sj = object()
    svc._connected.set()
    monkeypatch.setattr(svc, "_quote_type_value", lambda sdk, lane: lane)
    monkeypatch.setattr(svc, "_resolve_contract", lambda identity: SimpleNamespace(code=identity.code))
    return svc


@pytest.mark.parametrize("failed", [False, True])
def test_shioaji_bulk_sync_is_bounded_and_idle_sync_is_quiet(monkeypatch, caplog, failed):
    caplog.set_level(logging.INFO)
    svc = broker(monkeypatch)
    codes = [str(2000 + n) for n in range(60)]
    svc.subscription_manager.replace_plan([{"market": "STK", "code": code} for code in codes])
    if failed:
        svc._api.subscribe.side_effect = RuntimeError("broker rejected")
    svc._sync_subscriptions(force=True)
    lines = records(caplog)
    assert len(lines) == 1
    assert "subscribe symbol/lane=" in lines[0] and "session_generation=42" in lines[0]
    assert f"result={'failed' if failed else 'ok'}" in lines[0]
    assert len(lines[0]) < 300
    if failed:
        assert len([r for r in caplog.records if r.levelno == logging.ERROR]) == 1
        return
    caplog.clear()
    svc._sync_subscriptions()
    assert records(caplog) == []
    svc.subscription_manager.replace_plan([])
    svc._sync_subscriptions()
    assert len(records(caplog)) == 1
    assert "unsubscribe symbol/lane=" in records(caplog)[0]


@pytest.mark.parametrize("failed", [False, True])
def test_shioaji_single_lane_and_uncertain_unsubscribe(monkeypatch, caplog, failed):
    caplog.set_level(logging.INFO)
    svc = broker(monkeypatch)
    identity = shioaji.StreamIdentity("STK", "2330", "Tick")
    svc._subscribe_stream(identity)
    if failed:
        svc._api.unsubscribe.side_effect = RuntimeError("uncertain")
    assert svc._unsubscribe_stream(identity) is (not failed)
    lines = records(caplog)
    assert len(lines) == 2
    assert "subscribe symbol/lane=2330/Tick session_generation=42 result=ok" in lines[0]
    assert f"result={'failed' if failed else 'ok'}" in lines[1]
    assert (identity.key in svc._active_subscription_keys) is failed


@pytest.mark.parametrize("method", ["logout_after_drain", "_disconnect"])
@pytest.mark.parametrize("failed", [False, True])
def test_shioaji_logout_paths_and_repeated_logout(monkeypatch, caplog, method, failed):
    caplog.set_level(logging.INFO)
    svc = broker(monkeypatch)
    if failed:
        svc._api.logout.side_effect = RuntimeError("logout rejected")
    getattr(svc, method)()
    getattr(svc, method)()
    assert len(records(caplog)) == 1
    assert f"logout symbol/lane=-/- session_generation=42 result={'failed' if failed else 'ok'}" in records(caplog)[0]


@pytest.mark.parametrize("failed", [False, True])
def test_shioaji_login_result_and_generation(monkeypatch, caplog, failed):
    caplog.set_level(logging.INFO)
    svc = broker(monkeypatch)
    api = MagicMock()
    if failed:
        api.login.side_effect = RuntimeError("secret must not appear")
    svc.credential_service.load_shioaji_credentials.return_value = SimpleNamespace(api_key="key", secret_key="secret")
    monkeypatch.setitem(sys.modules, "shioaji", SimpleNamespace(Shioaji=lambda **kwargs: api))
    monkeypatch.setattr(shioaji, "configure_shioaji_log_path", lambda: None)
    monkeypatch.setattr(shioaji, "ensure_shioaji_log_rotation", lambda: None)
    monkeypatch.setattr(svc, "_register_callbacks", lambda api: None)
    monkeypatch.setattr(svc, "_sync_subscriptions", lambda **kwargs: [])
    if failed:
        with pytest.raises(RuntimeError):
            svc._connect()
    else:
        svc._connect()
        assert svc._session_generation == 43
    assert len(records(caplog)) == 1
    assert f"login symbol/lane=-/- session_generation=43 result={'failed' if failed else 'ok'}" in records(caplog)[0]
    assert "secret" not in records(caplog)[0]


def futu_service(tmp_path, monkeypatch):
    monkeypatch.setenv("FUTU_SECURITY_MASTER_FILE", str(tmp_path / "security.csv"))
    svc = FutuMarketService(tmp_path / "futu.db", event_sink=MagicMock())
    svc.subscription_manager.observe_quota({"total_used": 0, "remain": 1000, "own_used": 0})  # OpenD's quota, read before a context subscribes
    svc._opend.context_generation = 42
    svc.advance_context_generation = lambda value: value   # the on-disk seed is not under test here
    svc._opend.sdk = SimpleNamespace(RET_OK=0, SubType=SimpleNamespace(
        QUOTE="QUOTE", RT_DATA="RT_DATA", TICKER="TICKER", ORDER_BOOK="ORDER_BOOK"))
    return svc


def test_futu_bulk_reconnect_idle_and_unsubscribe(tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    svc = futu_service(tmp_path, monkeypatch)
    codes = [f"US.TEST{n}" for n in range(100)]
    svc.subscription_manager.replace_plan([{"market": "US", "code": code, "kinds": ["quote", "trade"]} for code in codes])
    context = MagicMock()
    context.subscribe.return_value = (0, "ok")
    context.unsubscribe.return_value = (0, "ok")
    svc._opend.context = context   # the open quote context the cycle syncs
    svc.subscription_manager.minimum_subscription_seconds = 0
    svc.opend_lifecycle.sync_context(context)
    assert len(records(caplog)) == 1 and len(records(caplog)[0]) < 300
    caplog.clear()
    svc.opend_lifecycle.sync_context(context)
    assert records(caplog) == []
    svc.subscription_manager.reset_session()
    svc.subscription_manager.observe_quota({"total_used": 0, "remain": 1000, "own_used": 0})  # the new context's quota
    svc._opend.context_generation = 43
    svc.opend_lifecycle.sync_context(context)
    assert len(records(caplog)) == 1 and "session_generation=43" in records(caplog)[0]
    caplog.clear()
    svc.subscription_manager.replace_plan([])
    svc.opend_lifecycle.sync_context(context)
    assert len(records(caplog)) == 1 and "unsubscribe" in records(caplog)[0]


@pytest.mark.parametrize("exception", [False, True])
def test_futu_failed_call_is_logged_without_payload(tmp_path, monkeypatch, caplog, exception):
    caplog.set_level(logging.INFO)
    svc = futu_service(tmp_path, monkeypatch)
    context = MagicMock()
    if exception:
        context.subscribe.side_effect = RuntimeError("private payload")
    else:
        context.subscribe.return_value = (1, "private payload")
    with pytest.raises(RuntimeError):
        svc._call(context, "subscribe", ["US.AAPL"], ["QUOTE"])
    assert len(records(caplog)) == 1
    assert "US.AAPL/QUOTE session_generation=42 result=failed" in records(caplog)[0]
    assert "private payload" not in records(caplog)[0]


@pytest.mark.parametrize("failed", [False, True])
def test_futu_context_login_logout(tmp_path, monkeypatch, caplog, failed):
    caplog.set_level(logging.INFO)
    svc = futu_service(tmp_path, monkeypatch)
    context = MagicMock()
    def open_context(**kwargs):
        if failed:
            svc._stop.set()
            raise RuntimeError("open failed")
        return context
    svc._opend.sdk.OpenQuoteContext = open_context
    monkeypatch.setattr(svc.opend_lifecycle, "load_sdk", lambda: svc._opend.sdk)
    monkeypatch.setattr(futu, "_opend_port_reachable", lambda *args: True)
    monkeypatch.setattr(svc.opend_lifecycle, "install_push_handlers", lambda context: svc._stop.set())
    svc.opend_lifecycle.run()
    svc._close_context()
    lines = records(caplog)
    assert len(lines) == (1 if failed else 2)
    assert f"login symbol/lane=-/quote_context session_generation=43 result={'failed' if failed else 'ok'}" in lines[0]
    if not failed:
        assert "logout symbol/lane=-/quote_context session_generation=43 result=ok" in lines[1]


def test_nested_batch_partial_result_and_exception_cleanup(caplog):
    caplog.set_level(logging.INFO)
    with broker_operation_batch():
        with broker_operation("futu", "subscribe", 42, symbol="US.AAPL", lane="QUOTE"):
            pass
        with pytest.raises(RuntimeError), broker_operation_batch():
            with broker_operation("futu", "subscribe", 42, symbol="US.MSFT", lane="QUOTE"):
                raise RuntimeError("private")
    assert len(records(caplog)) == 1
    assert "result=partial ok=1 failed=1" in records(caplog)[0]
    with broker_operation_batch():
        pass
    assert len(records(caplog)) == 1


@pytest.mark.parametrize("method", ["begin_graceful_shutdown", "_disconnect"])
def test_shioaji_shutdown_unsubscribe_is_one_summary(monkeypatch, caplog, method):
    caplog.set_level(logging.INFO)
    svc = broker(monkeypatch)
    for n in range(60):
        svc._subscribe_stream(shioaji.StreamIdentity("STK", str(2000 + n), "Tick"))
    caplog.clear()
    getattr(svc, method)()
    lines = records(caplog)
    unsubscribes = [line for line in lines if "] unsubscribe " in line]
    assert len(unsubscribes) == 1
    assert "result=ok ok=60 failed=0" in unsubscribes[0]


def test_futu_deferred_unsubscribe_is_quiet_and_failure_is_recorded(tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    svc = futu_service(tmp_path, monkeypatch)
    context = MagicMock()
    context.subscribe.return_value = (0, "ok")
    svc.subscription_manager.subscribe(context, svc._opend.sdk, ["US.AAPL"], ["QUOTE"], session_current=lambda: True, call=svc._call)
    caplog.clear()
    assert not svc.subscription_manager.unsubscribe_pair(context, "US.AAPL", "QUOTE", session_current=lambda: True, call=svc._call)
    assert records(caplog) == []
    svc.subscription_manager.minimum_subscription_seconds = 0
    context.unsubscribe.return_value = (1, "private")
    assert not svc.subscription_manager.unsubscribe_pair(context, "US.AAPL", "QUOTE", session_current=lambda: True, call=svc._call)
    assert len(records(caplog)) == 1
    assert "unsubscribe symbol/lane=US.AAPL/QUOTE session_generation=42 result=failed" in records(caplog)[0]
    caplog.clear()
    assert not svc.subscription_manager.unsubscribe_pair(context, "US.AAPL", "QUOTE", session_current=lambda: True, call=svc._call)
    assert records(caplog) == []


def test_futu_logout_failure_is_logged_once(tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    svc = futu_service(tmp_path, monkeypatch)
    svc._opend.context = MagicMock()
    svc._opend.context.close.side_effect = RuntimeError("private")
    svc._close_context()
    svc._close_context()
    assert len(records(caplog)) == 1
    assert "logout symbol/lane=-/quote_context session_generation=42 result=failed" in records(caplog)[0]


def test_graceful_shutdown_never_unsubscribes_beside_a_running_sync(monkeypatch):
    """After a join that timed out, the unsubscribes ran without the sync mutex, beside the sync."""
    import threading

    svc = broker(monkeypatch)
    svc._subscribe_stream(shioaji.StreamIdentity("STK", "2330", "Tick"))
    unsubscribed = []
    original = svc._unsubscribe_stream
    svc._unsubscribe_stream = lambda identity: unsubscribed.append(identity) or original(identity)
    holding, release = threading.Event(), threading.Event()

    def sync_in_progress():
        with svc._sync_mutex:
            holding.set()
            release.wait(5)

    worker = threading.Thread(target=sync_in_progress, daemon=True)
    worker.start()
    assert holding.wait(5)
    result = svc.begin_graceful_shutdown(timeout=0.05)
    assert result["unsubscribe"] == "SKIPPED_SYNC_BUSY" and unsubscribed == [], "not raced with the sync"
    release.set()
    worker.join(5)
    assert svc.begin_graceful_shutdown(timeout=1.0)["unsubscribe"] == "DONE" and len(unsubscribed) == 1
