"""The STK day partition was sealed at 13:30 and materialized at 13:34, before the 14:30 盤後定價
print (and the broker's re-sent close) arrived -- 2344 had two trades in the WAL its history lacked.
The day is held until STK_AFTER_HOURS_END and sealed once, complete."""
from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from service.market.lifecycle.policy import STK_AFTER_HOURS_END, SessionAction, SessionPolicyEngine
from service.market.lifecycle.resolver import MarketSessionResolver

TPE = ZoneInfo("Asia/Taipei")
ACTIVE = "STK|2026-10-05|DAY|"


def _decide(when: str, previous: str = ACTIVE):
    now = datetime.fromisoformat(when).replace(tzinfo=TPE)
    resolution = MarketSessionResolver().resolve("STK", market="STK", now=now)
    return SessionPolicyEngine().evaluate(resolution, previous_identity=previous, candidate_identity="", now=now)


def test_the_day_is_held_through_the_after_hours_match_and_sealed_after_it():
    assert STK_AFTER_HOURS_END.strftime("%H:%M") == "14:40"
    for when in ("2026-10-05T13:31", "2026-10-05T14:30", "2026-10-05T14:39"):
        decision = _decide(when)
        assert decision.after_hours_capture and decision.phase == "AFTER_HOURS", when
        assert SessionAction.SEAL.value not in decision.actions, f"{when}: not sealed yet"
        assert decision.expected_lanes == {} and not decision.owns_market_data, "no data is expected meanwhile"
    sealed = _decide("2026-10-05T14:40")
    assert not sealed.after_hours_capture and sealed.phase == "CLOSED"
    assert SessionAction.SEAL.value in sealed.actions and SessionAction.FINALIZE.value in sealed.actions


def test_without_a_clock_or_on_a_holiday_nothing_is_held():
    resolution = MarketSessionResolver().resolve("STK", market="STK", now=datetime(2026, 10, 5, 14, 0, tzinfo=TPE))
    assert SessionPolicyEngine().evaluate(resolution, previous_identity=ACTIVE).finalize_previous, "no now: old rule"
    holiday = _decide("2026-10-04T14:00", previous="STK|2026-10-02|DAY|")
    assert not holiday.after_hours_capture and holiday.finalize_previous


def test_an_older_day_still_left_active_is_sealed_at_once():
    late = _decide("2026-10-05T14:00", previous="STK|2026-10-02|DAY|")
    assert late.after_hours_capture and late.finalize_previous, "only the same day is held"
