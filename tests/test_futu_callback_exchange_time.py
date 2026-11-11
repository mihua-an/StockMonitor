"""Every Futu lane must take its session identity from its own exchange timestamp.

One field name per OpenD handler: StockQuoteHandlerBase carries `data_time`, TickerHandlerBase
`time`, OrderBookHandlerBase `update_time`, and RTDataHandlerBase `time_key`. `time_key` was absent
from the resolver, so minute bars silently fell back to arrival time -- filed under whatever
wall-clock minute processed them, with a trading_date derived from arrival rather than from the
exchange. These assert the mapping directly, per lane, so a future lane cannot be added without one.
"""
from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from service.market.futu.callback import FutuThinCallbackAdapter


class _RecordingSink:
    def __init__(self) -> None:
        self.events: list = []

    def publish(self, event) -> bool:
        self.events.append(event)
        return True

    def stop_admission(self) -> None:
        return None


def _adapter() -> tuple[FutuThinCallbackAdapter, _RecordingSink]:
    sink = _RecordingSink()
    adapter = FutuThinCallbackAdapter(
        sink=sink, generation=lambda: 1,
    )
    return adapter, sink


def _expected_ns(text: str) -> int:
    stamp = datetime.fromisoformat(text).replace(tzinfo=ZoneInfo("America/New_York"))
    return int(stamp.timestamp() * 1_000_000_000)


def test_every_lane_takes_its_timestamp_from_its_own_field():
    exchange_time = "2026-09-25 10:31:00"
    expected = _expected_ns(exchange_time)
    # The shapes the SDK really delivers (moomoo 10.10 quote_query.py). The quote's updateTime arrives split into
    # data_date + a bare "HH:MM:SS" data_time, and a book has only the server receive time of each side: with the
    # shapes this test used to assume, every live Futu quote and book was refused once rows without a time were.
    lanes = {
        "quote": {"code": "US.SPCX", "data_date": "2026-09-25", "data_time": "10:31:00", "last_price": 57.5,
                  "prev_close_price": 56.0, "volume": 1200},
        "trade": {"code": "US.SPCX", "time": exchange_time, "price": 57.5, "volume": 3},
        "orderbook": {"code": "US.SPCX", "svr_recv_time_bid": exchange_time, "svr_recv_time_ask": "",
                      "Bid": [(57.4, 5, 1, {})], "Ask": [(57.6, 5, 1, {})]},
        # The regression: this lane's field is `time_key`, nothing else.
        "minute_bar": {"code": "US.SPCX", "time_key": exchange_time, "open": 57.4, "high": 57.6,
                "low": 57.3, "close": 57.5, "volume": 11},
    }
    for kind, payload in lanes.items():
        adapter, sink = _adapter()
        adapter._publish(kind, [payload])
        assert len(sink.events) == 1, f"{kind} must admit exactly one event"
        event = sink.events[0]
        # A US bar is labelled with the minute it ends and stamped with the minute it covers.
        assert event.exchange_ts_ns == expected - (60_000_000_000 if kind == "minute_bar" else 0), (
            f"the {kind} lane must take its exchange timestamp from its own field, "
            f"not fall back to arrival time"
        )
        assert not {"trading_date", "session"} & set(event.as_dict()), "Market Runtime names the partition from that time"


