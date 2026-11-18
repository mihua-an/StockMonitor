"""TXFR1 is the front month of the FUT trading date being traded.

11-18 (TXFK6's last trading day): the Quote lane was subscribed at the morning login on the SDK's R1 mapping (TXFK6)
and kept all night; the night that opened at 15:00 belongs to trading date 11-19, which trades TXFL6, so no quote came
until the provider was restarted. The month is now resolved from the futures contract table for the session owner's
trading date, and the lane moves to the new month when that date's front month changes.
"""
from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import MagicMock
from zoneinfo import ZoneInfo

import pytest

from config import broker_connection_settings
from service.market.lifecycle.rollover import SessionOrchestrator
from service.market.reference.futures_contracts import FuturesMonth, FuturesTable
from service.market.shioaji import session as shioaji

ZONE = ZoneInfo("Asia/Taipei")


def _month(code: str, ym: str, delivered: str) -> FuturesMonth:
    return FuturesMonth(code=code, symbol=f"TXF{ym}", category="TXF", name="臺股期貨", underlying_code="",
                        unit=200, delivery_month=ym, delivery_date=delivered)


TABLE = FuturesTable([_month("TXFK6", "202611", "2026-11-18"), _month("TXFL6", "202612", "2026-12-16"),
                      _month("TXFA7", "202701", "2027-01-20")])


@pytest.fixture
def svc(monkeypatch):
    monkeypatch.setattr(broker_connection_settings, "shioaji", lambda config_root=None: {
        "connections": 1, "per_connection_limit": 10, "revision": 1})
    service = shioaji.ShioajiBrokerService(event_sink=MagicMock(), credential_service=MagicMock())
    service._session_generation = 7
    api = MagicMock(name="connection1")
    api.contracts.get.side_effect = lambda code: SimpleNamespace(code=code, target_code=None)
    service._api = api
    service._sj = object()
    service._connected.set()
    monkeypatch.setattr(service, "_quote_type_value", lambda sdk, lane: lane)
    monkeypatch.setattr(service.subscription_manager, "futures_table", lambda: TABLE)
    return service


def _subscribed(api) -> list[str]:
    return [call.args[0].code for call in api.subscribe.call_args_list]


def _unsubscribed(api) -> list[str]:
    return [call.args[0].code for call in api.unsubscribe.call_args_list]


def test_the_expiry_day_session_trades_the_expiring_month(svc) -> None:
    svc.txf_contract_for("2026-11-18")
    svc.apply_demand_plan([{"market": "FUT", "code": "TXFR1"}])
    assert _subscribed(svc._api) == ["TXFK6"]
    assert svc.status()["txf"]["target_code"] == "TXFK6"


def test_the_night_after_an_expiry_moves_the_lane_to_the_next_month(svc) -> None:
    svc.txf_contract_for("2026-11-18")
    svc.apply_demand_plan([{"market": "FUT", "code": "TXFR1"}])

    # 15:00: the session owner opens the night of trading date 11-19.
    assert svc.txf_contract_for("2026-11-19") == "TXFL6"
    assert _unsubscribed(svc._api) == ["TXFK6"]
    assert _subscribed(svc._api) == ["TXFK6", "TXFL6"]
    assert "FUT:TXFR1:Quote" in svc._active_subscription_keys
    assert svc.status()["txf"]["target_code"] == "TXFL6"

    # The same trading date again (every later reconcile) changes nothing at the broker.
    assert svc.txf_contract_for("2026-11-19") == "TXFL6"
    assert svc._api.subscribe.call_count == 2 and svc._api.unsubscribe.call_count == 1


def test_a_login_on_the_expiry_night_subscribes_the_next_month(svc) -> None:
    # No trading date named yet (the morning login before the owner reconciles): the calendar's for now.
    svc._txf_business_date = lambda at=None: "2026-11-19"
    svc.apply_demand_plan([{"market": "FUT", "code": "TXFR1"}])
    assert _subscribed(svc._api) == ["TXFL6"]


def test_nothing_subscribed_yet_names_no_contract(svc) -> None:
    assert svc.txf_contract_for("2026-11-19") == ""
    svc._api.subscribe.assert_not_called()


def test_the_session_owner_names_the_night_by_the_month_it_streams(tmp_path) -> None:
    asked: list[str] = []

    def contract_for(trading_date: str) -> str:
        asked.append(trading_date)
        return "TXFL6" if trading_date >= "2026-11-19" else "TXFK6"

    broker = SimpleNamespace(txf_contract_for=contract_for, status=lambda: {"txf": {"target_code": "TXFK6"}},
                             mark_market_session_transition=MagicMock(), set_market_session_event_listener=MagicMock())
    app = SimpleNamespace(broker_service=broker)
    night = datetime(2026, 11, 18, 15, 0, 5, tzinfo=ZONE)
    owner = SessionOrchestrator(app_provider=lambda: app, manifest_dir=tmp_path / "finalization",
                                now_provider=lambda: night, materialization_jobs_root=tmp_path / "jobs")
    owner.reconcile(night)
    active = owner.lightweight_status()["active"]["FUT"]
    assert (active["trading_date"], active["session"], active["actual_contract"]) == ("2026-11-19", "NIGHT", "TXFL6")
    assert "2026-11-19" in asked
