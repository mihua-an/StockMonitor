from __future__ import annotations

import asyncio
import json

from fastapi import FastAPI


def request(app, path, *, query=b"", method="GET", body=None):
    sent = []

    async def receive():
        return {"type": "http.request", "body": json.dumps(body).encode() if body is not None else b"", "more_body": False}

    async def send(message):
        sent.append(message)

    asyncio.run(app({
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
        "method": method, "scheme": "http", "path": path, "raw_path": path.encode(),
        "query_string": query, "headers": [(b"content-type", b"application/json")],
        "root_path": "", "server": ("test", 80), "client": ("test", 1),
    }, receive, send))
    return sent[0]["status"], json.loads(b"".join(item.get("body", b"") for item in sent))


def test_market_route_preserves_trade_page_identity_and_errors(tmp_path, monkeypatch):
    """The trade-detail page route reads the Rust-materialized historical store directly.

    It used to proxy the Shioaji daemon (`runtime.get_json("/v1/trade-detail/page")`); M22 made
    `service/market/history/historical_store.py` the single historical read boundary, so the
    route now calls `rust_trade_page` and the daemon is not on this path at all. What must not
    regress is the identity/limit handling around that call: page_size clamped to 100, page
    floored at 1, watermark/before_sequence passed through, and a reader failure answered with
    HTTP 200 + a classified, empty-rows envelope rather than a 500.
    """
    import api.routes.market_routes as module
    calls = []
    response = {"ok": True, "rows": [{"sequence": 12}], "snapshot_watermark": 77, "session_generation": 4}

    def fake_trade_page(**kwargs):
        calls.append(kwargs)
        return response

    monkeypatch.setattr(module, "rust_trade_page", fake_trade_page)

    from service.platform.http.errors import register_error_handlers

    deps = module.MarketRouteDependencies(None, None, None, None)
    app = FastAPI()
    register_error_handlers(app)
    app.include_router(module.create_market_router(deps))
    status, body = request(app, "/api/trade-detail/page", query=b"market=STK&logical_code=2330&trading_date=2026-10-16&session=DAY&page=0&page_size=500&snapshot_watermark=77&before_sequence=12")
    assert status == 200 and body == response
    assert calls[0]["market"] == "STK" and calls[0]["code"] == "2330"
    assert calls[0]["page_size"] == 100          # clamped: the caller asked for 500
    assert calls[0]["page"] == 1                 # floored: the caller asked for 0
    assert calls[0]["snapshot_watermark"] == 77
    assert calls[0]["before_sequence"] == 12
    assert calls[0]["metadata_only"] is False
    assert calls[0]["trading_date"] == "2026-10-16" and calls[0]["session"] == "DAY"
    # A stock request naming no day is refused: the caller names the day its view shows (Market Runtime's session).
    status, body = request(app, "/api/trade-detail/page", query=b"market=STK&logical_code=2330")
    assert status == 400 and body["classification"] == "TRADING_DATE_REQUIRED"
    assert len(calls) == 1

    def unavailable(**kwargs):
        raise RuntimeError("historical store unavailable")

    monkeypatch.setattr(module, "rust_trade_page", unavailable)
    status, body = request(app, "/api/trade-detail/page", query=b"market=STK&logical_code=2330&trading_date=2026-10-16&session=DAY")
    assert status == 200 and body["ok"] is False
    assert body["classification"] == "RUST_DURABLE_PROJECTION_UNAVAILABLE"
    assert body["rows"] == []


def test_moomoo_reconnect_route_is_the_manual_retry_the_attach_loop_gives_up_to(monkeypatch):
    # MoomooDaemonClient.attach_in_background stops on its own after a single
    # OPEND_NOT_RUNNING classification instead of polling forever (see
    # service/market/futu/daemon_client.py) -- this route is the only way
    # left to try again, and it must only restore watchlist subscriptions
    # when the manual attempt actually succeeds.
    import api.routes.market_routes as module

    class FakeFutuClient:
        def __init__(self, result):
            self.result = result
            self.starts = 0

        # The route's manual retry is the client's recorded attach (client.futu_daemon_attach).
        def manual_reattach(self):
            self.starts += 1
            return self.result

    client = FakeFutuClient({"ok": True, "attached": True})
    restored = []
    deps = module.MarketRouteDependencies(
        None, client, None, None,
        on_moomoo_attached=lambda: restored.append(True),
    )
    app = FastAPI()
    app.include_router(module.create_market_router(deps))

    status, body = request(app, "/api/futu-daemon/reconnect", method="POST")
    assert status == 200
    assert body["ok"] is True
    assert client.starts == 1
    assert restored == [True]

    client.result = {"ok": False, "classification": "OPEND_NOT_RUNNING", "error": "OpenD not running"}
    status, body = request(app, "/api/futu-daemon/reconnect", method="POST")
    assert status == 200
    assert body["ok"] is False
    assert client.starts == 2
    assert restored == [True]  # unchanged: a failed manual attempt must not restore


def test_every_market_route_handler_defined_is_actually_reachable():
    """A handler nobody registered is a feature that silently 404s.

    ``get_txf_trend`` was once constructed but left out of the router's route table, so its path
    answered 404 (the route itself is gone: Market Runtime carries the TXF
    reference). The same omission can happen to any handler, so this pins the general rule that
    every route-shaped handler in the factory body is exposed.
    """
    import ast
    import importlib
    import inspect
    import textwrap

    module = importlib.import_module("api.routes.market_routes")
    deps = module.MarketRouteDependencies(None, None, None, None)
    paths = {getattr(route, "path", "") for route in module.create_market_router(deps).routes}
    assert "/api/monitor/events" in paths

    factory = ast.parse(textwrap.dedent(inspect.getsource(module.create_market_router))).body[0]
    defined = {
        node.name for node in factory.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }
    registered = {
        element.elts[2].id
        for node in ast.walk(factory)
        if isinstance(node, ast.Assign)
        and any(getattr(target, "id", "") == "routes" for target in node.targets)
        for element in getattr(node.value, "elts", [])
        if isinstance(element, ast.Tuple) and len(element.elts) == 3
        and isinstance(element.elts[2], ast.Name)
    }
    assert registered, "the route table could not be read; this test would otherwise pass vacuously"
    # Only route-shaped names are checked: the factory body also holds private helpers.
    prefixes = ("get_", "post_", "put_", "replace_", "retry_", "reconnect_", "sync_", "repair_",
                "set_", "clear_")
    # No exemptions: the unregistered search-focus trio was removed; the daemon's own
    # /v1/subscriptions/search-focus route is the one that is used.
    unreachable = sorted(name for name in defined if name.startswith(prefixes) and name not in registered)
    assert not unreachable, f"route handlers defined but never registered: {unreachable}"
