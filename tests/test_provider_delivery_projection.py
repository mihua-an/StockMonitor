"""Behaviour tests for the single, evidence-based provider readiness projection.

Covers the four rulings this change implements:

* the 30s / 120s lane staleness tiers (replacing ``stale_after_seconds=1e9``),
* a closed market projects ``IDLE`` rather than stale or pending,
* "never started" and "started then stopped" are distinguishable lane states,
* the link is the broker login and its worker; delivered events never stand in for it.
"""
from __future__ import annotations

import time
from types import SimpleNamespace

import pytest

from service.market.shared.provider_contract import (
    FUTU_CAPABILITIES,
    HIGH_FREQUENCY_STALE_SECONDS,
    ORDINARY_STALE_SECONDS,
    SHIOAJI_CAPABILITIES,
    LaneDeliveryEvidence,
    lane_stale_after_seconds,
    lanes_market_data_ready,
    provider_lane_freshness,
    provider_link_online,
)


# --------------------------------------------------------------------------
# 1. Lane tiering: 30s high frequency, 120s ordinary, derived from capabilities
# --------------------------------------------------------------------------

def test_high_frequency_tier_is_the_fixed_context_and_focus_only_lanes() -> None:
    taiex = SHIOAJI_CAPABILITIES.plan_for("IND", "IX0001")
    txf = SHIOAJI_CAPABILITIES.plan_for("FUT", "TXFR1")
    stock = SHIOAJI_CAPABILITIES.plan_for("STK", "2330")
    us = FUTU_CAPABILITIES.plan_for("US", "US.AAPL")

    # The rule is read off the capability contract, not off a symbol list.
    assert taiex.fixed_context is True and txf.fixed_context is True
    assert stock.fixed_context is False
    assert "ORDER_BOOK" in us.lanes and "ORDER_BOOK" not in us.watchlist_lanes

    assert lane_stale_after_seconds(taiex, "Quote") == HIGH_FREQUENCY_STALE_SECONDS == 30.0
    assert lane_stale_after_seconds(txf, "Quote") == 30.0
    assert lane_stale_after_seconds(us, "ORDER_BOOK") == 30.0

    assert lane_stale_after_seconds(stock, "Tick") == ORDINARY_STALE_SECONDS == 120.0
    assert lane_stale_after_seconds(stock, "BidAsk") == 120.0
    for lane in ("QUOTE", "RT_DATA", "TICKER"):
        assert lane_stale_after_seconds(us, lane) == 120.0


def _lane(**overrides):
    payload = dict(
        provider="shioaji", code="2330", lane="Tick", desired=True, confirmed=True,
        last_event_at="2026-09-27T09:00:00.000", age_seconds=0.0,
        stale_after_seconds=ORDINARY_STALE_SECONDS,
    )
    payload.update(overrides)
    return provider_lane_freshness(**payload)


def test_index_and_futures_quote_go_stale_at_thirty_seconds() -> None:
    plan = SHIOAJI_CAPABILITIES.plan_for("FUT", "TXFR1")
    budget = lane_stale_after_seconds(plan, "Quote")

    fresh = _lane(code="TXFR1", lane="Quote", age_seconds=29.0, stale_after_seconds=budget)
    dead = _lane(code="TXFR1", lane="Quote", age_seconds=31.0, stale_after_seconds=budget)

    assert fresh["state"] == "HEALTHY" and fresh["stale"] is False
    assert dead["state"] == "STALE" and dead["stale"] is True


def test_ordinary_stock_lanes_tolerate_thirty_seconds_and_go_stale_at_two_minutes() -> None:
    plan = SHIOAJI_CAPABILITIES.plan_for("STK", "2330")
    budget = lane_stale_after_seconds(plan, "Tick")

    assert _lane(age_seconds=31.0, stale_after_seconds=budget)["state"] == "HEALTHY"
    assert _lane(age_seconds=119.0, stale_after_seconds=budget)["state"] == "HEALTHY"
    stale = _lane(age_seconds=121.0, stale_after_seconds=budget)
    assert stale["state"] == "STALE" and stale["stale"] is True


