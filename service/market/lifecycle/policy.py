from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime
from enum import Enum
from typing import Any
from zoneinfo import ZoneInfo

from service.market.lifecycle.resolver import TW_EQUITY_PREOPEN_START, MarketSessionResolution
from service.market.shared.session_identity_contract import STK_AFTER_HOURS_END


# 盤後定價交易 (14:00-14:30) is matched at 14:30; its print -- and the broker's re-send of the 13:30 closing print --
# arrive minutes later (14:31:18 and 14:34:47 for 2344). Sealing the STK day at 13:30 would materialize the
# partition at 13:34 without them, and the WAL would keep two trades the history did not. The day partition
# is held -- not sealed, no data expected -- until STK_AFTER_HOURS_END (session_identity_contract), then sealed and
# materialized once, complete.
_TAIPEI = ZoneInfo("Asia/Taipei")


def stk_after_hours_capture(resolution: MarketSessionResolution, now: datetime | None) -> bool:
    """True from the 13:30 close until STK_AFTER_HOURS_END on a trading day: the day session still receives prints."""
    if now is None or str(resolution.market or "").upper() != "STK" or resolution.live:
        return False
    if resolution.reason != "outside_day_session" or not resolution.session_end:
        return False
    end = datetime.fromisoformat(str(resolution.session_end))
    local = (now if now.tzinfo else now.replace(tzinfo=_TAIPEI)).astimezone(end.tzinfo or _TAIPEI)
    return local.date() == end.date() and end.time() <= local.time() < STK_AFTER_HOURS_END


def stk_preopen_capture(resolution: MarketSessionResolution, now: datetime | None) -> bool:
    """True from the 08:30 pre-open until the open on a stock trading day: the broker delivers 試撮 BidAsk on the
    day's subscriptions, so the provider owns the day's generation from then on. This is the provider's capture
    window only; which session the screens show is Market Runtime's (session.current), decided on the first print."""
    if now is None or str(resolution.market or "").upper() != "STK" or resolution.live:
        return False
    if resolution.reason != "outside_day_session" or not resolution.session_start:
        return False
    start = datetime.fromisoformat(str(resolution.session_start))
    local = (now if now.tzinfo else now.replace(tzinfo=_TAIPEI)).astimezone(start.tzinfo or _TAIPEI)
    return local.date() == start.date() and TW_EQUITY_PREOPEN_START <= local.time() < start.time()


class CacheDirective(str, Enum):
    KEEP = "KEEP"
    ROTATE_EPHEMERAL = "ROTATE_EPHEMERAL"
    SEAL_AFTER_DURABILITY = "SEAL_AFTER_DURABILITY"


class SessionAction(str, Enum):
    """Provider-neutral actions understood by SessionOrchestrator."""

    ACTIVATE = "ACTIVATE"
    SEAL = "SEAL"
    FINALIZE = "FINALIZE"
    ROTATE_EPHEMERAL = "ROTATE_EPHEMERAL"


@dataclass(frozen=True)
class MarketSessionPolicyDecision:
    market: str
    phase: str
    owns_market_data: bool
    expected_lanes: dict[str, float]
    activate_candidate: bool
    finalize_previous: bool
    cache_directive: CacheDirective
    durable_history_action: str = "RETAIN"
    actions: tuple[str, ...] = ()
    #: STK between the close and STK_AFTER_HOURS_END: the day is held open for the after-hours print.
    after_hours_capture: bool = False

    def as_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["cache_directive"] = self.cache_directive.value
        return payload


