"""成交量 (volume) is a decimal quantity on every boundary -- the Python twin of native/market_runtime/src/volume.rs.

An int would turn a US fractional-share print (0.25 shares, Futu
``hpVolume``) into 0. Prices keep their own representation; volumes are floats with these rules:

- Never ``int()`` / ``round()`` a volume. Read one with :func:`to_volume`.
- Compare with :func:`eq` / :func:`gt` / :func:`lt` / :func:`positive` (tolerance relative to the magnitude), never
  ``==`` / ``<=`` on two volumes: a summed total (0.1 + 0.2) and the source's (0.3) are the same total, and "the
  cumulative volume did not move" (a broker resend) must not hinge on the last binary digit.
- :func:`clean` / :func:`wire` remove binary noise where a value leaves the process; a whole value stays an int, so a
  Taiwan lot count reads exactly as before.
- The unit is explicit: :func:`unit` (lot 張 / contract 口 / share 股 / coin).
"""
from __future__ import annotations

import math
from typing import Any

TOLERANCE = 1e-9
DECIMALS = 8

UNIT_LABELS = {"lot": "張", "contract": "口", "share": "股", "coin": "顆", "index_lot": "張", "unit": ""}


def to_volume(value: Any, default: float = 0.0) -> float:
    """A source value as a volume: finite float, else ``default`` (None, '', NaN, garbage)."""
    if value is None or value == "":
        return float(default)
    try:
        number = float(value)
    except (TypeError, ValueError):  # not an error: volume coercion: a non-numeric value is the caller's default by contract
        return float(default)
    return number if math.isfinite(number) else float(default)


def _tol(a: float, b: float) -> float:
    return TOLERANCE * max(1.0, abs(a), abs(b))


def eq(a: float, b: float) -> bool:
    return abs(a - b) <= _tol(a, b)


def gt(a: float, b: float) -> bool:
    """``a`` is more than ``b``, not just by binary noise."""
    return a - b > _tol(a, b)


def lt(a: float, b: float) -> bool:
    return b - a > _tol(a, b)


def positive(value: Any) -> bool:
    """A real, positive quantity (a 0.0001-share print is one; 0, negative, NaN are not)."""
    number = to_volume(value)
    return number > TOLERANCE


def clean(value: Any) -> float:
    number = round(to_volume(value), DECIMALS)
    return 0.0 if number == 0 else number


def wire(value: Any) -> int | float:
    """JSON/display form: an int when whole (TW lots unchanged), else the cleaned decimal."""
    number = clean(value)
    return int(number) if number.is_integer() and abs(number) < 9e15 else number


def wire_opt(value: Any) -> int | float | None:
    return None if value is None else wire(value)


def unit(source: str, market: str) -> str:
    source, market = str(source or "").strip().lower(), str(market or "").strip().upper()
    if source == "shioaji":
        return {"STK": "lot", "FUT": "contract", "IDX": "index_lot"}.get(market, "unit")
    if source == "futu":
        return "coin" if market == "CC" else "share"
    return "unit"
