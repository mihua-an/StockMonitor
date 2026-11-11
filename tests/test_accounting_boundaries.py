from __future__ import annotations

import subprocess
import sys
from decimal import Decimal
from pathlib import Path

from service.account.accounting_core import AccountingCore
from service.account.account_types import Leg
from service.account.paper_wallet_service import PaperWalletService


def test_accounting_core_preserves_known_tw_daytrade_costs():
    core = AccountingCore()
    assert core.fee_for_order("台股", Decimal("100000")) == Decimal("40")
    assert core.fee_for_order("台股", Decimal("110000")) == Decimal("44")
    sell = Leg("S1", "2026-09-01", "台股", "賣出", "2330", "10:00", 2,
               "當沖", Decimal("1000"), Decimal("110000"), Decimal("44"),
               Decimal("0"), Decimal("110"))
    assert core.tax_for_leg(sell) == Decimal("165")


def test_paper_wallet_uses_local_input_and_same_fifo_result(tmp_path: Path):
    service = PaperWalletService(
        db_path=tmp_path / "paper.db",
        config_path=tmp_path / "must-not-be-created.json",
        security_master_path=tmp_path / "master.csv",
    )
    base = {"trade_date": "2026-09-01", "market": "台股", "code": "2330"}
    service.local_save_trade({**base, "trade_id": "B1", "action": "買進",
                              "trade_info": "1000@100", "trade_time": "09:00"})
    service.local_save_trade({**base, "trade_id": "S1", "action": "賣出",
                              "trade_info": "1000@110", "trade_time": "10:00"})
    try:
        realized = service.get_realized()
        assert len(realized) == 1
        assert realized[0]["buy_fee"] == 40
        assert realized[0]["sell_fee"] == 44
        assert realized[0]["tax"] == 165
        assert realized[0]["profit"] == 9751
        assert service.get_positions() == []
        assert not (tmp_path / "must-not-be-created.json").exists()
    finally:
        service.shutdown()


def test_a_sell_first_is_held_as_a_short_until_bought_back(tmp_path: Path):
    service = PaperWalletService(db_path=tmp_path / "paper.db", config_path=tmp_path / "config.json",
                                 security_master_path=tmp_path / "master.csv")
    base = {"market": "台股", "code": "4958"}
    try:
        service.local_save_trade({**base, "trade_id": "S1", "trade_date": "2026-11-02", "action": "賣出",
                                  "trade_info": "1000@491.5", "trade_time": "10:49:04"})
        [position] = service.get_positions()
        assert position["qty"] == -1000
        # What the sell brought in: 價金 less its fee and 一般 tax (0.3%, floored); avg is that per share, so
        # (price - avg) * qty is the P&L.
        proceeds = Decimal("491500") - service.accounting_core.fee_for_order("台股", Decimal("491500")) - 1474
        assert position["cost_amount"] == proceeds
        assert Decimal(str(position["avg_cost"])) == proceeds / 1000
        assert service.get_errors() == []
        service.local_save_trade({**base, "trade_id": "B1", "trade_date": "2026-11-03", "action": "買進",
                                  "trade_info": "1000@480", "trade_time": "09:30:00"})
        assert service.get_positions() == []
        [match] = service.get_realized()
        assert (match["trade_type"], match["direction"], match["qty"]) == ("一般", "空", 1000)
        assert match["sell_ref"] == "2026-11-02" and match["buy_ref"] == "2026-11-03"
    finally:
        service.shutdown()


