"""A provider subscribes exactly Market Runtime's plan and says what its broker did.

The product pages, holdings, workspace, focus and market context used to be owner sets inside each provider,
subscribed beside the plan -- a second authority, a quota Market Runtime could not see, and a status that did not
match what was subscribed. They now reach Market Runtime (the pages, holdings and market context through the
background list settings_api composes; the workspace and focus straight from the windows), and a provider only
executes the plan: instruments named as Market Runtime names them, resolved by capability, reported truthfully.
"""
from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from config.config_revisions import ConfigRevisionStore
from service.market.futu import service as futu_module
from service.market.shared.adapter_control import AdapterControlConnection
from service.market.futu import store as futu_store_module
from service.market.reference import background_demand
from service.market.shared.provider_contract import FUTU_CAPABILITIES, SHIOAJI_CAPABILITIES
from service.market.shared.rust_live import RustDaemonEventSink
from service.market.shioaji.session import ShioajiBrokerService
from service.market.shioaji.subscriptions import ShioajiSubscriptionManager


def plan(*rows):
    # No kinds named: every kind, as Market Runtime plans an instrument the user looks at.
    return [{"market": market, "code": code, "kinds": list(kinds) or ["quote", "trade", "orderbook"]} for market, code, *kinds in rows]


# ------------------------------------------------------------------ identity is resolved by capability
def test_instruments_resolve_by_market_identity_never_by_guessing_from_a_code():
    assert SHIOAJI_CAPABILITIES.resolve("STK", "2330").security_type == "STK"
    taiex = SHIOAJI_CAPABILITIES.resolve("IDX", "TAIEX")
    assert (taiex.security_type, taiex.logical_code) == ("IND", "IX0001"), "TAIEX is the broker's IX0001"
    assert SHIOAJI_CAPABILITIES.resolve("FUT", "TXFR1").lanes == ("Quote",)
    assert SHIOAJI_CAPABILITIES.resolve("IDX", "OTC") is None
    assert SHIOAJI_CAPABILITIES.resolve("US", "2330") is None
    assert FUTU_CAPABILITIES.resolve("US", "US.AAPL").lanes[-1] == "ORDER_BOOK"
    assert FUTU_CAPABILITIES.resolve("HK", "HK.00700") is None


# ------------------------------------------------------------------ Shioaji
def test_shioaji_desires_exactly_the_plan_and_refuses_what_it_cannot_carry():
    manager = ShioajiSubscriptionManager(subscription_limit=5)
    refused = manager.replace_plan(plan(("STK", "2330"), ("IDX", "TAIEX"), ("IDX", "OTC"), ("FUT", "TXFR1"), ("STK", "2317"), ("STK", "1101")))
    # 5 streams: 2330 takes two, TAIEX and TXFR1 one each; 2317 and 1101 (two each) no longer fit, in plan order.
    assert refused == {("IDX", "OTC"): "UNSUPPORTED_INSTRUMENT", ("STK", "2317"): "QUOTA_EXCEEDED", ("STK", "1101"): "QUOTA_EXCEEDED"}
    keys = {identity.key for identity in manager.desired_identities()}
    assert keys == {"STK:2330:Tick:regular", "STK:2330:BidAsk:regular", "IND:IX0001:Quote", "FUT:TXFR1:Quote"}
    # A new plan replaces the old one whole: nothing is kept for another owner.
    manager.replace_plan(plan(("STK", "2317")))
    assert {identity.code for identity in manager.desired_identities()} == {"2317"}


def _broker(connected: bool):
    broker = ShioajiBrokerService.__new__(ShioajiBrokerService)
    broker.subscription_manager = ShioajiSubscriptionManager()
    broker._connected = threading.Event()
    if connected:
        broker._connected.set()
    broker._api = object() if connected else None
    broker._subscription_mutation_frozen = False
    broker._lock = threading.RLock()
    broker._session_generation = 3
    broker._stream_subscription_state = {}
    broker._active_subscription_keys = set()
    broker._stream_since = {}
    broker._plan_refused = {}
    broker.event_sink = SimpleNamespace(subscriptions_changed=lambda: None)
    return broker


def test_shioaji_never_reports_a_plan_subscribed_while_not_connected():
    broker = _broker(connected=False)
    report = broker.apply_demand_plan(plan(("STK", "2330"), ("IDX", "OTC")))
    assert report["subscribed"] == []
    assert {(r["code"], r["reason"]) for r in report["failed"]} == {("2330", "SOURCE_NOT_CONNECTED"), ("OTC", "UNSUPPORTED_INSTRUMENT")}


