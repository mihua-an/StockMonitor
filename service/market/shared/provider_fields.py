"""Provider event fields: required, optional and invalid are three different things.

A broker value that is missing or cannot be read is never turned into a real 0:

* a REQUIRED field (a print's price and size, a quote's current price) that is missing or invalid rejects the
  whole event -- ``InvalidField`` -- and the adapter counts it by field;
* an OPTIONAL field that is missing is left out of the event (Market Runtime reads an absent field as "not reported");
  one that is present but invalid is left out too and counted, so a renamed or reformatted SDK field shows up
  instead of quietly reading as 0;
* a quote's CURRENT price of exactly 0 is neither: the broker's way of saying the market has no price yet (a trial
  auction's first quote before anything matched). The quote has nothing to show and is dropped -- ``NoPriceYet`` --
  counted apart from the invalid fields, since it is not an error.
"""
from __future__ import annotations

import math
import threading
from collections import Counter
from decimal import Decimal
from typing import Any

from service.market.shared.native_values import NONE_I64, derived_price_to_units, price_to_units


class InvalidField(ValueError):
    def __init__(self, field: str, value: Any) -> None:
        super().__init__(f"required field {field} is missing or invalid: {value!r}"[:200])
        self.field = field
        self.value = value


class NoPriceYet(Exception):
    """A quote reports its current price as 0: the market has not priced it yet. Not a ValueError -- it is no
    invalid value, so no caller's invalid-value handling may take it for one."""

    def __init__(self, field: str, value: Any) -> None:
        super().__init__(f"{field} has no price yet: {value!r}"[:200])
        self.field = field
        self.value = value


def _absent(value: Any) -> bool:
    return value is None or value == ""


def _price_units(field: str, value: Any, *, scale: int, derived: bool = False) -> int:
    try:
        units = (derived_price_to_units if derived else price_to_units)(value, scale=scale)
    except (ValueError, OverflowError) as exc:
        raise InvalidField(field, value) from exc
    if units == NONE_I64 or units < 0:
        raise InvalidField(field, value)
    return units


def required_price(field: str, value: Any, *, scale: int) -> int:
    """A print's price: a print always has one, so 0 is as invalid as a negative or unreadable value."""
    units = _price_units(field, value, scale=scale)
    if units == 0:
        raise InvalidField(field, value)
    return units


def quote_price(field: str, value: Any, *, scale: int, derived: bool = False) -> int:
    """A quote's current price: 0 means no price yet (``NoPriceYet``); a missing or invalid one is ``InvalidField``.

    `derived` rounds a price finer than the scale (Futu's computed prices) instead of refusing it; a nonzero price that
    rounds to 0 is then invalid, not "no price yet" -- only the broker's own 0 means that."""
    units = _price_units(field, value, scale=scale, derived=derived)
    if units == 0:
        if derived and Decimal(str(value)) != 0:
            raise InvalidField(field, value)
        raise NoPriceYet(field, value)
    return units


def required_volume(field: str, value: Any) -> float:
    if _absent(value) or isinstance(value, bool):
        raise InvalidField(field, value)
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise InvalidField(field, value) from exc
    if not math.isfinite(number) or number < 0:
        raise InvalidField(field, value)
    return number


class OptionalFields:
    """Reads optional fields for one adapter, counting the present-but-invalid ones by field."""

    def __init__(self) -> None:
        self.invalid: Counter[str] = Counter()
        # Several SDK connections call one adapter from their own threads: a count is a read-modify-write.
        self._lock = threading.Lock()

    def _count(self, field: str) -> None:
        with self._lock:
            self.invalid[field] += 1

    def price(self, field: str, value: Any, *, scale: int, derived: bool = False) -> int | None:
        if _absent(value):
            return None
        try:
            units = (derived_price_to_units if derived else price_to_units)(value, scale=scale)
        except (ValueError, OverflowError):  # not an error: counted in invalid[field] and reported with the provider's field quality
            self._count(field)
            return None
        return None if units == NONE_I64 else units

    def number(self, field: str, value: Any) -> float | None:
        if _absent(value):
            return None
        if isinstance(value, bool):
            self._count(field)
            return None
        try:
            number = float(value)
        except (TypeError, ValueError):  # not an error: counted in invalid[field] and reported with the provider's field quality
            self._count(field)
            return None
        if not math.isfinite(number):
            self._count(field)
            return None
        return number

    def volume(self, field: str, value: Any) -> float | None:
        number = self.number(field, value)
        if number is not None and number < 0:
            self._count(field)
            return None
        return number

    def snapshot(self) -> dict[str, int]:
        with self._lock:
            return dict(self.invalid)


def present(data: dict[str, Any]) -> dict[str, Any]:
    """The event data without the fields nobody reported."""
    return {key: value for key, value in data.items() if value is not None}
