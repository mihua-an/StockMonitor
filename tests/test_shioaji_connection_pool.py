"""永豐行情連線 (user 10-19): each connection takes `per_connection_limit` subscriptions; past them the next login opens
by itself, up to `connections`; a connection left holding nothing is logged out; a refusal the broker sends after the
subscribe moves the stream elsewhere; a lower setting lays the streams out again."""
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from config import broker_connection_settings
from service.market.shioaji import session as shioaji


def settings(monkeypatch, connections, limit, revision=1):
    monkeypatch.setattr(broker_connection_settings, "shioaji", lambda config_root=None: {
        "connections": connections, "per_connection_limit": limit, "revision": revision})


@pytest.fixture
def svc(monkeypatch):
    settings(monkeypatch, 3, 4)
    sink = MagicMock()
    service = shioaji.ShioajiBrokerService(event_sink=sink, credential_service=MagicMock())
    service._session_generation = 7
    service._api = MagicMock(name="connection1")
    service._sj = object()
    service._connected.set()
    logins = []

    def login(sj, generation, reason):
        api = MagicMock(name=f"connection{len(logins) + 2}")
        logins.append((api, reason))
        return api

    monkeypatch.setattr(service, "_login", login)
    monkeypatch.setattr(service, "_quote_type_value", lambda sdk, lane: lane)
    monkeypatch.setattr(service, "_resolve_contract", lambda identity: SimpleNamespace(code=identity.code))
    service.logins = logins
    return service


def plan(service, *codes, indexes=()):
    service.apply_demand_plan([{"market": "STK", "code": c} for c in codes] + [{"market": "IDX", "code": c} for c in indexes])


def held(service):
    return {row["connection"]: row["streams"] for row in service._connections_status()["open"]}


def test_the_next_connection_opens_only_when_the_open_ones_are_full_and_the_lanes_of_a_stock_stay_together(svc):
    plan(svc, "2330", "2317")
    assert held(svc) == {1: 4} and svc.logins == [], "4 streams fit the first connection"
    plan(svc, "2330", "2317", "2454", indexes=("IX0028",))
    assert held(svc) == {1: 4, 2: 3}, "the next login opened for the rest, an index counts one"
    assert [reason for _, reason in svc.logins] == ["broker_connection_open"]
    by_code = {}
    for key, index in svc._stream_connection.items():
        by_code.setdefault(key.split(":")[1], set()).add(index)
    assert all(len(v) == 1 for v in by_code.values()), f"Tick and BidAsk of a stock on one connection: {by_code}"
    second = svc.logins[0][0]
    assert second.subscribe.call_count == 3 and second.set_session_down_callback.called
    # The plan shrinks: the second connection holds nothing and is logged out.
    plan(svc, "2330")
    assert held(svc) == {1: 2}
    second.logout.assert_called_once()


def test_past_every_allowed_connection_the_plan_is_refused_not_overbooked(svc):
    codes = [str(2000 + n) for n in range(7)]       # 14 streams; 3 x 4 = 12 allowed
    plan(svc, *codes)
    assert sum(held(svc).values()) == 12 and len(svc.logins) == 2
    refused = {code for (_, code), reason in svc._plan_refused.items() if reason == "QUOTA_EXCEEDED"}
    assert refused == {"2006"}


def test_a_broker_refusal_moves_the_stream_and_caps_its_connection(svc):
    plan(svc, "2330", "2317")
    svc._on_broker_event(400, 4, "Max Num Subscriptions Exceeded - Topic 'QUO/v1/STK/*/TSE/2317' Subscribe: Response code: '400'",
                         "Subscription problem on session", connection=0)
    svc._sync_subscriptions()
    assert svc._connection_cap[0] == 3, "the first connection took 3 before refusing"
    assert held(svc) == {1: 3, 2: 1}, "the refused BidAsk went to a new connection"
    assert svc._stream_connection["STK:2317:BidAsk:regular"] == 1


def test_a_lower_setting_logs_in_again_to_lay_the_streams_out(svc, monkeypatch):
    plan(svc, "2330", "2317", "2454")
    assert held(svc) == {1: 4, 2: 2}
    disconnected = []
    monkeypatch.setattr(svc, "_disconnect", lambda: disconnected.append(True))
    settings(monkeypatch, 1, 4, revision=2)
    svc._apply_connection_settings()
    assert disconnected == [True], "two connections open, one allowed: a new login lays them out"