def test_shioaji_reports_what_the_broker_took_with_the_sdk_error_of_what_it_did_not():
    broker = _broker(connected=True)

    def sync():
        for identity in broker.subscription_manager.desired_identities():
            if identity.code == "2330":
                broker._active_subscription_keys.add(identity.key)
                broker._stream_subscription_state[identity.key] = {"session_generation": 3}
            else:
                broker._stream_subscription_state[identity.key] = {"last_subscribe_error": "Shioaji 找不到行情合約 2334 (STK)"}
        return [{"code": "2334", "error": "Shioaji 找不到行情合約 2334 (STK)"}]

    broker._sync_subscriptions = sync
    report = broker.apply_demand_plan(plan(("STK", "2330"), ("STK", "2334")))
    assert report["subscribed"] == [{"market": "STK", "code": "2330"}]
    assert report["failed"] == [{"market": "STK", "code": "2334", "reason": "Shioaji 找不到行情合約 2334 (STK)"}]
    # A stream requested by an older broker session does not count.
    broker._session_generation = 4
    assert broker.plan_report()["subscribed"] == []


def test_each_subscribed_instrument_states_when_its_print_stream_was_subscribed():
    # Market Runtime judges a late join by it (market_runtime late_join.rs): the Tick lane's moment, not the order book's.
    broker = _broker(connected=True)

    def sync():
        for identity in broker.subscription_manager.desired_identities():
            broker._active_subscription_keys.add(identity.key)
            broker._stream_subscription_state[identity.key] = {"session_generation": 3}
            broker._stream_since[identity.key] = 500 if identity.quote_type == "BidAsk" else 900
        return []

    broker._sync_subscriptions = sync
    report = broker.apply_demand_plan(plan(("STK", "2330"), ("STK", "2603", "orderbook")))
    assert report["subscribed"] == [{"market": "STK", "code": "2330", "since_ns": 900}, {"market": "STK", "code": "2603"}], \
        "an order book alone carries no print"
    broker._sync_subscriptions = lambda: []
    broker.apply_demand_plan(plan(("STK", "2603", "orderbook")))
    assert all(key.split(":")[1] != "2330" for key in broker._stream_since), "a stream the plan dropped is forgotten"


def test_the_adapter_registers_its_real_instrument_capacity(monkeypatch):
    """Shioaji's limit counts streams and a stock takes two; registering the stream count as instruments let A plan
    twice what the broker takes. The capacity is every allowed connection's (設定 → 永豐行情連線, default 3 x 200)."""
    from config import broker_connection_settings

    registered = {}
    sink = SimpleNamespace(register_adapter=lambda **kw: registered.update(kw))
    monkeypatch.setattr(broker_connection_settings, "shioaji", lambda config_root=None: {
        "connections": 3, "per_connection_limit": 200, "revision": None})
    ShioajiBrokerService(event_sink=sink)
    assert registered["max_subscriptions"] == 300
    assert callable(registered["report_subscriptions"])
    assert registered["hold_until_close"] is True, "盤中訂閱過的不退訂: Market Runtime keeps what the plan carried"
    monkeypatch.setattr(broker_connection_settings, "shioaji", lambda config_root=None: {
        "connections": 1, "per_connection_limit": 200, "revision": 2})
    ShioajiBrokerService(event_sink=sink)
    assert registered["max_subscriptions"] == 100
    # The exact capacity is in streams, per kind: an index or TXFR1 its quote, a stock or a futures month its
    # trade and orderbook, one each.
    assert registered["stream_budget"] == {"streams": 200, "kinds_by_market": {"FUT": {"orderbook": 1, "quote": 1, "trade": 1}, "IDX": {"quote": 1}, "ODD": {"orderbook": 1, "trade": 1}, "STK": {"orderbook": 1, "trade": 1}}}


