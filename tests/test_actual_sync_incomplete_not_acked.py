"""A sync whose rebuild left trades unmatched was ACKed and reported ok, so the bridge treated it as done
and never retried. (A failed derived-sheet publish is gone with the derived sheets: the phone's data is
published separately by the debounced mobile publisher.)"""
from __future__ import annotations

import pytest

from tests.support.actual_sync import BUY, OVERSELL, actual_service


def test_incomplete_sync_is_not_acked(tmp_path, monkeypatch):
    # Every trade text the Sheet can hold is either rejected at import (the whole sync fails) or matched -- a sell
    # beyond the holding is a short (先賣) -- so a rebuild that records errors is forced here: what is tested is the
    # sync's answer to one, not a way to produce it.
    ledger, calls = actual_service(tmp_path, monkeypatch, items=[BUY])
    rebuild = ledger.replace_raw_trades
    monkeypatch.setattr(ledger, "replace_raw_trades", lambda items: {**rebuild(items), "errors": 1})
    try:
        result = ledger.sync_service.sync_from_gas()
        assert result["ok"] is False
        assert any("帳務重建" in error for error in result["incomplete"])
        assert result["bridge"]["pending"] and not result["bridge"]["acknowledged"]
        assert "actualBridgeAck" not in calls
    finally:
        ledger.shutdown()


def test_a_sell_beyond_the_holding_is_a_short_and_the_sync_completes(tmp_path, monkeypatch):
    ledger, calls = actual_service(tmp_path, monkeypatch, items=[BUY, OVERSELL])
    try:
        result = ledger.sync_service.sync_from_gas()
        assert result["ok"] is True and result["incomplete"] == []
        assert "actualBridgeAck" in calls
        assert [(p["code"], p["qty"]) for p in ledger.get_positions()] == [("2330", -1000)]
    finally:
        ledger.shutdown()


def test_complete_sync_is_still_acked(tmp_path, monkeypatch):
    ledger, calls = actual_service(tmp_path, monkeypatch, items=[BUY])
    try:
        result = ledger.sync_service.sync_from_gas()
        assert result["ok"] is True and result["incomplete"] == []
        assert result["bridge"]["acknowledged"]
        assert "actualBridgeAck" in calls
    finally:
        ledger.shutdown()


def test_a_gas_script_without_the_ack_action_still_records_the_synced_revision(tmp_path, monkeypatch):
    """The user's GAS answered 不支援的 POST action：actualBridgeAck. The revision went unrecorded, so every poll
    re-synced and re-published, and the mobile publish's 30-minute debounce never ran out."""
    from service.account.account_types import ActualAccountError

    ledger, calls = actual_service(tmp_path, monkeypatch, items=[BUY])
    inner = ledger.sync_service._gas_request

    def request(action, payload=None, *, write=False):
        if action == "actualBridgeAck":
            calls.append(action)
            raise ActualAccountError("GAS 操作失敗：不支援的 POST action：actualBridgeAck")
        return inner(action, payload, write=write)

    monkeypatch.setattr(ledger.sync_service, "_gas_request", request)
    monkeypatch.setattr(ledger.report_publisher, "_gas_request", request)
    try:
        ledger.sync_service.save_config("https://example.invalid/exec", "token")
        first = ledger.sync_service.poll_gas_bridge_once()
        assert first.get("changed") is True and first.get("local_revision_after") == 7, first
        assert "actualBridgeAck" in calls
        syncs = calls.count("actualRawTrades")
        second = ledger.sync_service.poll_gas_bridge_once()
        assert second["changed"] is False, "the next poll sees revision 7 as already synced"
        assert calls.count("actualRawTrades") == syncs, "no re-sync"
    finally:
        ledger.shutdown()


def test_raw_trades_and_derived_ledger_change_together(tmp_path, monkeypatch):
    # Raw rows were committed before the rebuild; a rebuild that failed left new raw rows next to the
    # previous positions, and nothing repaired it.
    from service.account.actual_account_service import ActualAccountService

    monkeypatch.setenv("STOCK_MONITOR_SQLITE_DIAGNOSTICS", "0")
    ledger = ActualAccountService(db_path=tmp_path / "actual.db", config_path=tmp_path / "config.json",
                                  security_master_path=tmp_path / "master.csv")
    try:
        import sqlite3

        def raw_ids():
            with sqlite3.connect(tmp_path / "actual.db") as conn:
                return [row[0] for row in conn.execute("SELECT trade_id FROM raw_trades ORDER BY trade_id")]

        ledger.replace_raw_trades([BUY])
        before = (raw_ids(), ledger.get_positions())

        def boom(*_args, **_kwargs):
            raise RuntimeError("rebuild failed")

        monkeypatch.setattr(ledger.repository, "replace_derived", boom)
        second = {**BUY, "trade_id": "B2", "trade_date": "2026-08-03"}
        with pytest.raises(RuntimeError):
            ledger.replace_raw_trades([BUY, second])
        assert (raw_ids(), ledger.get_positions()) == before
    finally:
        ledger.shutdown()


@pytest.mark.parametrize("content", ["{not json", "[1, 2]"])
def test_a_damaged_config_is_reported_not_treated_as_unconfigured(tmp_path, monkeypatch, content):
    # A damaged config silently became the defaults, so auto-sync stopped looking "not configured".
    from service.account.account_types import ActualAccountError
    from service.account.actual_account_service import ActualAccountService

    monkeypatch.setenv("STOCK_MONITOR_SQLITE_DIAGNOSTICS", "0")
    (tmp_path / "config.json").write_text(content, encoding="utf-8")
    ledger = ActualAccountService(db_path=tmp_path / "actual.db", config_path=tmp_path / "config.json",
                                  security_master_path=tmp_path / "master.csv")
    try:
        config = ledger.sync_service.get_config()
        assert config["gas_url"] == "" and "帳務設定檔無法讀取" in config["config_error"]
        polled = ledger.sync_service.poll_gas_bridge_once()
        assert polled["ok"] is False and "帳務設定檔無法讀取" in polled["error"]
        with pytest.raises(ActualAccountError, match="帳務設定檔無法讀取"):
            ledger.sync_service._gas_request("actualBridgeStatus")
    finally:
        ledger.shutdown()
