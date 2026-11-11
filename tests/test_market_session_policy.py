from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from service.market.lifecycle.policy import CacheDirective, SessionAction, SessionPolicyEngine, stk_preopen_capture
from service.market.lifecycle.resolver import MarketSessionResolution
from service.market.lifecycle.resolver import MarketSessionResolver


def _resolution(*, market="STK", live=False, session="DAY") -> MarketSessionResolution:
    return MarketSessionResolution(
        security_type=market,
        market=market,
        state="LIVE" if live else "CLOSED",
        session=session,
        trading_date="2026-09-01",
        live=live,
        session_start=None,
        session_end=None,
        calendar_source="test",
    )


def test_preopen_rotates_only_ephemeral_state_and_retains_durable_history() -> None:
    decision = SessionPolicyEngine().evaluate(
        _resolution(),
        equity_preopen=True,
        candidate_identity="STK|2026-09-01|DAY|",
    )

    assert decision.owns_market_data
    assert decision.expected_lanes == {"stk.bidask": 120.0}
    assert decision.cache_directive == CacheDirective.ROTATE_EPHEMERAL
    assert decision.durable_history_action == "RETAIN"
    assert decision.actions == (SessionAction.ACTIVATE.value, SessionAction.ROTATE_EPHEMERAL.value)


def test_session_transition_seals_old_cache_only_after_durability() -> None:
    decision = SessionPolicyEngine().evaluate(
        _resolution(live=True),
        previous_identity="STK|2026-08-31|DAY|",
        candidate_identity="STK|2026-09-01|DAY|",
    )

    assert decision.finalize_previous
    assert decision.activate_candidate
    assert decision.cache_directive == CacheDirective.SEAL_AFTER_DURABILITY
    assert decision.actions == (
        SessionAction.SEAL.value,
        SessionAction.FINALIZE.value,
        SessionAction.ACTIVATE.value,
        SessionAction.ROTATE_EPHEMERAL.value,
    )


def test_closed_session_never_requests_durable_deletion() -> None:
    decision = SessionPolicyEngine().evaluate(
        _resolution(live=False),
        previous_identity="STK|2026-09-01|DAY|",
    )

    assert decision.finalize_previous
    assert not decision.owns_market_data
    assert decision.durable_history_action == "RETAIN"
    assert decision.actions == (SessionAction.SEAL.value, SessionAction.FINALIZE.value)


def test_ephemeral_cleanup_requires_every_finalization_barrier() -> None:
    engine = SessionPolicyEngine()
    blocked = engine.finalization_barrier(
        authority_transition_committed=True,
        generation_transition_committed=True,
        durable_landed=False,
    )
    assert not blocked.allow_ephemeral_cleanup
    assert blocked.as_dict()["blocked_by"] == ["DURABLE_DATA_NOT_LANDED"]

    allowed = engine.finalization_barrier(
        authority_transition_committed=True,
        generation_transition_committed=True,
        durable_landed=True,
    )
    assert allowed.allow_ephemeral_cleanup


def test_policy_has_one_explicit_authority_name() -> None:
    assert SessionPolicyEngine.__name__ == "SessionPolicyEngine"


def test_equity_preopen_activates_at_0830_without_second_0900_rotation() -> None:
    zone = ZoneInfo("Asia/Taipei")
    resolver = MarketSessionResolver()
    engine = SessionPolicyEngine()

    before = resolver.resolve("STK", market="STK", now=datetime(2026, 9, 2, 8, 29, tzinfo=zone))
    assert not stk_preopen_capture(before, datetime(2026, 9, 2, 8, 29, tzinfo=zone))

    preopen_at = datetime(2026, 9, 2, 8, 30, tzinfo=zone)
    preopen = resolver.resolve("STK", market="STK", now=preopen_at)
    identity = "STK|2026-09-02|DAY|"
    preopen_decision = engine.evaluate(
        preopen,
        equity_preopen=stk_preopen_capture(preopen, preopen_at),
        candidate_identity=identity,
    )
    assert preopen_decision.activate_candidate
    assert preopen_decision.expected_lanes == {"stk.bidask": 120.0}

    open_at = datetime(2026, 9, 2, 9, 0, tzinfo=zone)
    opened = resolver.resolve("STK", market="STK", now=open_at)
    open_decision = engine.evaluate(
        opened,
        previous_identity=identity,
        candidate_identity=identity,
    )
    assert opened.live
    assert not open_decision.activate_candidate
    assert not open_decision.finalize_previous


def test_the_stock_preopen_capture_runs_from_0830_to_the_open_only_on_trading_days() -> None:
    # 2026-10-05 is a Monday. This is the provider's capture window; the screens' 盤前 is Market Runtime's phase.
    resolver = MarketSessionResolver()
    taipei = ZoneInfo("Asia/Taipei")
    at = lambda day, hh, mm: datetime(2026, 10, day, hh, mm, tzinfo=taipei)  # noqa: E731
    capture = lambda stamp: stk_preopen_capture(resolver.resolve("STK", market="STK", now=stamp), stamp)  # noqa: E731
    assert [capture(at(5, hh, mm)) for hh, mm in ((8, 29), (8, 30), (8, 59), (9, 0))] == [False, True, True, False]
    assert not capture(at(4, 8, 35)), "Sunday"
    assert not capture(at(10, 8, 35)), "國慶日 official closure"


def test_futures_resolver_never_marks_official_closure_live() -> None:
    resolver = MarketSessionResolver()
    taipei = ZoneInfo("Asia/Taipei")
    closed = resolver.resolve(
        "FUT",
        market="FUT",
        now=datetime(2026, 10, 9, 9, 0, tzinfo=taipei),
    )

    assert not closed.live
    assert closed.state == "CLOSED"
    assert closed.reason == "non_trading_day"
    assert closed.calendar_source == "official_calendar"