def test_a_holding_provider_says_so_when_it_registers_and_releases_a_settled_session_once():
    sink = RustDaemonEventSink(source="shioaji", token="t")
    sink.register_adapter(source="shioaji", max_subscriptions=2, hold_until_close=True,
                          replace_subscriptions=lambda items, generation: {}, report_subscriptions=lambda: {})
    assert json.loads(sink._control._register_message())["payload"]["hold_until_close"] is True
    sink.release_held(["STK", "ODD"], "2026-11-13T00:00:00", "day")
    sink.release_held(["STK", "ODD"], "2026-11-13", "DAY")
    socket = Socket()
    sink._control.send_due_releases(socket)
    sink._control.send_due_releases(socket)
    assert socket.sent == [{"type": "demand.release", "payload": {
        "source": "shioaji", "markets": ["STK", "ODD"], "trading_date": "2026-11-13", "session": "DAY"}}]

    quiet = RustDaemonEventSink(source="futu", token="t")
    quiet.register_adapter(source="futu", max_subscriptions=2, replace_subscriptions=lambda items, generation: {},
                           report_subscriptions=lambda: {})
    assert "hold_until_close" not in json.loads(quiet._control._register_message())["payload"]


def test_a_stream_budget_is_registered_and_the_provider_bills_the_plan_by_streams():
    """With a stream budget the plan is not cut at the instrument count: the provider lays it out by streams and
    refuses past the budget with a reason (here: 3 instruments, one an index, in a budget of 4 streams for 2
    instruments of the most lanes)."""
    taken = []
    sink = RustDaemonEventSink(source="shioaji", token="t")
    sink.register_adapter(source="shioaji", max_subscriptions=2,
                          stream_budget={"streams": 4, "kinds_by_market": {"STK": {"trade": 1, "orderbook": 1}, "IDX": {"quote": 1}}},
                          replace_subscriptions=lambda items, generation: taken.extend(items) or {"subscribed": items},
                          report_subscriptions=lambda: {})
    register = json.loads(sink._control._register_message())["payload"]
    assert register["max_subscriptions"] == 2
    assert register["stream_budget"] == {"streams": 4, "kinds_by_market": {"IDX": {"quote": 1}, "STK": {"orderbook": 1, "trade": 1}}}
    socket = Socket()
    sink._control.apply_plan(socket, {"generation": 3, "items": [
        {"market": "STK", "code": "2330"}, {"market": "IDX", "code": "IX0028"}, {"market": "STK", "code": "2317"}]})
    assert [i["code"] for i in taken] == ["2330", "IX0028", "2317"], "the whole plan reached the provider"
    # A new budget re-registers; the same one does not.
    sink.set_max_subscriptions(2, stream_budget={"streams": 4, "kinds_by_market": {"STK": {"trade": 1, "orderbook": 1}, "IDX": {"quote": 1}}})
    assert not sink._control._register_due.is_set()
    sink.set_max_subscriptions(4, stream_budget={"streams": 8, "kinds_by_market": {"STK": {"trade": 1, "orderbook": 1}, "IDX": {"quote": 1}}})
    assert sink._control._register_due.is_set()
    with pytest.raises(ValueError):
        sink.register_adapter(source="shioaji", max_subscriptions=2, stream_budget={"streams": 0, "kinds_by_market": {}},
                              replace_subscriptions=lambda items, generation: {}, report_subscriptions=lambda: {})


def test_without_a_stream_budget_the_plan_is_cut_at_the_instrument_count():
    taken = []
    sink = RustDaemonEventSink(source="futu", token="t")
    sink.register_adapter(source="futu", max_subscriptions=1,
                          replace_subscriptions=lambda items, generation: taken.extend(items) or {},
                          report_subscriptions=lambda: {})
    assert "stream_budget" not in json.loads(sink._control._register_message())["payload"]
    sink._control.apply_plan(Socket(), {"generation": 1, "items": [{"market": "US", "code": "US.AAPL"}, {"market": "US", "code": "US.TSLA"}]})
    assert [i["code"] for i in taken] == ["US.AAPL"]


# ------------------------------------------------------------------ Futu
class FrozenTime(datetime):
    @classmethod
    def now(cls, tz=None):
        value = datetime(2026, 9, 19, 15, 0, tzinfo=timezone.utc)
        return value.astimezone(tz) if tz else value.replace(tzinfo=None)


def futu_service(tmp_path, monkeypatch):
    monkeypatch.setattr(futu_module, "datetime", FrozenTime)
    monkeypatch.setattr(futu_store_module, "datetime", FrozenTime)
    monkeypatch.setenv("FUTU_SECURITY_MASTER_FILE", str(tmp_path / "security.csv"))
    service = futu_module.FutuMarketService(tmp_path / "market.db")
    service.subscription_manager.observe_quota({"total_used": 0, "remain": 1000, "own_used": 0})  # OpenD's quota, read before a context subscribes
    service.security_master.codes = {"US.AAPL", "US.MSFT"}
    return service


