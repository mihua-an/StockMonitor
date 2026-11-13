"""The provider's stop closes the OpenD quote context from its own thread at any point of a subscription pass.

A call that fails because of that close is no pair to retry: reset_session() has already abandoned the open retries
and no one would ever finish a new one (20 left open by the 10-14 10:51 stop). And a pass must not go on after the
close: reset_session() empties the confirmed set, so the rest of the pass would send the whole plan to the closed
context -- the 10-28 22:10:40 full close did exactly that (30 subscribe calls, each `Connection closed`, each a
provider.futu_subscribe_retry abandoned 5 ms later) because the stop landed between the cycle's check and the first
subscribe of the pass."""
from __future__ import annotations

import threading
from types import SimpleNamespace

from service.market.futu import opend_lifecycle
from service.market.futu import subscriptions as module
from service.market.futu.opend_lifecycle import FutuOpenDLifecycle, OpenDConnectionState
from service.market.futu.subscriptions import FutuSubscriptionManager

_SDK = SimpleNamespace(RET_OK=0, SubType=SimpleNamespace(QUOTE="QUOTE", RT_DATA="RT_DATA", TICKER="TICKER",
                                                         ORDER_BOOK="ORDER_BOOK"))


class _Recorder:
    def __init__(self):
        self.started, self.finished = [], []

    def begin(self, *, mechanism_id, **kw):
        recorder = self

        class Op:
            def finish(self, outcome, **_kw):
                recorder.finished.append((mechanism_id, outcome))

        self.started.append(mechanism_id)
        return Op()


def test_a_failure_on_a_session_closed_meanwhile_opens_no_retry(monkeypatch):
    recorder = _Recorder()
    monkeypatch.setattr(module.remediation, "emitter", lambda: recorder)
    manager = FutuSubscriptionManager()
    manager.observe_quota({"total_used": 0, "remain": 1000, "own_used": 0})  # OpenD's quota, read before a context subscribes
    session = {"open": True}
    calls = []

    def closing_call(_context, _op, codes, _subtypes, **_kw):
        calls.append(codes[0])
        session["open"] = False              # the stop closes the context during the call
        manager.reset_session()
        raise RuntimeError("quote context closed")

    manager.subscribe(object(), _SDK, ["US.AAPL", "US.TSM", "US.NOK"], ["QUOTE"], call=closing_call,
                      session_current=lambda: session["open"])
    assert calls == ["US.AAPL"], "the pass ends with its session"
    assert recorder.started == [] and manager._retry_ops == {}, "a close-caused failure is no retry"

    # On a live session a failure is still a retry, finished when the pair subscribes.
    def busy(*_a, **_k):
        raise RuntimeError("busy")

    manager.subscribe(object(), _SDK, ["US.AAPL"], ["QUOTE"], call=busy, session_current=lambda: True)
    assert recorder.started == ["provider.futu_subscribe_retry"]
    manager.subscribe_retry_after.clear()
    manager.subscribe(object(), _SDK, ["US.AAPL"], ["QUOTE"], call=lambda *a, **k: None, session_current=lambda: True)
    assert recorder.finished == [("provider.futu_subscribe_retry", "succeeded")]


class _ClosedAwareContext:
    """An OpenD quote context: answers while open, `Connection closed` once closed."""

    def __init__(self):
        self.open = True
        self.calls: list[tuple[str, str, str]] = []

    def close(self):
        self.open = False

    def _answer(self, method, codes, subtypes):
        self.calls.append((method, codes[0], str(subtypes[0])))
        return (0, "ok") if self.open else (-1, "Connection closed")

    def subscribe(self, codes, subtypes, **_kw):
        return self._answer("subscribe", codes, subtypes)

    def unsubscribe(self, codes, subtypes, **_kw):
        return self._answer("unsubscribe", codes, subtypes)

    def get_market_snapshot(self, _codes):
        raise AssertionError("no snapshot read on a closed session")


def _provider(manager, codes_hook):
    return SimpleNamespace(
        subscription_manager=manager, operation_state={},
        pollable_watch_codes=codes_hook,
        notify_subscriptions_changed=lambda: None,
        reset_lane_activity=lambda: None,
        provider_backend=SimpleNamespace(reset_callbacks=lambda: None),
        reference=SimpleNamespace(run=lambda *_a, **_k: None),
        trend_backfill=SimpleNamespace(run=lambda *_a, **_k: 0),
    )


def test_a_stop_between_the_cycle_check_and_the_first_subscribe_sends_nothing_to_the_closed_context(monkeypatch):
    recorder = _Recorder()
    monkeypatch.setattr(module.remediation, "emitter", lambda: recorder)
    failures: list[str] = []
    monkeypatch.setattr(opend_lifecycle, "record_failure", lambda _log, what, exc: failures.append(what))
    monkeypatch.setattr(opend_lifecycle, "api_call", _null_api_call)

    manager = FutuSubscriptionManager()
    manager.observe_quota({"total_used": 0, "remain": 1000, "own_used": 0})  # OpenD's quota, read before a context subscribes
    manager.replace_plan([{"market": "US", "code": code, "kinds": ["quote", "trade", "orderbook"]}
                          for code in ("US.ASX", "US.MU", "US.UMC")])
    stop = threading.Event()
    lifecycle_box = {}

    def stop_lands_now():
        # The daemon's graceful stop on its own thread: stop flag, then close_context (as FutuProviderService.stop).
        stop.set()
        lifecycle_box["lifecycle"].close_context()
        return [], []

    provider = _provider(manager, stop_lands_now)
    state = OpenDConnectionState(context_generation=7, sdk=_SDK)
    lifecycle = FutuOpenDLifecycle(provider, state=state, lock=threading.RLock(), stop=stop, wake=threading.Event())
    lifecycle_box["lifecycle"] = lifecycle
    context = _ClosedAwareContext()
    state.context = context
    manager.reset_session()

    assert lifecycle.context_current(context), "the cycle's check passes: the stop has not landed yet"
    done = lifecycle.run_operation("subscription_sync", lambda: lifecycle.sync_context(context))

    assert done is False, "the step did not reach the plan"
    assert context.calls == [], "no subscribe is sent to the closed context"
    assert recorder.started == [] and manager._retry_ops == {}, "a closed session opens no subscribe retry"
    assert failures == [], "the close under the step is not a step failure"
    assert "subscription_sync" not in provider.operation_state or provider.operation_state["subscription_sync"].get("ok") is not False


def test_a_live_session_still_subscribes_the_whole_plan(monkeypatch):
    monkeypatch.setattr(module.remediation, "emitter", lambda: _Recorder())
    manager = FutuSubscriptionManager()
    manager.observe_quota({"total_used": 0, "remain": 1000, "own_used": 0})  # OpenD's quota, read before a context subscribes
    manager.replace_plan([{"market": "US", "code": "US.MU", "kinds": ["quote", "trade", "orderbook"]}])
    provider = _provider(manager, lambda: ([], []))
    state = OpenDConnectionState(context_generation=7, sdk=_SDK)
    lifecycle = FutuOpenDLifecycle(provider, state=state, lock=threading.RLock(), stop=threading.Event(),
                                   wake=threading.Event())
    context = _ClosedAwareContext()
    state.context = context

    assert lifecycle.run_operation("subscription_sync", lambda: lifecycle.sync_context(context)) is True
    assert {lane for _m, _code, lane in context.calls} == {"QUOTE", "RT_DATA", "TICKER", "ORDER_BOOK"}


class _null_api_call:
    def __init__(self, *_a, **_k):
        self.detail = {}

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False
