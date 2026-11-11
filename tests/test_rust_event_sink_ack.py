"""RustDaemonEventSink ack contract: success, timeout+resend, rejection
classification, queue-full drop, and the effect on Futu completeness."""
from __future__ import annotations

import pytest

import json
import threading
import time

from service.market.shared.rust_live import RustDaemonEventSink, RustLiveEvent


def _event(sequence: int) -> RustLiveEvent:
    return RustLiveEvent(
        source="futu", market="US", code="US.AAPL",
        generation=1, sequence=sequence, event_type="trade", exchange_ts_ns=1_000 + sequence,
        arrival_ns=2_000 + sequence, data={"price": 1_000_000, "volume": 1, "total_volume": 1, "side": 1,
                                             "trade_id": str(sequence)},
    )


WATERMARK_ALL = {"type": "event.durable", "payload": {"committed": 10 ** 9, "instance_id": "mr-1", "wal_failed": None}}


class FakeWebSocket:
    """Scripted Rust peer speaking event.ingest.batch: each event of the last batch consumes the next scripted
    result; a "timeout" step loses the whole batch's ack (the sink then resends that batch). The WAL watermark is
    pushed when the sink subscribes and after every answered batch (everything is on disk at once)."""

    def __init__(self, script):
        self.script = list(script)
        self.sent = []
        self.outbox = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def send(self, raw):
        message = json.loads(raw)
        self.sent.append(message)
        if message["type"] == "event.durable.subscribe":
            self.outbox.append(json.dumps(WATERMARK_ALL))
        elif message["type"] == "ingest.hello":
            self.outbox.append(json.dumps({"type": "ingest.hello.ack", "payload": {"restarted": []}}))
        elif message["type"] == "ingest.loss":
            self.outbox.append(json.dumps({"type": "ingest.loss.ack", "payload": {"instance_id": "mr-1", "results": [
                {"accepted": True, "durable_sequence": 1} for _ in message["payload"]["reports"]]}}))

    def results_for(self, batch):
        results = []
        for _ in batch:
            step = self.script.pop(0) if self.script else "hang"
            if step == "timeout":
                raise TimeoutError("ack lost")
            if step == "hang":
                return None
            results.append(step)
        return results

    def recv(self, timeout=None):
        if self.outbox:
            return self.outbox.pop(0)
        last = self.sent[-1] if self.sent else {}
        if last.get("type") == "event.ingest.batch" and not last.get("_answered"):
            results = self.results_for(last["payload"]["events"])
            if results:
                last["_answered"] = True
                self.outbox.append(json.dumps(WATERMARK_ALL))
                return json.dumps({"type": "event.ack.batch", "payload": {"results": results, "instance_id": "mr-1"}})
        time.sleep(min(0.05, timeout or 0.05))
        raise TimeoutError("idle")


def _run_sink(monkeypatch, script, events):
    sink = RustDaemonEventSink(url="ws://127.0.0.1:1/live", token="t", capacity=2048, ack_timeout=0.05)
    peers = []

    def connect(url, **_kw):
        peer = FakeWebSocket(script if not peers else [])
        peers.append(peer)
        # the SAME script continues across reconnects
        peer.script = script
        return peer

    monkeypatch.setattr("websockets.sync.client.connect", connect)
    for event in events:
        assert sink.publish(event)
    thread = threading.Thread(target=sink._run, daemon=True)
    thread.start()
    deadline = time.time() + 5
    while time.time() < deadline and (sink.stats()["acked"] + sink.stats()["rejected"]) < len(events):
        time.sleep(0.01)
    sink._stop.set()
    thread.join(timeout=2)
    return sink, peers


ACCEPT = {"accepted": True, "durable_sequence": 1, "storage": "wal"}


def test_ack_success_is_counted_as_acked(monkeypatch):
    sink, _ = _run_sink(monkeypatch, [ACCEPT, ACCEPT], [_event(1), _event(2)])
    stats = sink.stats()
    assert stats["acked"] == 2 and stats["rejected"] == 0 and stats["dropped"] == 0