def test_a_higher_setting_moves_the_streams_onto_fewer_connections_and_logs_the_empty_ones_out(svc, monkeypatch):
    # User 10-22 (INTRADAY I12): per connection 100 -> 200 left the second login holding 69 streams until a restart.
    plan(svc, "2330", "2317", "2454")
    assert held(svc) == {1: 4, 2: 2}
    first, second = svc._api, svc.logins[0][0]
    order = []
    first.subscribe.side_effect = lambda contract, quote_type: order.append(("subscribe 1", contract.code, quote_type))
    second.unsubscribe.side_effect = lambda contract, quote_type: order.append(("unsubscribe 2", contract.code, quote_type))
    disconnected = []
    monkeypatch.setattr(svc, "_disconnect", lambda: disconnected.append(True))
    settings(monkeypatch, 3, 8, revision=2)
    svc._apply_connection_settings()
    assert disconnected == [], "more room: applied in place, no new login"
    assert svc.subscription_manager.subscription_limit == 24
    svc.event_sink.set_max_subscriptions.assert_called_with(
        12, stream_budget={"streams": 24, "kinds_by_market": {"FUT": {"orderbook": 1, "quote": 1, "trade": 1}, "IDX": {"quote": 1}, "STK": {"orderbook": 1, "trade": 1}}})
    assert held(svc) == {1: 6}, "2454 moved onto the first connection"
    second.logout.assert_called_once()
    assert svc._extra_apis == {}
    # Each lane is taken on the new connection before it is let go on the old one: no print falls between them.
    for lane in ("Tick", "BidAsk"):
        assert order.index(("subscribe 1", "2454", lane)) < order.index(("unsubscribe 2", "2454", lane)), order
    assert all(index == 0 for index in svc._stream_connection.values())
    assert {s.get("connection") for k, s in svc._stream_subscription_state.items() if k.startswith("STK:2454:")} == {1}
    assert svc.logins[1:] == [], "no other login"


def test_an_instrument_moves_only_whole_and_only_where_it_fits(svc, monkeypatch):
    plan(svc, "2330", "2317", "2454", "2303", "2603")
    assert held(svc) == {1: 4, 2: 4, 3: 2}
    third = svc.logins[1][0]
    settings(monkeypatch, 3, 5, revision=2)
    svc._apply_connection_settings()
    assert held(svc) == {1: 4, 2: 4, 3: 2}, "one free slot each: a stock's two lanes are never split"
    third.logout.assert_not_called()
    settings(monkeypatch, 3, 6, revision=3)
    svc._apply_connection_settings()
    assert held(svc) == {1: 6, 2: 4}, "the last connection's stock fits the first now; the second's do not"
    third.logout.assert_called_once()
    by_code = {}
    for key, index in svc._stream_connection.items():
        by_code.setdefault(key.split(":")[1], set()).add(index)
    assert all(len(v) == 1 for v in by_code.values()), by_code


def test_a_move_the_broker_refuses_is_recorded_and_the_stream_stays(svc, monkeypatch, caplog):
    plan(svc, "2330", "2317", "2454")
    first, second = svc._api, svc.logins[0][0]
    first.subscribe.side_effect = RuntimeError("Max Num Subscriptions Exceeded")
    settings(monkeypatch, 3, 8, revision=2)
    with caplog.at_level("WARNING"):
        svc._apply_connection_settings()
    assert held(svc) == {1: 4, 2: 2}, "nothing moved"
    second.unsubscribe.assert_not_called()
    second.logout.assert_not_called()
    assert "moving STK:2454" in caplog.text and "Max Num Subscriptions Exceeded" in caplog.text


def test_a_disconnect_unsubscribes_each_stream_on_its_own_connection_and_logs_every_one_out(svc):
    plan(svc, "2330", "2317", "2454")
    first, second = svc._api, svc.logins[0][0]
    svc._disconnect()
    assert first.unsubscribe.call_count == 4 and second.unsubscribe.call_count == 2
    first.logout.assert_called_once()
    second.logout.assert_called_once()
    assert svc._extra_apis == {} and svc._stream_connection == {}


def test_the_settings_validate():
    v = broker_connection_settings.validate
    assert v({"shioaji": {"connections": 3, "per_connection_limit": 200}}) == []
    assert [p["code"] for p in v({"shioaji": {"connections": 5, "per_connection_limit": 200}})] == ["CONNECTIONS"]
    assert [p["code"] for p in v({"shioaji": {"connections": True, "per_connection_limit": "200"}})] == ["CONNECTIONS", "PER_CONNECTION_LIMIT"]