def test_paper_wallet_import_has_no_requests_dependency(tmp_path: Path):
    root = Path(__file__).resolve().parents[1]
    code = "import sys; from service.account.paper_wallet_service import PaperWalletService; assert 'requests' not in sys.modules"
    result = subprocess.run([sys.executable, "-c", code], cwd=tmp_path,
                            env={"PYTHONPATH": str(root)}, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr


def test_actual_and_paper_match_pre_refactor_transaction_golden(tmp_path, monkeypatch):
    import json
    from service.account.actual_account_service import ActualAccountService
    monkeypatch.setenv("STOCK_MONITOR_SQLITE_DIAGNOSTICS", "0")
    golden = json.loads((Path(__file__).parent / "fixtures/accounting_golden.json").read_text(encoding="utf-8"))
    for cls in (ActualAccountService, PaperWalletService):
        ledger = cls(db_path=tmp_path / f"{cls.__name__}.db",
                     config_path=tmp_path / "config.json", security_master_path=tmp_path / "master.csv")
        try:
            ledger.replace_raw_trades(golden["trades"])
            assert ledger.get_positions() == golden["positions"]
            assert ledger.get_realized() == golden["realized"]
            ledger.rebuild()
            assert ledger.get_positions() == golden["positions"]
            assert [{k:v for k,v in row.items() if k != "id"} for row in ledger.get_realized()] == [{k:v for k,v in row.items() if k != "id"} for row in golden["realized"]]
            if cls is PaperWalletService:
                assert not hasattr(ledger, "sync_service")
                assert not hasattr(ledger, "report_publisher")
        finally:
            assert ledger.shutdown()["ok"]


def test_actual_sync_revision_race_and_mobile_publication(tmp_path, monkeypatch):
    import json
    from service.account.actual_account_service import ActualAccountService
    monkeypatch.setenv("STOCK_MONITOR_SQLITE_DIAGNOSTICS", "0")
    ledger = ActualAccountService(db_path=tmp_path / "actual.db", config_path=tmp_path / "config.json",
                                 security_master_path=tmp_path / "master.csv")
    golden = json.loads((Path(__file__).parent / "fixtures/accounting_golden.json").read_text(encoding="utf-8"))
    revisions = iter([3, 4, 4, 4])
    calls = []
    def request(action, payload=None, *, write=False):
        calls.append((action, payload))
        if action == "actualBridgeStatus": return {"raw_revision": next(revisions)}
        if action == "actualRawTrades": return {"items": golden["trades"], "next_offset": None, "raw_revision": 1}
        return {"ok": True}
    monkeypatch.setattr(ledger.sync_service, "_gas_request", request)
    monkeypatch.setattr(ledger.report_publisher, "_gas_request", request)
    try:
        first = ledger.sync_service.sync_from_gas()
        assert first["bridge"]["pending"]
        assert not any(action == "actualBridgeAck" for action, _ in calls)
        second = ledger.sync_service.sync()
        assert second["bridge"]["acknowledged"]
        assert [payload["revision"] for action, payload in calls if action == "actualBridgeAck"] == [4]
        assert [{k:v for k,v in row.items() if k != "id"} for row in ledger.get_realized()] == [{k:v for k,v in row.items() if k != "id"} for row in golden["realized"]]
        assert ledger.report_publisher.schedule_mobile_publish("test")["scheduled"]
        assert ledger.report_publisher.get_mobile_publish_status()["scheduled"]
        assert ledger.report_publisher.publish_now()["ok"]
        assert not ledger.report_publisher.get_mobile_publish_status()["scheduled"]
        payload = next(payload for action, payload in calls if action == "mobilePublish")
        assert {"summary", "holdings", "rank:spot:profit", "realizedReport:day", "dayTradeEntryTime:week"} <= set(payload["entries"])
        # The desktop's 手機卡片 view: the same package, computed locally, nothing sent to GAS.
        sent = len(calls)
        preview = ledger.report_publisher.preview_mobile_data()
        assert len(calls) == sent
        assert preview["ok"] and preview["entries"] == payload["entries"]
        assert preview["last_publish_at"] == payload["published_at"]
        # 帳務頁讀 /status：上傳時間要和設定頁讀的是同一份紀錄。
        assert ledger.get_status()["last_publish_at"] == payload["published_at"]
    finally:
        ledger.shutdown()


def test_default_paper_wallet_never_opens_actual_database(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    paper_root = tmp_path / "data/accounts/paper"
    ledger = PaperWalletService(
        db_path=paper_root / "paper_wallet.db",
        config_path=paper_root / "paper_wallet_config.json",
    )
    try:
        assert ledger.db_path == paper_root / "paper_wallet.db"
        assert not Path("data/actual_account.db").exists()
        assert not Path("data/actual_account_config.json").exists()
        assert not Path("data/accounts/paper/paper_wallet_config.json").exists()
    finally:
        ledger.shutdown()


def _legs(tmp_path, market, trades):
    service = PaperWalletService(db_path=tmp_path / "paper.db", config_path=tmp_path / "unused.json",
                                 security_master_path=tmp_path / "master.csv")
    rows = [{"trade_id": tid, "trade_date": "2026-09-01", "market": market, "action": action, "code": "2330",
             "trade_info": info, "trade_time": time, "source_order": n}
            for n, (tid, action, info, time) in enumerate(trades)]
    orders, errors = service._build_orders(rows)
    assert errors == []
    return [(leg.trade_id, leg.trade_type, leg.qty) for leg in service._split_orders_to_legs(orders)]


def test_tw_day_trading_is_board_lots_only_and_us_never_day_trades(tmp_path):
    # User rule: a TW odd-lot order is 1-999 shares in one order, so an order of
    # 1000 or more is a board lot, and only board lots can be day-traded. US stocks have no day-trade class.
    # Summing quantities across orders would wrongly make odd lots day-tradable.
    board = _legs(tmp_path / "a", "台股", [("B1", "買進", "1000@100", "09:00"), ("S1", "賣出", "1000@101", "10:00")])
    assert {(tid, kind) for tid, kind, _ in board} == {("B1", "當沖"), ("S1", "當沖")}
    odd = _legs(tmp_path / "b", "台股", [("B1", "買進", "500@100", "09:00"), ("B2", "買進", "500@100", "09:05"),
                                        ("S1", "賣出", "1000@101", "10:00")])
    assert all(kind != "當沖" for _, kind, _ in odd), odd
    us = _legs(tmp_path / "c", "美股", [("B1", "買進", "1000@100", "09:30"), ("S1", "賣出", "1000@101", "10:00")])
    assert all(kind != "當沖" for _, kind, _ in us), us
