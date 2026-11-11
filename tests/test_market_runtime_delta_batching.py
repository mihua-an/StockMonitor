"""Market Runtime coalesces a burst of deltas into `view.delta.batch` for a client that asked.

Across a real process boundary: the real `market_runtime_daemon` binary, the real
`RustDaemonEventSink`, and a real WebSocket reading the way the renderer does.

Why this exists. Under the isolated feed the renderer fell behind: one WebSocket frame per delta
meant one message event, JSON parse and page callback each, the connection's outbound queue filled
and the hub closed it ("outbound queue full at 2048 messages ... the client must reconnect"). The
reconnect storm left the 加權走勢 / 期貨走勢 views unsubscribed until a tab switch re-created them,
and froze the 個股走勢 加權 overlay around 10:30.

What it pins
------------
* a client that subscribes with ``delta_batch: true`` receives the burst in fewer frames than
  deltas, and not one delta is lost, duplicated or reordered;
* a client that did not opt in still receives plain ``view.delta`` frames only -- the Python
  consumers of this socket never see a frame shape they cannot read.
"""
from __future__ import annotations

import json
import threading
import time

import pytest

from service.market.shared.rust_live import RustDaemonEventSink, RustLiveEvent
from tests import synthetic_runtime as rt

rt.require_binaries(rt.RUNTIME_EXE)

TRADING_DATE = "2026-09-24"
SESSION = "DAY"
CODE = "2330"
BURST = 1500


@pytest.fixture()
def runtime(tmp_path):
    with rt.RuntimeProcess(tmp_path / "live-engine") as process:
        yield process


def _client(url: str):
    from websockets.sync.client import connect
    return connect(url, additional_headers={"Authorization": f"Bearer {rt.VIEWER_TOKEN}"}, max_size=None)


def _spec(**extra) -> dict:
    return {"source": "shioaji", "market": "STK", "code": CODE, "trading_date": TRADING_DATE,
            "session": SESSION, "channels": ["summary", "trend"], **extra}


# 09:00:00 of TRADING_DATE, Taipei: Market Runtime files each quote in that partition by its exchange time.
OPEN_NS = 1_790_211_600_000_000_000


def _quote(sequence: int) -> RustLiveEvent:
    now_ns = time.time_ns()
    return RustLiveEvent(
        source="shioaji", market="STK", code=CODE,
        generation=1, sequence=sequence, event_type="quote", exchange_ts_ns=OPEN_NS + sequence * 1_000_000_000,
        arrival_ns=now_ns,
        data={"current": 40_0000 + sequence, "open": 39_5000, "high": 45_0000,
              "low": 39_0000, "total_volume": 1000 + sequence, "total_amount": 0.0, "status": "live",
              "average": 40_0000, "volume": 1, "amount": 0.0,
              "advance_count": 0, "decline_count": 0, "flat_count": 0,
              "limit_up_count": 0, "limit_down_count": 0},
    )


def _text(raw) -> dict:
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", "replace")
    return json.loads(raw)


def _subscribe(ws, request_id: str, **extra) -> None:
    ws.send(json.dumps({"type": "view.subscribe", "request_id": request_id, "payload": _spec(**extra)}))
    deadline = time.time() + 10
    while time.time() < deadline:
        if _text(ws.recv(timeout=10)).get("type") == "view.subscription.accepted":
            return
    raise AssertionError("view.subscribe was never accepted")


def _collect(ws, frames: list, stop: threading.Event) -> None:
    while not stop.is_set():
        try:
            frames.append(_text(ws.recv(timeout=0.5)))
        except TimeoutError:
            continue
        except Exception:  # noqa: BLE001 - the socket closing ends the reader
            return


def _deltas(frames: list) -> list[dict]:
    items = []
    for frame in frames:
        if frame.get("type") == "view.delta":
            items.append(frame.get("payload") or {})
        elif frame.get("type") == "view.delta.batch":
            items.extend((frame.get("payload") or {}).get("items") or [])
    return items