def test_ack_timeout_resend_that_rust_already_applied_is_a_duplicate_not_a_rejection(monkeypatch):
    # Rust applied event 1 but the ack was lost; the resend comes back RejectedSequence.
    sink, peers = _run_sink(monkeypatch, ["timeout", {"accepted": False, "reason": "RejectedSequence"}], [_event(1)])
    stats = sink.stats()
    assert stats["transport_errors"] >= 1
    assert stats["duplicate_after_retry"] == 1
    assert stats["rejected"] == 0, "a resent duplicate is not a genuine rejection"
    assert stats["acked"] == 1
    batches = [m for peer in peers for m in peer.sent if m["type"] == "event.ingest.batch"]
    assert len(batches) == 2, "the same event was resent once after the lost ack"


def test_a_genuine_rejection_without_a_prior_failed_send_is_counted_rejected(monkeypatch):
    sink, _ = _run_sink(monkeypatch, [{"accepted": False, "reason": "RejectedSequence"}], [_event(1)])
    stats = sink.stats()
    assert stats["rejected"] == 1 and stats["duplicate_after_retry"] == 0
    assert stats["last_error"] == "RejectedSequence"
    assert stats["last_rejection"]["generation"] == 1
    assert stats["last_rejection"]["code"] == "US.AAPL"
    assert stats["last_rejection"]["event_type"] == "trade"
    assert stats["last_rejection"]["sequence"] == 1


def test_an_event_of_a_closed_session_is_answered_and_counted_apart_never_as_a_rejection(monkeypatch):
    # OpenD re-sends the finished day's last print on a new subscription; Market Runtime refuses it as PARTITION_CLOSED.
    sink, _ = _run_sink(monkeypatch, [{"accepted": False, "reason": "PARTITION_CLOSED"}, ACCEPT], [_event(1), _event(2)])
    stats = sink.stats()
    assert stats["closed_partition"] == 1 and stats["rejected"] == 0 and stats["acked"] == 1
    assert stats["last_error"] is None and stats["last_rejection"] is None


def test_rejection_of_a_resend_for_another_reason_is_still_a_rejection(monkeypatch):
    sink, _ = _run_sink(monkeypatch, ["timeout", {"accepted": False, "reason": "RejectedGeneration"}], [_event(1)])
    assert sink.stats()["rejected"] == 1 and sink.stats()["duplicate_after_retry"] == 0


def test_queue_full_is_a_local_drop_counted_separately_from_rust_rejections():
    sink = RustDaemonEventSink(url="ws://127.0.0.1:1/live", token="t", capacity=1024)
    accepted = [sink.publish(_event(i)) for i in range(1, 1026)]
    assert accepted.count(False) == 1 and sink.stats()["dropped"] == 1 and sink.stats()["rejected"] == 0


def test_a_full_wal_queue_is_retried_not_counted_as_a_rejection(monkeypatch):
    # "WAL_QUEUE_FULL: retry" means Market Runtime applied nothing (a disk stall). The sink
    # counted it as rejected and the event was lost.
    full = {"accepted": False, "reason": "WAL_QUEUE_FULL: retry"}
    script = [full, ACCEPT]
    sink, peers = _run_sink(monkeypatch, script, [_event(1)])
    stats = sink.stats()
    assert (stats["acked"], stats["rejected"]) == (1, 0)
    sent = [e["sequence"] for m in peers[0].sent if m["type"] == "event.ingest.batch" for e in m["payload"]["events"]]
    assert sent == [1, 1], "the same event was sent again"
    assert sink.unconfirmed_before(["US"], 10 ** 18) == 0, "answered for good: nothing left unconfirmed"


