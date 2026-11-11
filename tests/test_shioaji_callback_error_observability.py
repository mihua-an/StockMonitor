"""Shioaji on_stock_tick/on_stock_bidask used to swallow any non-ValueError
exception with a bare `except Exception: pass` -- zero counter, zero log,
zero diagnostics. The fix counts it (owner._callback_errors) and records the
last message (owner._last_callback_error), both surfaced via
ShioajiBrokerService.status(); the drop-on-error recovery behavior itself is
unchanged (the tick/bidask is still silently discarded, same as before).
"""

from types import SimpleNamespace

from service.market.shioaji import callback
from service.market.shared.provider_contract import LaneDeliveryEvidence


def _boom(*args, **kwargs):
    raise RuntimeError("boom")


def _owner(**overrides):
    """Minimal stand-in for ShioajiBrokerService as the adapter's owner.

    The adapter reads the fixed-point scale off the owner (`price_scale`) and hands every
    normalized event to `owner.event_sink.publish()` -- there is no in-process Rust runtime
    on the owner any more (M21 retired the embedded PyO3 binding), so failure is injected
    by making the sink raise, not by making a `native_runtime.push_*` raise.
    """
    base = dict(
        price_scale=100,
        publish_session_reference=lambda *args: True,
        event_sink=SimpleNamespace(publish=_boom),
        # Part of the owner contract: the adapter records one lane-delivery
        # observation per accepted callback (readiness/staleness evidence).
        delivery_evidence=LaneDeliveryEvidence(), note_market_event=lambda *a, **k: None,
        _session_generation=1,
        _price_scale_errors=0,
        _callback_errors=0,
        _last_callback_error=None,
        _last_callback_epoch_ns=0,
        _int_value=lambda value: int(value),
        _number=lambda value: value,
        _exchange_text=lambda value: value,
        _flag_bits=lambda value: 0,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def test_on_stock_tick_generic_exception_is_counted_not_raised(monkeypatch):
    monkeypatch.setattr(callback, "exchange_timestamp_ns", lambda value: 1)
    owner = _owner()
    event = SimpleNamespace(code="2330", close=100, price_chg=1, volume=2, total_volume=20)
    adapter = callback.ShioajiThinCallbackAdapter(owner)

    result = adapter.on_stock_tick("TSE", event)

    assert result is None  # still drops silently -- recovery policy unchanged
    assert owner._callback_errors == 1
    assert "on_stock_tick" in owner._last_callback_error
    assert "boom" in owner._last_callback_error
    assert owner._price_scale_errors == 0  # distinct from the ValueError branch


def test_on_stock_bidask_generic_exception_is_counted_not_raised(monkeypatch):
    monkeypatch.setattr(callback, "exchange_timestamp_ns", lambda value: 1)
    owner = _owner()
    event = SimpleNamespace(
        code="2330",
        bid_price=[99] * 5, ask_price=[101] * 5,
        bid_volume=[2] * 5, ask_volume=[3] * 5,
        diff_bid_vol=[0] * 5, diff_ask_vol=[0] * 5,
    )
    adapter = callback.ShioajiThinCallbackAdapter(owner)

    result = adapter.on_stock_bidask("TSE", event)

    assert result is None
    assert owner._callback_errors == 1
    assert "on_stock_bidask" in owner._last_callback_error


def test_an_unreadable_required_price_is_a_counted_rejection_not_a_zero(monkeypatch):
    # A print whose price cannot be represented is rejected and counted by field -- never published as 0 --
    # and the generic-exception counter stays untouched.
    monkeypatch.setattr(callback, "exchange_timestamp_ns", lambda value: 1)
    published = []
    owner = _owner(event_sink=SimpleNamespace(publish=lambda event: published.append(event) or True))
    adapter = callback.ShioajiThinCallbackAdapter(owner)
    adapter.on_stock_tick("TSE", SimpleNamespace(code="2330", close="garbage", price_chg=1, volume=2, total_volume=20))
    adapter.on_stock_tick("TSE", SimpleNamespace(code="2330", close=100, price_chg=1, volume=None, total_volume=20))
    assert published == []
    assert adapter.invalid_required == {"stk.tick.close": 1, "stk.tick.volume": 1}
    # Each rejection says which product, what value and when (a count alone cannot name the contract or payload).
    last = adapter.invalid_required_last["stk.tick.close"]
    assert (last["code"], last["value"], last["count"], last["exchange_ts_ns"]) == ("2330", "'garbage'", 1, 1)
    assert last["at"]
    assert adapter.invalid_required_last["stk.tick.volume"]["value"] == "None"
    assert owner._callback_errors == 0 and owner._last_callback_error is None
    # A broken optional field is left out and counted; the print itself goes through.
    adapter.on_stock_tick("TSE", SimpleNamespace(code="2330", close=100, price_chg=1, volume=2, total_volume="n/a"))
    assert len(published) == 1 and "total_volume" not in published[0].data
    assert adapter.optional_fields.snapshot() == {"total_volume": 1}


def test_value_error_still_routes_to_price_scale_errors_not_callback_errors(monkeypatch):
    # Regression guard: the order book's ValueError (price-scale mismatch) branch keeps its own counter.
    monkeypatch.setattr(callback, "exchange_timestamp_ns", lambda value: 1)

    def _raise(*args, **kwargs):
        raise ValueError("fixed-point scale exceeded")

    monkeypatch.setattr(callback, "fixed_price_5", _raise)
    owner = _owner()
    event = SimpleNamespace(code="2330", bid_price=[1], ask_price=[1], bid_volume=[1], ask_volume=[1])
    adapter = callback.ShioajiThinCallbackAdapter(owner)

    adapter.on_stock_bidask("TSE", event)

    assert owner._price_scale_errors == 1
    assert owner._callback_errors == 0
    assert owner._last_callback_error is None


def test_happy_path_leaves_error_counters_untouched(monkeypatch):
    monkeypatch.setattr(callback, "exchange_timestamp_ns", lambda value: 1)
    owner = _owner(event_sink=SimpleNamespace(publish=lambda *a, **k: True))
    event = SimpleNamespace(code="2330", close=100, price_chg=1, volume=2, total_volume=20)
    adapter = callback.ShioajiThinCallbackAdapter(owner)

    adapter.on_stock_tick("TSE", event)

    assert owner._callback_errors == 0
    assert owner._price_scale_errors == 0
    assert owner._last_callback_error is None


# --- index / futures quote lanes ------------------------------------------------------------
# These two used to have NO exception handling at all and converted the exchange-computed
# `avg_price` with the strict price_to_units(). A TAIEX/TXFR1 quote whose average is not exactly
# representable at the fixed-point scale therefore raised straight out of the SDK callback
# thread: quote lost, no counter, no dataflow pulse, no log line -- while the stock tick/bidask
# lanes beside them counted the same class of failure.


def _quote_owner(**overrides):
    base = dict(
        # Index/futures lanes run at the finer fixed-point scale, which is exactly where a
        # derived average is least likely to land on an exact unit.
        price_scale=10000,
        TAIEX_CODE="IX0001",
        TXF_CODE="TXFR1",
        _value=lambda obj, name, default=None: getattr(obj, name, default),
        _session_generation=1,
    )
    base.update(overrides)
    return _owner(**base)


def _index_quote(avg_price):
    return SimpleNamespace(code="IX0001", close=25000, reference=24900, open=24950,
                           high=25100, low=24800, vol_sum=4200, amount_sum=1_250_000,
                           avg_price=avg_price)


def _futures_quote(avg_price):
    return SimpleNamespace(code="TXFR1", close=24960, reference=24900, open=24950,
                           high=25100, low=24800, total_volume=11, total_amount=1_000,
                           simtrade=False, volume=1, amount=100, avg_price=avg_price)


def test_index_and_futures_quotes_accept_a_derived_average_that_is_not_scale_exact(monkeypatch):
    monkeypatch.setattr(callback, "exchange_timestamp_ns", lambda value: 1)
    published = []
    owner = _quote_owner(event_sink=SimpleNamespace(publish=lambda event: published.append(event) or True))
    adapter = callback.ShioajiThinCallbackAdapter(owner)

    # 24945.40860435987 * 10000 is not an integer: strict conversion rejected it.
    adapter.on_index_quote(_index_quote(24945.40860435987))
    adapter.on_futures_quote("TAIFEX", _futures_quote(24945.40860435987))

    assert len(published) == 2, "both quotes must reach the sink"
    assert owner._price_scale_errors == 0 and owner._callback_errors == 0
    assert all(event.data["average"] == 249454086 for event in published)   # ROUND_HALF_UP at scale 10000


def test_index_and_futures_quote_failures_are_counted_not_raised_into_the_sdk_thread(monkeypatch):
    monkeypatch.setattr(callback, "exchange_timestamp_ns", lambda value: 1)

    owner = _quote_owner()          # default sink raises RuntimeError("boom")
    adapter = callback.ShioajiThinCallbackAdapter(owner)
    assert adapter.on_index_quote(_index_quote(24945.41)) is None
    assert adapter.on_futures_quote("TAIFEX", _futures_quote(24945.41)) is None
    assert owner._callback_errors == 2
    assert "on_futures_quote" in owner._last_callback_error and "boom" in owner._last_callback_error

    # An unconvertible required price is a rejection counted by field, and still does not escape.
    scale_owner = _quote_owner(event_sink=SimpleNamespace(publish=lambda event: True))
    scale_adapter = callback.ShioajiThinCallbackAdapter(scale_owner)
    assert scale_adapter.on_index_quote(_index_quote(1)) is None      # close/high/... are fine here
    bad = _index_quote(1)
    bad.close = "not-a-price"
    assert scale_adapter.on_index_quote(bad) is None
    assert scale_adapter.invalid_required == {"index.quote.close": 1}
    assert scale_owner._callback_errors == 0


def test_a_quote_without_a_price_yet_is_dropped_and_counted_apart_from_invalid_fields(monkeypatch, caplog):
    # A trial auction's first futures quote carries close=0 (no match yet): the whole quote -- bid/ask included --
    # is dropped, but as "no price yet", not as an invalid field: no invalid_required count, no rejected warning,
    # no failed dataflow pulse. Its own count says which contract, what value and when.
    from decimal import Decimal

    monkeypatch.setattr(callback, "exchange_timestamp_ns", lambda value: 1)
    published, pulses = [], []
    owner = _quote_owner(event_sink=SimpleNamespace(publish=lambda event: published.append(event) or True),
                         publish_txf_session_reference=lambda key, reference: True)
    adapter = callback.ShioajiThinCallbackAdapter(owner)
    monkeypatch.setattr(adapter, "_pulse_dataflow", lambda *args, **kwargs: pulses.append((args, kwargs)))
    unpriced = _futures_quote(None)
    unpriced.code, unpriced.close = "TXFJ6", Decimal("0")
    index_unpriced = _index_quote(None)
    index_unpriced.close = 0
    with caplog.at_level("WARNING", logger=callback.__name__):
        adapter.on_futures_quote("TAIFEX", unpriced)
        adapter.on_futures_quote("TAIFEX", unpriced)
        adapter.on_index_quote(index_unpriced)
    assert published == [] and pulses == []
    assert adapter.invalid_required == {} and adapter.invalid_required_last == {}
    assert adapter.unpriced_quotes == {"futures.quote.close": 2, "index.quote.close": 1}
    last = adapter.unpriced_quotes_last["futures.quote.close"]
    assert (last["code"], last["value"], last["count"], last["exchange_ts_ns"]) == ("TXFJ6", "Decimal('0')", 2, 1)
    assert last["at"]
    assert "rejected" not in caplog.text
    assert owner._callback_errors == 0 and owner._price_scale_errors == 0

    # A truly invalid current price is still an error: counted as invalid and warned about.
    for bad in (-1, "garbage", None):
        quote = _futures_quote(None)
        quote.close = bad
        with caplog.at_level("WARNING", logger=callback.__name__):
            adapter.on_futures_quote("TAIFEX", quote)
    assert adapter.invalid_required == {"futures.quote.close": 3}
    assert "futures.quote rejected for TXFR1: close=-1" in caplog.text
    assert adapter.unpriced_quotes == {"futures.quote.close": 2, "index.quote.close": 1}
    assert published == []

    # A priced quote goes through untouched.
    adapter.on_futures_quote("TAIFEX", _futures_quote(None))
    assert len(published) == 1 and published[0].data["current"] == 24960 * 10000


def test_a_print_price_of_zero_stays_invalid_only_a_quote_price_of_zero_means_no_price_yet():
    import pytest

    from service.market.shared.provider_fields import InvalidField, NoPriceYet, quote_price, required_price

    with pytest.raises(InvalidField):
        required_price("close", 0, scale=100)
    with pytest.raises(NoPriceYet):
        quote_price("close", 0, scale=100)
    for bad in (-1, "garbage", None, ""):
        with pytest.raises(InvalidField):
            quote_price("close", bad, scale=100)
    # NoPriceYet is not an invalid value: no ValueError handler may take it for one.
    assert not issubclass(NoPriceYet, ValueError)
    assert quote_price("close", 1.5, scale=100) == required_price("close", 1.5, scale=100) == 150


def test_an_event_without_exchange_time_is_refused_as_such_never_dated_by_the_wall_clock(monkeypatch):
    """No exchange time: no partition. The callback names none either way; the sink refuses the event and counts it
    as a missing-time refusal -- it is neither published under today's date nor a price-scale error."""
    from service.market.shared.rust_live import RustDaemonEventSink

    monkeypatch.setattr(callback, "exchange_timestamp_ns", lambda value: 0)
    sink = RustDaemonEventSink(source="shioaji", token="t")
    owner = _owner(event_sink=sink, _value=lambda obj, key, default=None: getattr(obj, key, default), TXF_CODE="TXFR1")
    adapter = callback.ShioajiThinCallbackAdapter(owner)
    adapter.on_stock_tick("TSE", SimpleNamespace(code="2330", close=100, price_chg=1, volume=2, total_volume=20))
    adapter.on_futures_quote("TAIFEX", SimpleNamespace(code="TXFK6", close=20000, total_volume=5, volume=1))
    stats = sink.stats()
    assert stats["accepted"] == 0 and owner._price_scale_errors == 0 and owner._callback_errors == 0
    assert stats["missing_exchange_time"] == {"trade": 1, "quote": 1}
