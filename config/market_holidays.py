"""Official Taiwan market closures (config/market_holidays.json) and the ones Market Runtime observed, read-only.

The data is TWSE's published schedule, fetched by ``scripts/tooling/update_market_holidays.py`` (once a year, plus
hand-recorded ad-hoc closures). TAIFEX closes on the same days. A year the file does not cover answers None, and
``tw_is_trading_day`` is the one place that falls back to weekdays for such a year, and records it.

A closure nobody announced (a typhoon day) is observed by Market Runtime: a trading day with no Shioaji print by 09:00
while the broker is connected. It writes those, and the Shioaji day sessions that have opened on their first print,
to its sessions file (``<DATA_ROOT>/live-engine/market_sessions.json``, native/market_runtime/src/rollover.rs
MarketSessions); an observed closure is not a trading day here either. Both files are read again whenever they change.

US trading days are the NYSE days of the same file (``markets.NYSE``: closed weekdays and half days, recorded by hand
from NYSE's published calendar once a year with ``update_market_holidays.py --nyse-closed / --nyse-half``), with the
calendar OpenD publishes laid over them: the Futu provider writes it to ``<DATA_ROOT>/futu/us_trading_calendar.json``
(ten days back through two weeks ahead), and inside its window it decides. Market Runtime (rollover.rs
FollowedUsCalendar) applies the same rule. A year the NYSE section does not list answers None.
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path
import logging
import threading

_failure_log = logging.getLogger(__name__)

PATH = Path(__file__).with_suffix(".json")
SOURCE = "official_calendar"
SESSIONS_SCHEMA = "market-sessions-v1"
US_CALENDAR_SCHEMA = "us-trading-calendar-v1"

_lock = threading.Lock()
# path -> (modification time, parsed value, last logged error)
_read: dict[Path, tuple[int | None, object, str]] = {}


def _stamp(path: Path) -> int | None:
    try:
        return path.stat().st_mtime_ns
    except FileNotFoundError:  # not an error: Market Runtime has not written its sessions file yet
        return None


def _record_read_failure(path: Path, stamp: int | None, exc: Exception, empty):
    """Keeps the last value read from ``path`` under ``stamp`` (the file is read again once the writer replaces it)
    and logs the failure once per distinct error. Called with ``_lock`` held."""
    failure = f"{type(exc).__name__}: {exc}"
    seen = _read.get(path)
    if seen is None or seen[2] != failure:
        _failure_log.warning("reading %s failed, keeping the last value: %s", path, failure)
    last = seen[1] if seen is not None else empty
    _read[path] = (stamp, last, failure)
    return last


def _cached(path: Path, parse, empty):
    """``parse(path)`` again whenever the file's modification time changed; a file that fails keeps the last value
    and is logged once per distinct error."""
    with _lock:
        seen = _read.get(path)
        try:
            stamp = _stamp(path)
        except OSError as exc:
            return _record_read_failure(path, seen[0] if seen is not None else None, exc, empty)
        if seen is not None and seen[0] == stamp:
            return seen[1]
        if stamp is None:
            _read[path] = (stamp, empty, "")
            return empty
        try:
            value = parse(path)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            return _record_read_failure(path, stamp, exc, empty)
        _read[path] = (stamp, value, "")
        return value


def _parse_holidays(path: Path) -> tuple[dict[int, tuple[frozenset[date], frozenset[date]]], dict[int, frozenset[date]]]:
    """The TWSE years (closed, trading) and the NYSE years (closed) of the holidays file, read together: the cache
    holds one value per file."""
    data = json.loads(path.read_text(encoding="utf-8"))
    years: dict[int, tuple[frozenset[date], frozenset[date]]] = {}
    for year, entry in ((data.get("markets") or {}).get("TWSE") or {}).get("years", {}).items():
        try:
            closed = frozenset(date.fromisoformat(row["date"]) for row in entry.get("closed") or [])
            trading = frozenset(date.fromisoformat(row["date"]) for row in entry.get("trading") or [])
            years[int(year)] = (closed, trading)
        except (KeyError, TypeError, ValueError) as exc:
            _failure_log.warning("reading a TWSE holiday year entry failed: %s: %s", type(exc).__name__, exc)
            continue
    nyse: dict[int, frozenset[date]] = {}
    for year, entry in ((data.get("markets") or {}).get("NYSE") or {}).get("years", {}).items():
        try:
            nyse[int(year)] = frozenset(date.fromisoformat(row["date"]) for row in entry.get("closed") or [])
        except (KeyError, TypeError, ValueError) as exc:
            _failure_log.warning("reading an NYSE holiday year entry failed: %s: %s", type(exc).__name__, exc)
            continue
    return years, nyse


def _twse() -> dict[int, tuple[frozenset[date], frozenset[date]]]:
    return _cached(PATH, _parse_holidays, ({}, {}))[0]


def _nyse() -> dict[int, frozenset[date]]:
    return _cached(PATH, _parse_holidays, ({}, {}))[1]


def sessions_path() -> Path:
    # Imported here: importing a config/ reader loads no service module (AGENTS.md section 2).
    from config.system_contract import data_child
    from service.platform.project_root import DATA_ROOT
    return Path(DATA_ROOT).joinpath(*data_child("market_sessions").split("/"))


def _parse_sessions(path: Path) -> tuple[date | None, frozenset[date]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("schema") != SESSIONS_SCHEMA:
        raise ValueError(f"schema {data.get('schema')!r}, expected {SESSIONS_SCHEMA!r}")
    day = str((data.get("opened") or {}).get("day") or "")
    closures = frozenset(date.fromisoformat(row["date"]) for row in data.get("closures") or [])
    return (date.fromisoformat(day) if day else None), closures


def _sessions() -> tuple[date | None, frozenset[date]]:
    return _cached(sessions_path(), _parse_sessions, (None, frozenset()))


def us_calendar_path() -> Path:
    from config.system_contract import data_child
    from service.platform.project_root import DATA_ROOT
    return Path(DATA_ROOT).joinpath(*data_child("us_trading_calendar").split("/"))


def _parse_us(path: Path) -> tuple[date, date, frozenset[date]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("schema") != US_CALENDAR_SCHEMA:
        raise ValueError(f"schema {data.get('schema')!r}, expected {US_CALENDAR_SCHEMA!r}")
    first, last = date.fromisoformat(data["from"]), date.fromisoformat(data["to"])
    days = frozenset(date.fromisoformat(row["date"]) for row in data.get("days") or [])
    if first > last or any(not first <= day <= last for day in days):
        raise ValueError(f"trading days outside the window {first}..{last}")
    return first, last, days


def us_trading_day(day: date) -> bool | None:
    """True / False from the US exchange calendar OpenD published (the Futu provider writes it, see
    service/market/futu/trading_calendar.py) inside its window, else from the NYSE days of the holidays file; None when
    neither covers ``day``, and callers keep their weekday rule."""
    window = _cached(us_calendar_path(), _parse_us, None)
    if window is not None:
        first, last, days = window
        if first <= day <= last:
            return day in days
    closed = _nyse().get(day.year)
    if closed is None:
        return None
    return day.weekday() < 5 and day not in closed


def futu_trading_day(market: str, day: date) -> bool:
    """Whether a Futu stock market trades on its venue-local ``day``: the US by ``us_trading_day`` where it covers the
    day, weekdays otherwise (no calendar is read for the other markets)."""
    official = us_trading_day(day) if str(market).upper() == "US" else None
    return official if official is not None else day.weekday() < 5


def tw_trading_day(day: date) -> bool | None:
    """True / False from the official schedule and the observed closures; None when the official file does not cover
    ``day``'s year and no closure was observed on it."""
    if day in _sessions()[1]:
        return False
    entry = _twse().get(day.year)
    if entry is None:
        return None
    closed, trading = entry
    if day in closed:
        return False
    return day.weekday() < 5 or day in trading