def test_a_failed_login_of_the_next_connection_is_not_retried_every_pass(svc, monkeypatch):
    calls = []

    def refuse(sj, generation, reason):
        calls.append(reason)
        raise RuntimeError("Shioaji login 失敗：too many connections")

    monkeypatch.setattr(svc, "_login", refuse)
    plan(svc, "2330", "2317", "2454")
    svc._sync_subscriptions()
    svc._sync_subscriptions()
    assert calls == ["broker_connection_open"], "one try, then the backoff"
    assert held(svc) == {1: 4}
    errors = {key: s.get("last_subscribe_error") for key, s in svc._stream_subscription_state.items() if s.get("health") == "SUBSCRIBE_ERROR"}
    assert errors and all("2454" in key for key in errors), errors


def _recorded_remediations(monkeypatch):
    from service.platform import remediation

    events = []
    monkeypatch.setattr(remediation, "emitter", lambda: SimpleNamespace(
        begin=lambda **kw: events.append(("begin", kw["mechanism_id"], kw["trigger_reason"])) or SimpleNamespace(
            finish=lambda outcome, **k: events.append(("finish", kw["mechanism_id"], outcome)))))
    return events


def test_a_login_whose_setup_fails_is_logged_out_not_left_holding_a_connection(svc, monkeypatch):
    login = svc._login

    def login_then_refuse_callbacks(sj, generation, reason):
        api = login(sj, generation, reason)
        api.set_event_callback.side_effect = RuntimeError("callback slot taken")
        return api

    monkeypatch.setattr(svc, "_login", login_then_refuse_callbacks)
    plan(svc, "2330", "2317", "2454")
    opened = svc.logins[0][0]
    opened.logout.assert_called_once()
    assert svc._extra_apis == {} and svc._closing_apis == {} and svc._connection_states == {}
    assert held(svc) == {1: 4}
    health = {k: s.get("health") for k, s in svc._stream_subscription_state.items() if k.startswith("STK:2454:")}
    assert set(health.values()) == {"SUBSCRIBE_ERROR"}, health


def test_a_failed_logout_keeps_the_handle_and_the_index_and_is_tried_again_up_to_the_bound(svc, monkeypatch):
    events = _recorded_remediations(monkeypatch)
    plan(svc, "2330", "2317", "2454")
    second = svc.logins[0][0]
    second.logout.side_effect = RuntimeError("network down")
    plan(svc, "2330")                                        # the second connection is left idle: its logout fails
    assert svc._extra_apis == {} and svc._closing_apis == {1: second}
    status = svc._connections_status()
    assert [(r["connection"], r["state"], r["close_attempts"]) for r in status["not_closed"]] == [(2, "CLOSE_FAILED", 1)]
    plan(svc, "2330", "2317", "2454")                        # needs a second connection again: not index 1
    assert [api for api, _ in svc.logins[1:]] and 2 in svc._extra_apis, "the next login takes connection 3"
    assert svc._closing_apis.get(1) is second and second.logout.call_count == 2, "the sync tried the logout again"
    plan(svc, "2330")
    assert second.logout.call_count == svc.CLOSE_ATTEMPTS and 1 not in svc._closing_apis, "let go after the bound"
    assert svc._connection_states[1]["abandoned"] is True
    close = [e for e in events if e[1] == "provider.shioaji_connection_close_retry"]
    assert close == [("begin", "provider.shioaji_connection_close_retry", "logout_failed"),
                     ("finish", "provider.shioaji_connection_close_retry", "abandoned")]


def test_a_logout_that_succeeds_on_a_retry_ends_its_recovery(svc, monkeypatch):
    events = _recorded_remediations(monkeypatch)
    plan(svc, "2330", "2317", "2454")
    second = svc.logins[0][0]
    second.logout.side_effect = [RuntimeError("busy"), None]
    plan(svc, "2330")
    svc._sync_subscriptions()
    assert svc._closing_apis == {} and svc._connection_states == {}
    assert [e for e in events if e[1] == "provider.shioaji_connection_close_retry"] == [
        ("begin", "provider.shioaji_connection_close_retry", "logout_failed"),
        ("finish", "provider.shioaji_connection_close_retry", "succeeded")]