def test_futu_desires_exactly_the_plan_with_the_lanes_its_kinds_ask_for(tmp_path, monkeypatch):
    service = futu_service(tmp_path, monkeypatch)
    report = service.apply_demand_plan(plan(("US", "US.AAPL", "quote", "trade", "orderbook"), ("US", "US.MSFT", "quote", "trade"),
                                            ("HK", "HK.00700", "quote")))
    pairs = service.subscription_manager.desired_pairs()
    assert ("US.AAPL", "ORDER_BOOK") in pairs and ("US.MSFT", "ORDER_BOOK") not in pairs
    assert ("US.MSFT", "QUOTE") in pairs
    assert report["subscribed"] == []
    assert {(r["code"], r["reason"]) for r in report["failed"]} == {
        ("US.AAPL", "SOURCE_NOT_CONNECTED"), ("US.MSFT", "SOURCE_NOT_CONNECTED"), ("HK.00700", "UNSUPPORTED_INSTRUMENT")}
    # What OpenD confirmed is what is reported; an SDK error is the reason for what it did not.
    service._opend.connected = True
    manager = service.subscription_manager
    manager.confirmed_pairs |= {("US.AAPL", lane) for lane in FUTU_CAPABILITIES.resolve("US", "US.AAPL").lanes}
    manager.subscribe_errors[("US.MSFT", "QUOTE")] = "RuntimeError: no quote right"
    report = service.plan_report()
    assert report["subscribed"] == [{"market": "US", "code": "US.AAPL"}]
    assert {"market": "US", "code": "US.MSFT", "reason": "RuntimeError: no quote right"} in report["failed"]
    assert report["draining"] == []


def test_futu_reports_what_opend_still_holds_inside_its_minimum_subscription_time(tmp_path, monkeypatch):
    # US.AAPL leaves the plan 10 s after it was subscribed. Moomoo keeps it (and pushes it) until the
    # one-minute minimum is over, so it is reported as draining -- Market Runtime keeps it covered -- until it is gone.
    service = futu_service(tmp_path, monkeypatch)
    service._opend.connected = True
    manager = service.subscription_manager
    service.apply_demand_plan(plan(("US", "US.AAPL", "quote", "trade")))
    lanes = FUTU_CAPABILITIES.resolve("US", "US.AAPL").watchlist_lanes
    calls = []
    sdk = SimpleNamespace(SubType=SimpleNamespace(**{lane: lane for lane in lanes}))
    manager.sync(object(), sdk, session_current=lambda: True, call=lambda _ctx, name, codes, subtypes, **_kw: calls.append((name, codes[0], subtypes[0])))
    assert service.plan_report()["subscribed"] == [{"market": "US", "code": "US.AAPL"}]
    report = service.apply_demand_plan(plan(("US", "US.MSFT", "quote", "trade")))
    manager.sync(object(), sdk, session_current=lambda: True, call=lambda _ctx, name, codes, subtypes, **_kw: calls.append((name, codes[0], subtypes[0])))
    assert not [c for c in calls if c[0] == "unsubscribe"], "inside the minimum time nothing is unsubscribed"
    report = service.plan_report()
    assert report["draining"] == [{"market": "US", "code": "US.AAPL"}]
    assert {"market": "US", "code": "US.AAPL"} not in report["subscribed"]
    for pair in list(manager.subscription_started_at):
        manager.subscription_started_at[pair] -= 61.0
    manager.sync(object(), sdk, session_current=lambda: True, call=lambda _ctx, name, codes, subtypes, **_kw: calls.append((name, codes[0], subtypes[0])))
    assert service.plan_report()["draining"] == [], "gone once OpenD took the unsubscribe"
    # The adapter passes draining on, outside the plan only.
    _sub, _failed, draining = AdapterControlConnection.report_rows(
        {"draining": [{"market": "US", "code": "US.AAPL"}, {"market": "US", "code": "US.MSFT"}]},
        [{"market": "US", "code": "US.MSFT"}])
    assert draining == [{"market": "US", "code": "US.AAPL"}]


# ------------------------------------------------------------------ the adapter reports, and reports again
class Socket:
    def __init__(self):
        self.sent = []

    def send(self, raw):
        self.sent.append(json.loads(raw))


