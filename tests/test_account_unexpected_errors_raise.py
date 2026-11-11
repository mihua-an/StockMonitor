"""Only the Sheet's own bad data is listed as a 'Google Sheet error' / rebuild error. A program error while reading a
row is logged with the row and raised, not reported to the user as their data being wrong (R14-08)."""
from __future__ import annotations

import logging

import pytest

from service.account import accounting_core
from service.account.account_types import ActualAccountError
from service.account.paper_wallet_service import PaperWalletService


@pytest.fixture
def ledger(tmp_path, monkeypatch):
    monkeypatch.setenv("STOCK_MONITOR_SQLITE_DIAGNOSTICS", "0")
    service = PaperWalletService(db_path=tmp_path / "paper.db", config_path=tmp_path / "unused.json",
                                 security_master_path=tmp_path / "master.csv")
    yield service
    service.shutdown()


ROW = {"trade_id": "T1", "trade_date": "2026-09-01", "market": "台股", "action": "買進", "code": "2330",
       "trade_info": "1000@100", "trade_time": "09:00"}


def test_bad_sheet_data_is_listed(ledger):
    with pytest.raises(ActualAccountError, match="第 1 段格式錯誤") as caught:
        ledger.replace_raw_trades([{**ROW, "trade_info": "1000x100"}])
    assert "Google Sheet" in str(caught.value)
    with pytest.raises(ActualAccountError, match="source_order 不是整數"):
        ledger.replace_raw_trades([{**ROW, "source_order": "abc"}])


def test_a_program_error_in_import_is_raised_and_logged(ledger, monkeypatch, caplog):
    def broken(*_args):
        raise KeyError("fills")
    monkeypatch.setattr(type(ledger), "parse_trade_info", staticmethod(broken))
    with caplog.at_level(logging.ERROR), pytest.raises(KeyError):
        ledger.replace_raw_trades([ROW])
    assert any("row 2" in r.getMessage() and "T1" in r.getMessage() for r in caplog.records)


def test_a_program_error_in_rebuild_is_raised_and_logged(ledger, monkeypatch, caplog):
    rows = [{**ROW, "source_order": 2}]
    def broken(*_args):
        raise AttributeError("qty")
    monkeypatch.setattr(accounting_core.AccountingCore, "parse_trade_info", staticmethod(broken))
    with caplog.at_level(logging.ERROR), pytest.raises(AttributeError):
        ledger._build_orders(rows)
    assert any("T1" in r.getMessage() for r in caplog.records)
    monkeypatch.undo()
    orders, errors = ledger._build_orders([{**ROW, "source_order": 2, "trade_info": "abc"}])
    assert orders == [] and errors and errors[0][0] == "T1"