def test_no_lane_is_given_an_effectively_infinite_staleness_budget() -> None:
    """The retired 1e9 escape hatch made every age branch unreachable."""
    for plan, lane in (
        (SHIOAJI_CAPABILITIES.plan_for("STK", "2330"), "Tick"),
        (SHIOAJI_CAPABILITIES.plan_for("STK", "2330"), "BidAsk"),
        (SHIOAJI_CAPABILITIES.plan_for("IND", "IX0001"), "Quote"),
        (SHIOAJI_CAPABILITIES.plan_for("FUT", "TXFR1"), "Quote"),
        (FUTU_CAPABILITIES.plan_for("US", "US.AAPL"), "ORDER_BOOK"),
        (FUTU_CAPABILITIES.plan_for("CC", "CC.BTC"), "QUOTE"),
    ):
        assert lane_stale_after_seconds(plan, lane) <= ORDINARY_STALE_SECONDS

    source = (
        __import__("pathlib").Path(__file__).resolve().parents[1]
        / "service" / "market" / "shioaji" / "session.py"
    ).read_text(encoding="utf-8")
    assert "1_000_000_000.0" not in source


# --------------------------------------------------------------------------
# 2. Closed market -> IDLE
# --------------------------------------------------------------------------

def test_closed_market_is_idle_not_stale_however_old_the_lane_is() -> None:
    row = _lane(age_seconds=86_400.0, expected_active=False)
    assert row["state"] == "IDLE"
    assert row["stale"] is False


def test_closed_market_is_idle_even_before_the_subscription_is_confirmed() -> None:
    """IDLE is evaluated before ``confirmed``: silence off-session is correct."""
    row = _lane(confirmed=False, last_event_at=None, age_seconds=None, expected_active=False)
    assert row["state"] == "IDLE"
    assert row["stale"] is False


def test_an_undesired_lane_still_wins_over_idle() -> None:
    assert _lane(desired=False, expected_active=False)["state"] == "NOT_DESIRED"


# --------------------------------------------------------------------------
# 3. Never started vs started then stopped
# --------------------------------------------------------------------------

def test_never_started_lane_is_subscription_pending_and_not_stale() -> None:
    row = _lane(confirmed=False, last_event_at=None, age_seconds=None)
    assert row["state"] == "SUBSCRIPTION_PENDING"
    assert row["stale"] is False


def test_confirmed_but_silent_lane_is_awaiting_event_not_stale() -> None:
    row = _lane(confirmed=True, last_event_at=None, age_seconds=None)
    assert row["state"] == "CONFIRMED_AWAITING_EVENT"
    assert row["stale"] is False


def test_started_then_stopped_lane_is_stale_even_when_confirmation_was_lost() -> None:
    """The live hole: a lane dropped from ``confirmed_pairs`` by a failing
    resubscribe keeps its counters and used to report SUBSCRIPTION_PENDING /
    stale=False forever while dead."""
    row = _lane(confirmed=False, last_event_at="2026-09-27T08:00:00.000", age_seconds=600.0)
    assert row["state"] == "STALE"
    assert row["stale"] is True


def test_delivering_lane_is_healthy_even_when_confirmation_is_established_elsewhere() -> None:
    """A lane dropped from ``confirmed_pairs`` while events flow is still healthy: delivery evidence outranks the
    confirmation flag."""
    row = _lane(confirmed=False, last_event_at="2026-09-27T09:00:00.000", age_seconds=1.0)
    assert row["state"] == "HEALTHY"
    assert row["stale"] is False


def test_readiness_verdict_reads_only_the_lane_projection() -> None:
    assert lanes_market_data_ready([]) is False
    assert lanes_market_data_ready([_lane(age_seconds=1.0)]) is True
    assert lanes_market_data_ready([_lane(expected_active=False)]) is True
    assert lanes_market_data_ready([_lane(confirmed=False, last_event_at=None, age_seconds=None)]) is False
    assert lanes_market_data_ready([_lane(age_seconds=1.0), _lane(age_seconds=9_999.0)]) is False


# --------------------------------------------------------------------------
# 4. The link: the broker login and its worker
# --------------------------------------------------------------------------

