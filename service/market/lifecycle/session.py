from __future__ import annotations

import threading
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, time, timedelta
from functools import partial
from typing import Any, Callable
from zoneinfo import ZoneInfo

from config.market_holidays import futu_trading_day
from service.market.shared.session_identity_contract import futu_partition_date, market_zone, session_minute_span


PHASE_RESTORING = "RESTORING"
PHASE_ACTIVE = "ACTIVE"
PHASE_SEALING = "SEALING"
PHASE_SEALED = "SEALED"
PHASE_NOT_STARTED = "NOT_STARTED"

# How far a trading-day search looks before it gives up: a year and then some (no market closes that long).
TRADING_DAY_SEARCH_DAYS = 370


class TradingDayResolutionError(RuntimeError):
    """No day within TRADING_DAY_SEARCH_DAYS satisfied the trading-day predicate: there is no trading day to return,
    and an untested neighbouring date is never handed out as one."""


def session_order_for_name(session: str) -> int:
    """Stable chronological order for multiple sessions sharing one trading date.

    Futures NIGHT belongs to the same trading date as the following DAY session,
    so date-only comparison is insufficient for rejecting late old-session data.
    Unknown/single-session names default to zero and remain date-ordered.
    """
    name = str(session or "").strip().upper()
    return {"NIGHT": 0, "ALL": 0, "DAY": 1}.get(name, 0)


@dataclass(frozen=True, slots=True)
class SessionIdentity:
    """Provider-neutral identity for one market-data session generation."""

    source: str
    market: str
    trading_date: str
    session: str
    session_order: int = field(default=0, compare=False, repr=False)
    variant: str = field(default="", compare=False)

    @property
    def sort_key(self) -> tuple[str, int]:
        return (str(self.trading_date or "")[:10], int(self.session_order or 0))

    @property
    def key(self) -> str:
        parts = [
            str(self.source or "").strip().lower(),
            str(self.market or "").strip().upper(),
            str(self.trading_date or "")[:10],
            str(self.session or "").strip().upper(),
        ]
        variant = str(self.variant or "").strip().upper()
        if variant:
            parts.append(variant)
        return ":".join(parts)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class SessionSpec:
    """Static provider/product session rule.

    Session lifecycle is common.  Providers only supply this specification.
    ``close_time=None`` represents a calendar-day session ending at the next
    midnight (used by 24/7 crypto).
    """

    source: str
    market: str
    timezone: str
    session: str
    open_time: time
    close_time: time | None
    weekday_only: bool = True
    session_order: int = 0
    # Some markets label an overnight session by the business day on which it
    # ends. US extended-hours is 20:00 previous calendar day -> 20:00 trading
    # day, including Sunday night as Monday's session.
    window_date_is_close_day: bool = False
    # The venue's own trading days when the caller names none (config/market_holidays.py); None: ``weekday_only``.
    calendar: Callable[[date], bool] | None = None
    # The partition a moment belongs to when the venue's rule is not the session window's own dating (Futu:
    # session_identity_contract.futu_partition_date, the rule Market Runtime and the reference reader keep). The
    # window still decides whether the session is active; the identities name this partition.
    partition_date: Callable[[datetime], date] | None = None

    @property
    def zone(self) -> ZoneInfo:
        return ZoneInfo(self.timezone)

    def localize(self, stamp: datetime | None = None) -> datetime:
        value = stamp or datetime.now(self.zone)
        if value.tzinfo is None:
            return value.replace(tzinfo=self.zone)
        return value.astimezone(self.zone)

    def is_trading_day(self, day: date, predicate: Callable[[date], bool] | None = None) -> bool:
        if predicate is not None:
            return bool(predicate(day))
        if self.calendar is not None:
            return bool(self.calendar(day))
        return not self.weekday_only or day.weekday() < 5

    def previous_trading_day(self, day: date, predicate: Callable[[date], bool] | None = None) -> date:
        return self._search_trading_day(day, -1, predicate)

    def next_trading_day(self, day: date, predicate: Callable[[date], bool] | None = None) -> date:
        return self._search_trading_day(day, 1, predicate)

    def _search_trading_day(self, day: date, step: int, predicate: Callable[[date], bool] | None) -> date:
        candidate = day + timedelta(days=step)
        for _ in range(TRADING_DAY_SEARCH_DAYS):
            if self.is_trading_day(candidate, predicate):
                return candidate
            candidate += timedelta(days=step)
        raise TradingDayResolutionError(
            f"no {'next' if step > 0 else 'previous'} {self.source}:{self.market} {self.session} trading day within "
            f"{TRADING_DAY_SEARCH_DAYS} days of {day.isoformat()} (predicate={getattr(predicate, '__name__', predicate)!r})")

    def window_for(self, trading_date: date) -> tuple[datetime, datetime]:
        if self.window_date_is_close_day and self.close_time is not None:
            start = datetime.combine(trading_date - timedelta(days=1), self.open_time, tzinfo=self.zone)
            end = datetime.combine(trading_date, self.close_time, tzinfo=self.zone)
            return start, end
        start = datetime.combine(trading_date, self.open_time, tzinfo=self.zone)
        if self.close_time is None:
            end = datetime.combine(trading_date + timedelta(days=1), time(0, 0), tzinfo=self.zone)
        else:
            end_day = trading_date + timedelta(days=1) if self.close_time <= self.open_time else trading_date
            end = datetime.combine(end_day, self.close_time, tzinfo=self.zone)
        return start, end

    def identity(self, trading_date: date) -> SessionIdentity:
        return SessionIdentity(self.source, self.market, trading_date.isoformat(), self.session, session_order=self.session_order)

    def trading_date_for(self, stamp: datetime | None = None) -> date:
        """Return the ownership date for a timestamp in a possibly overnight window.

        A session whose close is at or before its open starts on the previous
        calendar evening and owns the after-midnight portion as well.  Keeping
        this rule in the shared session spec prevents late-night/pre-market
        events from rotating the lifecycle into the next calendar date.
        """
        local = self.localize(stamp)
        if self.partition_date is not None:
            return self.partition_date(local)
        return self.window_day_for(local)

    def window_day_for(self, stamp: datetime | None = None) -> date:
        """The trading date whose window (``window_for``) holds or follows ``stamp``."""
        local = self.localize(stamp)
        if self.window_date_is_close_day:
            candidate = local.date() + (timedelta(days=1) if local.time() >= self.open_time else timedelta())
            if self.is_trading_day(candidate):
                return candidate
            if local.time() >= self.open_time:
                return self.next_trading_day(local.date())
            return self.previous_trading_day(local.date() + timedelta(days=1))
        if self.close_time is not None and self.close_time <= self.open_time and local.time() < self.open_time:
            return self.previous_trading_day(local.date())
        return local.date()