def test_the_status_market_runtime_receives_states_when_each_print_stream_was_subscribed():
    # From the provider's own report to the frame on the wire, on the plan's answer and on a later report alike:
    # without since_ns Market Runtime can never judge a late join (late_join.rs), and the code's first print waits forever.
    broker = _broker(connected=True)

    def sync():
        for identity in broker.subscription_manager.desired_identities():
            broker._active_subscription_keys.add(identity.key)
            broker._stream_subscription_state[identity.key] = {"session_generation": 3}
            broker._stream_since[identity.key] = 900
        return []

    broker._sync_subscriptions = sync
    sink = RustDaemonEventSink(source="shioaji", token="t")
    sink.register_adapter(source="shioaji", max_subscriptions=10,
                          replace_subscriptions=lambda items, _generation: broker.apply_demand_plan(items),
                          report_subscriptions=broker.plan_report)
    socket = Socket()
    sink._control.apply_plan(socket, {"generation": 7, "items": plan(("STK", "2330"), ("STK", "2603", "orderbook"))})
    expected = [{"market": "STK", "code": "2330", "since_ns": 900}, {"market": "STK", "code": "2603"}]
    assert socket.sent[-1]["payload"]["subscribed"] == expected, "an order book alone carries no print, so no since_ns"
    sink.subscriptions_changed()
    sink._control.send_due_report(socket)
    assert (len(socket.sent), socket.sent[-1]["payload"]["subscribed"]) == (2, expected)


def test_the_adapter_sends_the_providers_report_and_resends_it_when_the_broker_moves():
    state = {"subscribed": []}
    sink = RustDaemonEventSink(source="shioaji", token="t")
    sink.register_adapter(source="shioaji", max_subscriptions=10,
                          replace_subscriptions=lambda items, generation: {"failed": [{**items[0], "reason": "SOURCE_NOT_CONNECTED"}]},
                          report_subscriptions=lambda: {"subscribed": state["subscribed"]})
    socket = Socket()
    sink._control.apply_plan(socket, {"generation": 7, "items": [{"market": "STK", "code": "2330"}, {"market": "STK", "code": "2317"}]})
    payload = socket.sent[-1]["payload"]
    assert payload["generation"] == 7 and payload["subscribed"] == []
    assert {(f["code"], f["reason"]) for f in payload["failed"]} == {("2330", "SOURCE_NOT_CONNECTED"), ("2317", "UNREPORTED")}
    sink._control.send_due_report(socket)
    assert len(socket.sent) == 1, "nothing moved, nothing is sent"
    state["subscribed"] = [{"market": "STK", "code": "2330"}, {"market": "STK", "code": "9999"}]
    sink.subscriptions_changed()
    sink._control.send_due_report(socket)
    payload = socket.sent[-1]["payload"]
    assert payload["generation"] == 7
    assert payload["subscribed"] == [{"market": "STK", "code": "2330"}], "an instrument outside the plan is not reported"


# ------------------------------------------------------------------ the background list's owners
def test_owners_merge_and_an_instrument_leaves_with_its_last_owner():
    items = background_demand.merge([], "watchlist", [{"source": "shioaji", "market": "STK", "code": "2330", "kinds": ["quote", "trade"]}])
    items = background_demand.merge(items, "holdings", [{"source": "shioaji", "market": "STK", "code": "2330", "kinds": ["orderbook"]},
                                                        {"source": "futu", "market": "US", "code": "US.AAPL"}])
    row = next(i for i in items if i["code"] == "2330")
    assert row["owners"] == ["holdings", "watchlist"] and row["kinds"] == ["quote", "trade", "orderbook"]
    items = background_demand.merge(items, "holdings", [])
    assert [(i["code"], i["owners"]) for i in items] == [("2330", ["watchlist"])]
    items = background_demand.merge(items, "watchlist", [], enabled=lambda source: source != "futu")
    assert items == []
    with pytest.raises(ValueError):
        background_demand.merge(items, "someone", [])


def test_holdings_are_tw_stocks_and_futu_us_codes():
    items = background_demand.holdings_items([{"market": "台股", "code": "2330"}, {"market": "美股", "code": "aapl"},
                                              {"market": "美股", "code": "US.MSFT"}, {"market": "台股", "code": ""}])
    assert [(i["source"], i["market"], i["code"]) for i in items] == [
        ("futu", "US", "US.AAPL"), ("futu", "US", "US.MSFT"), ("shioaji", "STK", "2330")]