def test_a_short_batch_ack_resends_the_unanswered_events(monkeypatch):
    # Events past the end of a truncated ack were recorded as permanently rejected.
    class ShortAckPeer(FakeWebSocket):
        def results_for(self, batch):
            if sum(1 for m in self.sent if m["type"] == "event.ingest.batch") == 1:
                return [ACCEPT]
            return [ACCEPT for _ in batch]

    peers = []

    def connect(url, **_kw):
        peers.append(ShortAckPeer([]))
        return peers[-1]

    monkeypatch.setattr("websockets.sync.client.connect", connect)
    sink = RustDaemonEventSink(url="ws://127.0.0.1:1/live", token="t", capacity=2048, ack_timeout=0.05)
    for event in (_event(1), _event(2), _event(3)):
        assert sink.publish(event)
    thread = threading.Thread(target=sink._run, daemon=True)
    thread.start()
    deadline = time.time() + 5
    while time.time() < deadline and sink.stats()["acked"] < 3:
        time.sleep(0.01)
    sink._stop.set()
    thread.join(timeout=2)
    stats = sink.stats()
    assert (stats["acked"], stats["rejected"], stats["short_acks"]) == (3, 0, 1)
    resent = [e["sequence"] for e in [m for m in peers[0].sent if m["type"] == "event.ingest.batch"][1]["payload"]["events"]]
    assert resent == [2, 3], "only the unanswered events went again"


def test_a_stored_event_is_held_until_a_watermark_of_its_process_passes_it(monkeypatch, caplog):
    # The ack says where an event went (storage wal, its durable sequence), never that it is on disk: the pushed WAL
    # watermark of the same Market Runtime process does. A failed WAL keeps them held and is recorded once.
    sink = RustDaemonEventSink(url="ws://127.0.0.1:1/live", token="t", capacity=16)
    for n in (1, 2):
        sink._queue.put(_event(n))
        sink._queue.get()
    assert sink._record_ack(_event(1), {"accepted": True, "storage": "wal", "durable_sequence": 4}, resent=False,
                            instance="mr-1") is False
    assert sink._record_ack(_event(2), {"accepted": True, "storage": "wal", "durable_sequence": 5}, resent=False,
                            instance="mr-1") is False
    assert (sink.stats()["acked"], sink.stats()["durable_pending"]) == (0, 2)
    with caplog.at_level("WARNING"):
        for _ in range(2):
            assert sink._settle_durable({"committed": 4, "instance_id": "mr-1", "wal_failed": "disk full"}) == []
    stats = sink.stats()
    assert (stats["acked"], stats["durable_pending"], stats["durable_confirmed"]) == (1, 1, 1)
    assert "WAL failed" in stats["last_error"]
    assert sum("cannot write" in r.getMessage() for r in caplog.records) == 1, "recorded once per reason"
    assert sink._settle_durable({"committed": 9, "instance_id": "mr-1", "wal_failed": None}) == []
    assert (sink.stats()["acked"], sink.stats()["durable_pending"]) == (2, 0)
    assert sink._queue.unfinished_tasks == 0


def test_a_live_only_event_is_final_at_its_ack(monkeypatch):
    # 盤前試撮 and never-stored markets (Futu crypto) take no WAL slot: Rust A acks them `storage: live_only`, with
    # nothing to wait for.
    from service.market.shared import rust_live

    recorder = _Recorder()
    monkeypatch.setattr(rust_live.remediation, "emitter", lambda: recorder)
    sink = RustDaemonEventSink(url="ws://127.0.0.1:1/live", token="t", capacity=16)
    assert sink._record_ack(_event(1), {"accepted": True, "storage": "live_only", "durable_sequence": None},
                            resent=False) is True
    stats = sink.stats()
    assert (stats["acked"], stats["durable_held"], stats["durable_pending"]) == (1, 0, 0)
    assert recorder.started == [] and recorder.emitted == []


