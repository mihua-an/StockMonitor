"""An idle provider keeps its ingest connection alive while Rust A pushes WAL watermarks it does not need.

Rust A pushes the committed watermark to every subscribed provider connection whenever it moves, whatever moved it
(another provider's events too). A sink holding nothing must still read those pushes: websockets stops reading the
socket once 16 unread frames are buffered, the pong behind them is never seen, and the connection dies with 1011
keepalive ping timeout -- what the Shioaji provider hit in its quiet pre- and post-market hours.
"""
from __future__ import annotations

import json
import threading
import time

import websockets.sync.client
from websockets.sync.server import serve

from service.market.shared.rust_live import RustDaemonEventSink, RustLiveEvent

PUSHES = 64
SUBSCRIBED = threading.Event()


def _event() -> RustLiveEvent:
    return RustLiveEvent(
        source="shioaji", market="STK", code="2330",
        generation=1, sequence=1, event_type="trade", exchange_ts_ns=1_000, arrival_ns=2_000,
        data={"price": 1_000_000, "volume": 1, "total_volume": 1, "side": 1, "trade_id": "1"},
    )


def _peer(connection):
    """Fake Rust A: after the subscribe, the watermark moves PUSHES times (other providers' events); a batch is
    accepted and on disk at once."""
    try:
        for raw in connection:
            message = json.loads(raw)
            if message.get("type") == "event.durable.subscribe":
                SUBSCRIBED.set()
                for committed in range(PUSHES):
                    connection.send(json.dumps({"type": "event.durable", "payload": {
                        "committed": committed, "instance_id": "mr-1", "wal_failed": None}}))
            elif message.get("type") == "ingest.hello":
                connection.send(json.dumps({"type": "ingest.hello.ack", "payload": {"restarted": []}}))
            elif message.get("type") == "event.ingest.batch":
                events = message["payload"]["events"]
                connection.send(json.dumps({"type": "event.ack.batch", "payload": {"instance_id": "mr-1", "results": [
                    {"accepted": True, "durable_sequence": PUSHES + 1, "storage": "wal"} for _ in events]}}))
                connection.send(json.dumps({"type": "event.durable", "payload": {
                    "committed": PUSHES + 1, "instance_id": "mr-1", "wal_failed": None}}))
    except Exception:  # not an error: the client went away; the test reads the sink's own counters
        pass


def test_an_idle_sink_reads_watermark_pushes_and_answers_keepalive(monkeypatch):
    real_connect = websockets.sync.client.connect

    def connect(url, **kw):
        # The same keepalive, scaled down: a ping every 0.2 s, closed when its pong is not seen in 0.3 s.
        return real_connect(url, **{**kw, "ping_interval": 0.2, "ping_timeout": 0.3})

    monkeypatch.setattr("websockets.sync.client.connect", connect)
    with serve(_peer, "127.0.0.1", 0, ping_interval=None) as server:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        port = server.socket.getsockname()[1]
        sink = RustDaemonEventSink(source="shioaji", url=f"ws://127.0.0.1:{port}/live", token="t", capacity=64, ack_timeout=1.0)
        thread = threading.Thread(target=sink._run, daemon=True)
        thread.start()
        try:
            time.sleep(2.0)  # ten keepalive pings with nothing queued to send
            assert sink.publish(_event())
            deadline = time.time() + 3
            while time.time() < deadline and sink.stats()["acked"] + sink.stats()["transport_errors"] == 0:
                time.sleep(0.01)
            stats = sink.stats()
        finally:
            sink._stop.set()
            thread.join(timeout=3)
            server.shutdown()
    assert SUBSCRIBED.is_set(), "the sink never opened its ingest connection"
    assert stats["transport_errors"] == 0, f"the idle ingest connection was lost: {stats['last_error']}"
    assert stats["acked"] == 1
