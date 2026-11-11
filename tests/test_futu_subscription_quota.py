"""Futu's subscription capacity is OpenD's quota, in OpenD's unit (decisions.md 富途的訂閱管理): every type of every
instrument is one subscription (報價 QUOTE + 分時 RT_DATA always, 明細 TICKER, 五檔 ORDER_BOOK), the quota is what
``query_subscription`` answers -- never a fixed number of symbols --, Market Runtime plans the Futu streams within it
(stream_budget), and the provider asks OpenD only for what it has room for (unsubscribes first; a pair the plan dropped
inside OpenD's one-minute minimum is 退訂中 and holds its room)."""
from __future__ import annotations

import threading
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from service.market.futu.service import FutuMarketService
from service.market.futu.subscriptions import FutuSubscriptionManager
from service.market.shared.adapter_control import AdapterControlConnection
from service.platform import remediation

SDK = SimpleNamespace(SubType=SimpleNamespace(QUOTE="QUOTE", RT_DATA="RT_DATA", TICKER="TICKER", ORDER_BOOK="ORDER_BOOK"), RET_OK=0)
FUTU_KINDS = {"orderbook": 1, "quote": 2, "trade": 1}
# 11-01: query_subscription answered total_used 29, remain 71 for 9 symbols.
OPEND_11_01 = {"total_used": 29, "remain": 71, "own_used": 29}


def _service(tmp_path, monkeypatch, sink=None) -> FutuMarketService:
    monkeypatch.setenv("FUTU_SECURITY_MASTER_FILE", str(tmp_path / "security.csv"))
    return FutuMarketService(tmp_path / "futu.db", event_sink=sink or MagicMock())


class _OpenD:
    """A quote context: subscribe/unsubscribe recorded, at most `quota` pairs held (OpenD refuses past it)."""

    def __init__(self, quota: int) -> None:
        self.quota = quota
        self.held: set[tuple[str, str]] = set()
        self.calls: list[tuple[str, str, str]] = []

    def call(self, _context, method, codes, subtypes, **_kwargs):
        pair = (codes[0], str(subtypes[0]))
        self.calls.append((method, *pair))
        if method == "subscribe":
            if len(self.held) >= self.quota:
                raise RuntimeError("订阅额度不足")
            self.held.add(pair)
        else:
            self.held.discard(pair)


def _sync(manager: FutuSubscriptionManager, opend: _OpenD) -> dict:
    return manager.sync(object(), SDK, call=opend.call, session_current=lambda: True, session_all="ALL")


def _plan(*rows: tuple[str, list[str]]) -> list[dict]:
    return [{"market": code.split(".", 1)[0], "code": code, "kinds": kinds} for code, kinds in rows]


# ------------------------------------------------------------------ the capacity told to Market Runtime
def test_the_adapter_is_registered_with_opend_quota_by_type_never_with_a_fixed_symbol_count(tmp_path, monkeypatch):
    sink = MagicMock()
    svc = _service(tmp_path, monkeypatch, sink)
    register = sink.register_adapter.call_args.kwargs
    assert register["max_subscriptions"] is None and register.get("stream_budget") is None, \
        "no capacity is assumed before OpenD says it (it was 100 symbols, FUTU_LIVE_SUBSCRIPTION_LIMIT)"
    svc.observe_subscription_quota(OPEND_11_01)
    limit, kwargs = sink.set_max_subscriptions.call_args.args[0], sink.set_max_subscriptions.call_args.kwargs
    assert kwargs["stream_budget"] == {"streams": 100, "kinds_by_market": {"CC": FUTU_KINDS, "US": FUTU_KINDS}}
    assert limit == 25, "the instruments that fit however a plan mixes them: 100 / 4 types"
    # The same answer again tells Market Runtime nothing new; another connection taking 10 shrinks this one's room.
    svc.observe_subscription_quota(OPEND_11_01)
    assert sink.set_max_subscriptions.call_count == 1
    svc.observe_subscription_quota({"total_used": 39, "remain": 61, "own_used": 29})
    assert sink.set_max_subscriptions.call_args.kwargs["stream_budget"]["streams"] == 90
    quota = svc.status()["subscription_quota"]
    assert (quota["known"], quota["streams"], quota["total"], quota["used_by_others"]) == (True, 90, 100, 10)