class LateJoinPeer(FakeWebSocket):
    """Answers the batch with a late join the batch revealed (market_runtime late_join.rs)."""

    GAP = {"cause": "late_join", "market": "STK", "code": "3481", "trading_date": "2026-11-06", "session": "DAY", "after_ns": 0,
           "volume_at_after": 0.0, "total_before": 0.0, "since_ns": 1, "next_ns": 2, "next_total_before": 65.0}

    def recv(self, timeout=None):
        reply = super().recv(timeout)
        message = json.loads(reply)
        if message["type"] == "event.ack.batch":
            message["payload"]["gaps"] = [self.GAP]
        return json.dumps(message)


def test_a_late_join_named_in_a_batch_answer_goes_to_the_gap_handler(monkeypatch):
    sink = RustDaemonEventSink(url="ws://127.0.0.1:1/live", token="t", capacity=16, ack_timeout=0.05)
    handed = []
    sink.fill_gaps_with(handed.extend)
    monkeypatch.setattr("websockets.sync.client.connect", lambda url, **_kw: LateJoinPeer([ACCEPT]))
    assert sink.publish(_event(1))
    thread = threading.Thread(target=sink._run, daemon=True)
    thread.start()
    deadline = time.time() + 5
    while time.time() < deadline and not handed:
        time.sleep(0.01)
    sink._stop.set()
    thread.join(timeout=2)
    assert handed == [LateJoinPeer.GAP]


class WatermarkPeer(FakeWebSocket):
    """Acks each batch at once (`storage: wal`, durable sequence 10 + sequence) and pushes the watermarks of a
    script: (seconds after the ack, instance, committed). Pushes due later than now are held back until then."""

    def __init__(self, instance, watermarks, acks=None):
        super().__init__([])
        self.instance = instance
        self.watermarks = list(watermarks)
        self.acks = acks
        self.timed = []

    def send(self, raw):
        message = json.loads(raw)
        self.sent.append(message)
        if message["type"] == "event.durable.subscribe":
            self.outbox.append(json.dumps({"type": "event.durable", "payload": {
                "committed": 0, "instance_id": self.instance, "wal_failed": None}}))
        elif message["type"] == "ingest.hello":
            self.outbox.append(json.dumps({"type": "ingest.hello.ack", "payload": {"restarted": []}}))

    def recv(self, timeout=None):
        now = time.monotonic()
        due = [item for item in self.timed if item[0] <= now]
        if due:
            self.timed.remove(due[0])
            return due[0][1]
        if self.outbox:
            return self.outbox.pop(0)
        last = self.sent[-1]
        if last["type"] == "event.ingest.batch" and not last.get("_answered"):
            last["_answered"] = True
            batch = last["payload"]["events"]
            if self.acks is not None:
                results = [self.acks.pop(0) for _ in batch]
            else:
                results = [{"accepted": True, "storage": "wal", "durable_sequence": 10 + e["sequence"]} for e in batch]
            for delay, instance, committed in self.watermarks:
                self.timed.append((now + delay, json.dumps({"type": "event.durable", "payload": {
                    "committed": committed, "instance_id": instance, "wal_failed": None}})))
            self.watermarks = []
            return json.dumps({"type": "event.ack.batch", "payload": {"results": results, "instance_id": self.instance}})
        time.sleep(min(0.01, timeout or 0.01))
        raise TimeoutError("idle")


def _drive(monkeypatch, peer_factory, events, until):
    peers = []

    def connect(url, **_kw):
        peers.append(peer_factory(len(peers)))
        return peers[-1]

    monkeypatch.setattr("websockets.sync.client.connect", connect)
    sink = RustDaemonEventSink(url="ws://127.0.0.1:1/live", token="t", capacity=2048, ack_timeout=0.2)
    for event in events:
        assert sink.publish(event)
    thread = threading.Thread(target=sink._run, daemon=True)
    thread.start()
    deadline = time.time() + 5
    while time.time() < deadline and not until(sink):
        time.sleep(0.01)
    sink._stop.set()
    thread.join(timeout=2)
    return sink, peers


