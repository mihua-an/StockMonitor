from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date, datetime, time
from typing import Any
from zoneinfo import ZoneInfo

from config.market_holidays import SOURCE as OFFICIAL_CALENDAR, tw_is_trading_day, tw_trading_day
from service.market.lifecycle.calendar import MarketSessionCalendar
from service.market.lifecycle.session import TW_EQUITY_SPEC, resolve_session
TAIPEI = ZoneInfo("Asia/Taipei")
# The Shioaji stock pre-open (order entry and 試撮) starts here; the broker delivers from then on.
TW_EQUITY_PREOPEN_START = time(8, 30)


@dataclass(frozen=True)
class MarketSessionResolution:
    security_type: str
    market: str
    state: str
    session: str
    trading_date: str
    live: bool
    session_start: str | None
    session_end: str | None
    calendar_source: str
    reason: str = ""

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)




class MarketSessionResolver:
    """Canonical product-aware realtime-session resolver.

    Temporary SEARCH_FOCUS uses this resolver before creating broker ownership.
    Permanent WATCHLIST/FIXED ownership is deliberately *not* removed at session
    close; that lifecycle remains owned by SubscriptionManager/Market Daemon.
    """

    def __init__(self, repository: Any | None = None) -> None:
        self.repository = repository
        self.futures_calendar = MarketSessionCalendar()

    @staticmethod
    def _local(stamp: datetime | None) -> datetime:
        value = stamp or datetime.now(TAIPEI)
        if value.tzinfo is None:
            return value.replace(tzinfo=TAIPEI)
        return value.astimezone(TAIPEI)

    def _is_equity_trading_day(self, day: date) -> tuple[bool, str]:
        # The official TWSE schedule decides when it covers the year: a weekday holiday is not a
        # trading day, whatever the weekday rule says.
        # Outside the years it covers, the weekday rule -- never the dates that happen to have data on disk.
        return tw_is_trading_day(day), OFFICIAL_CALENDAR if tw_trading_day(day) is not None else "weekday_fallback"

    def resolve(
        self,
        security_type: str,
        *,
        market: str = "",
        now: datetime | None = None,
    ) -> MarketSessionResolution:
        stamp = self._local(now)
        security = str(security_type or "STK").strip().upper()
        market_name = str(market or ("FUT" if security == "FUT" else "STK")).strip().upper()

        if security in {"STK", "EQUITY"}:
            trading, source = self._is_equity_trading_day(stamp.date())
            common = resolve_session(
                TW_EQUITY_SPEC,
                stamp,
                trading_day_predicate=lambda day: self._is_equity_trading_day(day)[0],
            )
            # Keep the public resolver contract stable while the underlying
            # open/restore decision now comes from the provider-neutral session
            # lifecycle specification.
            return MarketSessionResolution(
                security_type="STK",
                market=market_name,
                state="LIVE" if common.active else "CLOSED",
                session="DAY",
                trading_date=common.current_identity.trading_date,
                live=bool(common.active),
                session_start=common.session_start,
                session_end=common.session_end,
                calendar_source=source,
                reason="" if common.active else ("non_trading_day" if not trading else "outside_day_session"),
            )

        if security == "FUT":
            naive = stamp.replace(tzinfo=None)
            # trading_date_for_timestamp answers only with trading dates (the one calendar); whether anything trades
            # now is the question of that date's session windows (config/trading_sessions.json via the calendar).
            trading_day, source = self.futures_calendar.trading_date_for_timestamp(naive)
            night = self.futures_calendar.window(trading_day, "night")
            day = self.futures_calendar.window(trading_day, "day")
            window = None
            session = "CLOSED"
            if night.start <= naive < night.end:
                window, session = night, "NIGHT"
            elif day.start <= naive <= day.end:
                window, session = day, "DAY"
            live = window is not None
            return MarketSessionResolution(
                security_type="FUT",
                market=market_name,
                state="LIVE" if live else "CLOSED",
                session=session,
                trading_date=trading_day.isoformat(),
                live=live,
                session_start=(window.start.replace(tzinfo=TAIPEI).isoformat() if window else None),
                session_end=(window.end.replace(tzinfo=TAIPEI).isoformat() if window else None),
                calendar_source=source,
                reason="" if live else ("non_trading_day" if not self.futures_calendar.is_trading_day(naive.date())
                                        else "outside_futures_session"),
            )

        return MarketSessionResolution(
            security_type=security,
            market=market_name,
            state="CLOSED",
            session="CLOSED",
            trading_date=stamp.date().isoformat(),
            live=False,
            session_start=None,
            session_end=None,
            calendar_source="unsupported",
            reason="unsupported_security_type",
        )
