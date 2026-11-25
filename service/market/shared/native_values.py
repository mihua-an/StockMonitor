"""Provider value conversion at the Python-to-native boundary: prices to the native fixed point (1/10_000, Rust
`event::PRICE_SCALE`) on the way in, and back to a number when a stored value is read."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any


DEFAULT_PRICE_SCALE = 10_000
NONE_I64 = -(2**63)
TAIPEI_EXCHANGE_TZ = timezone(timedelta(hours=8), name="Asia/Taipei")


def price_to_units(value: Any, *, scale: int = DEFAULT_PRICE_SCALE) -> int:
    if value is None or value == "":
        return NONE_I64
    if isinstance(value, bool):
        raise ValueError("boolean is not a market price")
    try:
        decimal_value = value if isinstance(value, Decimal) else Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise ValueError(f"invalid market price {value!r}") from exc
    scaled = decimal_value * int(scale)
    integral = scaled.to_integral_value()
    if scaled != integral:
        raise ValueError(f"price {decimal_value} is not lossless at fixed-point scale {scale}")
    result = int(integral)
    if result <= -(2**63) or result >= 2**63:
        raise OverflowError("market price fixed-point value exceeds i64")
    return result


def units_to_price(units: Any) -> float | None:
    """A stored fixed-point price as a number (None when the value is not an integer)."""
    try:
        return int(units) / DEFAULT_PRICE_SCALE
    except (TypeError, ValueError):  # not an error: a missing or non-numeric stored price is None by contract
        return None


def derived_price_to_units(value: Any, *, scale: int = DEFAULT_PRICE_SCALE) -> int:
    if value is None or value == "":
        return NONE_I64
    if isinstance(value, bool):
        raise ValueError("boolean is not a derived market price")
    try:
        decimal_value = value if isinstance(value, Decimal) else Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise ValueError(f"invalid derived market price {value!r}") from exc
    integral = (decimal_value * int(scale)).to_integral_value(rounding=ROUND_HALF_UP)
    result = int(integral)
    if result <= -(2**63) or result >= 2**63:
        raise OverflowError("derived market price fixed-point value exceeds i64")
    return result


class RunningAverage:
    """The session-to-now 均價 of a run of prints (fixed point), as the live stream states it on each print: traded
    amount over volume. A broker's history states only price and volume, so whoever turns it into events runs this.

    ``average_before`` / ``total_before``: the 均價 and cumulative volume the run starts from; ``from_open`` starts at
    nothing. A run whose start is not known has no average (0 = not stated): its own prints' average is not the
    session's."""

    def __init__(self, *, from_open: bool, average_before: int | None = None, total_before: float | None = None) -> None:
        self._known = from_open or (bool(average_before) and bool(total_before))
        self._volume = 0.0 if from_open or not self._known else float(total_before)
        self._amount = 0.0 if from_open or not self._known else float(average_before) * float(total_before)

    def after(self, price_units: int, volume: float) -> int:
        """The average at this print."""
        if not self._known:
            return 0
        self._volume += float(volume)
        self._amount += float(price_units) * float(volume)
        return int(self._amount / self._volume + 0.5)


def exchange_timestamp_ns(obj: Any) -> int:
    """Return a Shioaji exchange-local wall clock as an epoch timestamp."""
    raw = getattr(obj, "datetime", None)
    if isinstance(raw, datetime):
        if raw.tzinfo is None:
            raw = raw.replace(tzinfo=TAIPEI_EXCHANGE_TZ)
        return int(raw.timestamp() * 1_000_000_000)
    raw_date = getattr(obj, "date", None)
    raw_time = getattr(obj, "time", None)
    if isinstance(raw_date, datetime):
        raw_date = raw_date.date()
    try:
        year, month, day = ((raw_date.year, raw_date.month, raw_date.day) if hasattr(raw_date, "year") else tuple(raw_date)[:3])
        if hasattr(raw_time, "hour"):
            hour, minute, second = raw_time.hour, raw_time.minute, raw_time.second
            microsecond = getattr(raw_time, "microsecond", 0)
        else:
            parts = tuple(raw_time or ())
            hour, minute, second = (list(parts) + [0, 0, 0])[:3]
            microsecond = parts[3] if len(parts) > 3 else 0
        value = datetime(int(year), int(month), int(day), int(hour), int(minute), int(second), int(microsecond), tzinfo=TAIPEI_EXCHANGE_TZ)
        return int(value.timestamp() * 1_000_000_000)
    except Exception:  # not an error: an SDK datetime that does not form a valid time is 0 (missing) by contract; the caller rejects a 0 timestamp
        return 0


def fixed_price_5(values: Any, *, scale: int = DEFAULT_PRICE_SCALE) -> list[int]:
    result = [NONE_I64] * 5
    try:
        iterator = iter(values or ())
    except Exception:  # not an error: a non-iterable SDK value is an empty sequence by contract
        return result
    for index, value in enumerate(iterator):
        if index >= 5:
            break
        result[index] = price_to_units(value, scale=scale)
    return result
