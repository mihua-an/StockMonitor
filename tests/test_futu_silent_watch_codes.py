"""A Futu watch code that stops delivering is seen and reported -- never "renewed" by forgetting its
subscription.

Readiness asked only whether a watch code had *ever* delivered, and a confirmed subscription stayed confirmed for
good: a subscription OpenD stopped feeding froze that row all day while Futu read READY.
"""
from __future__ import annotations

import time
from types import SimpleNamespace

import pytest

import service.market.futu.service as futu_service


@pytest.fixture()
def futu(tmp_path, monkeypatch):
    monkeypatch.setenv("FUTU_MARKET_DB", str(tmp_path / "futu.db"))
    monkeypatch.setenv("FUTU_SECURITY_MASTER_FILE", str(tmp_path / "master.csv"))
    monkeypatch.setattr(futu_service, "resolve_session", lambda _spec: SimpleNamespace(active=True))
    service = futu_service.FutuMarketService()
    service._opend.connected = True                                   # OpenD up and its worker running: the link is online
    service._thread = SimpleNamespace(is_alive=lambda: True)
    manager = service.subscription_manager
    manager.replace_plan([{"market": "US", "code": c, "kinds": ["quote", "trade"]} for c in ("US.AAPL", "US.TSLA")])
    long_ago = time.monotonic() - futu_service.WATCH_SILENT_SECONDS - 60
    for code in ("US.AAPL", "US.TSLA"):
        for lane in manager.subscription_plan(code).watchlist_lanes:
            manager.confirmed_pairs.add((code, lane))
            manager.subscription_started_at[(code, lane)] = long_ago
    return service


def test_a_silent_lane_is_listed_without_making_futu_stale_and_keeps_its_subscription(futu):
    now = time.monotonic()
    for lane in futu.subscription_manager.subscription_plan("US.AAPL").watchlist_lanes:
        futu._lane_last_event_monotonic[("US.AAPL", lane)] = now
        futu._lane_last_event_at[("US.AAPL", lane)] = "now"
    tsla_lanes = futu.subscription_manager.subscription_plan("US.TSLA").watchlist_lanes
    futu._lane_last_event_monotonic[("US.TSLA", tsla_lanes[0])] = now          # one family delivering...
    futu._lane_last_event_at[("US.TSLA", tsla_lanes[0])] = "now"

    status = futu.read_status()
    # ...does not hide another that stopped (the newest mark across a code's lanes would hide it).
    assert status["stale_watch_lanes"] == [f"US.TSLA:{lane}" for lane in tsla_lanes[1:]]
    assert status["stale_watch_codes"] == (["US.TSLA"] if tsla_lanes[1:] else [])
    assert status["readiness"]["state"] == "READY", "a quiet lane is not a failure"

    assert not hasattr(futu, "resubscribe_silent_watch_codes")
    assert any(code == "US.TSLA" for code, _ in futu.subscription_manager.confirmed_pairs), "its subscription stands"


def test_readiness_is_the_confirmed_subscriptions_never_silence(futu):
    """Silence is reported, never a verdict -- every name may simply be quiet."""
    status = futu.read_status()
    assert sorted(status["stale_watch_codes"]) == ["US.AAPL", "US.TSLA"]
    assert status["readiness"]["state"] == "READY" and status["readiness"]["reason"] is None
    futu.subscription_manager.confirmed_pairs.discard(("US.AAPL", "QUOTE"))
    assert futu.read_status()["readiness"]["state"] == "STARTING", "an unconfirmed subscription is not ready"


def test_a_code_outside_its_session_is_not_judged(futu, monkeypatch):
    monkeypatch.setattr(futu_service, "resolve_session", lambda _spec: SimpleNamespace(active=False))
    assert futu.read_status()["stale_watch_codes"] == []


def test_a_failing_maintenance_step_is_its_own_failure_not_a_lost_context(futu):
    """A maintenance exception must not tear the whole OpenD context down."""

    lifecycle = futu.opend_lifecycle
    lifecycle.run_operation("security_master", lambda: (_ for _ in ()).throw(TimeoutError("snapshot quota")))
    state = futu.read_status()["operations"]["security_master"]
    assert state["ok"] is False and "snapshot quota" in state["current_error"] and state["failures"] == 1
    lifecycle.run_operation("security_master", lambda: None)
    recovered = futu.read_status()["operations"]["security_master"]
    assert recovered["ok"] is True and recovered["current_error"] is None
    assert "snapshot quota" in recovered["last_failure"]["error"] and recovered["last_failure"]["recovered_at"]
