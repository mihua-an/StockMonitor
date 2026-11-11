"""The trade-statistics rules the desktop analytics and the mobile bundle share: what a win is, the win rate, the
total profit, what a trade put in and the 報酬率, the statistics of a set of trades (metric_summary), the 當沖
entry-time and hold-time bands and their descriptions, a trade's weekday and how its clock text is read. Values are
Decimal or None (no trades); each caller only names its fields and formats them (account_analytics_service.py for the
desktop, mobile_api.py for the phone). The renderer keeps no copy: the 當沖分析 answer carries band_descriptions()."""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any, Iterable

ZERO = Decimal("0")

# 當沖 entry-time bands: label, from minute (inclusive), to minute (exclusive) of the Taipei day.
ENTRY_TIME_BANDS: tuple[tuple[str, int, int], ...] = (
    ("09:00~09:10", 540, 550), ("09:10~09:20", 550, 560), ("09:20~09:30", 560, 570),
    ("09:30~09:40", 570, 580), ("09:40~09:50", 580, 590), ("09:50~10:00", 590, 600),
    ("10:00~11:00", 600, 660), ("11:00~12:00", 660, 720), ("12:00~13:00", 720, 780),
    ("13:00~13:30", 780, 810),
)


# 當沖 hold-time bands: label, the matrix's short column label, from minute (inclusive), to minute (exclusive; None =
# no end).
HOLD_TIME_BANDS: tuple[tuple[str, str, int, int | None], ...] = (
    ("0~10分", "10分", 0, 10), ("10~20分", "20分", 10, 20), ("20~30分", "30分", 20, 30), ("30~40分", "40分", 30, 40),
    ("40~50分", "50分", 40, 50), ("50~60分", "60分", 50, 60), ("1~2h", "1~2h", 60, 120), ("2~3h", "2~3h", 120, 180),
    ("3~4h", "3~4h", 180, 240), ("4h+", "4h+", 240, None),
)


def clock_minute(text: Any) -> int | None:
    """Minutes of the day of an HH:MM[:SS] clock text; None when it is not one (unknown, not midnight)."""
    parts = str(text or "").strip().split(":")
    if len(parts) < 2:
        return None
    try:
        hour, minute = int(parts[0]), int(parts[1])
    except ValueError:  # not an error: a clock text that is not HH:MM is None (unknown) by contract
        return None
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return None
    return hour * 60 + minute


def entry_band(minute: int | None) -> str | None:
    """The ENTRY_TIME_BANDS label `minute` falls in, or None outside them."""
    if minute is None:
        return None
    for label, lower, upper in ENTRY_TIME_BANDS:
        if lower <= minute < upper:
            return label
    return None


def hold_band_index(minute: int | None) -> int | None:
    """The HOLD_TIME_BANDS index `minute` falls in, or None."""
    if minute is None:
        return None
    for index, (_label, _short, lower, upper) in enumerate(HOLD_TIME_BANDS):
        if minute >= lower and (upper is None or minute < upper):
            return index
    return None


def entry_band_index(minute: int | None) -> int | None:
    """The ENTRY_TIME_BANDS index `minute` falls in, or None."""
    label = entry_band(minute)
    return None if label is None else [band[0] for band in ENTRY_TIME_BANDS].index(label)


def band_descriptions() -> dict[str, list[dict[str, Any]]]:
    """The 當沖 bands as the answers describe them to a screen: each band's label (the hold bands also the matrix's
    short column label) and its from / to minute (to None = no end). Screens draw these and keep no copy."""
    return {"hold": [{"label": label, "short_label": short, "from_minute": lower, "to_minute": upper}
                     for label, short, lower, upper in HOLD_TIME_BANDS],
            "entry": [{"label": label, "from_minute": lower, "to_minute": upper} for label, lower, upper in ENTRY_TIME_BANDS]}


def entry_minute(direction: str, buy_ref: Any, sell_ref: Any) -> int | None:
    """The minute of the day a 當沖 was entered: its sell for a 空 (it sells first), its buy otherwise."""
    return clock_minute(sell_ref if direction == "空" else buy_ref)


def trade_weekday(day: date | None) -> int | None:
    """Monday 1 ... Friday 5 of a trade date; None for a weekend or no date."""
    if day is None:
        return None
    weekday = day.isoweekday()
    return weekday if weekday <= 5 else None


def metric_summary(trades: Iterable[tuple[Decimal, str, Decimal]]) -> dict[str, Any]:
    """The statistics of a set of trades, each (profit, direction, invested): total profit, win rate, expectancy,
    average win / loss and 盈虧比, the 多 and 空 parts and the 報酬率s. A figure with nothing to measure is None (no
    trade, no win, no 多), never 0; counts are ints. Every screen and the phone format these and compute none."""
    rows = list(trades)
    profits = [profit for profit, _direction, _invested in rows]
    longs = [row for row in rows if row[1] == "多"]
    shorts = [row for row in rows if row[1] == "空"]
    wins = [value for value in profits if value > 0]
    losses = [value for value in profits if value < 0]
    total = profit_total(profits)
    avg_win = sum(wins, ZERO) / len(wins) if wins else None
    avg_loss = sum(losses, ZERO) / len(losses) if losses else None
    side_profit = lambda side: profit_total(row[0] for row in side) if side else None
    side_rate = lambda side: return_rate((row[0], row[2]) for row in side)
    return {
        "total_profit": total,
        "win_rate": win_rate(profits),
        "expectancy": total / len(rows) if rows else None,
        "profit_loss_ratio": avg_win / abs(avg_loss) if avg_win is not None and avg_loss else None,
        "avg_win": avg_win,
        "avg_loss": avg_loss,
        "long_profit": side_profit(longs),
        "short_profit": side_profit(shorts),
        "long_win_rate": win_rate(row[0] for row in longs),
        "short_win_rate": win_rate(row[0] for row in shorts),
        "return_rate": side_rate(rows),
        "long_return_rate": side_rate(longs),
        "short_return_rate": side_rate(shorts),
        "win_count": len(wins),
        "loss_count": len(losses),
        "total_count": len(rows),
        "long_count": len(longs),
        "short_count": len(shorts),
    }


def win_count(profits: Iterable[Decimal]) -> int:
    """A win is a trade with a profit above zero (zero is neither win nor loss)."""
    return sum(1 for profit in profits if profit > 0)


def win_rate(profits: Iterable[Decimal]) -> Decimal | None:
    """Wins over trades; None with no trades (not 0%)."""
    values = list(profits)
    return Decimal(win_count(values)) / Decimal(len(values)) if values else None


def profit_total(profits: Iterable[Decimal]) -> Decimal:
    return sum(profits, ZERO)


def invested_amount(direction: str, buy_amount: Decimal, sell_amount: Decimal) -> Decimal:
    """What a matched trade put in: the side its position was opened on (a 空 trade sells first, every other buys)."""
    return sell_amount if direction == "空" else buy_amount


def return_rate(pairs: Iterable[tuple[Decimal, Decimal]]) -> Decimal | None:
    """報酬率 (docs/decisions.md): total net profit over total invested, from (profit, invested) per trade; None when
    nothing was put in. Never an average of each trade's own rate."""
    profit, invested = ZERO, ZERO
    for one_profit, one_invested in pairs:
        profit += one_profit
        invested += one_invested
    return profit / invested if invested else None