def test_an_impossible_quota_answer_is_refused():
    manager = FutuSubscriptionManager()
    with pytest.raises(ValueError):
        manager.observe_quota({"total_used": 5, "remain": 10, "own_used": 6})
    with pytest.raises(KeyError):
        manager.observe_quota({"remain": 10})
    assert manager.quota_streams() is None


def test_a_control_connection_without_a_stated_capacity_does_not_register_until_it_has_one(monkeypatch):
    import websockets.sync.client as client

    def connect(*_a, **_k):
        raise AssertionError("connected before the capacity was known")

    monkeypatch.setattr(client, "connect", connect)
    errors: list[str] = []
    control = AdapterControlConnection(source="futu", max_subscriptions=None, kinds=None,
                                       replace_subscriptions=lambda items, gen: {}, report_subscriptions=lambda: {},
                                       url=lambda: "ws://127.0.0.1:1/x", auth_headers=lambda: {}, on_transport_error=errors.append)
    stop = threading.Event()
    thread = threading.Thread(target=control.run, args=(stop,), daemon=True)
    thread.start()
    stop.wait(0.6)
    stop.set()
    thread.join(2.0)
    assert errors == [], errors
    control.set_max_subscriptions(25, stream_budget={"streams": 100, "kinds_by_market": {"US": FUTU_KINDS}})
    assert '"stream_budget":{"streams":100' in control._register_message()


# ------------------------------------------------------------------ the provider within OpenD's room
def test_nothing_is_subscribed_on_a_context_before_its_quota_is_read():
    manager = FutuSubscriptionManager(minimum_subscription_seconds=0)
    manager.replace_plan(_plan(("US.AAPL", ["quote", "trade"])))
    opend = _OpenD(quota=100)
    outcome = _sync(manager, opend)
    assert opend.calls == [] and outcome["pending"] and not outcome["ok"]
    manager.observe_quota({"total_used": 0, "remain": 100, "own_used": 0})
    assert _sync(manager, opend)["ok"] and len(opend.held) == 3, "報價＋分時＋明細"
    manager.reset_session()
    assert manager.quota_streams() is None and manager.quota_due(), "a new context reads its own quota"


def test_pairs_past_the_quota_wait_for_room_instead_of_being_refused_by_opend():
    manager = FutuSubscriptionManager(minimum_subscription_seconds=0)
    manager.observe_quota({"total_used": 0, "remain": 4, "own_used": 0})
    manager.replace_plan(_plan(("US.AAPL", ["quote", "trade"]), ("US.NVDA", ["quote", "trade"])))
    opend = _OpenD(quota=4)
    outcome = _sync(manager, opend)
    assert [c[0] for c in opend.calls] == ["subscribe"] * 4, "never a subscribe OpenD has no room for"
    assert outcome["pending"] and manager.snapshot()["errors"] == 0
    assert {p["code"] for p in manager.quota_snapshot()["waiting"]} == {"US.NVDA"}