def test_a_futures_refusal_names_the_contract_month_and_is_attributed_to_txfr1(svc, monkeypatch):
    monkeypatch.setattr(svc, "_resolve_contract", lambda identity: SimpleNamespace(
        code="TXFL6" if identity.code == "TXFR1" else identity.code, target_code=identity.code))
    svc.apply_demand_plan([{"market": "STK", "code": "2330"}, {"market": "FUT", "code": "TXFR1"}])
    assert "FUT:TXFR1:Quote" in svc._active_subscription_keys
    svc._on_broker_event(400, 4, "Max Num Subscriptions Exceeded - Topic 'QUO/v1/FOP/*/TFE/TXFL6' Subscribe: Response code: '400'",
                         "Subscription problem on session", connection=0)
    with svc._lock:
        key = svc._refused_stream_key(0, svc._broker_refusals[0][1])
    assert key == "FUT:TXFR1:Quote"
    svc._sync_subscriptions()
    assert svc._connection_cap[0] == 2 and svc._stream_connection["FUT:TXFR1:Quote"] == 1, "moved to the next connection"


def test_a_refusal_that_names_no_held_stream_lays_the_connection_out_again(svc, monkeypatch):
    events = _recorded_remediations(monkeypatch)
    plan(svc, "2330", "2317")
    svc._on_broker_event(400, 4, "Max Num Subscriptions Exceeded - Topic 'XYZ/v9/OPT/*/TFE/TXO18000' Subscribe",
                         "Subscription problem on session", connection=0)
    svc._take_broker_refusals()
    states = {k: s["health"] for k, s in svc._stream_subscription_state.items()}
    assert set(states.values()) == {"UNVERIFIED"} and svc._active_subscription_keys == set()
    assert svc._connection_cap[0] == 3 and svc._connections_status()["unattributed_refusals"] == 1
    svc._sync_subscriptions()
    assert held(svc) == {1: 3, 2: 1}, "every stream subscribed again within one less on the refusing connection"
    assert [e for e in events if e[1] == "provider.shioaji_refusal_resync"] == [
        ("begin", "provider.shioaji_refusal_resync", "unattributed_refusal"),
        ("finish", "provider.shioaji_refusal_resync", "succeeded")]


def test_a_new_limit_never_splits_a_plan_being_laid_out(monkeypatch):
    """The settings thread changes the limit while Rust A's control thread lays a plan out: the plan uses one reading."""
    import threading

    from service.market.shioaji.subscriptions import ShioajiSubscriptionManager

    manager = ShioajiSubscriptionManager(subscription_limit=4)
    halfway, release = threading.Event(), threading.Event()
    real_resolve = manager.resolve
    seen = []

    def slow_resolve(market, code):
        seen.append(code)
        if len(seen) == 2:
            halfway.set()
            release.wait(2)
        return real_resolve(market, code)

    monkeypatch.setattr(manager, "resolve", slow_resolve)
    result = {}
    worker = threading.Thread(target=lambda: result.update(manager.replace_plan(
        [{"market": "STK", "code": c} for c in ("2330", "2317", "2454", "2303")])))
    worker.start()
    assert halfway.wait(2)
    setter = threading.Thread(target=manager.set_subscription_limit, args=(8,))
    setter.start()
    setter.join(0.2)
    assert setter.is_alive(), "the new limit waits for the plan being laid out"
    release.set()
    worker.join(2)
    setter.join(2)
    assert result == {("STK", "2454"): "QUOTA_EXCEEDED", ("STK", "2303"): "QUOTA_EXCEEDED"}, "the whole plan on the old limit"
    assert manager.subscription_limit == 8 and manager.replace_plan(
        [{"market": "STK", "code": c} for c in ("2330", "2317", "2454", "2303")]) == {}


def test_the_callback_counts_from_many_connections_are_not_lost_and_read_once():
    import threading

    from service.market.shioaji.callback import ShioajiThinCallbackAdapter

    adapter = ShioajiThinCallbackAdapter(owner=SimpleNamespace())

    def count():
        for _ in range(2000):
            adapter._count_dropped(adapter.invalid_required, adapter.invalid_required_last, "stk.tick.close", "None", "2330", None)
            adapter.optional_fields._count("price_chg")

    threads = [threading.Thread(target=count) for _ in range(4)]
    for thread in threads:
        thread.start()
    snapshots = [adapter.diagnostic_snapshot() for _ in range(200)]
    for thread in threads:
        thread.join()
    final = adapter.diagnostic_snapshot()
    assert final["invalid_required_fields"] == {"stk.tick.close": 8000}
    assert final["invalid_required_last"]["stk.tick.close"]["count"] == 8000
    assert final["invalid_optional_fields"] == {"price_chg": 8000}
    for snap in snapshots:   # each one taken at one moment: the last row's count is the count
        if snap["invalid_required_fields"]:
            assert snap["invalid_required_last"]["stk.tick.close"]["count"] == snap["invalid_required_fields"]["stk.tick.close"]
