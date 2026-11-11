"""模擬庫存 product pages: the paper wallet has the same positions routes as the actual ledger, and its holdings stay
subscribed through their own background owner."""
from __future__ import annotations

import socket
import threading
import time

import pytest
import requests

BUY = {"trade_id": "P1", "trade_date": "2026-08-01", "market": "台股", "action": "買進", "code": "2603",
       "trade_info": "1000@100", "trade_time": "09:00"}


def _ledger(tmp_path, monkeypatch, name, cls):
    monkeypatch.setenv("STOCK_MONITOR_SQLITE_DIAGNOSTICS", "0")
    return cls(db_path=tmp_path / f"{name}.db", config_path=tmp_path / f"{name}.json",
               security_master_path=tmp_path / "master.csv")


@pytest.fixture
def served(tmp_path, monkeypatch):
    import uvicorn
    from fastapi import FastAPI

    from api.routes.account_routes import create_actual_account_router, create_paper_wallet_router
    from service.account.actual_account_service import ActualAccountService
    from service.account.paper_wallet_service import PaperWalletService

    actual = _ledger(tmp_path, monkeypatch, "actual", ActualAccountService)
    paper = _ledger(tmp_path, monkeypatch, "paper", PaperWalletService)
    app = FastAPI()
    app.include_router(create_actual_account_router(actual, object(), actual.sync_service, actual.report_publisher))
    app.include_router(create_paper_wallet_router(paper))
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.02)
    try:
        yield actual, paper, f"http://127.0.0.1:{port}"
    finally:
        actual.positions_feed.close()
        paper.positions_feed.close()
        server.should_exit = True
        thread.join(10)
        actual.shutdown()
        paper.shutdown()


def test_paper_positions_are_the_paper_ledgers_own(served):
    actual, paper, base = served
    paper.replace_raw_trades([BUY])
    got = requests.get(f"{base}/api/paper-wallet/positions", timeout=10).json()
    assert got["ok"] is True and got["revision"] == 1 and [p["code"] for p in got["positions"]] == ["2603"]
    assert requests.get(f"{base}/api/actual-account/positions", timeout=10).json()["positions"] == []


def test_paper_positions_stream_sends_the_revision_then_each_change(served):
    _actual, paper, base = served
    with requests.get(f"{base}/api/paper-wallet/positions/events", stream=True, timeout=10) as response:
        assert response.headers["content-type"].startswith("text/event-stream")
        lines = (line for line in response.iter_lines(decode_unicode=True) if line.startswith("data: "))
        assert next(lines) == 'data: {"revision": 0}'
        paper.replace_raw_trades([BUY])
        assert '"revision": 1' in next(lines)
        paper.positions_feed.close()
        assert list(lines) == []


def test_paper_holdings_have_their_own_background_owner(tmp_path):
    from service.market.reference import background_demand

    assert "paper_holdings" in background_demand.OWNERS
    items = background_demand.merge([], "holdings", background_demand.holdings_items([{"market": "台股", "code": "2330"}]))
    items = background_demand.merge(items, "paper_holdings",
                                    background_demand.holdings_items([{"market": "台股", "code": "2330"}, {"market": "美股", "code": "NVDA"}]))
    by_code = {item["code"]: item["owners"] for item in items}
    assert by_code == {"2330": ["holdings", "paper_holdings"], "US.NVDA": ["paper_holdings"]}
    # Selling everything in the paper wallet lets go of its claim only.
    items = background_demand.merge(items, "paper_holdings", [])
    assert [(item["code"], item["owners"]) for item in items] == [("2330", ["holdings"])]


def test_settings_api_follows_both_ledgers():
    source = open("api/services/settings_api.py", encoding="utf-8").read()
    assert 'follow_holdings("actual_account", "holdings"' in source
    assert 'follow_holdings("paper_wallet", "paper_holdings"' in source