def test_q17_a_stored_event_is_held_until_the_pushed_watermark_passes_it(monkeypatch):
    sink, peers = _drive(
        monkeypatch, lambda _n: WatermarkPeer("mr-1", [(0.0, "mr-1", 11), (0.05, "mr-1", 12)]), [_event(1), _event(2)],
        lambda s: s.stats()["acked"] == 2)
    stats = sink.stats()
    assert (stats["acked"], stats["durable_pending"], stats["durable_confirmed"]) == (2, 0, 2)
    assert sink._queue.unfinished_tasks == 0
    kinds = [m["type"] for m in peers[0].sent]
    assert kinds == ["event.durable.subscribe", "ingest.hello", "event.ingest.batch"], "nothing is asked again: the watermark is pushed"
    assert sink.unconfirmed_before(["US"], 10 ** 18) == 0


def test_a_disk_slower_than_the_ack_timeout_is_a_wait_not_a_remediation(monkeypatch):
    # 10-28 16:17, 17:26, 18:07: a Windows shadow copy held the WAL's sync 6-16 s. The ack waited 2 s for it and
    # answered durable: false, and every such stall was a provider.durability_recheck. The watermark now comes when
    # the disk is done, however long that is (here past the 0.2 s ack timeout), and nothing is recorded.
    from service.market.shared import rust_live

    recorder = _Recorder()
    monkeypatch.setattr(rust_live.remediation, "emitter", lambda: recorder)
    started = time.monotonic()
    sink, peers = _drive(monkeypatch, lambda _n: WatermarkPeer("mr-1", [(0.6, "mr-1", 11)]), [_event(1)],
                            lambda s: s.stats()["acked"] == 1)
    assert time.monotonic() - started >= 0.55, "released only by the late watermark"
    stats = sink.stats()
    assert (stats["acked"], stats["durable_pending"], stats["transport_errors"]) == (1, 0, 0)
    assert recorder.started == [] and recorder.emitted == []
    assert len(peers) == 1


def test_q17_held_events_are_resent_when_rust_a_restarted_before_they_were_on_disk(monkeypatch):
    calls = {"n": 0}

    def factory(n):
        if n == 0:
            peer = WatermarkPeer("mr-1", [])  # accepted, never on disk; then the connection breaks
            original = peer.recv

            def recv(timeout=None):
                calls["n"] += 1
                if calls["n"] > 4:
                    raise ConnectionError("market_runtime went away")
                return original(timeout)
            peer.recv = recv
            return peer
        # the new process never saw them: its first watermark orphans them, they are resent and reach its disk
        return WatermarkPeer("mr-2", [(0.0, "mr-2", 5)], acks=[{"accepted": True, "storage": "wal", "durable_sequence": 5}])

    sink, peers = _drive(monkeypatch, factory, [_event(1)], lambda s: s.stats()["acked"] == 1)
    stats = sink.stats()
    assert stats["acked"] == 1 and stats["durable_pending"] == 0 and stats["durable_resent"] == 1
    resent = [m for m in peers[-1].sent if m["type"] == "event.ingest.batch"]
    assert [e["sequence"] for e in resent[0]["payload"]["events"]] == [1]


def test_q17_close_is_not_clean_while_events_are_not_on_disk():
    sink = RustDaemonEventSink(url="ws://127.0.0.1:1/live", token="t", capacity=16)
    sink._record_ack(_event(1), {"accepted": True, "storage": "wal", "durable_sequence": 3}, resent=False, instance="mr-1")
    result = sink.close(timeout=0.05)
    assert result["ok"] is False and result["durable_pending"] == 1


