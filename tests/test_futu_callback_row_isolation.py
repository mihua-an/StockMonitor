"""Futu callback decoding, one row at a time.

A row that failed to convert (NaN price) raised out of the batch loop, so every later row of the same
push was lost, the lane had already been marked alive, and nothing counted it.
A row without an exchange time was filed by arrival time; it is refused and counted.
The per-key sequence was read/incremented/written outside any lock.
"""
from __future__ import annotations

import threading

from service.market.futu.callback import FutuThinCallbackAdapter


def _adapter():
    events, observed = [], []

    class Sink:
        def publish(self, event):
            events.append(event)
            return True

    adapter = FutuThinCallbackAdapter(Sink(), generation=lambda: 1,
                                      observe=lambda code, kind: observed.append(code))
    return adapter, events, observed


def test_a_bad_row_does_not_take_the_rest_of_the_batch_with_it():
    adapter, events, observed = _adapter()
    adapter._publish("quote", [
        {"code": "US.AAPL", "last_price": 250.0, "data_time": "2026-10-01 10:00:00"},
        {"code": "US.MSFT", "last_price": float("nan"), "data_time": "2026-10-01 10:00:00"},
        {"code": "US.NVDA", "last_price": 180.0, "data_time": "2026-10-01 10:00:00"},
    ])
    assert [event.code for event in events] == ["US.AAPL", "US.NVDA"]
    assert observed == ["US.AAPL", "US.NVDA"], "only admitted rows count as lane evidence"
    snapshot = adapter.snapshot()
    assert snapshot["rejected"] == 1
    # A required field that cannot be read rejects the row by name, never publishes it as 0.
    assert snapshot["last_rejection"]["ret_code"] == "invalid_last_price"


def test_a_row_without_exchange_time_is_refused_and_counted():
    # No wall-clock guess of the trading date; the row is refused and the refusal is visible.
    adapter, events, observed = _adapter()
    adapter._publish("quote", [{"code": "US.AAPL", "last_price": 250.0},
                               {"code": "US.AAPL", "last_price": 251.0, "data_time": "2026-10-01 10:00:00"}])
    assert [event.time_quality for event in events] == ["exchange"]
    assert [event.sequence for event in events] == [1], "a refused row takes no sequence"
    assert observed == ["US.AAPL"]
    snapshot = adapter.snapshot()
    assert snapshot["missing_exchange_time"] == 1
    assert snapshot["last_rejection"]["ret_code"] == "missing_exchange_time"


def test_concurrent_callbacks_get_unique_ordered_sequences():
    adapter, events, _ = _adapter()
    rows = [{"code": "US.AAPL", "price": 250.0, "volume": 1, "time": "2026-10-01 10:00:00"}]
    threads = [threading.Thread(target=lambda: [adapter._publish("trade", rows) for _ in range(200)]) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert [event.sequence for event in events] == list(range(1, 801)), "published in sequence order, none repeated"


def test_a_quote_without_a_price_yet_is_dropped_and_counted_apart_from_the_rejections():
    # Counted the same way as Shioaji: a current price of 0 means no price yet (NoPriceYet), not a decode error.
    adapter, events, observed = _adapter()
    result = adapter._publish("quote", [
        {"code": "US.AAPL", "last_price": 0, "data_time": "2026-10-01 04:00:00"},
        {"code": "US.MSFT", "last_price": 0.00001, "data_time": "2026-10-01 10:00:00"},
        {"code": "US.NVDA", "last_price": 180.00005, "data_time": "2026-10-01 10:00:00"},
    ])
    assert [event.code for event in events] == ["US.NVDA"] and observed == ["US.NVDA"]
    assert events[0].data["current"] == 1_800_001, "Futu's derived prices are rounded, not refused"
    assert result["rejected_by_reason"] == {"no_price_yet": 1, "invalid_last_price": 1}
    snapshot = adapter.snapshot()
    assert snapshot["rejected"] == 1, "only the price that rounds to 0 is an invalid field"
    assert snapshot["unpriced_quotes"] == {"last_price": 1}
    assert snapshot["unpriced_quote_last"]["code"] == "US.AAPL"


def test_a_print_or_bar_price_of_zero_stays_invalid():
    adapter, events, _ = _adapter()
    adapter._publish("trade", [{"code": "US.AAPL", "price": 0, "volume": 1, "time": "2026-10-01 10:00:00"}])
    adapter._publish("minute_bar", [{"code": "US.AAPL", "close": 0, "volume": 1, "time": "2026-10-01 10:00:00"}])
    snapshot = adapter.snapshot()
    assert events == [] and snapshot["rejected"] == 2 and snapshot["unpriced_quotes"] == {}


def test_a_print_carries_opend_ticker_type_as_its_condition():
    # OpenD's `type` (TickerType) was dropped: an odd lot or an average-price print became an ordinary 現價.
    adapter, events, _ = _adapter()
    adapter._publish("trade", [
        {"code": "US.TSM", "price": 353.10, "volume": 0.25, "type": "ODD_LOT", "time": "2026-11-06 07:36:00"},
        {"code": "US.TSM", "price": 354.00, "volume": 100, "type": "AUTO_MATCH", "time": "2026-11-06 09:31:00"},
        {"code": "US.TSM", "price": 354.10, "volume": 5, "time": "2026-11-06 09:32:00"},
    ])
    assert [event.data.get("condition") for event in events] == ["ODD_LOT", "AUTO_MATCH", None]
    assert "condition" not in events[2].data, "an unknown type is left out, never an empty string"
