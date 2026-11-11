"""When the provider's ingress queue was full the event was dropped while the producer's sequence moved on, and
Market Runtime -- whose fences are per payload kind while producer sequence spaces differ per source -- could not see
the hole, so the lost trades silently never existed downstream. The sink reports every loss to Market Runtime
(``ingest.loss``: per instrument, its exchange-time span and count), which writes it as a gap of the partition it names
and keeps it in that partition's evidence. A report is held until Market Runtime's WAL watermark passes it."""
from __future__ import annotations

import json

from service.market.shared.rust_live import RustDaemonEventSink, RustLiveEvent


def _event(code: str, sequence: int, ts: int = 1_000) -> RustLiveEvent:
    return RustLiveEvent(source="shioaji", market="STK", code=code, generation=1, sequence=sequence, event_type="trade",
                         exchange_ts_ns=ts, arrival_ns=1, data={"price": 1, "volume": 1})


class _Socket:
    """Fake Rust A for one ``ingest.loss``: the answer it was told to give, then nothing."""

    def __init__(self, ack: dict) -> None:
        self.sent: list[dict] = []
        self._ack = ack

    def send(self, raw: str) -> None:
        self.sent.append(json.loads(raw))

    def recv(self, timeout: float = 0) -> str:
        return json.dumps(self._ack)


def test_dropped_events_are_reported_as_a_loss_per_instrument_and_never_stamped_on_the_next_event():
    sink = RustDaemonEventSink(source="shioaji", url="ws://127.0.0.1:1", token="t" * 40, capacity=1024)
    for sequence in range(1, 1025):
        assert sink.publish(_event("2330", sequence, ts=1_000 + sequence))
    assert not sink.publish(_event("2330", 1025, ts=5_000))
    assert not sink.publish(_event("2330", 1026, ts=6_000))
    assert not sink.publish(_event("2317", 1, ts=7_000))
    while not sink._queue.empty():   # the drain the sender thread would do
        sink._queue.get_nowait()
    assert sink.publish(_event("2330", 1027, ts=8_000))
    assert "gap_before" not in sink._queue.get_nowait().as_dict()["flags"], "no loss is stated on another event"
    assert sink.stats()["dropped"] == 3
    # Before 7_000 and not answered by Market Runtime: the 1024 queued events and the 2330 loss report (2317's starts at 7_000).
    assert sink.unconfirmed_before(["STK"], 7_000) == 1024 + 1

    socket = _Socket({"type": "ingest.loss.ack", "payload": {"instance_id": "mr-1", "results": [
        {"accepted": True, "durable_sequence": 11}, {"accepted": True, "durable_sequence": 12}]}})
    assert sink._send_losses(socket) == []
    reports = socket.sent[0]["payload"]["reports"]
    assert [(r["code"], r["reason"], r["from_ns"], r["to_ns"], r["count"]) for r in reports] == [
        ("2317", "dropped", 7_000, 7_000, 1), ("2330", "dropped", 5_000, 6_000, 2)]
    assert sink.stats()["losses_held"] == 2, "held until the watermark passes them"
    assert sink.unconfirmed_before(["STK"], 5_500) >= 1, "a held report still holds its partition open"
    sink._settle_durable({"instance_id": "mr-1", "committed": 12})
    assert (sink.stats()["losses_held"], sink.stats()["losses_reported"]) == (0, 2)


def test_a_report_another_market_runtime_never_stored_is_sent_again():
    sink = RustDaemonEventSink(source="shioaji", url="ws://127.0.0.1:1", token="t" * 40, capacity=1024)
    sink.report_outage([("STK", "2330"), ("STK", "2454")], 100, 200, connection="connection 2")
    socket = _Socket({"type": "ingest.loss.ack", "payload": {"instance_id": "mr-1", "results": [
        {"accepted": True, "durable_sequence": 5}, {"accepted": True, "durable_sequence": None, "written": False}]}})
    sink._send_losses(socket)
    assert [(r["code"], r["reason"], r["connection"]) for r in socket.sent[0]["payload"]["reports"]] == [
        ("2330", "broker_outage", "connection 2"), ("2454", "broker_outage", "connection 2")]
    assert sink.stats()["losses_reported"] == 1, "an outage outside trading has nothing to store"
    sink._settle_durable({"instance_id": "mr-2", "committed": 0})   # another Market Runtime process answers now
    assert sink.stats()["losses_waiting"] == 1, "the report the old process held is sent again"


def test_an_event_after_admission_stopped_is_part_of_the_restart_gap_not_a_loss():
    sink = RustDaemonEventSink(source="shioaji", url="ws://127.0.0.1:1", token="t" * 40, capacity=1024)
    sink.stop_admission()
    assert not sink.publish(_event("2330", 1, ts=5_000))
    assert not sink.publish(_event("2330", 2, ts=6_000))
    assert sink._losses == {}, "the successor's restart gap covers it: no ingest.loss"
    assert sink.stats()["refused_after_stop"] == 2
    assert sink.unconfirmed_before(["STK"], 7_000) == 0, "nothing holds the partition open for it"