def test_a_dropped_pair_inside_the_minimum_is_draining_and_holds_its_room_until_it_is_unsubscribed(monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr("service.market.futu.subscriptions.time.monotonic", lambda: clock[0])
    manager = FutuSubscriptionManager(minimum_subscription_seconds=60.0)
    manager.observe_quota({"total_used": 0, "remain": 3, "own_used": 0})
    opend = _OpenD(quota=3)
    manager.replace_plan(_plan(("US.AAPL", ["quote", "trade"])))
    _sync(manager, opend)
    # 30 s later the user swaps AAPL for NVDA: AAPL may not be unsubscribed yet, so NVDA has no room.
    clock[0] += 30
    manager.replace_plan(_plan(("US.NVDA", ["quote", "trade"])))
    opend.calls.clear()
    _sync(manager, opend)
    assert opend.calls == [], "no unsubscribe inside the minimum, no subscribe past the quota"
    quota = manager.quota_snapshot()
    assert len(quota["draining"]) == 3 and {p["code"] for p in quota["waiting"]} == {"US.NVDA"}
    assert manager.draining() == [("US", "US.AAPL")]
    # Past the minimum one sync frees AAPL first and then takes NVDA in the room it freed.
    clock[0] += 31
    _sync(manager, opend)
    assert [c[0] for c in opend.calls] == ["unsubscribe"] * 3 + ["subscribe"] * 3
    assert opend.held == {("US.NVDA", "QUOTE"), ("US.NVDA", "RT_DATA"), ("US.NVDA", "TICKER")}
    assert manager.quota_snapshot()["draining"] == [] and manager.quota_snapshot()["waiting"] == []


def test_a_planned_instrument_waiting_for_room_is_reported_as_opend_quota_full(tmp_path, monkeypatch):
    svc = _service(tmp_path, monkeypatch)
    svc._opend.connected = True
    svc.subscription_manager.observe_quota({"total_used": 0, "remain": 3, "own_used": 0})
    svc.apply_demand_plan(_plan(("US.AAPL", ["quote", "trade"]), ("US.NVDA", ["quote", "trade"])))
    _sync(svc.subscription_manager, _OpenD(quota=3))
    report = svc.plan_report()
    assert report["subscribed"] == [{"market": "US", "code": "US.AAPL"}]
    assert report["failed"] == [{"market": "US", "code": "US.NVDA", "reason": "OPEND_QUOTA_FULL"}]


# ------------------------------------------------------------------ reading the quota from OpenD
class _Recorder:
    def __init__(self) -> None:
        self.begun: list[dict] = []
        self.finished: list[str] = []

    def begin(self, **kwargs):
        self.begun.append(kwargs)
        recorder = self
        return SimpleNamespace(finish=lambda outcome, **_k: recorder.finished.append(outcome))


def test_the_lifecycle_reads_the_quota_when_due_and_retries_a_failed_read_as_a_remediation(tmp_path, monkeypatch):
    recorder = _Recorder()
    monkeypatch.setattr(remediation, "emitter", lambda: recorder)
    sink = MagicMock()
    svc = _service(tmp_path, monkeypatch, sink)
    lifecycle = svc.opend_lifecycle
    svc._opend.sdk = SDK
    answers: list = [RuntimeError("OpenD busy"), (0, dict(OPEND_11_01))]

    class Context:
        def query_subscription(self, **kwargs):
            assert kwargs == {"is_all_conn": True}, "every connection's subscriptions: the quota is OpenD's, not ours"
            answer = answers.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer

    context = Context()
    svc._opend.context = context
    with pytest.raises(RuntimeError):
        lifecycle.read_quota(context)
    assert [b["mechanism_id"] for b in recorder.begun] == ["provider.futu_quota_read_retry"]
    assert recorder.begun[0]["trigger_reason"] == "quota_read_failed"
    assert lifecycle.read_quota(context)["pending"], "read again only after its wait"
    lifecycle._quota_retry_at = 0.0
    assert lifecycle.read_quota(context) == {"ok": True}
    assert recorder.finished == ["succeeded"]
    assert sink.set_max_subscriptions.call_args.kwargs["stream_budget"]["streams"] == 100
    assert lifecycle.read_quota(context) == {"ok": True} and answers == [], "not due: OpenD is not asked again"
    assert svc.subscription_quota()["streams"] == 100 and svc.subscription_manager.quota_due(), \
        "the settings page asks: read again on the next cycle"