def test_a_burst_reaches_an_opted_in_client_batched_and_a_legacy_client_unbatched(runtime):
    sink = RustDaemonEventSink(url=runtime.url, token=rt.TOKEN)
    sink.start()
    try:
        assert sink.publish(_quote(1))
        rt.wait_acked(sink, 1)
        with _client(runtime.url) as batched, _client(runtime.url) as legacy:
            _subscribe(batched, "b-1", delta_batch=True)
            _subscribe(legacy, "l-1")
            frames = {"batched": [], "legacy": []}
            stop = threading.Event()
            readers = [threading.Thread(target=_collect, args=(ws, frames[name], stop), daemon=True)
                       for name, ws in (("batched", batched), ("legacy", legacy))]
            for reader in readers:
                reader.start()
            for sequence in range(2, BURST + 2):
                assert sink.publish(_quote(sequence))
            stats = rt.wait_acked(sink, BURST + 1)
            assert stats["rejected"] == 0, stats

            def settled() -> bool:
                return (len(_deltas(frames["batched"])) >= BURST
                        and len(_deltas(frames["legacy"])) >= BURST)
            deadline = time.time() + 20
            while time.time() < deadline and not settled():
                time.sleep(0.05)
            stop.set()
            for reader in readers:
                reader.join(timeout=2)

        batched_items = _deltas(frames["batched"])
        legacy_items = _deltas(frames["legacy"])
        assert len(legacy_items) >= BURST, f"legacy client saw {len(legacy_items)} deltas"
        assert len(batched_items) == len(legacy_items), (
            "batching must deliver exactly the deltas a per-frame client receives")

        sequences = [int(item["sequence"]) for item in batched_items]
        assert sequences == sorted(sequences) and len(set(sequences)) == len(sequences), (
            "batched deltas must stay strictly ordered with no duplicates")
        assert sequences == [int(item["sequence"]) for item in legacy_items]
        assert all(item.get("subscription_id") for item in batched_items), (
            "every batched item still names its own subscription")

        batch_frames = [f for f in frames["batched"] if f.get("type") == "view.delta.batch"]
        delta_frames = [f for f in frames["batched"] if f.get("type") in ("view.delta", "view.delta.batch")]
        assert batch_frames, "a burst of deltas must be coalesced for an opted-in client"
        assert len(delta_frames) < len(batched_items), (
            f"{len(delta_frames)} frames for {len(batched_items)} deltas: nothing was coalesced")

        assert not [f for f in frames["legacy"] if f.get("type") == "view.delta.batch"], (
            "a client that did not opt in must never receive view.delta.batch")
    finally:
        sink.close(timeout=2.0)


def test_a_reader_that_stalls_for_seconds_mid_burst_is_not_dropped(runtime):
    """A renderer main thread routinely pauses (GC, a heavy paint, a tab switch) for a second or
    more. With a 250 ms per-frame write timeout and a 2048-message queue, a pause like that under
    the isolated feed closed the connection (`os error 10060` / `outbound queue full`), and every
    reconnect re-sent ~85 subscribes and snapshots -- the storm that blanked 加權走勢 / 期貨走勢."""
    burst = 6000
    sink = RustDaemonEventSink(url=runtime.url, token=rt.TOKEN)
    sink.start()
    try:
        assert sink.publish(_quote(1))
        rt.wait_acked(sink, 1)
        with _client(runtime.url) as slow:
            _subscribe(slow, "s-1", delta_batch=True)
            for sequence in range(2, burst + 2):
                while not sink.publish(_quote(sequence)):
                    time.sleep(0.005)
            rt.wait_acked(sink, burst + 1, timeout=60)
            time.sleep(3.0)   # the reader is stalled the whole time the burst is written
            frames: list = []
            deadline = time.time() + 30
            while time.time() < deadline and len(_deltas(frames)) < burst:
                frames.append(_text(slow.recv(timeout=10)))
        sequences = [int(item["sequence"]) for item in _deltas(frames)]
        assert len(sequences) >= burst, f"the stalled reader was dropped after {len(sequences)} deltas"
        assert sequences == sorted(sequences) and len(set(sequences)) == len(sequences)
    finally:
        sink.close(timeout=2.0)