@dataclass(frozen=True, slots=True)
class SessionResolution:
    spec: SessionSpec
    now: str
    phase: str
    current_identity: SessionIdentity
    restore_identity: SessionIdentity
    active: bool
    session_start: str
    session_end: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "spec": {
                "source": self.spec.source,
                "market": self.spec.market,
                "timezone": self.spec.timezone,
                "session": self.spec.session,
                "open_time": self.spec.open_time.isoformat(),
                "close_time": self.spec.close_time.isoformat() if self.spec.close_time is not None else None,
                "weekday_only": self.spec.weekday_only,
                "session_order": self.spec.session_order,
            },
            "now": self.now,
            "phase": self.phase,
            "current_identity": self.current_identity.as_dict(),
            "restore_identity": self.restore_identity.as_dict(),
            "active": self.active,
            "session_start": self.session_start,
            "session_end": self.session_end,
        }


def resolve_session(
    spec: SessionSpec,
    stamp: datetime | None = None,
    *,
    trading_day_predicate: Callable[[date], bool] | None = None,
) -> SessionResolution:
    """Resolve current and restore session using one OPEN/RESTORE rule.

    - During the session, restore/current are the same active identity.
    - After close, the just-completed session is restored.
    - Before open (or on a non-trading day), the previous completed session is
      restored while ``current_identity`` still names the next/current calendar
      trading day candidate.  This prevents startup from racing an async old
      snapshot against the first event of a new session.
    """

    local = spec.localize(stamp)
    today = local.date()
    if spec.window_date_is_close_day:
        trading_date = spec.window_day_for(local)
        start, end = spec.window_for(trading_date)
        owner = spec.identity(spec.partition_date(local)) if spec.partition_date is not None else None
        if spec.is_trading_day(trading_date, trading_day_predicate) and start <= local < end:
            identity = owner or spec.identity(trading_date)
            return SessionResolution(spec, local.isoformat(), PHASE_ACTIVE, identity, identity, True, start.isoformat(), end.isoformat())
        if spec.is_trading_day(trading_date, trading_day_predicate) and local >= end:
            # A closed day's daytime (a weekend, a holiday) belongs to the session that just closed.
            identity = owner or spec.identity(trading_date)
            return SessionResolution(spec, local.isoformat(), PHASE_SEALED, identity, identity, False, start.isoformat(), end.isoformat())
        previous = spec.previous_trading_day(trading_date, trading_day_predicate)
        return SessionResolution(
            spec, local.isoformat(), PHASE_NOT_STARTED, owner or spec.identity(trading_date), owner or spec.identity(previous),
            False, start.isoformat(), end.isoformat(),
        )
    trading_today = spec.is_trading_day(today, trading_day_predicate)
    start, end = spec.window_for(today)

    if trading_today and start <= local < end:
        identity = spec.identity(today)
        return SessionResolution(spec, local.isoformat(), PHASE_ACTIVE, identity, identity, True, start.isoformat(), end.isoformat())

    current_identity = spec.identity(today)
    if trading_today and local >= end:
        restore_day = today
        phase = PHASE_SEALED
    else:
        restore_day = spec.previous_trading_day(today, trading_day_predicate)
        phase = PHASE_NOT_STARTED
    restore_start, restore_end = spec.window_for(restore_day)
    return SessionResolution(
        spec,
        local.isoformat(),
        phase,
        current_identity,
        spec.identity(restore_day),
        False,
        (start if phase == PHASE_NOT_STARTED else restore_start).isoformat(),
        (end if phase == PHASE_NOT_STARTED else restore_end).isoformat(),
    )


