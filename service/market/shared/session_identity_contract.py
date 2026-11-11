"""The ONE session-identity contract for session owners, materialization jobs and readers.

A materializable session partition is ``source + market/venue + trading_date + session``. Market Runtime alone names
the partition of every event it stores, from the exchange time (native/market_runtime/src/event.rs wal_partition;
docs/decisions.md 分區身分與分區完整性紀錄的擁有者): a provider names none, and nothing here derives one from a
time. What this module holds is the contract readers and owners share about partitions that exist:

- the WAL session(s) a market's partitions carry: Shioaji STK/IDX ``DAY``; Shioaji FUT ``DAY`` and ``NIGHT`` (a
  NIGHT dated by the day it opens, its minutes continuing past midnight); every Futu market ``FULL``;
- which partitions a business session covers (``session_windows``: 全日 of FUT is a NIGHT and the next DAY);
- when a partition can receive nothing more (``partition_end``), from config/trading_sessions.json, the file Market
  Runtime and Rust B read.
"""
from __future__ import annotations

import json
from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from service.platform import project_root as process_paths

TAIPEI = "Asia/Taipei"


def _load_market_timezones() -> dict[str, str]:
    """config/market_timezones.json: the one table of each market's clock (the renderer and Rust A are tested against it).

    Every zone is checked to exist here, so a typo fails at import rather than reading a day on UTC."""
    with open(process_paths.PROJECT_ROOT / "config" / "market_timezones.json", "r", encoding="utf-8") as handle:
        markets = json.load(handle)["markets"]
    for market, zone in markets.items():
        ZoneInfo(zone)
    return {str(market).upper(): str(zone) for market, zone in markets.items()}


MARKET_TIMEZONES = _load_market_timezones()


def _load_trading_sessions() -> dict[str, Any]:
    """config/trading_sessions.json: each market's trading minutes, the same file Rust B's calendar bundles."""
    with open(process_paths.PROJECT_ROOT / "config" / "trading_sessions.json", "r", encoding="utf-8") as handle:
        return json.load(handle)


TRADING_SESSIONS = _load_trading_sessions()

_WAL_SESSIONS = {("shioaji", "STK"): "DAY", ("shioaji", "IDX"): "DAY"}
# Markets stored per business session (DAY / NIGHT) rather than per calendar day.
_SESSION_PARTITIONED = {("shioaji", "FUT")}

SHIOAJI_MARKETS = ("STK", "IDX", "FUT")


def market_zone(market: str) -> ZoneInfo:
    """Exchange time zone of a market; an unknown venue is UTC, never silently another zone."""
    return ZoneInfo(MARKET_TIMEZONES.get(str(market or "").upper(), "UTC"))


# Futu sessions are sealed by their owner (service/market/futu/session_lifecycle.py) at the end of the venue-local date
# plus a grace for late callbacks. It lives here, not in the provider, because the WAL 下次合併 forecast
# (shared/wal_retention.py) must use the very same rule and shared code may not import a provider.
FUTU_SEAL_GRACE = timedelta(minutes=10)

# The Shioaji STK/IDX day is held open past the 13:30 close for the 14:30 after-hours match and sealed at this time.
# The session policy and the WAL 下次合併 forecast both read it here: shared code may not import lifecycle.
STK_AFTER_HOURS_END = time(14, 40)


def iso_trading_date(value: Any) -> str:
    """A trading date as YYYY-MM-DD from a date, a datetime or that text; anything else raises ValueError."""
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, date):
        return value.isoformat()
    return datetime.strptime(str(value), "%Y-%m-%d").strftime("%Y-%m-%d")


def futu_seal_due_at(market: str, date_text: str) -> datetime:
    """When the Futu owner seals ``market``'s session for the venue-local date ``date_text``."""
    return datetime.fromisoformat(str(date_text)[:10]).replace(tzinfo=market_zone(market)) + timedelta(days=1) + FUTU_SEAL_GRACE