def test_link_online_is_the_broker_login_and_its_worker() -> None:
    for connected in (False, True):
        for worker_alive in (False, True):
            assert provider_link_online(connected=connected, worker_alive=worker_alive) is bool(connected and worker_alive)


# --------------------------------------------------------------------------
# 5. The evidence record itself
# --------------------------------------------------------------------------

def test_delivery_evidence_records_per_lane_age_and_counts() -> None:
    evidence = LaneDeliveryEvidence()
    assert evidence.age_seconds("STK:2330:Tick:regular") is None
    assert evidence.last_delivery_at() is None

    evidence.observe("STK:2330:Tick:regular", code="2330", lane="Tick")
    evidence.observe("STK:2330:Tick:regular", code="2330", lane="Tick")
    evidence.observe("FUT:TXFR1:Quote", code="TXFR1", lane="Quote")

    assert evidence.count("STK:2330:Tick:regular") == 2
    assert evidence.count("FUT:TXFR1:Quote") == 1
    assert evidence.age_seconds("STK:2330:Tick:regular") < 5.0
    assert evidence.last_delivery_at() is not None
    assert set(evidence.keys()) == {"STK:2330:Tick:regular", "FUT:TXFR1:Quote"}
    assert evidence.identity("FUT:TXFR1:Quote") == ("TXFR1", "Quote")
    assert evidence.snapshot()["FUT:TXFR1:Quote"]["count"] == 1


# --------------------------------------------------------------------------
# 6. Shioaji: the callback adapter is the one place evidence is written
# --------------------------------------------------------------------------

class _FakeOwner:
    TAIEX_CODE = "IX0001"
    TXF_CODE = "TXFR1"

    def __init__(self) -> None:
        self.delivery_evidence = LaneDeliveryEvidence()
        self.first_events: list[str] = []

    def note_market_event(self, security_type: str, exchange_timestamp: str = "") -> None:
        self.first_events.append(security_type)


def _adapter():
    from service.market.shioaji.callback import ShioajiThinCallbackAdapter

    owner = _FakeOwner()
    return owner, ShioajiThinCallbackAdapter(owner)


def test_shioaji_callback_pulse_records_lane_delivery_under_the_stream_key() -> None:
    owner, adapter = _adapter()
    arrival = time.time_ns()
    adapter._pulse_dataflow("stk.tick", "2330", 1, True, arrival)
    adapter._pulse_dataflow("stk.bidask", "2330", 1, True, arrival)
    adapter._pulse_dataflow("index.quote", "IX0001", 1, True, arrival)
    # The futures callback pulses the native contract code; evidence must still
    # be keyed by the logical subscription code.
    adapter._pulse_dataflow("futures.quote", "TXFJ6", 1, True, arrival)

    assert set(owner.delivery_evidence.keys()) == {
        "STK:2330:Tick:regular",
        "STK:2330:BidAsk:regular",
        "IND:IX0001:Quote",
        "FUT:TXFR1:Quote",
    }


def test_shioaji_callback_pulse_does_not_record_rejected_events() -> None:
    owner, adapter = _adapter()
    adapter._pulse_dataflow("stk.tick", "2330", 1, False, time.time_ns(), error="price_scale")
    assert list(owner.delivery_evidence.keys()) == []


# --------------------------------------------------------------------------
# 7. Shioaji session projection
# --------------------------------------------------------------------------

@pytest.fixture()
def _session(tmp_path, monkeypatch):
    monkeypatch.setenv("STOCK_MONITOR_DATA_ROOT", str(tmp_path / "data"))
    from service.market.shioaji.session import ShioajiBrokerService

    session = ShioajiBrokerService()
    yield session


def test_shioaji_readiness_ignores_delivery_evidence_for_the_link(_session) -> None:
    """A disconnected broker stays DISCONNECTED however many events the sink has seen."""
    _session.delivery_evidence.observe("STK:2330:Tick:regular", code="2330", lane="Tick")

    status = _session.lightweight_status()
    assert status["readiness"]["connected"] is False
    assert status["readiness"]["state"] == "DISCONNECTED"

    _session._connected.set()
    _session._running.set()
    assert _session.lightweight_status()["readiness"]["connected"] is True


