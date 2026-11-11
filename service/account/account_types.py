from __future__ import annotations
from dataclasses import dataclass

from service.platform.stated_error import StatedError
from decimal import Decimal, InvalidOperation
from typing import Any

class ActualAccountError(StatedError, RuntimeError):
    """An account operation that failed for a reason this code states on purpose.

    It carries what the failure means over HTTP: by default the remote side (GAS / the Sheet) failed or
    answered something unusable (502); call sites name the other cases -- bad input (422), something missing (404),
    not configured or switched off (409), shutting down (503), the local credential store (500)."""

    def __init__(self, message: str = "", *, classification: str = "ACCOUNT_REMOTE_FAILURE", status_code: int = 502) -> None:
        super().__init__(message)
        self.classification = classification
        self.status_code = int(status_code)


def invalid_account_input(message: str) -> ActualAccountError:
    return ActualAccountError(message, classification="INVALID_INPUT", status_code=422)


class TradeInfoError(StatedError, ValueError):
    """Trade text that cannot be read: the user's input, answered 422."""
    status_code = 422
    classification = "INVALID_INPUT"


class LedgerDataError(StatedError, RuntimeError):
    """A stored ledger amount that is not a finite number: the ledger is damaged. It fails the read or rebuild that met
    it (500) instead of entering the books as a zero cost or profit."""
    status_code = 500
    classification = "LEDGER_DATA_INVALID"


def ledger_decimal(value: Any) -> Decimal:
    """A stored or computed ledger amount as a Decimal. An absent amount (None or "") is zero; anything that is not a
    finite number raises LedgerDataError."""
    if value is None or value == "":
        return Decimal(0)
    if isinstance(value, bool):
        raise LedgerDataError(f"ledger amount {value!r} is not a number")
    try:
        number = value if isinstance(value, Decimal) else Decimal(str(value).strip())
    except InvalidOperation:
        raise LedgerDataError(f"ledger amount {value!r} is not a number") from None
    if not number.is_finite():
        raise LedgerDataError(f"ledger amount {value!r} is not a finite number")
    return number


@dataclass(frozen=True)
class Fill:
    qty: Decimal
    price: Decimal
    amount: Decimal


@dataclass
class Order:
    trade_id: str
    trade_date: str
    market: str
    action: str
    code: str
    trade_info: str
    trade_time: str
    source_order: int
    fills: list[Fill]
    qty: Decimal
    gross_amount: Decimal
    avg_price: Decimal
    fee: Decimal


@dataclass
class Leg:
    trade_id: str
    trade_date: str
    market: str
    action: str
    code: str
    trade_time: str
    source_order: int
    trade_type: str
    qty: Decimal
    gross_amount: Decimal
    fee: Decimal
    tax: Decimal
    avg_price: Decimal


