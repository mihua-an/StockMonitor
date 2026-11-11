"""The account summary is summed by SQLite in aggregate queries: the same exact Decimal totals as the rows give, per
period and market, and a stored amount that is not a number fails the read (R14-09) instead of counting as zero."""
from __future__ import annotations

import sqlite3
from datetime import date
from decimal import Decimal

import pytest

from service.account import account_analytics_service
from service.account.account_types import LedgerDataError
from service.account.paper_wallet_service import PaperWalletService


class ClockDate(date):
    value = date(2026, 9, 9)

    @classmethod
    def today(cls):
        return cls.value


@pytest.fixture
def ledger(tmp_path, monkeypatch):
    monkeypatch.setattr(account_analytics_service, "date", ClockDate)
    service = PaperWalletService(db_path=tmp_path / "paper.db", config_path=tmp_path / "config.json",
                                 security_master_path=tmp_path / "master.csv")
    try:
        for n, (day, sell) in enumerate((("2026-08-31", "101.15"), ("2026-09-08", "103.3"), ("2026-09-09", "99.45"))):
            base = {"trade_date": day, "market": "台股", "code": "2330", "trade_time": "09:00"}
            service.local_save_trade({**base, "trade_id": f"B{n}", "action": "買進", "trade_info": "1000@100"})
            service.local_save_trade({**base, "trade_id": f"S{n}", "action": "賣出", "trade_info": f"1000@{sell}", "trade_time": "10:00"})
        service.local_save_trade({"trade_date": "2026-09-09", "market": "台股", "code": "2317", "trade_time": "11:00",
                                  "trade_id": "H1", "action": "買進", "trade_info": "1000@150"})
        yield service
    finally:
        service.shutdown()


def _rows(ledger):
    with sqlite3.connect(ledger.db_path) as conn:
        return conn.execute("SELECT realized_date, profit, trade_type FROM realized_matches WHERE market='台股'").fetchall()


def test_period_totals_equal_the_rows_summed_as_decimals(ledger):
    rows = _rows(ledger)
    total = lambda pick: float(sum((Decimal(p) for d, p, t in rows if pick(d, t)), Decimal(0)))
    summary = ledger.get_summary()
    assert summary["today"]["tw"] == total(lambda d, t: d == "2026-09-09")
    assert summary["week"]["tw"] == total(lambda d, t: "2026-09-07" <= d <= "2026-09-09")
    assert summary["month"]["tw"] == total(lambda d, t: "2026-09-01" <= d <= "2026-09-09")
    assert summary["realized_total"]["tw"] == total(lambda d, t: True)
    assert summary["daytrade_total"]["tw"] == total(lambda d, t: t == "當沖")
    assert summary["holding_cost"]["tw"] > 150000 and summary["today"]["us"] == 0.0
    assert summary["month"]["tw"] != summary["realized_total"]["tw"], "August is outside September"


def test_a_damaged_amount_fails_the_summary(ledger):
    with sqlite3.connect(ledger.db_path) as conn:
        conn.execute("UPDATE realized_matches SET profit='abc' WHERE rowid=(SELECT MIN(rowid) FROM realized_matches)")
    with pytest.raises(LedgerDataError):
        ledger.get_summary()
