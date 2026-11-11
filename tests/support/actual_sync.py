"""An actual-account ledger whose GAS calls answer from a given raw-trade list, a buy and a sell beyond it (a short,
先賣), and an ActualAccountSync over an in-memory credential store."""
from __future__ import annotations

import threading
from types import SimpleNamespace

from service.account.actual_account_sync import ActualAccountSync


class FakeCredentials:
    def __init__(self):
        self.values = {}

    def set_password(self, service, entry, token):
        self.values[service, entry] = token

    def get_password(self, service, entry):
        return self.values.get((service, entry))

    def delete_password(self, service, entry):
        del self.values[service, entry]


def make_sync(tmp_path):
    ledger = SimpleNamespace(config_path=tmp_path / 'config.json',
                             _update_config_runtime_status=lambda value: None,
                             _shutdown_event=threading.Event(), remote_integrations_enabled=True)
    return ActualAccountSync(ledger, credential_backend=FakeCredentials())


def actual_service(tmp_path, monkeypatch, *, items):
    from service.account.actual_account_service import ActualAccountService

    monkeypatch.setenv("STOCK_MONITOR_SQLITE_DIAGNOSTICS", "0")
    ledger = ActualAccountService(db_path=tmp_path / "actual.db", config_path=tmp_path / "config.json",
                                  security_master_path=tmp_path / "master.csv")
    calls = []

    def request(action, payload=None, *, write=False):
        calls.append(action)
        if action == "actualBridgeStatus":
            return {"raw_revision": 7}
        if action == "actualRawTrades":
            return {"items": items, "next_offset": None, "raw_revision": 1}  # one page
        return {"ok": True}

    monkeypatch.setattr(ledger.sync_service, "_gas_request", request)
    monkeypatch.setattr(ledger.report_publisher, "_gas_request", request)
    return ledger, calls


BUY = {"trade_id": "B1", "trade_date": "2026-08-01", "market": "台股", "action": "買進", "code": "2330",
       "trade_info": "1000@100", "trade_time": "09:00"}
OVERSELL = {"trade_id": "S1", "trade_date": "2026-08-02", "market": "台股", "action": "賣出", "code": "2330",
            "trade_info": "2000@110", "trade_time": "10:00"}
