"""Futu cycle step state (R12-02, R12-03): a subscription sync whose missing pairs all wait out their own retry time
is pending, not a new failure every 0.2 s cycle; and a recovered step, subscription or reference carries no current
error beside its success -- the failure stays as last_failure with its recovery time."""
from __future__ import annotations

import threading
from types import SimpleNamespace

from service.market.futu import subscriptions as subscriptions_module
from service.market.futu.opend_lifecycle import FutuOpenDLifecycle
from service.market.futu.reference import RETRY_SECONDS, FutuReferencePublisher
from service.market.futu.subscriptions import FutuSubscriptionManager


def no_kline(code, start, end):
    raise AssertionError(f"no crypto here: 1-minute bars of {code} asked")

_SDK = SimpleNamespace(SubType=SimpleNamespace(QUOTE="QUOTE", RT_DATA="RT_DATA", TICKER="TICKER", ORDER_BOOK="ORDER_BOOK"))


class _Remediation:
    def begin(self, **_kw):
        return SimpleNamespace(finish=lambda *a, **k: None)


def _owner():
    from service.market.futu.opend_lifecycle import OpenDConnectionState

    return SimpleNamespace(operation_state={}, state=OpenDConnectionState(context_generation=1))


def _lifecycle(owner):
    return FutuOpenDLifecycle(owner, state=owner.state, lock=threading.RLock(), stop=threading.Event(),
                              wake=threading.Event())


def test_a_pending_sync_records_no_new_failure_and_a_success_clears_the_current_error(monkeypatch):
    from service.market.futu import opend_lifecycle

    recorded: list[str] = []
    monkeypatch.setattr(opend_lifecycle, "record_failure", lambda _log, what, exc: recorded.append(what))
    owner = _owner()
    lifecycle = _lifecycle(owner)

    assert lifecycle.run_operation("subscription_sync", lambda: {"ok": False, "error": "1 of 1 desired pairs not confirmed"}) is False
    state = owner.operation_state["subscription_sync"]
    assert state["current_error"] and state["failures"] == 1 and len(recorded) == 1 and owner.state.last_error

    for _ in range(25):   # five seconds of 0.2 s cycles waiting out the pair's back-off
        assert lifecycle.run_operation("subscription_sync", lambda: {"ok": False, "pending": True, "retry_in_seconds": 3.0}) is False
    assert state["failures"] == 1 and len(recorded) == 1, "waiting is not failing again"
    assert state["pending"] is True and state["current_error"], "still not subscribed: the current error stays"

    assert lifecycle.run_operation("subscription_sync", lambda: {"ok": True}) is True
    assert state["ok"] is True and state["current_error"] is None and state["pending"] is False
    assert state["last_failure"]["recovered_at"], "the failure is history with its recovery time"
    assert owner.state.last_error == "", "the provider's current error was that step's: cleared"


def test_a_sync_waiting_out_back_offs_is_pending_and_a_recovered_pair_clears_the_error(monkeypatch):
    monkeypatch.setattr(subscriptions_module.remediation, "emitter", lambda: _Remediation())
    manager = FutuSubscriptionManager(minimum_subscription_seconds=0)
    manager.observe_quota({"total_used": 0, "remain": 1000, "own_used": 0})  # OpenD's quota, read before a context subscribes
    manager.replace_plan([{"market": "US", "code": "US.AAPL", "kinds": ["quote"]}])
    busy = {"on": True}

    def call(_context, _op, codes, _subtypes, **_kw):
        if busy["on"]:
            raise RuntimeError("busy")

    first = manager.sync(object(), _SDK, session_current=lambda: True, call=call)
    assert first["ok"] is False and first["pending"] is False, "a real attempt failed"
    second = manager.sync(object(), _SDK, session_current=lambda: True, call=call)
    assert second["ok"] is False and second["pending"] is True and second["retry_in_seconds"] is not None
    assert manager.snapshot()["last_error"]

    busy["on"] = False
    manager.subscribe_retry_after.clear()
    assert manager.sync(object(), _SDK, session_current=lambda: True, call=call)["ok"] is True
    snapshot = manager.snapshot()
    assert snapshot["last_error"] is None and snapshot["last_failure"]["recovered_at"]


def test_a_reference_snapshot_that_works_again_clears_its_current_error():
    clock = SimpleNamespace(t=1000.0)
    publisher = FutuReferencePublisher(lambda *a: True, monotonic=lambda: clock.t)

    def broken(_codes):
        raise RuntimeError("quota")

    publisher.run(broken, ["US.TSM"], no_kline)
    assert publisher.snapshot_status()["last_error"]
    clock.t += RETRY_SECONDS
    publisher.run(lambda codes: [{"code": "US.TSM", "prev_close_price": 10.0}], ["US.TSM"], no_kline)
    status = publisher.snapshot_status()
    assert status["last_error"] == "" and status["last_failure"]["recovered_at"]
