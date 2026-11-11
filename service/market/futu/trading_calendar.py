"""The US exchange calendar as OpenD publishes it (``request_trading_days``), read once per New York day.

OpenD answers which US dates trade and whether a date is a whole or a half day. Read on the OpenD worker cycle, which
owns the quote context, each answer is written whole to the US calendar file (config/market_holidays.py
``us_calendar_path``), which Market Runtime lays over the NYSE days of config/market_holidays.json (it is the one judge
of US trading days and sessions the screens read) and config/market_holidays.py reads by the same rule for Futu's 昨收
partitions (reference.py) and the US session lifecycle. A window that has not been written cannot be read as one, so a
failed write is a failed read.
"""
from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo

from config.market_holidays import US_CALENDAR_SCHEMA
from service.platform.atomic_files import write_json_atomic
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)

NEW_YORK = ZoneInfo("America/New_York")
# The window read each day: ten days back (Market Runtime keeps the partitions of the two sessions before the current
# one, which a long weekend after a holiday puts a week back) through two weeks ahead.
DAYS_BACK = 10
DAYS_AHEAD = 14
RETRY_AFTER = timedelta(minutes=1)


def _new_york_today(now: datetime | None = None) -> str:
    return (now or datetime.now(timezone.utc)).astimezone(NEW_YORK).date().isoformat()


def _day_rows(data: Any) -> list[dict[str, str]]:
    """OpenD's rows ({"time": "YYYY-MM-DD", "trade_date_type": "WHOLE" | "MORNING" | "AFTERNOON"}) as date / kind."""
    rows = data.to_dict("records") if hasattr(data, "to_dict") else list(data or [])
    days = []
    for row in rows:
        date = str((row or {}).get("time") or "").strip()[:10]
        kind = str((row or {}).get("trade_date_type") or "").strip().upper()
        if len(date) == 10 and kind:
            days.append({"date": date, "kind": kind})
    return days


class FutuTradingCalendar:
    def __init__(self, call: Callable[..., Any], sdk: Callable[[], Any], *, clock: Callable[[], datetime] | None = None,
                 path: Path | None = None) -> None:
        self._call = call
        self._path = path     # None: kept in memory only (tests)
        self._sdk = sdk
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._lock = threading.Lock()
        self._read_for = ""
        self._retry_at: datetime | None = None

    def due(self) -> bool:
        """A read is due once per New York day; a refused read is asked again a minute later, not every 0.2 s cycle."""
        now = self._clock()
        with self._lock:
            return self._read_for != _new_york_today(now) and (self._retry_at is None or now >= self._retry_at)

    def refresh(self, context: Any) -> dict[str, Any]:
        """Read the calendar window from OpenD (raises, and records, when OpenD refuses)."""
        now = self._clock()
        today = _new_york_today(now)
        start = (now.astimezone(NEW_YORK).date() - timedelta(days=DAYS_BACK)).isoformat()
        end = (now.astimezone(NEW_YORK).date() + timedelta(days=DAYS_AHEAD)).isoformat()
        try:
            market = self._sdk().TradeDateMarket.US
            days = _day_rows(self._call(context, "request_trading_days", market=market, start=start, end=end))
            if self._path is not None:
                write_json_atomic(self._path, {"schema": US_CALENDAR_SCHEMA, "source": "futu_opend", "from": start,
                                               "to": end, "read_at": now.isoformat(timespec="seconds"), "days": days})
        except Exception as exc:
            record_failure(_failure_log, "reading the US trading calendar from OpenD", exc)
            with self._lock:
                self._retry_at = now + RETRY_AFTER
            raise
        with self._lock:
            self._retry_at = None
            self._read_for = today
        return {"ok": True}