@dataclass(slots=True)
class SessionRuntimeState:
    scope: str
    generation: int = 0
    phase: str = PHASE_RESTORING
    active: SessionIdentity | None = None
    sealing: dict[str, SessionIdentity] = field(default_factory=dict)
    sealed: dict[str, SessionIdentity] = field(default_factory=dict)
    identity_generation: dict[str, int] = field(default_factory=dict)
    previous_sealed: SessionIdentity | None = None
    previous_sealed_generation: int = 0
    transition_count: int = 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "scope": self.scope,
            "generation": self.generation,
            "phase": self.phase,
            "active": self.active.as_dict() if self.active else None,
            "sealing": {key: value.as_dict() for key, value in self.sealing.items()},
            "sealed": {key: value.as_dict() for key, value in self.sealed.items()},
            "previous_sealed": self.previous_sealed.as_dict() if self.previous_sealed else None,
            "previous_sealed_generation": self.previous_sealed_generation,
            "transition_count": self.transition_count,
        }


@dataclass(frozen=True, slots=True)
class SessionTransition:
    scope: str
    generation: int
    previous: SessionIdentity | None
    current: SessionIdentity | None
    rotated: bool

    def as_dict(self) -> dict[str, Any]:
        return {
            "scope": self.scope,
            "generation": self.generation,
            "previous": self.previous.as_dict() if self.previous else None,
            "current": self.current.as_dict() if self.current else None,
            "rotated": self.rotated,
        }


