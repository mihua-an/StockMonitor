"""Shioaji callback cost contract: one timestamp conversion, one non-blocking sink admission per event,
unique monotonic sequences under concurrent SDK threads, and the instrument identity on every event. The event names
no partition (trading date, session, minute): Market Runtime names it from the exchange time."""
from types import SimpleNamespace
from concurrent.futures import ThreadPoolExecutor
import threading
import time
from unittest.mock import Mock

import pytest
from service.market.shioaji import callback
from service.market.shared.provider_contract import LaneDeliveryEvidence

EXCHANGE_NS = 1_788_829_200_000_000_000  # 2026-09-08 09:00:00 Asia/Taipei
PARTITION_FIELDS = {"trading_date", "session", "minute"}


class Sink:
    def __init__(self, accepted=True, delay=0.0):
        self.events, self.accepted, self.delay, self._lock = [], accepted, delay, threading.Lock()

    def publish(self, event):
        if self.delay:
            time.sleep(self.delay)
        with self._lock:
            self.events.append(event)
        return self.accepted


def _owner(sink):
    # delivery_evidence is part of the callback owner contract: every accepted
    # callback records one lane-delivery observation there (the readiness/lane
    # staleness projection's single input).
    return SimpleNamespace(
        event_sink=sink, price_scale=100, _session_generation=1, TXF_CODE="TXFR1", TAIEX_CODE="TAIEX",
        delivery_evidence=LaneDeliveryEvidence(), note_market_event=lambda *a, **k: None,
        _price_scale_errors=0, _callback_errors=0, _last_callback_error="",
        _value=lambda obj, key, default=None: getattr(obj, key, default),
        _number=lambda value: value, _int_value=lambda value: int(value or 0),
    )


@pytest.mark.parametrize("lane", ["tick", "bidask"])
@pytest.mark.parametrize("accepted", [True, False])
def test_callback_converts_timestamp_once_even_on_rejection(monkeypatch, lane, accepted):
    stamp = Mock(return_value=EXCHANGE_NS)
    monkeypatch.setattr(callback, "exchange_timestamp_ns", stamp)
    timer = Mock(return_value=100)
    monkeypatch.setattr(callback.time, "perf_counter_ns", timer)
    sink = Sink(accepted)
    owner = _owner(sink)
    event = SimpleNamespace(code="2330", datetime="2026-09-08 09:00:00", close=100, price_chg=1,
                            volume=2, total_volume=20, bid_price=[99] * 5, ask_price=[101] * 5,
                            bid_volume=[2] * 5, ask_volume=[3] * 5)
    adapter = callback.ShioajiThinCallbackAdapter(owner)
    assert getattr(adapter, "on_stock_" + lane)("TSE", event) is None
    stamp.assert_called_once_with(event)
    timer.assert_not_called()
    assert len(sink.events) == 1
    published = sink.events[0]
    assert (published.source, published.market, published.code) == ("shioaji", "STK", "2330")
    assert published.exchange_ts_ns == EXCHANGE_NS
    assert not PARTITION_FIELDS & (set(published.as_dict()) | set(published.data))
    assert owner._callback_errors == 0


@pytest.mark.parametrize("lane", ["index", "futures"])
def test_quote_callback_is_single_nonblocking_sink_admission(monkeypatch, lane):
    stamp = Mock(return_value=EXCHANGE_NS)
    monkeypatch.setattr(callback, "exchange_timestamp_ns", stamp)
    sink = Sink()
    owner = _owner(sink)
    event = SimpleNamespace(
        code="TAIEX" if lane == "index" else "TXFR1", close=100.0, reference=99.0, open=98.0, high=101.0,
        low=97.0, avg_price=99.5, amount_sum=1000.0, vol_sum=200.0, volume=7, total_volume=207, amount=700.0,
        total_amount=20700.0, simtrade=False, to_dict=lambda: {})
    adapter = callback.ShioajiThinCallbackAdapter(owner)
    if lane == "index":
        adapter.on_index_quote(event)
        (published,) = sink.events
        assert (published.market, published.code, published.event_type) == ("IDX", "TAIEX", "quote")
    else:
        adapter.on_futures_quote("TAIFEX", event)
        (published,) = sink.events
        assert (published.market, published.code, published.event_type) == ("FUT", "TXFR1", "quote")
    # Which session (FUT DAY / NIGHT) and trading day the quote belongs to is Market Runtime's, from exchange_ts_ns.
    assert published.exchange_ts_ns == EXCHANGE_NS
    assert not PARTITION_FIELDS & (set(published.as_dict()) | set(published.data))
    stamp.assert_called_once_with(event)