def test_shioaji_status_projects_delivering_lanes_without_subscriptions(_session) -> None:
    """A lane this process holds no subscription state for is still described once it is demonstrably delivering."""
    _session.delivery_evidence.observe("STK:2330:Tick:regular", code="2330", lane="Tick")
    _session.delivery_evidence.observe("FUT:TXFR1:Quote", code="TXFR1", lane="Quote")

    status = _session.status()
    rows = {(row["code"], row["lane"]): row for row in status["lane_freshness"]}

    assert ("2330", "Tick") in rows and ("TXFR1", "Quote") in rows
    assert rows[("2330", "Tick")]["state"] == "HEALTHY"
    assert rows[("2330", "Tick")]["confirmed"] is False
    assert rows[("2330", "Tick")]["stale_after_seconds"] == 120.0
    assert rows[("TXFR1", "Quote")]["stale_after_seconds"] == 30.0


def test_shioaji_status_reports_a_dead_lane_as_stale(_session) -> None:
    """Finding B: a Shioaji lane that stopped delivering must not stay HEALTHY."""
    evidence = _session.delivery_evidence
    evidence.observe("FUT:TXFR1:Quote", code="TXFR1", lane="Quote")
    # Age the lane past its 30s high-frequency budget without sleeping.
    evidence._rows["FUT:TXFR1:Quote"][0] -= 45.0

    status = _session.status()
    row = next(row for row in status["lane_freshness"] if row["code"] == "TXFR1")
    assert row["state"] == "STALE"
    assert row["stale"] is True
    assert status["readiness"]["market_data_ready"] is False


# --------------------------------------------------------------------------
# 8. App-side link authority (api/source_diagnostics.py)
# --------------------------------------------------------------------------

def _broker_status(health):
    from api.source_diagnostics import create_source_diagnostics

    runtime = SimpleNamespace(cached_health=lambda: health)
    futu = SimpleNamespace(cached_health=lambda: {})
    return create_source_diagnostics(runtime, futu).broker_status()


def _health(**overrides):
    from service.market.shioaji.daemon_contract import (
        MARKET_DAEMON_IDENTITY,
        MARKET_DAEMON_PROTOCOL_VERSION,
        MARKET_DAEMON_RUNTIME_VERSION,
    )

    payload = {
        "ok": True,
        "identity": MARKET_DAEMON_IDENTITY,
        "protocol_version": MARKET_DAEMON_PROTOCOL_VERSION,
        "runtime_version": MARKET_DAEMON_RUNTIME_VERSION,
        "daemon_runtime_version": MARKET_DAEMON_RUNTIME_VERSION,
        "shioaji_connected": True,
        "shioaji": {"connected": True, "readiness": {"connected": True, "market_data_ready": True}},
        "live_ingress": {"ready": True, "running": True},
    }
    payload.update(overrides)
    return payload


def test_app_keeps_the_broker_login_flag_as_the_live_link_authority(monkeypatch) -> None:
    status = _broker_status(_health(shioaji_connected=False, shioaji={"connected": False,
                            "readiness": {"connected": True, "market_data_ready": True}}))
    assert status["authority"] == "persistent_market_daemon"
    assert status["state"] == "DISCONNECTED"
    assert status["stale_reason"] == "SHIOAJI_DISCONNECTED"
    assert status["readiness"]["connected"] is False


def test_app_does_not_call_a_quiet_closed_session_stale(monkeypatch) -> None:
    """No expected-live session means silence is IDLE, not 「資料停滯」."""
    status = _broker_status(
        _health(last_market_callback_at="2020-01-01T00:00:00.000"),
    )
    assert status["callback_age_seconds"] is not None
    assert status["callback_age_seconds"] > ORDINARY_STALE_SECONDS
    assert status["state"] == "CONNECTED"
    assert status["stale_reason"] is None


def test_app_still_calls_an_expected_live_session_stale(monkeypatch) -> None:
    status = _broker_status(
        _health(
            last_market_callback_at="2020-01-01T00:00:00.000",
            market_sessions={"expected": {"STK": {"live": True, "session": "DAY"}},
                             "active": {"STK": {"state": "ACTIVE"}}},
        ),
    )
    assert status["state"] == "CONNECTED_STREAM_STALE"
    assert status["stale_reason"] == "ACTIVE_STREAM_CALLBACK_STALE"


