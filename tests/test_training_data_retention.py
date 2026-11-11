"""Training data kept apart from the raw history (user 10-22): its own retention setting, and the traded codes every
ledger publishes for Market Runtime's prune (their raw history is kept forever)."""
from __future__ import annotations

import json

from config import training_data_settings as tds
from config.config_revisions import ConfigRevisionStore
from service.account.paper_wallet_service import PaperWalletService


def test_the_training_data_is_kept_forever_and_trains_on_twenty_days_by_default():
    assert tds.DEFAULTS == {"retention_days": None, "window_trading_days": 20}
    assert tds.validate(tds.DEFAULTS) == []


def test_the_settings_are_validated_strictly(tmp_path):
    codes = lambda values: {p["code"] for p in tds.validate(values)}
    assert codes({"retention_days": 0, "window_trading_days": 20}) == {"RETENTION_DAYS"}
    assert codes({"retention_days": True, "window_trading_days": 20}) == {"RETENTION_DAYS"}
    assert codes({"window_trading_days": 20}) == {"RETENTION_DAYS"}, "forever is an explicit null, never a missing field"
    assert codes({"retention_days": None, "window_trading_days": 0}) == {"WINDOW_TRADING_DAYS"}
    assert codes({"retention_days": None, "window_trading_days": 20, "extra": 1}) == {"UNKNOWN_FIELD"}
    assert tds.training_data(tmp_path) == tds.DEFAULTS
    store = ConfigRevisionStore(tmp_path, "training_data")
    store.save({"retention_days": 250, "window_trading_days": 40}, expected_revision=None, source="test", activate=True)
    assert tds.training_data(tmp_path) == {"retention_days": 250, "window_trading_days": 40}


def test_every_ledger_publishes_the_codes_it_traded_as_partition_names(tmp_path):
    out = tmp_path / "traded_codes" / "paper.json"
    ledger = PaperWalletService(db_path=tmp_path / "paper.db", config_path=tmp_path / "config.json",
                                security_master_path=tmp_path / "m.csv", traded_codes_path=out)
    doc = json.loads(out.read_text(encoding="utf-8"))
    assert doc["schema"] == "traded-codes-v1" and doc["codes"] == {"shioaji": {"STK": []}, "futu": {"US": []}}, \
        "published at start, before any trade: Market Runtime removes nothing until every ledger has published"
    base = {"trade_date": "2026-09-01", "market": "台股", "code": "2330"}
    ledger.local_save_trade({**base, "trade_id": "B1", "action": "買進", "trade_info": "1000@100", "trade_time": "09:00"})
    assert json.loads(out.read_text(encoding="utf-8"))["codes"]["shioaji"]["STK"] == ["2330"]
    ledger.local_delete_trade("B1")
    assert json.loads(out.read_text(encoding="utf-8"))["codes"]["shioaji"]["STK"] == [], "a deleted trade is no longer kept"
    ledger.shutdown()