def test_q19_a_market_event_without_exchange_time_is_refused_and_counted():
    sink = RustDaemonEventSink(source="shioaji", url="ws://127.0.0.1:1/live", token="t", capacity=1024)
    missing = RustLiveEvent(source="shioaji", market="STK", code="2330",
                            generation=1, sequence=1, event_type="trade", exchange_ts_ns=0, arrival_ns=5, data={})
    clocked = RustLiveEvent(source="futu", market="US", code="US.AAPL",
                            generation=1, sequence=1, event_type="quote", exchange_ts_ns=7, arrival_ns=7, data={},
                            time_quality="backend_clock")
    assert sink.publish(missing) is False and sink.publish(clocked) is False
    stats = sink.stats()
    assert stats["missing_exchange_time"] == {"trade": 1, "quote": 1}
    assert stats["last_missing_time"]["code"] == "US.AAPL" and stats["accepted"] == 0 and stats["queue_depth"] == 0
    # Coverage is no longer a provider event at all (Market Runtime writes it): it cannot be built.
    with pytest.raises(ValueError, match="unsupported live event type"):
        RustLiveEvent(source="shioaji", market="STK", code="2330",
                      generation=1, sequence=2, event_type="source_status", exchange_ts_ns=0, arrival_ns=5,
                      data={"state": "subscribed"}, time_quality="backend_clock")
    assert sink.stats()["accepted"] == 0
    assert sink.publish(_event(1)) is True


class _Recorder:
    """Stands in for the remediation emitter: what was started, finished and emitted."""

    def __init__(self):
        self.started, self.finished, self.emitted = [], [], []

    def begin(self, *, mechanism_id, trigger_reason, **kw):
        recorder = self

        class Op:
            def finish(self, outcome, *, attempt=None, detail=None):
                recorder.finished.append((mechanism_id, outcome, attempt))

        self.started.append((mechanism_id, trigger_reason))
        return Op()

    def emit(self, *, mechanism_id, trigger_reason, outcome, **kw):
        self.emitted.append((mechanism_id, trigger_reason, outcome, kw.get("detail")))


def test_delivery_remediations_are_recorded_with_their_outcome(monkeypatch):
    """A WAL-queue-full retry and a resent duplicate were only counters."""
    from service.market.shared import rust_live

    recorder = _Recorder()
    monkeypatch.setattr(rust_live.remediation, "emitter", lambda: recorder)
    full = {"accepted": False, "reason": "WAL_QUEUE_FULL: retry"}
    _run_sink(monkeypatch, [full, full, ACCEPT], [_event(1)])
    assert ("provider.wal_queue_full_retry", "wal_queue_full") in recorder.started
    assert ("provider.wal_queue_full_retry", "succeeded", 2) in recorder.finished, "closed by the accepted batch, 2 attempts"

    recorder = _Recorder()
    monkeypatch.setattr(rust_live.remediation, "emitter", lambda: recorder)
    _run_sink(monkeypatch, ["timeout", {"accepted": False, "reason": "RejectedSequence"}], [_event(1)])
    duplicates = [e for e in recorder.emitted if e[0] == "provider.resend_duplicate"]
    assert duplicates and duplicates[0][1:3] == ("rejected_sequence_after_resend", "succeeded") and duplicates[0][3]["events"] == 1


def test_an_ingest_reconnect_ends_only_when_the_events_it_held_are_answered(monkeypatch):
    """The reconnect was recorded succeeded on the first ack frame, before anything was known
    about the events held across the loss -- here the resend is refused for now (WAL queue full)."""
    from types import SimpleNamespace

    from service.market.shared import rust_live
    from service.platform import remediation

    log = []

    class Operation:
        def finish(self, outcome, **_):
            log.append(f"reconnect:{outcome}")

    monkeypatch.setattr(remediation, "emitter", lambda: SimpleNamespace(
        begin=lambda **kw: log.append(f"reconnect:started:{kw['mechanism_id']}") or Operation(),
        emit=lambda **kw: None))
    monkeypatch.setattr(rust_live, "RETRY_FULL_SECONDS", 0.01)
    full = {"accepted": False, "reason": "WAL_QUEUE_FULL"}
    script = ["timeout", full, ACCEPT]
    original = FakeWebSocket.recv

    def recv(self, timeout=None):
        step = self.script[0] if self.script else None
        raw = original(self, timeout)
        if json.loads(raw)["type"] == "event.ack.batch":
            log.append("ack:accepted" if step is ACCEPT else "ack:wal_full" if step is full else "ack:?")
        return raw

    monkeypatch.setattr(FakeWebSocket, "recv", recv)
    sink, _ = _run_sink(monkeypatch, script, [_event(1)])
    assert sink.stats()["acked"] == 1
    reconnect = [entry for entry in log if entry.startswith("reconnect:") or entry.startswith("ack:")]
    assert reconnect[0] == "reconnect:started:provider.ingest_reconnect"
    assert reconnect.index("reconnect:succeeded") > reconnect.index("ack:accepted") > reconnect.index("ack:wal_full"), reconnect