# --------------------------------------------------------------------------
# 9. Futu: the same rule
# --------------------------------------------------------------------------

@pytest.fixture()
def _futu(tmp_path, monkeypatch):
    monkeypatch.setenv("FUTU_MARKET_DB", str(tmp_path / "futu.db"))
    monkeypatch.setenv("FUTU_SECURITY_MASTER_FILE", str(tmp_path / "master.csv"))
    from service.market.futu.service import FutuMarketService

    yield FutuMarketService()


def test_futu_link_is_unchanged_by_delivery_evidence(_futu) -> None:
    _futu._last_callback_at = "2026-09-27T09:00:00Z"
    assert _futu.read_status()["readiness"]["connected"] is False


def test_futu_order_book_uses_the_high_frequency_tier_and_every_planned_lane_is_judged(_futu) -> None:
    # The provider keeps no focus of its own: every lane Market Runtime planned is judged, the order book included.
    _futu.subscription_manager.replace_plan([{"market": "US", "code": "US.AAPL", "kinds": ["quote", "trade", "orderbook"]},
                                             {"market": "US", "code": "US.NOK", "kinds": ["quote", "trade"]}])
    status = _futu.read_status()
    assert "focused_code" not in status
    assert {row["code"] for row in status["lane_freshness"]} == {"US.AAPL", "US.NOK"}
    assert not any(row["code"] == "US.NOK" and row["lane"] == "ORDER_BOOK" for row in status["lane_freshness"])
    rows = {row["lane"]: row for row in status["lane_freshness"] if row["code"] == "US.AAPL"}
    assert rows["ORDER_BOOK"]["stale_after_seconds"] == 30.0
    for lane in ("QUOTE", "RT_DATA", "TICKER"):
        assert rows[lane]["stale_after_seconds"] == 120.0


def test_a_fresh_futures_ledger_lane_without_session_identity_is_not_stale(monkeypatch) -> None:
    # The callback ledger lane for futures.quote reports observed/age but no session or
    # generation. Those blanks used to fail the session/generation match, so 「永豐 已連線（行情停滯）」 showed all
    # session while TXFR1 updated every second.
    from datetime import datetime

    now = datetime.now().isoformat(timespec="milliseconds")
    status = _broker_status(
        _health(
            session_generation=3,
            last_market_callback_at=now,
            market_sessions={"expected": {"FUT": {"live": True, "session": "DAY"}},
                             "active": {"FUT": {"state": "ACTIVE"}}},
            callback_lanes={"futures.quote": {"observed": 120, "age_seconds": 0.2, "source_timestamp": now,
                                              "session": "", "generation": 0}},
        ),
    )
    assert status["txf_lanes"]["Quote"]["healthy"] is True
    assert status["state"] == "CONNECTED"
    assert status["readiness"].get("reason") != "FUT_QUOTE_STALE"


def test_the_first_event_of_a_market_generation_reaches_the_session_owner_once(_session) -> None:
    """The per-stream marking that should signal it had no caller; the listener never fired."""
    fired = []
    _session.set_market_session_event_listener(lambda security, stamp: fired.append(security))
    for _ in range(3):
        _session.note_market_event("FUT")
        _session.note_market_event("STK")
    assert fired == ["FUT", "STK"], "once per security type, not per callback"
    _session.mark_market_session_transition(market="FUT", trading_date="2026-10-13", session="DAY", generation=9, live=True)
    _session.note_market_event("FUT")
    _session.note_market_event("STK")
    assert fired == ["FUT", "STK", "FUT"], "a new FUT generation signals FUT again; STK's stays seen"


def test_the_callback_path_signals_the_market_event() -> None:
    owner, adapter = _adapter()
    arrival = time.time_ns()
    adapter._pulse_dataflow("stk.tick", "2330", 1, True, arrival)
    adapter._pulse_dataflow("index.quote", "IX0001", 1, True, arrival)
    assert owner.first_events == ["STK", "IND"], "every delivered event is offered; the session dedupes"
