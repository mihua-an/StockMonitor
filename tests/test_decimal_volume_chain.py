"""成交量 is a decimal quantity through the whole Python layer.

A US fractional-share print (Futu hpVolume 0.25) was int()-truncated to 0 in the Futu callback and showed 0 in the
成交明細. Every volume reader, comparison, de-duplication and output is covered here: no positive volume may become 0
anywhere, whole lots must read exactly as before, and "the total did not move" (a resend) must not depend on binary
noise of a decimal sum.
"""
from __future__ import annotations

import json

import pytest

from service.market.futu.callback import FutuThinCallbackAdapter
from service.market.shared import volume as vol

NOISY = 0.1 + 0.2  # 0.30000000000000004


# ------------------------------------------------------------------------------------------- the shared module

def test_volume_helpers_ignore_binary_noise_but_never_a_real_difference():
    assert NOISY != 0.3, "the premise: plain == fails"
    assert vol.eq(NOISY, 0.3) and not vol.gt(NOISY, 0.3) and not vol.lt(NOISY, 0.3)
    assert vol.gt(48_971_788.25, 48_971_788.0)
    assert vol.lt(0.0001, 0.0002)
    assert vol.positive(0.25) and vol.positive(0.0001)
    assert not vol.positive(0) and not vol.positive(-1) and not vol.positive(float("nan")) and not vol.positive(None)


def test_readers_and_output():
    assert vol.to_volume("0.25") == 0.25
    assert vol.to_volume(None) == 0.0 and vol.to_volume("") == 0.0 and vol.to_volume("x") == 0.0
    assert vol.to_volume(float("inf")) == 0.0
    assert vol.wire(NOISY) == 0.3
    assert vol.wire(5371.0) == 5371 and isinstance(vol.wire(5371.0), int), "whole lots stay ints on the wire"
    assert vol.wire(0.25) == 0.25
    assert vol.wire_opt(None) is None
    assert json.dumps({"v": vol.wire(10.0)}) == '{"v": 10}'


def test_units_are_explicit():
    assert vol.unit("shioaji", "STK") == "lot" and vol.UNIT_LABELS["lot"] == "張"
    assert vol.unit("shioaji", "FUT") == "contract" and vol.UNIT_LABELS["contract"] == "口"
    assert vol.unit("futu", "US") == "share" and vol.UNIT_LABELS["share"] == "股"
    assert vol.unit("futu", "CC") == "coin"


# ------------------------------------------------------------------------------------------- providers

class _Sink:
    def __init__(self) -> None:
        self.events: list = []

    def publish(self, event) -> bool:
        self.events.append(event)
        return True

    def stop_admission(self) -> None:
        return None


def _futu(kind: str, row: dict):
    sink = _Sink()
    FutuThinCallbackAdapter(sink=sink, generation=lambda: 1)._publish(kind, [row])
    assert len(sink.events) == 1, f"{kind} admitted"
    return sink.events[0].data


@pytest.mark.parametrize("size", [0.25, 0.0001, 1.5, 100.0])
def test_futu_ticker_size_is_never_truncated(size):
    data = _futu("trade", {"code": "US.NOK", "time": "2026-10-06 10:31:00", "price": 10.85, "volume": size})
    assert data["volume"] == size, "the root cause: int(0.25) was 0"
    assert vol.positive(data["volume"])


def test_futu_quote_bar_and_book_volumes_keep_their_fractions():
    quote = _futu("quote", {"code": "US.NOK", "data_date": "2026-10-06", "data_time": "10:31:00", "last_price": 10.85,
                            "prev_close_price": 10.2, "volume": 48_971_788.25})
    assert quote["total_volume"] == 48_971_788.25
    bar = _futu("minute_bar", {"code": "US.NOK", "time_key": "2026-10-06 10:31:00", "open": 10.8, "high": 10.9, "low": 10.8,
                        "close": 10.85, "volume": 12.75})
    assert bar["volume"] == 12.75
    book = _futu("orderbook", {"code": "US.NOK", "svr_recv_time_bid": "2026-10-06 10:31:00", "svr_recv_time_ask": "",
                               "Bid": [(10.84, 0.5, 1, {})], "Ask": [(10.86, 200, 1, {})]})
    assert book["bids"][0]["volume"] == 0.5 and book["asks"][0]["volume"] == 200


def test_shioaji_book_levels_need_a_real_volume():
    """A priced level whose volume is missing, short, NaN or garbage is left out and counted, never volume 0."""
    from service.market.shared.provider_fields import OptionalFields
    from service.market.shioaji.callback import _book_side

    fields = OptionalFields()
    prices = [1000, 990, 980, 970, -1]           # the fifth level has no price
    levels = _book_side(prices, [5, "0.5", None, float("nan")], fields, "bid_volume")
    assert [(lv["price"], lv["volume"]) for lv in levels] == [(1000, 5.0), (990, 0.5)]
    assert fields.invalid["bid_volume"] == 2      # None and NaN; the 4th price had a volume (NaN), the 5th no price
    assert _book_side([1000], "x", fields, "ask_volume") == []
    assert fields.invalid["ask_volume"] == 1


# ------------------------------------------------------------------------------------------- history / query

