"""The futures contract table is written for the futures trading date being traded or next to open.

11-18 (the November months' last trading day): the table was written per calendar day and kept TXFK6 and every expired
stock-future month after 15:00, so the night of trading date 11-19 still showed them as the near month (the 期貨
picker, the background list's near month) until the next morning's refresh. The refresh now runs when the futures
trading date moves on at 15:00 and drops a month whose last trading day is before it.
"""
from __future__ import annotations

from datetime import date, datetime
from types import SimpleNamespace

from service.market.lifecycle.calendar import MarketSessionCalendar
from service.market.reference.futures_contracts import rows_from_contracts
from service.market.shioaji import maintenance
from service.market.shioaji.maintenance import MarketMaintenanceCoordinator, contract_day


def test_the_upcoming_trading_date_moves_on_at_15_00_and_never_goes_back() -> None:
    calendar = MarketSessionCalendar()
    at = lambda *parts: calendar.upcoming_trading_date(datetime(*parts)).isoformat()
    assert at(2026, 11, 18, 14, 59) == "2026-11-18"
    assert at(2026, 11, 18, 15, 0) == "2026-11-19"
    assert at(2026, 11, 19, 3, 0) == "2026-11-19", "the night after midnight is still trading date 11-19"
    assert at(2026, 11, 20, 15, 0) == "2026-11-23", "a Friday night belongs to Monday"
    assert at(2026, 11, 21, 10, 0) == "2026-11-23", "a Saturday daytime: the next to open, not Friday again"


def _contract(code: str, ym: str, delivered: str, root: str = "TXF") -> SimpleNamespace:
    return SimpleNamespace(code=code, root=root, delivery_month=ym, delivery_date=delivered.replace("-", "/"),
                           name=root, underlying_code="", contract_size=200)


def test_the_expiry_night_table_drops_the_expired_month() -> None:
    contracts = [_contract("TXFK6", "202611", "2026-11-18"), _contract("TXFL6", "202612", "2026-12-16"),
                 _contract("CDFK6", "202611", "2026-11-18", root="CDF"), _contract("CDFL6", "202612", "2026-12-16", root="CDF")]
    day = rows_from_contracts(contracts, today=date.fromisoformat(contract_day(datetime(2026, 11, 18, 14, 0))))[0]
    night = rows_from_contracts(contracts, today=date.fromisoformat(contract_day(datetime(2026, 11, 18, 15, 0))))[0]
    assert [m.code for m in day] == ["CDFK6", "CDFL6", "TXFK6", "TXFL6"]
    assert [m.code for m in night] == ["CDFL6", "TXFL6"]


def test_the_refresh_runs_again_when_the_night_opens(monkeypatch) -> None:
    coordinator = MarketMaintenanceCoordinator()
    refreshed: list[str] = []

    def refresh(api, day: str) -> dict:
        refreshed.append(day)
        return {"ok": True, "count": 1}

    monkeypatch.setattr(coordinator, "_refresh", refresh)
    api = object()
    coordinator._current_day = "2026-11-18"   # the morning login's refresh
    assert coordinator.schedule_daily(now=datetime(2026, 11, 18, 14, 59), connected=True, api=api)["reason"] == "already_current"
    scheduled = coordinator.schedule_daily(now=datetime(2026, 11, 18, 15, 0), connected=True, api=api)
    assert scheduled == {"scheduled": True, "day": "2026-11-19"}
    coordinator._active_thread.join(5)
    assert refreshed[-1] == "2026-11-19"


def test_the_table_is_written_for_the_contract_day(monkeypatch) -> None:
    from service.market.reference import futures_contracts

    seen: dict = {}
    monkeypatch.setattr(futures_contracts, "update_from_api", lambda api, **kw: seen.update(kw) or {"ok": True})
    monkeypatch.setattr(maintenance, "SecurityMasterService",
                        lambda *a, **k: SimpleNamespace(update_master=lambda api: {"ok": True, "count": 0}))
    monkeypatch.setattr(maintenance, "process_market_layout", lambda: SimpleNamespace(shioaji_security_master="unused"))
    MarketMaintenanceCoordinator().refresh_connected(object(), day="2026-11-19")
    assert seen == {"today": date(2026, 11, 19)}
