from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Any


def finite_number(value: Any) -> float | None:
    try:
        if value in (None, ""):
            return None
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):  # not an error: value coercion: a non-numeric value is None (missing) by contract
        return None


@dataclass(frozen=True, slots=True)
class ResolvedMarketMove:
    price_change: float | None
    pct_change: float | None


def resolve_market_move(*, current: Any, prev_close: Any) -> ResolvedMarketMove:
    """漲跌 and 漲跌幅 of ``current`` against ``prev_close`` (None where either is missing)."""
    current_n = finite_number(current)
    previous_n = finite_number(prev_close)
    if current_n is None or previous_n is None:
        return ResolvedMarketMove(None, None)
    change = current_n - previous_n
    return ResolvedMarketMove(change, change / previous_n * 100.0 if previous_n != 0 else None)
