"""Market Runtime pushes the session on every viewer connection; a request/response reader on a viewer
connection reads past it. realtime_api's Market Runtime health check once took that frame for its reply and
failed every 5 s."""
from __future__ import annotations

import json

from service.market.shared import rust_view_client
from service.market.shared.rust_view_client import RustViewClient


class Socket:
    def __init__(self, replies):
        self.replies = [json.dumps(r) for r in replies]
        self.sent = []

    def send(self, raw):
        self.sent.append(json.loads(raw))

    def recv(self, timeout=None):
        return self.replies.pop(0)

    def close(self):
        pass


def _client(socket, monkeypatch):
    client = RustViewClient(url="ws://127.0.0.1:1/live", token="t")
    monkeypatch.setattr(client, "_connection", lambda timeout: socket)
    return client


def test_health_and_snapshot_read_past_the_pushed_session(monkeypatch):
    pushed = {"type": "session.current", "payload": {"equity": {"trading_date": "2026-10-12"}}}
    health = _client(Socket([pushed, {"type": "health", "payload": {"ok": True, "instance": "a"}}]), monkeypatch).health()
    assert health == {"ok": True, "instance": "a"}
    snapshot = _client(Socket([pushed, {"type": "view.snapshot", "payload": {"summary": {}}}]), monkeypatch).get_snapshot(market="STK", code="2330")
    assert snapshot == {"summary": {}}
    assert rust_view_client._MAX_SKIPPED_FRAMES > 1