@dataclass(frozen=True)
class SessionFinalizationBarrier:
    """Gate for releasing an old session's ephemeral cache."""

    authority_transition_committed: bool
    generation_transition_committed: bool
    durable_landed: bool
    post_close_products_ready: bool = True

    @property
    def allow_ephemeral_cleanup(self) -> bool:
        return all((
            self.authority_transition_committed,
            self.generation_transition_committed,
            self.durable_landed,
            self.post_close_products_ready,
        ))

    def as_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["allow_ephemeral_cleanup"] = self.allow_ephemeral_cleanup
        payload["blocked_by"] = [
            name for name, passed in (
                ("AUTHORITY_TRANSITION_NOT_COMMITTED", self.authority_transition_committed),
                ("GENERATION_TRANSITION_NOT_COMMITTED", self.generation_transition_committed),
                ("DURABLE_DATA_NOT_LANDED", self.durable_landed),
                ("POST_CLOSE_PRODUCTS_NOT_READY", self.post_close_products_ready),
            ) if not passed
        ]
        return payload


class SessionPolicyEngine:
    """Pure market-time policy; it never mutates broker, cache or storage state."""

    def evaluate(
        self,
        resolution: MarketSessionResolution,
        *,
        equity_preopen: bool = False,
        previous_identity: str = "",
        candidate_identity: str = "",
        now: datetime | None = None,
        opened: bool = True,
    ) -> MarketSessionPolicyDecision:
        """``opened``: the session has had its first print (config.market_holidays.tw_day_session_opened). Before it,
        the session still owns the subscriptions (its first print comes on them) but no lane is expected to have
        data: a day that never opens is a closure, not 行情停滯."""
        market = str(resolution.market or "").upper()
        owns_market_data = bool(resolution.live or (market == "STK" and equity_preopen))
        after_hours = stk_after_hours_capture(resolution, now)
        phase = "LIVE" if resolution.live else ("PREOPEN" if equity_preopen else ("AFTER_HOURS" if after_hours else "CLOSED"))
        expected_lanes: dict[str, float] = {}
        if not opened:
            pass
        elif owns_market_data and market == "STK":
            if resolution.live:
                expected_lanes = {"stk.tick": 180.0, "stk.bidask": 60.0, "index.quote": 60.0}
            else:
                expected_lanes = {"stk.bidask": 120.0}
        elif owns_market_data and market == "FUT":
            expected_lanes = {"futures.quote": 120.0}

        previous = str(previous_identity or "")
        candidate = str(candidate_identity or "")
        identity_changed = bool(previous and previous != candidate)
        activate_candidate = bool(owns_market_data and candidate and previous != candidate)
        # The active day itself is not sealed during the after-hours capture (no lanes are expected either).
        holding_day = after_hours and previous.startswith(f"STK|{resolution.trading_date}|")
        finalize_previous = bool(previous and not holding_day and (not owns_market_data or identity_changed))
        if finalize_previous:
            cache_directive = CacheDirective.SEAL_AFTER_DURABILITY
        elif activate_candidate:
            cache_directive = CacheDirective.ROTATE_EPHEMERAL
        else:
            cache_directive = CacheDirective.KEEP
        actions: list[str] = []
        if finalize_previous:
            actions.extend((SessionAction.SEAL.value, SessionAction.FINALIZE.value))
        if activate_candidate:
            actions.extend((SessionAction.ACTIVATE.value, SessionAction.ROTATE_EPHEMERAL.value))
        return MarketSessionPolicyDecision(
            market=market,
            phase=phase,
            owns_market_data=owns_market_data,
            expected_lanes=expected_lanes,
            activate_candidate=activate_candidate,
            finalize_previous=finalize_previous,
            cache_directive=cache_directive,
            actions=tuple(actions),
            after_hours_capture=after_hours,
        )

    @staticmethod
    def finalization_barrier(
        *,
        authority_transition_committed: bool,
        generation_transition_committed: bool,
        durable_landed: bool,
        post_close_products_ready: bool = True,
    ) -> SessionFinalizationBarrier:
        return SessionFinalizationBarrier(
            authority_transition_committed=bool(authority_transition_committed),
            generation_transition_committed=bool(generation_transition_committed),
            durable_landed=bool(durable_landed),
            post_close_products_ready=bool(post_close_products_ready),
        )
