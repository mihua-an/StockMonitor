"""SessionSpec trading-day search (R13-07): a search that finds no trading day raises; it never hands out the
neighbouring calendar date, which the predicate never accepted, as a trading day."""
from __future__ import annotations

from datetime import date

import pytest

from service.market.lifecycle.session import TW_EQUITY_SPEC, TradingDayResolutionError


def test_the_neighbouring_trading_days_by_the_predicate():
    friday, monday = date(2026, 10, 2), date(2026, 10, 5)
    assert TW_EQUITY_SPEC.next_trading_day(friday) == monday
    assert TW_EQUITY_SPEC.previous_trading_day(monday) == friday
    assert TW_EQUITY_SPEC.next_trading_day(friday, lambda day: day == date(2026, 10, 7)) == date(2026, 10, 7)


def test_no_trading_day_within_the_search_raises_instead_of_inventing_one():
    def closed(_day):
        return False

    with pytest.raises(TradingDayResolutionError, match="closed"):
        TW_EQUITY_SPEC.previous_trading_day(date(2026, 10, 5), closed)
    with pytest.raises(TradingDayResolutionError, match="2026-10-05"):
        TW_EQUITY_SPEC.next_trading_day(date(2026, 10, 5), closed)