def test_a_reference_read_from_the_broker_is_admitted_with_its_read_time():
    """昨收 / limits are instrument data read from the broker: stamped backend_clock and admitted, while a print
    with only a backend time is still refused (Futu's 昨收 was refused for that since the guard tightened)."""
    sink = RustDaemonEventSink(source="futu", url="ws://127.0.0.1:1/live", token="t", capacity=1024)
    reference = RustLiveEvent(source="futu", market="US", code="US.ASX",
                              generation=1, sequence=1, event_type="reference", exchange_ts_ns=7, arrival_ns=7,
                              data={"prev_close": 1}, time_quality="backend_clock", describes_trading_date="2026-10-15")
    unclocked = RustLiveEvent(source="futu", market="US", code="US.ASX",
                              generation=1, sequence=2, event_type="reference", exchange_ts_ns=0, arrival_ns=7, data={})
    assert sink.publish(reference) is True
    assert sink.publish(unclocked) is False
    assert sink.stats()["missing_exchange_time"] == {"reference": 1}


def test_every_reference_producer_labels_its_read_time():
    from pathlib import Path
    root = Path(__file__).resolve().parents[1]
    shioaji = (root / "service/market/shioaji/session.py").read_text(encoding="utf-8")
    assert shioaji.count('event_type="reference", exchange_ts_ns=now_ns, arrival_ns=now_ns, time_quality="backend_clock"') == 2
    assert 'event_type="reference",\n                exchange_ts_ns=now_ns, arrival_ns=now_ns, data=dict(data), time_quality="backend_clock"' in \
        (root / "service/market/futu/callback.py").read_text(encoding="utf-8").replace("\r\n", "\n")


def test_a_control_registration_timeout_backs_off_like_every_other_control_failure(monkeypatch):
    """A connect or registration that times out is counted, recorded and retried after a growing wait -- it used to
    loop again at once without counting anything."""
    import threading
    import time

    import websockets.sync.client as ws_client

    from service.market.shared.rust_live import RustDaemonEventSink

    attempts: list[float] = []

    def connect(*_args, **_kwargs):
        attempts.append(time.monotonic())
        raise TimeoutError("timed out during opening handshake")

    monkeypatch.setattr(ws_client, "connect", connect)
    sink = RustDaemonEventSink(source="shioaji", url="ws://127.0.0.1:9/ingest", token="t")
    sink.register_adapter(source="shioaji", max_subscriptions=10, replace_subscriptions=lambda items, generation: {},
                          report_subscriptions=lambda: {})
    worker = threading.Thread(target=sink._control.run, args=(sink._stop,), daemon=True)
    worker.start()
    time.sleep(0.6)
    sink._stop.set()
    worker.join(3.0)
    assert 2 <= len(attempts) <= 6, attempts
    gaps = [later - earlier for earlier, later in zip(attempts, attempts[1:])]
    assert all(later >= earlier * 1.5 for earlier, later in zip(gaps, gaps[1:])), gaps
    stats = sink.stats()
    assert stats["transport_errors"] == len(attempts) and "TimeoutError" in stats["last_error"]
