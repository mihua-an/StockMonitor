from __future__ import annotations


def shioaji_tick_side(tick_type: int | None) -> int:
    """The print side Market Runtime stores for a Shioaji TickType: 1 = 外盤 (ask-side execution, aggressor BUY),
    2 = 內盤 (bid-side, aggressor SELL), anything else (0, missing) = no side."""
    return 1 if tick_type == 1 else -1 if tick_type == 2 else 0