def never_stored(source: str, market: str) -> bool:
    """A market Market Runtime never writes to the WAL (native/market_runtime/src/rollover.rs `never_stored`): Futu
    crypto (user rule). It has no partition, so no session -- no evidence, nothing to seal or materialize."""
    return str(source).lower() == "futu" and str(market).upper() == "CC"


def is_session_partitioned(source: str, market: str) -> bool:
    return (str(source).lower(), str(market).upper()) in _SESSION_PARTITIONED


def wal_sessions(source: str, market: str) -> tuple[str, ...]:
    """Every WAL session a market's partitions can carry."""
    if is_session_partitioned(source, market):
        return ("DAY", "NIGHT")
    return (_WAL_SESSIONS.get((str(source).lower(), str(market).upper()), "FULL"),)


def wal_session(source: str, market: str) -> str:
    """The one WAL session of a market that is not partitioned per business session (``wal_sessions`` names both of a
    partitioned one)."""
    if is_session_partitioned(source, market):
        raise ValueError(f"{source}:{market} is partitioned per business session (DAY / NIGHT): name the session")
    return _WAL_SESSIONS.get((str(source).lower(), str(market).upper()), "FULL")


def _specs(source: str, market: str, session: str) -> list[dict[str, Any]]:
    """The trading_sessions.json sessions a partition reads: its market's (a partitioned market only its own session's),
    the ``unknown_market`` session (the whole day) for a market the file does not name, as Rust B's calendar does."""
    src, mk = str(source).lower(), str(market).upper()
    specs = TRADING_SESSIONS["markets"].get(f"{src}|{mk}")
    if specs is None:
        return [TRADING_SESSIONS["unknown_market"]]
    if is_session_partitioned(src, mk):
        return [spec for spec in specs if str(spec["session"]).upper() == str(session).upper()]
    return specs


def session_segments(source: str, market: str, session: str) -> list[list[list[int]]]:
    """Each business session of a partition as its trading intervals: what an N-minute bar's buckets count."""
    return [[list(interval) for interval in spec["intervals"]] for spec in _specs(source, market, session)]


