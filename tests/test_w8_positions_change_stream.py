"""A positions change in the ledger reaches the live-holdings screens as a pushed event.

The old `positions_changed_publisher` was an empty function and the screen's `actual-positions-changed` listener had
no sender. Now every ledger rebuild that changes the positions publishes to `positions_feed`, and app_api streams it
(Server-Sent Events) on /api/actual-account/positions/events: the revision at connect, then one event per change.
"""
from __future__ import annotations

import asyncio
import json
import socket
import threading
import time

import pytest
import requests

BUY = {"trade_id": "B1", "trade_date": "2026-08-01", "market": "台股", "action": "買進", "code": "2330",
       "trade_info": "1000@100", "trade_time": "09:00"}


def _ledger(tmp_path, monkeypatch):
    from service.account.actual_account_service import ActualAccountService

    monkeypatch.setenv("STOCK_MONITOR_SQLITE_DIAGNOSTICS", "0")
    return ActualAccountService(db_path=tmp_path / "actual.db", config_path=tmp_path / "config.json",
                                security_master_path=tmp_path / "master.csv")


def test_the_empty_publisher_is_gone():
    import inspect

    from service.account.account_ledger_service import AccountLedgerService

    assert "positions_changed_publisher" not in inspect.signature(AccountLedgerService.__init__).parameters
    source = open("api/components.py", encoding="utf-8").read()
    assert "positions_changed_publisher" not in source


def test_a_rebuild_publishes_only_when_the_positions_change(tmp_path, monkeypatch):
    ledger = _ledger(tmp_path, monkeypatch)
    try:
        seen = []
        monkeypatch.setattr(ledger.positions_feed, "publish", seen.append)
        ledger.replace_raw_trades([BUY])
        assert [item["revision"] for item in seen] == [1] and seen[0]["count"] == 1
        ledger.rebuild()  # same raw trades: same positions, nothing to tell the screens
        assert len(seen) == 1
    finally:
        ledger.shutdown()


def test_the_feed_delivers_across_threads_and_close_ends_every_subscriber():
    from service.platform.change_feed import ChangeFeed

    async def scenario():
        feed = ChangeFeed()
        queue = feed.subscribe()
        threading.Thread(target=feed.publish, args=({"revision": 3},)).start()
        first = await asyncio.wait_for(queue.get(), 2)
        feed.close()
        closed = await asyncio.wait_for(queue.get(), 2)
        late = feed.subscribe()  # a stream opened after close ends at once
        return first, closed, await asyncio.wait_for(late.get(), 2), feed.subscriber_count()

    assert asyncio.run(scenario()) == ({"revision": 3}, None, None, 0)


def test_drain_closes_the_streams_before_waiting_for_inflight_requests():
    from api.service_host import ServiceHost

    host = ServiceHost("app_api", port=None, config_revision=None)
    closed = []
    host.stream_closers.append(lambda: closed.append(True))

    async def drain():
        host.requests.begin("stream")  # an open stream is an in-flight request ...

        def end_when_closed():
            while not closed:
                time.sleep(0.01)
            host.requests.end("stream", 200, 1.0)  # ... that finishes once its stream is closed

        threading.Thread(target=end_when_closed).start()
        return await host.drain(timeout_s=2.0)

    receipt = asyncio.run(drain())
    assert closed == [True] and receipt["ok"] is True and receipt["inflight"] == 0


@pytest.fixture
def served_ledger(tmp_path, monkeypatch):
    import uvicorn
    from fastapi import FastAPI

    from api.routes.account_routes import create_actual_account_router, create_paper_wallet_router

    ledger = _ledger(tmp_path, monkeypatch)
    app = FastAPI()
    app.include_router(create_actual_account_router(ledger, object(), ledger.sync_service, ledger.report_publisher))
    app.include_router(create_paper_wallet_router(ledger))
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
        yield ledger, f"http://127.0.0.1:{port}"
    finally:
        ledger.positions_feed.close()
        server.should_exit = True
        thread.join(10)
        ledger.shutdown()


def _events(response):
    name = None
    for raw in response.iter_lines(decode_unicode=True):
        if raw.startswith("event: "):
            name = raw[len("event: "):]
        elif raw.startswith("data: "):
            yield name, json.loads(raw[len("data: "):])


def test_the_stream_sends_the_revision_then_each_change_and_ends_on_close(served_ledger):
    ledger, base = served_ledger
    with requests.get(f"{base}/api/actual-account/positions/events", stream=True, timeout=10) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        events = _events(response)
        assert next(events) == ("positions.changed", {"revision": 0})
        ledger.replace_raw_trades([BUY])  # a new trade (same path as a GAS sync)
        name, payload = next(events)
        assert name == "positions.changed" and payload["revision"] == 1 and payload["count"] == 1
        reread = requests.get(f"{base}/api/actual-account/positions", timeout=10).json()
        assert reread["revision"] == 1 and [p["code"] for p in reread["positions"]] == ["2330"]
        ledger.positions_feed.close()  # the service drains: the stream ends instead of holding the drain
        assert list(events) == []


def test_a_failed_derived_recompute_is_a_visible_retried_state(tmp_path, monkeypatch):
    """A derived recompute (its version changed) failed with one log line; nothing said the ledger still held the
    old shape and nothing tried again."""
    from service.account import account_ledger_service as module
    from service.account.account_repository import AccountRepository

    original_init = AccountRepository.initialize

    def with_trades(self):
        meta, counts = original_init(self)
        return meta, {**counts, "raw_trades": 1}

    monkeypatch.setattr(AccountRepository, "initialize", with_trades)
    original_rebuild = module.AccountLedgerService.rebuild
    monkeypatch.setattr(module.AccountLedgerService, "rebuild", lambda self, **_k: (_ for _ in ()).throw(OSError("db locked")))
    status = _ledger(tmp_path, monkeypatch).get_status()
    assert status["derived_state"] == "DEGRADED" and "db locked" in status["derived_error"]

    # The next start retries -- the version still differs -- and a success clears it.
    monkeypatch.setattr(AccountRepository, "initialize", original_init)
    monkeypatch.setattr(module.AccountLedgerService, "rebuild", original_rebuild)
    status = _ledger(tmp_path, monkeypatch).get_status()
    assert status["derived_state"] == "OK" and status["derived_error"] is None


def test_api_shutdown_drains_and_checkpoints_the_account_ledger(tmp_path, monkeypatch):
    """prepare_shutdown looked for a close() the service never had."""
    from types import SimpleNamespace

    from api.services.actual_account_api import Resources

    ledger = _ledger(tmp_path, monkeypatch)
    api = object.__new__(Resources)
    built = {"actual_account": ledger}
    api.components = SimpleNamespace(peek=built.get)
    receipt = api.prepare_shutdown()["actual_account"]
    assert receipt["ok"] is True and "checkpoint" in receipt, receipt
