"""The TAIFEX trading-date / session calendar (F4): pure rules, no data access.

Which business date a timestamp belongs to and the DAY / NIGHT / FULL windows of a trading date -- from the official
TWSE/TAIFEX schedule where it covers the year, else the weekday rule. The DAY session closes at 13:45 on every trading
date (config/trading_sessions.json, the session contract Market Runtime partitions by); a contract month's own last
trading day is that contract's data (futures_contracts delivery_date), never a market-wide date rule here. Session
data (TXF ticks, trends) is Market Runtime's and the historical store's; nothing here reads it.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from config.market_holidays import SOURCE as OFFICIAL_CALENDAR, tw_is_trading_day, tw_trading_day
from service.market.shared.session_identity_contract import TRADING_SESSIONS


def _contract_span(partition_date: date, session: str) -> tuple[datetime, datetime]:
    """The first and last trading minute (exchange-local, naive) of a shioaji FUT session partition, read from the
    session contract (config/trading_sessions.json); minutes past 1440 run into the next calendar day."""
    spec = next(spec for spec in TRADING_SESSIONS["markets"]["shioaji|FUT"] if spec["session"] == session)

    def at(minute: int) -> datetime:
        days, rest = divmod(int(minute), 1440)
        return datetime.combine(partition_date + timedelta(days=days), time(rest // 60, rest % 60))

    return at(spec["intervals"][0][0]), at(spec["intervals"][-1][1])


@dataclass(frozen=True)
class FuturesSessionWindow:
    trading_date: date
    session: str
    start: datetime
    end: datetime


class MarketSessionCalendar:
    """Canonical TXF trading-date/session calendar with explicit source quality.

    One rule: the official TWSE/TAIFEX schedule where it covers the year, else the weekday rule,
    exposed through ``source`` so a weekday-rule date is never presented as exchange-certified. Dates that have data
    on disk are not calendar evidence.
    """

    @staticmethod
    def _weekday_forward(value: date, direction: int) -> date:
        # The official schedule (TAIFEX closes with TWSE) where it covers the year, else the weekday rule.
        current = value
        step = 1 if direction >= 0 else -1
        while not tw_is_trading_day(current):
            current += timedelta(days=step)
        return current

    @staticmethod
    def is_trading_day(day: date) -> bool:
        return tw_is_trading_day(day)

    @staticmethod
    def source_of(day: date) -> str:
        """Which rule decided `day`: the official schedule where it covers the year, else the weekday rule. Data on
        disk is never calendar evidence: a weekend snapshot once became a sealed FUT "DAY" partition
        for a Saturday and the screens resolved to it."""
        return OFFICIAL_CALENDAR if tw_trading_day(day) is not None else "weekday_fallback"

    def next_trading_date(self, value: date, *, inclusive: bool = True) -> tuple[date, str]:
        current = value if inclusive else value + timedelta(days=1)
        day = self._weekday_forward(current, 1)
        return day, self.source_of(day)

    def previous_trading_date(self, value: date, *, inclusive: bool = False) -> tuple[date, str]:
        current = value if inclusive else value - timedelta(days=1)
        day = self._weekday_forward(current, -1)
        return day, self.source_of(day)

    def trading_date_for_timestamp(self, stamp: datetime) -> tuple[date, str]:
        clock = stamp.time()
        if clock >= time(15, 0):
            return self.next_trading_date(stamp.date() + timedelta(days=1), inclusive=True)
        if clock < time(5, 0):
            return self.next_trading_date(stamp.date(), inclusive=True)
        # Daytime on a day the market does not trade (a weekend, an official closure such as 10/9) is never a live
        # futures DAY session: the latest completed business date, never a manufactured one whose ordinary
        # 08:45-13:45 window looks live.
        today = stamp.date()
        if not self.is_trading_day(today):
            return self.previous_trading_date(today, inclusive=True)
        return today, self.source_of(today)

    def window(self, trading_date_value: date, session: str) -> FuturesSessionWindow:
        session = str(session or "full").lower()
        day_start, day_end = _contract_span(trading_date_value, "DAY")
        if session == "day":
            return FuturesSessionWindow(trading_date=trading_date_value, session="day", start=day_start, end=day_end)
        # The NIGHT partition is dated by the day it opens, the previous trading day: its minutes past 1440 run into
        # the next calendar day only (a Monday's night opened Friday ends Saturday 05:00, never across the weekend).
        previous, _source = self.previous_trading_date(trading_date_value)
        night_start, night_end = _contract_span(previous, "NIGHT")
        if session == "night":
            # ``trading_date`` is the business date the NIGHT session rolls into: the preceding evening.
            return FuturesSessionWindow(trading_date_value, "night", night_start, night_end)
        return FuturesSessionWindow(trading_date=trading_date_value, session="full", start=night_start, end=day_end)