def no_futures(monkeypatch):
    from service.market.reference.futures_contracts import FuturesTable

    monkeypatch.setattr(background_demand, "_futures_table", lambda: FuturesTable(()))


def test_an_owner_change_saves_one_active_revision_and_an_unchanged_one_saves_none(tmp_path, monkeypatch):
    monkeypatch.setattr("config.source_settings.source_enabled", lambda source: True)
    no_futures(monkeypatch)
    first = background_demand.replace_owner(tmp_path, "holdings", background_demand.holdings_items([{"market": "台股", "code": "2330"}]), summary="t")
    assert first["ok"] and first["changed"] and first["revision"] == 1
    again = background_demand.replace_owner(tmp_path, "holdings", background_demand.holdings_items([{"market": "台股", "code": "2330"}]), summary="t")
    assert again == {"ok": True, "changed": False, "revision": 1, "items": 1}
    # The market context is derived from the 訂閱偏好 (the defaults here: 加權指數 and TXFR1).
    context = background_demand.replace_owner(tmp_path, "market_context", (), summary="t")
    assert context["revision"] == 2
    store = ConfigRevisionStore(tmp_path, "background")
    assert store.pointer()["active"] == 2, "a background revision is active on save"
    codes = {(i["market"], i["code"]) for i in store.active()["values"]["items"]}
    assert codes == {("STK", "2330"), ("IDX", "TAIEX"), ("FUT", "TXFR1")}


def test_the_product_pages_are_the_watchlist_owner(tmp_path, monkeypatch):
    monkeypatch.setattr("config.source_settings.source_enabled", lambda source: True)
    no_futures(monkeypatch)
    from service.market.reference.watch_page_service import WatchPageService

    pages = tmp_path / "watch_pages.csv"
    WatchPageService(pages).save_pages([
        {"id": "p1", "name": "台股", "source": "shioaji", "market": "tw", "items": [{"code": "2330"}, {"code": "2317"}]},
        {"id": "p2", "name": "美股", "source": "futu", "market": "us", "items": [{"code": "US.AAPL"}]},
    ])
    result = background_demand.refresh_fixed_owners(tmp_path / "config", pages)
    assert result["ok"]
    items = ConfigRevisionStore(tmp_path / "config", "background").active()["values"]["items"]
    by_code = {i["code"]: i for i in items}
    assert by_code["2330"]["owners"] == ["watchlist"] and by_code["2330"]["kinds"] == ["trade", "orderbook"], "a stock has no quote stream"
    assert by_code["US.AAPL"]["kinds"] == ["quote", "trade"], "Futu page instruments never took the order book"
    assert by_code["TAIEX"]["owners"] == ["market_context"]


def test_a_futu_sync_that_did_not_reach_the_plan_is_not_a_completed_step(tmp_path, monkeypatch):
    """subscribe() kept each SDK failure for a later retry and sync returned normally, so the cycle
    step -- and with it an OpenD reconnect -- was recorded as succeeded with pairs still unconfirmed."""

    service = futu_service(tmp_path, monkeypatch)
    service._opend.connected = True
    manager = service.subscription_manager
    service.apply_demand_plan(plan(("US", "US.AAPL", "quote", "trade")))
    lanes = FUTU_CAPABILITIES.resolve("US", "US.AAPL").watchlist_lanes
    sdk = SimpleNamespace(SubType=SimpleNamespace(**{lane: lane for lane in lanes}))

    def refusing(_ctx, name, codes, subtypes, **_kw):
        if subtypes[0] == lanes[0]:
            raise RuntimeError("subscribe quota")

    outcome = manager.sync(object(), sdk, session_current=lambda: True, call=refusing)
    assert outcome["ok"] is False and outcome["missing"] == [f"US.AAPL:{lanes[0]}"] and "subscribe quota" in outcome["error"]
    lifecycle = service.opend_lifecycle
    assert lifecycle.run_operation("subscription_sync", lambda: outcome) is False
    assert service.read_status()["operations"]["subscription_sync"]["ok"] is False
    for pair in list(manager.subscribe_retry_after):
        manager.subscribe_retry_after[pair] = 0.0
    done = manager.sync(object(), sdk, session_current=lambda: True, call=lambda *_a, **_k: None)
    assert done == {"ok": True, "pending": False, "desired": len(lanes), "missing": [], "retry_in_seconds": None,
                    "error": None}
    assert lifecycle.run_operation("subscription_sync", lambda: done) is True
