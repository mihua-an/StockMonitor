from service.market.shared.market_value_policy import resolve_market_move


def test_the_move_is_derived_from_the_reference():
    move = resolve_market_move(current=105, prev_close=100)
    assert (move.price_change, move.pct_change) == (5, 5)


def test_a_missing_value_or_a_zero_reference_has_no_move():
    assert resolve_market_move(current=None, prev_close=100).price_change is None
    assert resolve_market_move(current=105, prev_close=None).pct_change is None
    zero = resolve_market_move(current=105, prev_close=0)
    assert (zero.price_change, zero.pct_change) == (105, None)