def partition_end(source: str, market: str, trading_date: str, session: str) -> datetime:
    """A partition's close (exchange time): the start of its last trading minute or print instant, where the venue
    stamps its closing match (config/trading_sessions.json; minutes are inclusive minute starts, and one past 1440 is
    the next calendar day's). FUT DAY closes 13:45 of its date; a NIGHT dated by its open 05:00 the next day; STK 14:30
    (the 盤後定價 match); IDX 13:33. Events of the closing minute are stamped within it."""
    last = max(max([last for _first, last in spec["intervals"]] + list(spec.get("print_instants") or []))
               for spec in _specs(source, market, session))
    day = date.fromisoformat(str(trading_date)[:10])
    return datetime.combine(day + timedelta(days=last // 1440), time((last % 1440) // 60, last % 60), tzinfo=market_zone(market))


def partition_open(source: str, market: str, trading_date: str, session: str) -> datetime:
    """A partition's open (exchange time): the start of its first trading minute (config/trading_sessions.json)."""
    first = min(min(first for first, _last in spec["intervals"]) for spec in _specs(source, market, session))
    day = date.fromisoformat(str(trading_date)[:10])
    return datetime.combine(day + timedelta(days=first // 1440), time((first % 1440) // 60, first % 60), tzinfo=market_zone(market))


def session_minute_span(source: str, market: str, session: str) -> tuple[int, int]:
    """First and last trading minute (inclusive minute starts, config/trading_sessions.json) of a market's session."""
    specs = _specs(source, market, session)
    return (min(min(first for first, _last in spec["intervals"]) for spec in specs),
            max(max(last for _first, last in spec["intervals"]) for spec in specs))


def _us_overnight_open_minute() -> int:
    """Where the futu US overnight session that a date's partition carries opens (its OVERNIGHT interval that does
    not continue the previous day: 20:00 New York)."""
    return min(spec["intervals"][0][0] for spec in TRADING_SESSIONS["markets"]["futu|US"]
               if spec["session"] == "OVERNIGHT" and not spec.get("continues_previous_day"))


def futu_partition_date(market: str, stamp: datetime) -> date:
    """The Futu partition in progress at ``stamp``, the rule Market Runtime's rollover keeps (rollover.rs `cutoffs`):
    the newest trading day on or before the venue-local date (config/market_holidays.py ``futu_trading_day``: the NYSE
    days with OpenD's US calendar laid over them, weekdays elsewhere), so a weekend or a holiday never gets a partition of its own. A US partition is
    the New York calendar date, and a non-trading day's begins when the overnight session for the next trading day
    opens on it (Sunday evening, a holiday's evening)."""
    from config.market_holidays import futu_trading_day

    mk = str(market).upper()
    local = stamp.astimezone(market_zone(mk))
    day = local.date()
    if mk == "CC":  # crypto trades every day: its day is the New York date, as Market Runtime keys CC (event.rs)
        return day
    if futu_trading_day(mk, day):
        return day
    if (mk == "US" and local.hour * 60 + local.minute >= _us_overnight_open_minute()
            and futu_trading_day(mk, day + timedelta(days=1))):
        return day
    day -= timedelta(days=1)
    while not futu_trading_day(mk, day):
        day -= timedelta(days=1)
    return day


def session_windows(
    source: str, market: str, trading_date: str, session: str, *,
    start: datetime | None = None,
) -> list[tuple[str, str, str, str]]:
    """WAL identities (source, market, partition date, wal session) a business session covers.

    STK/IDX: the one DAY partition of that date. FUT (per-session partitions): the DAY of trading date T is
    (T, DAY); the NIGHT of trading date T is (the date it opened, NIGHT) -- ``start`` (the night's real open, as its
    owner recorded it) names that date; without one, the previous trading day (a Monday-dated night opened Friday, or
    Thursday after a Friday closure); FULL (全日) is both."""
    src, mk = str(source).lower(), str(market).upper()
    day = date.fromisoformat(str(trading_date)[:10])
    if not is_session_partitioned(src, mk):
        return [(src, mk, day.isoformat(), wal_session(src, mk))]
    name = str(session).upper()
    if start is not None:
        opened = start.astimezone(market_zone(mk)).date()
    else:
        # The official schedule decides; the weekday rule only fills years it does not cover.
        from config.market_holidays import tw_is_trading_day

        opened = day - timedelta(days=1)
        while not tw_is_trading_day(opened):
            opened -= timedelta(days=1)
    night = (src, mk, opened.isoformat(), "NIGHT")
    if name == "DAY":
        return [(src, mk, day.isoformat(), "DAY")]
    if name == "NIGHT":
        return [night]
    return [night, (src, mk, day.isoformat(), "DAY")]


def is_business_session(source: str, market: str, session: str, trading_date: str) -> bool:
    """Whether a (source, market, session, trading date) can be a session at all.

    A Shioaji day session exists only on a TWSE trading day (config/market_holidays.json, weekdays for a year it does
    not cover). Weekend reconnect snapshots carried Saturday / Sunday exchange times and were admitted as STK / IDX
    "DAY" sessions that nothing opens or seals. A NIGHT session is dated by the day it opened, which can precede a
    holiday: the night calendar owns it. Other sources have no venue calendar here and are not judged."""
    if str(source or "").strip().lower() != "shioaji" or str(session or "").strip().upper() == "NIGHT":
        return True
    from datetime import date

    from config.market_holidays import tw_is_trading_day

    try:
        day = date.fromisoformat(str(trading_date or "")[:10])
    except ValueError:  # not an error: no date is no business session
        return False
    return tw_is_trading_day(day)