def test_a_quote_and_a_bar_say_their_time_is_a_label_a_print_and_a_book_do_not():
    # Market Runtime measures 交易所延遲 from the event's own time; a quote's last-update second and a bar's minute only
    # file it (Futu P95 106 s on 10-16). The producer says which, on the event.
    exchange_time = "2026-09-25 10:31:00"
    lanes = {
        "quote": {"code": "US.SPCX", "data_date": "2026-09-25", "data_time": "10:31:00", "last_price": 57.5},
        "minute_bar": {"code": "US.SPCX", "time_key": exchange_time, "close": 57.5, "volume": 11},
        "trade": {"code": "US.SPCX", "time": exchange_time, "price": 57.5, "volume": 3},
        "orderbook": {"code": "US.SPCX", "svr_recv_time_bid": exchange_time, "Bid": [(57.4, 5, 1, {})], "Ask": [(57.6, 5, 1, {})]},
    }
    labelled = {}
    for kind, payload in lanes.items():
        adapter, sink = _adapter()
        adapter._publish(kind, [payload])
        event = sink.events[0]
        assert event.time_quality == "exchange", kind
        labelled[kind] = event.as_dict()["flags"].get("time_label", False)
    assert labelled == {"quote": True, "minute_bar": True, "trade": False, "orderbook": False}


def test_minute_bar_minute_comes_from_the_exchange_clock():
    adapter, sink = _adapter()
    adapter._publish("minute_bar", [{"code": "US.SPCX", "time_key": "2026-09-25 10:31:00",
                                  "open": 57.4, "high": 57.6, "low": 57.3, "close": 57.5,
                                  "volume": 11, "avg_price": 57.45}])
    data = sink.events[0].data
    # The bar is filed under its own exchange minute by Market Runtime, from this time; the provider names no minute.
    # OpenD's "10:31" US bar holds 10:30:00-10:30:59 (it is labelled with the minute it ends): stamped 10:30.
    assert sink.events[0].exchange_ts_ns == _expected_ns("2026-09-25 10:30:00")
    assert "minute" not in data
    # 均價 must survive the hop: without it Market Runtime's minute bar has average 0 and the
    # 均價線 cannot draw.
    assert data["average"] > 0, "avg_price must be carried through to the minute bar"


def test_a_row_without_any_timestamp_is_refused_and_counted_not_dated_by_the_clock():
    # It used to fall back to arrival time, so the wall clock chose its trading date.
    adapter, sink = _adapter()
    result = adapter._publish("quote", [{"code": "US.SPCX", "last_price": 57.5}])
    assert sink.events == []
    assert result == {"accepted": 0, "rejected": 1, "rejected_by_reason": {"missing_exchange_time": 1}}


def test_a_ticker_row_never_poses_its_own_size_as_cumulative_volume():
    # total_volume fell back to the print's own volume; Market Runtime then treated a
    # smaller print as "not new" and dropped it.
    adapter, sink = _adapter()
    adapter._publish("trade", [{"code": "US.SPCX", "time": "2026-09-25 10:31:00", "price": 57.5, "volume": 3}])
    assert sink.events[0].data["volume"] == 3
    # No cumulative figure reported is no field -- never a 0 Market Runtime would read as a real total.
    assert "total_volume" not in sink.events[0].data


def test_crypto_times_are_read_on_the_new_york_clock_its_day_is_on():
    # Real OpenD rows of 2026-10-08 13:19:11 Taipei (05:19:11 UTC): every CC lane reads 01:19, US Eastern. Read as UTC
    # (the old CC market clock) each print was stamped four hours early.
    real_utc = datetime(2026, 10, 8, 5, 19, 3, 195000, tzinfo=ZoneInfo("UTC"))
    lanes = {
        "trade": {"code": "CC.BTCUSD", "time": "2026-10-08 01:19:03.195", "price": 82773.58, "volume": 0.001431},
        "quote": {"code": "CC.BTCUSD", "data_date": "2026-10-08", "data_time": "01:19:03.195", "last_price": 82774.36},
        "orderbook": {"code": "CC.BTCUSD", "svr_recv_time_bid": "2026-10-08 01:19:03.195", "svr_recv_time_ask": "",
                      "Bid": [(82773.5, 0.2, 1, {})], "Ask": [(82774.0, 0.1, 1, {})]},
        "minute_bar": {"code": "CC.BTCUSD", "time_key": "2026-10-08 01:19:03.195", "cur_price": 82771.4, "volume": 4.642},
    }
    for kind, payload in lanes.items():
        adapter, sink = _adapter()
        adapter._publish(kind, [payload])
        event = sink.events[0]
        assert event.exchange_ts_ns == int(real_utc.timestamp() * 1_000_000_000), kind
        # Market Runtime files it on New York's day and minute (01:19, the day the CC cache is cleared on).
        assert "minute" not in event.data, kind


