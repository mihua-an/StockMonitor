"""A TXF quote states its session reference (close - price_chg); Market Runtime, which alone knows the partition, writes
it as that partition's reference when the partition does not hold it yet (ingest.rs stated_reference)."""
from __future__ import annotations

from types import SimpleNamespace

from service.market.shioaji import callback

SCALE = 10_000


def _adapter():
    return callback.ShioajiThinCallbackAdapter(SimpleNamespace(_value=lambda obj, name, default=None: getattr(obj, name, default), _number=lambda value: value))


def test_a_quote_states_close_less_its_change():
    stated = _adapter()._stated_txf_reference(SimpleNamespace(close=23050.0, price_chg=50.0, simtrade=False), SCALE)
    assert stated == {"stated_reference_price": 230_000_000, "reference_source": "shioaji.quote.close_minus_price_chg"}


def test_an_indicative_quote_states_none():
    assert _adapter()._stated_txf_reference(SimpleNamespace(close=23050.0, price_chg=50.0, simtrade=True), SCALE) == {}


def test_a_quote_without_a_price_or_a_change_states_none():
    adapter = _adapter()
    assert adapter._stated_txf_reference(SimpleNamespace(close=None, price_chg=50.0, simtrade=False), SCALE) == {}
    assert adapter._stated_txf_reference(SimpleNamespace(close=23050.0, price_chg=None, simtrade=False), SCALE) == {}
    assert adapter._stated_txf_reference(SimpleNamespace(close=0.0, price_chg=0.0, simtrade=False), SCALE) == {}