def test_every_print_states_the_previous_close_it_carries_and_no_reference_event_is_sent(monkeypatch):
    # D01-02 / D03-10: the provider keeps no memory of what it sent and names no partition. Each print or quote states
    # the feed's own 昨收 (a print's close - price_chg, an index quote's reference, a TXF quote's close - price_chg as
    # its reference price) in its data; Market Runtime takes it out as the partition's Reference event when that
    # partition does not hold it yet, so a print never carries 昨收 into the WAL. One callback, one event.
    monkeypatch.setattr(callback, "exchange_timestamp_ns", lambda _value: EXCHANGE_NS)
    sink = Sink()
    owner = _owner(sink)
    stated_txf = []
    owner.note_txf_stated_reference = lambda price, exchange_ns: stated_txf.append((price, exchange_ns))
    adapter = callback.ShioajiThinCallbackAdapter(owner)
    tick = lambda chg: SimpleNamespace(code="2330", close=100, price_chg=chg, volume=1, total_volume=1)  # noqa: E731
    adapter.on_stock_tick("TSE", tick(1))
    adapter.on_stock_tick("TSE", tick(1))
    adapter.on_stock_tick("TSE", tick(2))
    adapter.on_stock_tick("TSE", SimpleNamespace(code="2330", close=100, volume=1, total_volume=1))
    assert [event.data.get("stated_prev_close") for event in sink.events] == [9900, 9900, 9800, None]
    assert all(event.event_type == "trade" and "prev_close" not in event.data for event in sink.events)
    index = SimpleNamespace(code="TAIEX", close=100.0, reference=99.0, open=98.0, high=101.0, low=97.0, avg_price=99.5,
                            amount_sum=1000.0, vol_sum=200.0, to_dict=lambda: {})
    adapter.on_index_quote(index)
    assert sink.events[-1].event_type == "quote" and sink.events[-1].data["stated_prev_close"] == 9900
    assert "prev_close" not in sink.events[-1].data
    txf = SimpleNamespace(code="TXFK6", close=100.0, price_chg=2.0, open=98.0, high=101.0, low=97.0, volume=1,
                          total_volume=1, simtrade=False)
    adapter.on_futures_quote("TAIFEX", txf)
    assert sink.events[-1].data["stated_reference_price"] == 9800
    assert sink.events[-1].data["reference_source"] == "shioaji.quote.close_minus_price_chg"
    assert stated_txf == [(9800, EXCHANGE_NS)]
    assert len(sink.events) == 6
    assert owner._callback_errors == 0


def test_a_book_carries_prices_and_volumes_only(monkeypatch):
    # D01-05: the SDK's diff_bid_vol / diff_ask_vol is a per-index change; Market Runtime computes each level's change
    # against the previous book at the same price, so the provider sends no diff of its own.
    monkeypatch.setattr(callback, "exchange_timestamp_ns", lambda _value: EXCHANGE_NS)
    sink = Sink()
    adapter = callback.ShioajiThinCallbackAdapter(_owner(sink))
    adapter.on_stock_bidask("TSE", SimpleNamespace(code="2330", bid_price=[99, 98], ask_price=[101, 102], bid_volume=[2, 4],
                                                   ask_volume=[3, 5], diff_bid_vol=[1, -1], diff_ask_vol=[2, 0]))
    (book,) = sink.events
    assert book.data["bids"] == [{"price": 9900, "volume": 2}, {"price": 9800, "volume": 4}]
    assert all(set(level) == {"price", "volume"} for level in book.data["bids"] + book.data["asks"])


def test_a_refused_print_does_not_stop_the_next_one_stating_the_previous_close(monkeypatch):
    # The provider remembers nothing about a 昨收 it stated: after the sink refuses a print, the next print states it
    # again, and so does every one after it (whether the partition already holds it is Market Runtime's judgement).
    monkeypatch.setattr(callback, "exchange_timestamp_ns", lambda _value: EXCHANGE_NS)
    sink = Sink()
    answers = iter([False, True, True])
    sink.publish = lambda event: sink.events.append(event) or next(answers)
    adapter = callback.ShioajiThinCallbackAdapter(_owner(sink))
    event = SimpleNamespace(code="2330", close=100, price_chg=1, volume=1, total_volume=1)
    for _ in range(3):
        adapter.on_stock_tick("TSE", event)
    assert [e.data["stated_prev_close"] for e in sink.events] == [9900, 9900, 9900]


def test_concurrent_tick_callbacks_publish_unique_monotonic_sequences(monkeypatch):
    monkeypatch.setattr(callback, "exchange_timestamp_ns", lambda _value: EXCHANGE_NS)
    # Widen the read-modify-write/admission race: the adapter's lock must keep admission order exactly 1..N.
    sink = Sink(delay=0.001)
    event = SimpleNamespace(code="2330", close=100, price_chg=1, volume=1, total_volume=1)
    adapter = callback.ShioajiThinCallbackAdapter(_owner(sink))
    with ThreadPoolExecutor(max_workers=12) as pool:
        list(pool.map(lambda _index: adapter.on_stock_tick("TSE", event), range(40)))
    assert [e.sequence for e in sink.events] == list(range(1, 41))
