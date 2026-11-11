"""The Futu provider's quota route, its worker while OpenD is away, and a plan replaced during a sync."""
from __future__ import annotations

import threading
from types import SimpleNamespace
from unittest.mock import MagicMock

from backend.futu.routes import FutuRouteDependencies, create_futu_router
from backend.futu.runtime import FutuRuntime
from service.market.futu import opend_lifecycle
from service.market.futu.opend_lifecycle import FutuOpenDLifecycle, OpenDConnectionState
from service.market.futu.service import FutuMarketService
from service.market.futu.subscriptions import FutuSubscriptionManager

SDK = SimpleNamespace(SubType=SimpleNamespace(QUOTE="QUOTE", RT_DATA="RT_DATA", TICKER="TICKER", ORDER_BOOK="ORDER_BOOK"), RET_OK=0)
QUOTA = {"total_used": 0, "remain": 100, "own_used": 0}


def _plan(*codes: str) -> list[dict]:
    return [{"market": code.split(".", 1)[0], "code": code, "kinds": []} for code in codes]


def _manager() -> FutuSubscriptionManager:
    manager = FutuSubscriptionManager(minimum_subscription_seconds=0)
    manager.observe_quota(QUOTA)
    return manager


def _sync(manager: FutuSubscriptionManager, call) -> dict:
    return manager.sync(object(), SDK, call=call, session_current=lambda: True)


def test_the_quota_route_answers_through_the_real_runtime(tmp_path, monkeypatch):
    monkeypatch.setenv("FUTU_SECURITY_MASTER_FILE", str(tmp_path / "security.csv"))
    service = FutuMarketService(tmp_path / "futu.db", event_sink=MagicMock())
    service.subscription_manager.observe_quota(QUOTA)
    runtime = FutuRuntime(service_factory=lambda: service)
    runtime._service = service
    router = create_futu_router(FutuRouteDependencies(runtime=runtime, daemon_health=dict))
    route = next(r.endpoint for r in router.routes if r.path == "/v1/futu/subscription-quota")
    answer = route()
    assert answer["ok"] is True and answer["known"] is True and answer["streams"] == 100
    # A reader asks OpenD again, so a raised quota is seen without a reconnect.
    assert service.subscription_manager.quota_due() is True


def test_a_failed_tick_while_opend_is_away_does_not_end_the_worker(monkeypatch):
    monkeypatch.setattr(opend_lifecycle, "_opend_port_reachable", lambda *_a, **_k: False)
    stop = threading.Event()
    ticks = []

    def tick():
        ticks.append(1)
        if len(ticks) == 1:
            raise RuntimeError("market runtime is restarting")
        stop.set()

    provider = MagicMock(host="127.0.0.1", port=11111, operation_state={})
    provider.session_lifecycle.tick = tick
    lifecycle = FutuOpenDLifecycle(provider, state=OpenDConnectionState(context_generation=0), lock=threading.RLock(),
                                   stop=stop, wake=threading.Event())
    # Not waiting out the reconnect back-off: the second pass is what this test is about.
    monkeypatch.setattr(stop, "wait", lambda _seconds: stop.is_set())
    lifecycle.run()
    assert len(ticks) == 2
    state = provider.operation_state["session_lifecycle"]
    assert state["failures"] == 1 and state["ok"] is True and state["current_error"] is None


def test_a_pair_dropped_during_the_pass_is_not_subscribed_and_is_no_failure():
    manager = _manager()
    manager.replace_plan(_plan("US.AAA", "US.BBB"))
    calls = []

    def call(_context, method, codes, subtypes, **_kwargs):
        calls.append((method, codes[0], str(subtypes[0])))
        manager.replace_plan(_plan("US.AAA"))

    outcome = _sync(manager, call)
    assert not [entry for entry in calls if entry[1] == "US.BBB"], calls
    assert outcome["ok"] is True and outcome["error"] is None and outcome["desired"] == 2


def test_a_pair_wanted_again_during_the_pass_is_not_unsubscribed():
    manager = _manager()
    manager.replace_plan(_plan("US.AAA", "US.BBB"))
    _sync(manager, lambda *_a, **_k: None)
    manager.replace_plan([])
    calls = []

    def call(_context, method, codes, subtypes, **_kwargs):
        calls.append((method, codes[0], str(subtypes[0])))
        manager.replace_plan(_plan("US.BBB"))

    outcome = _sync(manager, call)
    assert calls and all(entry[1] == "US.AAA" for entry in calls), calls
    assert manager.is_confirmed("US.BBB", "QUOTE") and manager.is_confirmed("US.BBB", "RT_DATA")
    assert outcome["ok"] is True
