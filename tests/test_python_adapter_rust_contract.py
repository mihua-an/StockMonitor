from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace

from service.market.futu.callback import FutuThinCallbackAdapter
from service.market.shared.rust_live import LIVE_EVENT_SCHEMA, RustLiveEvent
from service.market.shioaji.callback import ShioajiThinCallbackAdapter
from tests import synthetic_runtime as rt


class CapturingSink:
    def __init__(self) -> None:
        self.events: list[RustLiveEvent] = []
        self.accepting = True

    def publish(self, event: RustLiveEvent) -> bool:
        if not self.accepting:
            return False
        self.events.append(event)
        return True

    def stop_admission(self) -> None:
        self.accepting = False


def test_shioaji_and_futu_callbacks_publish_rust_live_contract_without_python_view():
    sink = CapturingSink()
    owner = rt.shioaji_owner(sink)
    owner._session_generation = 7
    adapter = ShioajiThinCallbackAdapter(owner)
    stamp = datetime(2026, 9, 21, 9, 1, 2)

    adapter.on_stock_tick("TSE", SimpleNamespace(
        code="2330", datetime=stamp, close=100.5, price_chg=0.5,
        volume=3, total_volume=10, tick_type=1, seqno="t1",
    ))
    adapter.on_stock_bidask("TSE", SimpleNamespace(
        code="2330", datetime=stamp,
        bid_price=[100.0, 99.5], ask_price=[100.5, 101.0],
        bid_volume=[4, 5], ask_volume=[6, 7],
    ))

    # The 昨收 the print states (close - price_chg) travels with it; Market Runtime writes it as the Reference of the
    # print's partition when that partition does not hold it yet.
    assert [event.event_type for event in sink.events] == ["trade", "orderbook"]
    assert all(event.schema == LIVE_EVENT_SCHEMA for event in sink.events)
    assert all(event.generation == 7 and event.code == "2330" for event in sink.events)
    trade = sink.events[0].data
    assert trade["stated_prev_close"] == 1_000_000
    assert {key: trade[key] for key in ("price", "volume", "total_volume", "side", "trade_id")} == {
        "price": 1_005_000, "volume": 3, "total_volume": 10, "side": 1, "trade_id": "t1",
    }
    # Market Runtime names every partition and its minute from the exchange time: the envelope carries none.
    assert "minute" not in trade
    assert not {"trading_date", "session"} & set(sink.events[0].as_dict())
    assert "prev_close" not in trade, "a print never carries a 昨收 into the WAL: the Reference event is its one carrier"
    assert sink.events[1].data["bids"][0] == {"price": 1_000_000, "volume": 4}

    futu = FutuThinCallbackAdapter(sink, generation=lambda: 4)
    futu._publish("quote", {
        "code": "US.AAPL", "data_time": "2026-09-21T14:30:00+00:00",
        "last_price": 250.25, "prev_close_price": 249.0, "open_price": 250.0,
        "high_price": 251.0, "low_price": 248.5, "volume": 123,
    })
    event = sink.events[-1]
    assert event.source == "futu" and event.market == "US" and event.event_type == "quote"
    assert event.generation == 4 and event.sequence == 1
    assert event.data["current"] == 2_502_500
    assert "minute" not in event.data
    assert set(event.data) >= {"current", "open", "high", "low", "total_volume", "status"}
    # The 昨收 reaches Market Runtime only as a Reference event (service/market/futu/reference.py), never on a quote.
    assert "prev_close" not in event.data
    # Fields the row did not carry are not sent (Market Runtime reads absent as "not reported").
    assert not set(event.data) & {"total_amount", "average", "amount"}
    futu._publish("trade", {"code": "US.AAPL", "data_time": "2026-09-21T10:31:00",
                            "price": 250.5, "volume": 2, "ticker_direction": "BUY"})
    trade = sink.events[-1]
    assert "minute" not in trade.data
    assert set(trade.data) >= {"price", "volume", "side", "trade_id"}
    assert not set(trade.data) & {"total_volume", "prev_close", "open", "high", "low", "average", "total_amount", "amount"}
    assert "payload" not in event.as_dict()
    assert "data" in event.as_dict()