class SessionLifecycleRegistry:
    """Thread-safe OPEN -> SEALING -> SEALED authority for all providers.

    Rotation is atomic: the old identity is moved to ``sealing`` before the new
    identity becomes active.  Callers may then retain the old cache by reference
    while durable finalization completes; new events immediately write to a new
    cache/generation and can never clear data still being sealed.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._states: dict[str, SessionRuntimeState] = {}

    def restore(self, scope: str, identity: SessionIdentity) -> SessionTransition:
        key = str(scope or identity.market).strip().upper()
        with self._lock:
            state = self._states.setdefault(key, SessionRuntimeState(scope=key))
            if state.active and state.active.key == identity.key:
                state.phase = PHASE_ACTIVE
                return SessionTransition(key, state.generation, state.active, identity, False)

            # Once a generation has entered SEALING/SEALED, late evidence from
            # that same (or an older) session stays durable-only. It must never
            # reopen the hot cache after CLOSE or rotate a same-date DAY session
            # backwards into NIGHT.
            if identity.key in state.sealing or identity.key in state.sealed:
                state.phase = PHASE_ACTIVE if state.active else (PHASE_SEALING if state.sealing else PHASE_SEALED)
                return SessionTransition(key, state.generation, state.active, identity, False)
            if state.active is not None and identity.sort_key < state.active.sort_key:
                state.sealed.setdefault(identity.key, identity)
                while len(state.sealed) > 64:
                    state.sealed.pop(next(iter(state.sealed)))
                return SessionTransition(key, state.generation, state.active, state.active, False)
            if state.active is None and state.previous_sealed is not None and identity.sort_key < state.previous_sealed.sort_key:
                state.sealed.setdefault(identity.key, identity)
                while len(state.sealed) > 64:
                    state.sealed.pop(next(iter(state.sealed)))
                return SessionTransition(key, state.generation, None, identity, False)

            previous = state.active
            if previous is not None:
                state.sealing[previous.key] = previous
            state.generation += 1
            state.active = identity
            state.identity_generation[identity.key] = state.generation
            state.phase = PHASE_ACTIVE
            state.transition_count += 1
            return SessionTransition(key, state.generation, previous, identity, True)

    def observe(self, scope: str, identity: SessionIdentity) -> SessionTransition:
        return self.restore(scope, identity)

    def begin_sealing(self, scope: str, identity: SessionIdentity | None = None) -> SessionIdentity | None:
        key = str(scope or "").strip().upper()
        with self._lock:
            state = self._states.setdefault(key, SessionRuntimeState(scope=key))
            target = identity or state.active
            if target is None:
                return None
            state.sealing[target.key] = target
            if state.active and state.active.key == target.key:
                state.active = None
            state.phase = PHASE_SEALING
            return target

    def mark_sealed(self, scope: str, identity: SessionIdentity) -> None:
        key = str(scope or "").strip().upper()
        with self._lock:
            state = self._states.setdefault(key, SessionRuntimeState(scope=key))
            state.sealing.pop(identity.key, None)
            state.sealed[identity.key] = identity
            while len(state.sealed) > 64:
                state.sealed.pop(next(iter(state.sealed)))
            sealed_generation = int(state.identity_generation.get(identity.key, 0))
            if (
                state.previous_sealed is None
                or sealed_generation > state.previous_sealed_generation
                or (sealed_generation == state.previous_sealed_generation and identity.sort_key > state.previous_sealed.sort_key)
            ):
                state.previous_sealed = identity
                state.previous_sealed_generation = sealed_generation
            state.phase = PHASE_ACTIVE if state.active else (PHASE_SEALING if state.sealing else PHASE_SEALED)

    def state(self, scope: str) -> SessionRuntimeState:
        key = str(scope or "").strip().upper()
        with self._lock:
            current = self._states.setdefault(key, SessionRuntimeState(scope=key))
            return SessionRuntimeState(
                scope=current.scope,
                generation=current.generation,
                phase=current.phase,
                active=current.active,
                sealing=dict(current.sealing),
                sealed=dict(current.sealed),
                identity_generation=dict(current.identity_generation),
                previous_sealed=current.previous_sealed,
                previous_sealed_generation=current.previous_sealed_generation,
                transition_count=current.transition_count,
            )

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {key: value.as_dict() for key, value in self._states.items()}


def _minute_time(minute: int) -> time:
    return time((minute % 1440) // 60, minute % 60)


def _stk_day_spec() -> SessionSpec:
    """The Shioaji stock day session from config/trading_sessions.json (inclusive minute starts: [540, 810] trades
    from 09:00 through the 13:30 minute, so the window ends at 13:31). Not hard-coded: a stock whose close is delayed
    still prints after 13:30:00, and Market Runtime's phase reads the same file."""
    first, last = session_minute_span("shioaji", "STK", "DAY")
    return SessionSpec(
        source="shioaji", market="STK", timezone=str(market_zone("STK")), session="DAY",
        open_time=_minute_time(first), close_time=_minute_time(last + 1), weekday_only=True, session_order=1,
    )


TW_EQUITY_SPEC = _stk_day_spec()
FUTU_CRYPTO_SPEC = SessionSpec(
    # Around the clock: the session is always active, whatever the zone; the zone is the market's
    # (config/market_timezones.json).
    source="futu", market="CC", timezone=str(market_zone("CC")), session="DAY",
    open_time=time(0, 0), close_time=None, weekday_only=False, session_order=0,
)
FUTU_US_ALL_SPEC = SessionSpec(
    source="futu", market="US", timezone=str(market_zone("US")), session="ALL",
    # One Futu US trading-day projection spans overnight 20:00 through the
    # following after-hours close at 20:00.  The renderer slices this full
    # window into overnight/pre/regular/after/full views.
    open_time=time(20, 0), close_time=time(20, 0), weekday_only=True, session_order=0,
    window_date_is_close_day=True,
    # OpenD's US calendar where it covers the day (a holiday has no session), weekdays otherwise.
    calendar=partial(futu_trading_day, "US"),
    partition_date=partial(futu_partition_date, "US"),
)


def futu_session_spec(code: str) -> SessionSpec:
    normalized = str(code or "").strip().upper()
    if normalized.startswith("CC."):
        return FUTU_CRYPTO_SPEC
    return FUTU_US_ALL_SPEC
