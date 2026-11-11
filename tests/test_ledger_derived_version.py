"""The derived ledger tables carry their version; a ledger of another version is rebuilt once at start,
and analytics read only a current materialization -- a stale one is reported unavailable, never patched from
realized_matches."""
from __future__ import annotations

import json
from pathlib import Path


def _ledger(tmp_path):
    from service.account.actual_account_service import ActualAccountService

    return ActualAccountService(db_path=tmp_path / "actual.db", config_path=tmp_path / "config.json",
                                security_master_path=tmp_path / "master.csv")


def test_an_older_derived_version_is_rebuilt_once_and_stale_analytics_are_unavailable(tmp_path, monkeypatch):
    from service.account import account_ledger_service as als

    monkeypatch.setenv("STOCK_MONITOR_SQLITE_DIAGNOSTICS", "0")
    golden = json.loads((Path(__file__).parent / "fixtures/accounting_golden.json").read_text(encoding="utf-8"))
    ledger = _ledger(tmp_path)
    try:
        ledger.replace_raw_trades(golden["trades"])
        assert ledger.ledger_state()["state"] == "CURRENT"
        assert ledger.get_analytics()["台股"]["stock_stats"], "a current ledger has per-stock figures"
        # An older build: the version is gone. Analytics say so instead of patching.
        ledger._set_meta(als.DERIVED_VERSION_KEY, "1")
        assert ledger.ledger_state()["state"] == "REBUILD_PENDING"
        analytics = ledger.get_analytics()
        assert analytics["ledger_state"]["state"] == "REBUILD_PENDING" and analytics["台股"]["stock_stats"] == []
        # Nothing at all is computed from it -- home, daily, pair days and the pairs read on demand are unavailable too.
        market = analytics["台股"]
        assert market["available"] is False and market["home"] is None and market["pair_days"] == [] and market["daily_stats"] == []
        pairs = ledger.get_pairs("台股", "2330")
        assert pairs["ok"] and pairs["available"] is False and pairs["items"] == []
        assert pairs["ledger_state"]["state"] == "REBUILD_PENDING" and pairs["ledger_state"]["reason"]
        daytrade = ledger.get_daytrade_analysis("台股")
        assert daytrade["available"] is False and "pairs" not in daytrade and daytrade["ledger_state"]["state"] == "REBUILD_PENDING"
    finally:
        assert ledger.shutdown()["ok"]
    # The next start rebuilds it once, and it is current again.
    reopened = _ledger(tmp_path)
    try:
        assert reopened.ledger_state()["state"] == "CURRENT"
        assert reopened.get_analytics()["台股"]["stock_stats"]
    finally:
        assert reopened.shutdown()["ok"]