_uncovered_years: set[int] = set()


def tw_is_trading_day(day: date) -> bool:
    """The one Taiwan trading-day rule: the official schedule (and the observed closures) where it covers ``day``,
    weekdays otherwise. A year the official file does not cover is recorded once, so a weekday-rule answer is never
    silent. Callers that must say which rule decided keep ``tw_trading_day`` (None = not covered)."""
    official = tw_trading_day(day)
    if official is not None:
        return official
    with _lock:
        first = day.year not in _uncovered_years
        _uncovered_years.add(day.year)
    if first:
        _failure_log.warning("finding %s in the TWSE holiday file %s failed; weekdays are used for that year",
                             day.year, PATH.name)
    return day.weekday() < 5


def tw_day_session_opened(trading_date: date) -> bool:
    """Whether the Shioaji day session of ``trading_date`` has opened (Market Runtime saw its first print at or after
    the pre-open). Without a sessions file -- Market Runtime has written none yet -- the clock
    alone decides, as it did before Market Runtime recorded openings."""
    opened, _closures = _sessions()
    try:
        recorded = _stamp(sessions_path()) is not None
    except OSError as exc:
        _failure_log.warning("reading the market sessions file's time failed: %s: %s", type(exc).__name__, exc)
        recorded = False
    if not recorded:
        return True
    return opened is not None and opened >= trading_date


def reload() -> None:
    with _lock:
        _read.clear()
