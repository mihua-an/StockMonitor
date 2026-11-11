"""模擬下單 routes (api/routes/paper_order_routes.py) over a real 委託台 and paper ledger: a refused order is 422 with
the reason, an accepted one is listed, cancel / reduce / replace / cancel-all / delete reach the desk, the funds view
carries the reservation, and paper_account_api mounts the routes ahead of the ledger's."""
from __future__ import annotations

import json
from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import FastAPI

from tests.asgi_client import AsgiClient

from api.routes.paper_order_routes import create_paper_order_router
from service.account.paper_orders import PaperOrderDesk
from service.account.paper_wallet_service import PaperWalletService
from service.platform.http.errors import register_error_handlers

TPE = ZoneInfo("Asia/Taipei")


def _client(tmp_path):
    now = datetime(2026, 10, 16, 10, 0, tzinfo=TPE)
    ledger = PaperWalletService(db_path=tmp_path / "p.db", config_path=tmp_path / "c.json", security_master_path=tmp_path / "m.csv")
    desk = PaperOrderDesk(ledger, tmp_path / "matching", now=lambda: now, clock_ns=lambda: int(now.timestamp() * 1e9))
    app = FastAPI()
    register_error_handlers(app)
    app.include_router(create_paper_order_router(desk))
    return AsgiClient(app), desk


def test_orders_over_http(tmp_path):
    client, desk = _client(tmp_path)
    with client:
        _exercise(client, desk)


def _exercise(client, desk):
    bad = client.post("/api/paper-wallet/orders", json={"code": "2330", "side": "買進", "price": "100.3", "qty": 1000})
    assert bad.status_code == 422 and "升降單位" in bad.json()["error"]
    placed = client.post("/api/paper-wallet/orders", json={"code": "2330", "side": "買進", "price": 100, "qty": 2000})
    assert placed.status_code == 200, placed.text
    oid = placed.json()["order"]["order_id"]
    listed = client.get("/api/paper-wallet/orders").json()
    assert [o["order_id"] for o in listed["orders"]] == [oid] and listed["trading_date"] == "2026-10-16"
    assert client.post(f"/api/paper-wallet/orders/{oid}/reduce", json={"qty": 1000}).status_code == 200
    assert client.post(f"/api/paper-wallet/orders/{oid}/replace", json={"price": "99.5"}).status_code == 200
    assert client.post("/api/paper-wallet/orders/nope/cancel").status_code == 404
    history = client.get("/api/paper-wallet/orders/history?start=2026-10-16&end=2026-10-16").json()
    assert oid in [o["order_id"] for o in history["orders"]] and history["orders"][-1]["steps"][0]["text"].startswith("委託 2 張")
    funds = client.get("/api/paper-wallet/orders/funds").json()["capital"]
    assert funds["reserved_limit"] > 0
    assert client.post("/api/paper-wallet/orders/cancel-all").json()["ok"] is True
    assert client.post(f"/api/paper-wallet/orders/{oid}/delete").status_code == 422, "not finished yet"
    commands = [json.loads(line) for line in (desk.root / "orders.jsonl").read_text(encoding="utf-8").splitlines()]
    # 改價 is on the same order (its number kept): cancel-all cancels that order.
    assert [(c["type"], c["order_id"]) for c in commands] == [("new", oid), ("reduce", oid), ("replace", oid), ("cancel", oid)]


def test_paper_account_api_mounts_the_order_routes():
    """paper_account_api mounts its order desk's router and its ledger's, before any component is built."""
    from pathlib import Path
    from types import SimpleNamespace

    from fastapi import FastAPI

    from api.services.paper_account_api import Resources

    resources = object.__new__(Resources)
    resources.host = SimpleNamespace(stream_closers=[])
    resources.components = SimpleNamespace(lazy=lambda *_a, **_k: object(), built_component=lambda _name: False)
    app = FastAPI()
    resources.bind(app)
    paths = {getattr(route, "path", "") for route in app.routes}
    paths |= {getattr(route, "path", "") for r in app.routes for route in getattr(getattr(r, "original_router", None), "routes", [])}
    assert any(path.startswith("/api/paper-wallet/orders") for path in paths), paths
    assert "/api/paper-wallet/status" in paths and "/api/paper-wallet/positions" in paths
    assert not any(path.startswith("/api/actual-account") for path in paths), "the actual ledger is actual_account_api's"
    source = Path("api/services/paper_account_api.py").read_text(encoding="utf-8")
    assert "desk.start()" in source, "the desk follows the matching with no screen open"
