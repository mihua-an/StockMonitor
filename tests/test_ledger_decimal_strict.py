"""A stored ledger amount that is not a number is damage: it fails the read that met it instead of becoming a zero
cost or profit that keeps being summed (R14-09)."""
from __future__ import annotations

from decimal import Decimal

import pytest

from service.account import mobile_api
from service.account.account_types import LedgerDataError, ledger_decimal
from service.account.accounting_core import AccountingCore


@pytest.mark.parametrize("value,expected", [(None, Decimal(0)), ("", Decimal(0)), ("12.50", Decimal("12.50")),
                                            (" 3 ", Decimal(3)), (7, Decimal(7)), (Decimal("-1.5"), Decimal("-1.5"))])
def test_numbers_and_absence(value, expected):
    assert ledger_decimal(value) == expected


@pytest.mark.parametrize("value", ["abc", "1,000", "NaN", "Infinity", True, object()])
def test_damage_is_raised_by_every_reader(value):
    for read in (ledger_decimal, AccountingCore._decimal, mobile_api._dec, AccountingCore._number):
        with pytest.raises(LedgerDataError):
            read(value)
    assert LedgerDataError.status_code == 500
