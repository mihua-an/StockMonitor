"""盤中零股 (user 11-13): Market Runtime plans a stock's odd lots as the market ODD. The provider subscribes the stock's
contract with ``intraday_odd`` -- two streams of their own beside the whole-lot Tick and BidAsk -- and names every event
of them ODD, with a sequence of its own, so the odd-lot book and prints never mix into the stock's."""
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from config import broker_connection_settings
from service.market.shared.provider_contract import SHIOAJI_CAPABILITIES, SHIOAJI_LANE_KINDS
from service.market.shioaji import session as shioaji
from service.market.shioaji.subscriptions import wal_instrument


@pytest.fixture
def svc(monkeypatch):
    monkeypatch.setattr(broker_connection_settings, "shioaji", lambda config_root=None: {
        "connections": 1, "per_connection_limit": 8, "revision": 1})
    service = shioaji.ShioajiBrokerService(event_sink=MagicMock(), credential_service=MagicMock())
    service._session_generation = 3
    service._api = MagicMock(name="connection1")
    service._sj = object()
    service._connected.set()
    monkeypatch.setattr(service, "_quote_type_value", lambda sdk, lane: lane)
    monkeypatch.setattr(service, "_resolve_contract", lambda identity: SimpleNamespace(code=identity.code))
    return service


def test_the_budget_names_the_odd_lot_market_with_a_tick_and_a_book_stream():
    assert SHIOAJI_CAPABILITIES.kinds_by_market(SHIOAJI_LANE_KINDS)["ODD"] == {"orderbook": 1, "trade": 1}
    assert wal_instrument("STK", "2330", True) == ("ODD", "2330") and wal_instrument("STK", "2330") == ("STK", "2330")


def test_an_odd_lot_plan_item_subscribes_the_stock_contract_with_intraday_odd_beside_the_whole_lots(svc):
    report = svc.apply_demand_plan([{"market": "STK", "code": "2330"}, {"market": "ODD", "code": "2330"}])
    assert sorted((row["market"], row["code"]) for row in report["subscribed"]) == [("ODD", "2330"), ("STK", "2330")]
    calls = sorted((c.kwargs["quote_type"], c.kwargs["intraday_odd"]) for c in svc._api.subscribe.call_args_list)
    assert calls == [("BidAsk", False), ("BidAsk", True), ("Tick", False), ("Tick", True)]
    assert {"STK:2330:Tick:odd", "STK:2330:BidAsk:odd"} <= svc._active_subscription_keys
    assert svc._connection_instruments_locked(0) == [("ODD", "2330"), ("STK", "2330")]

    # Letting the odd lots go unsubscribes only them.
    svc._api.unsubscribe.reset_mock()
    svc.apply_demand_plan([{"market": "STK", "code": "2330"}])
    gone = sorted((c.kwargs["quote_type"], c.kwargs["intraday_odd"]) for c in svc._api.unsubscribe.call_args_list)
    assert gone == [("BidAsk", True), ("Tick", True)]
    assert svc._active_subscription_keys == {"STK:2330:Tick:regular", "STK:2330:BidAsk:regular"}


def test_a_refusal_naming_the_odd_lot_topic_is_the_odd_lot_stream(svc):
    svc.apply_demand_plan([{"market": "STK", "code": "2330"}, {"market": "ODD", "code": "2330"}])
    with svc._lock:
        assert svc._refused_stream_key(0, "Topic 'QUO/v1/ODD/*/TSE/2330'") == "STK:2330:BidAsk:odd"
        assert svc._refused_stream_key(0, "Topic 'QUO/v1/STK/*/TSE/2330'") == "STK:2330:BidAsk:regular"


def _tick(odd: bool):
    return SimpleNamespace(code="2330", datetime=__import__("datetime").datetime(2026, 11, 13, 10, 0, 5), close=1000.0, volume=37 if odd else 2,
                           total_volume=500, price_chg=5.0, tick_type=1, seqno=9, open=995.0, high=1005.0, low=990.0,
                           avg_price=999.0, total_amount=1.0, amount=1.0, simtrade=False, bid_side_total_vol=1,
                           ask_side_total_vol=1, intraday_odd=odd)


def test_an_odd_lot_callback_is_an_event_of_the_market_odd_with_its_own_sequence(svc):
    published = []
    svc.event_sink.publish.side_effect = lambda event: published.append(event) or True
    callback = svc.thin_callback
    callback.on_stock_tick(None, _tick(False))
    callback.on_stock_tick(None, _tick(True))
    callback.on_stock_tick(None, _tick(True))
    callback.on_stock_bidask(None, SimpleNamespace(
        code="2330", datetime=_tick(True).datetime, bid_price=[999.0] * 5, ask_price=[1000.0] * 5, bid_volume=[100] * 5,
        ask_volume=[200] * 5, simtrade=False, intraday_odd=True))
    assert [(e.market, e.code, e.event_type, e.sequence) for e in published] == [
        ("STK", "2330", "trade", 1), ("ODD", "2330", "trade", 1), ("ODD", "2330", "trade", 2), ("ODD", "2330", "orderbook", 3)]
    assert published[1].data["volume"] == 37
