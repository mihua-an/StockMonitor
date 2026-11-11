from __future__ import annotations

import json
from pathlib import Path
import time

from websockets.sync.client import connect

from tests import synthetic_runtime as rt


rt.require_binaries(rt.RUNTIME_EXE)
PROVIDER, VIEWER, CONTROLLER = rt.TOKEN, rt.VIEWER_TOKEN, rt.CONTROLLER_TOKEN
# 2026-09-29 09:30 Asia/Taipei (native/market_runtime/tests/support/mod.rs TAIPEI_0930_NS): the envelope names no
# partition, so this exchange time files the events in that day's STK DAY.
TAIPEI_0930_NS = 1_790_645_400_000_000_000


def _decode(raw):
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8")
    return json.loads(raw)


def _connect(runtime: rt.RuntimeProcess, *, token: str = PROVIDER):
    # RuntimeProcess is entered only after A said `ready` (WAL recovered), so the first connection is served.
    return connect(runtime.url, additional_headers={"Authorization": f"Bearer {token}"}, proxy=None,
                   open_timeout=2.0, close_timeout=0.05)


def _shutdown(runtime: rt.RuntimeProcess) -> float:
    started = time.perf_counter()
    with _connect(runtime, token=CONTROLLER) as websocket:
        websocket.send(json.dumps({"type": "shutdown", "payload": {}}))
        assert _decode(websocket.recv())["type"] == "shutdown.ack"
    runtime.proc.wait(timeout=2.0)
    return time.perf_counter() - started


def _ingest(websocket, sequence: int, event_type: str, data: dict) -> None:
    # The current ingest envelope (as native/market_runtime/tests/support/mod.rs `trade`): no trading_date, session
    # or minute -- Market Runtime refuses an envelope that names a partition.
    exchange_ts_ns = TAIPEI_0930_NS + sequence
    websocket.send(json.dumps({
        "type": "event.ingest",
        "payload": {
            "schema": "market-event-v2", "source": "shioaji", "market": "STK", "code": "2330",
            "generation": 1, "sequence": sequence,
            "event_type": event_type, "exchange_ts_ns": exchange_ts_ns,
            "arrival_ns": exchange_ts_ns + 500,
            "data": data,
        },
    }))
    ack = _decode(websocket.recv())
    assert ack["type"] == "event.ack" and ack["payload"]["accepted"] is True, ack


def _snapshot(websocket, request_id: str) -> dict:
    websocket.send(json.dumps({
        "type": "view.snapshot", "request_id": request_id,
        "payload": {"symbol": "shioaji:STK:2330"},
    }))
    return _decode(websocket.recv())


def test_checkpoint_restart_snapshot_and_shutdown_deadline(tmp_path: Path):
    data_dir = tmp_path / "rust-live"
    with rt.RuntimeProcess(data_dir) as runtime:
        with _connect(runtime) as websocket:
            _ingest(websocket, 1, "trade",
                    {"price": 1_010_000,
                     "open": 1_000_000, "high": 1_010_000, "low": 1_000_000, "average": 1_000_000,
                     "volume": 10, "total_volume": 10, "total_amount": 1010.0,
                     "amount": 1010.0, "side": 1, "trade_id": "one"})
            _ingest(websocket, 2, "orderbook",
                    {"bids": [{"price": 1_000_000, "volume": 9}],
                     "asks": [{"price": 1_020_000, "volume": 11}]})
        first_shutdown_seconds = _shutdown(runtime)
    assert first_shutdown_seconds < 2.0

    # Same data dir: the restarted A recovers both events from the WAL before it says `ready`.
    restarted_at = time.perf_counter()
    with rt.RuntimeProcess(data_dir) as runtime:
        with _connect(runtime, token=VIEWER) as websocket:
            # A viewer connection opens with what Market Runtime pushes: the session, then the analysis state.
            assert _decode(websocket.recv())["type"] == "session.current"
            assert _decode(websocket.recv())["type"] == "analysis.state"
            reply = _snapshot(websocket, "restart")
            first_snapshot_seconds = time.perf_counter() - restarted_at
            warm_snapshot_seconds = []
            for index in range(30):
                started = time.perf_counter()
                assert _snapshot(websocket, f"warm-{index}")["type"] == "view.snapshot"
                warm_snapshot_seconds.append(time.perf_counter() - started)
        second_shutdown_seconds = _shutdown(runtime)
    assert reply["type"] == "view.snapshot"
    # Both events recovered from the WAL: state version and durable watermark (view `sequence` is per-view).
    assert reply["payload"]["state_version"] == 2
    assert reply["payload"]["durable_watermark"] == 2
    # The forming minute is A's overlay of its latest price; closed minutes, K and flow are Rust B's.
    assert len(reply["payload"]["trend"]) == 1
    assert reply["payload"]["summary"]["current"] == 101.0
    assert reply["payload"]["trades"][0]["price"] == 101.0
    assert reply["payload"]["trend"][0]["close"] == 101.0
    assert reply["payload"]["orderbook"]["bid_prices"] == [100.0]
    assert reply["payload"]["orderbook"]["ask_prices"] == [102.0]
    # Price-volume and trade flow are computed by Rust B from the durable stream (02): with no B running A has
    # nothing to show and must not fabricate an empty-but-"OK" block.
    assert not (reply["payload"].get("price_volume") or {}).get("buckets")
    assert (reply["payload"].get("coverage") or {}).get("trade_flow") is False
    assert first_snapshot_seconds < 1.0
    assert second_shutdown_seconds < 2.0
    warm_p95_ms = sorted(warm_snapshot_seconds)[int(0.95 * len(warm_snapshot_seconds)) - 1] * 1000
    print(f"Rust live timings: restart_first_snapshot={first_snapshot_seconds * 1000:.2f}ms "
          f"warm_snapshot_p95={warm_p95_ms:.2f}ms "
          f"shutdowns={first_shutdown_seconds * 1000:.2f}/{second_shutdown_seconds * 1000:.2f}ms")