def test_crypto_after_taipei_midnight_is_still_the_new_york_day():
    # 00:30 Taipei = 12:30 US Eastern of the previous calendar day on OpenD's clock: still that New York day.
    adapter, sink = _adapter()
    adapter._publish("trade", [{"code": "CC.BTCUSD", "time": "2026-10-07 12:30:00", "price": 83000, "volume": 1}])
    event = sink.events[0]
    assert event.exchange_ts_ns == int(datetime(2026, 10, 7, 16, 30, tzinfo=ZoneInfo("UTC")).timestamp() * 1_000_000_000)


def test_a_live_quote_carries_its_volume_but_no_previous_close_and_a_book_takes_the_newer_side():
    adapter, sink = _adapter()
    adapter._publish("quote", [{"code": "US.NOK", "data_date": "2026-10-06", "data_time": "09:52:19",
                                    "last_price": 10.39, "prev_close_price": 10.32, "volume": 1500000}])
    adapter._publish("orderbook", [{"code": "US.NOK", "svr_recv_time_bid": "2026-10-06 09:52:18.100",
                                        "svr_recv_time_ask": "2026-10-06 09:52:19.250",
                                        "Bid": [(10.38, 900, 3, {})], "Ask": [(10.39, 400, 2, {})]}])
    quote, book = sink.events
    # 昨收 is the Reference event's alone (FutuReferencePublisher, D01-02): a quote never carries it.
    assert "prev_close" not in quote.data and quote.data["total_volume"] == 1500000
    assert quote.exchange_ts_ns == _expected_ns("2026-10-06 09:52:19") and "minute" not in quote.data
    assert book.exchange_ts_ns == _expected_ns("2026-10-06 09:52:19.250"), "the newer side's time dates the book"
    assert book.data["bids"][0]["volume"] == 900 and book.data["asks"][0]["price"] == 103900


def test_a_book_opend_replays_from_its_cache_is_dropped_and_counted_not_rejected():
    # Qot_UpdateOrderBook.proto: the receive time is empty for cached data (the first push after subscribing, a server
    # restart). 11-10: 22 such books after a restart were counted as missing_exchange_time rejections.
    adapter, sink = _adapter()
    result = adapter._publish("orderbook", [{"code": "US.SPCX", "svr_recv_time_bid": "", "svr_recv_time_ask": "",
                                             "Bid": [(57.4, 5, 1, {})], "Ask": [(57.6, 5, 1, {})]}])
    assert sink.events == []
    assert result == {"accepted": 0, "rejected": 1, "rejected_by_reason": {"cached_book": 1}}
    snapshot = adapter.snapshot()
    assert snapshot["cached_books"] == 1 and snapshot["cached_book_last"]["code"] == "US.SPCX"
    assert snapshot["rejected"] == 0 and snapshot["missing_exchange_time"] == 0


def test_a_rejection_is_written_to_the_log_not_only_counted(caplog):
    adapter, _ = _adapter()
    with caplog.at_level("WARNING", logger="service.market.futu.callback"):
        for _ in range(12):
            adapter._publish("quote", [{"code": "US.SPCX", "last_price": 57.5}])
    lines = [r.getMessage() for r in caplog.records if "rejected (missing_exchange_time)" in r.getMessage()]
    # The 1st and the 10th: a broken feed leaves a durable record without flooding the log.
    assert len(lines) == 2 and lines[0].endswith("(1 so far)") and lines[1].endswith("(10 so far)")
    assert adapter.snapshot()["rejections_by_reason"] == {"quote.missing_exchange_time": 12}
