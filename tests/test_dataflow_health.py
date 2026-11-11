from __future__ import annotations

import threading
from pathlib import Path

import pytest
import service.market.shared.dataflow_health as dataflow_health_module
from service.market.shared.dataflow_health import (
    DATAFLOW_HEALTH_SCHEMA,
    DataFlowHealthLedger,
    DataFlowIdentity,
    DataFlowSnapshotPublisher,
    DataFlowStage,
    read_dataflow_snapshot,
)


def test_hot_pulses_are_bounded_and_aggregated_off_callback_thread() -> None:
    ledger = DataFlowHealthLedger(component="market_daemon", hot_capacity=128)
    identity = DataFlowIdentity(stream_id="STK:2330:Tick", symbol="2330")

    def produce() -> None:
        for sequence in range(1, 1001):
            ledger.pulse_hot(
                DataFlowStage.CALLBACK_RECEIVED,
                lane="stk.tick",
                identity=DataFlowIdentity(
                    stream_id=identity.stream_id,
                    symbol=identity.symbol,
                    sequence=sequence,
                ),
            )

    thread = threading.Thread(target=produce)
    thread.start()
    thread.join(timeout=2.0)
    assert not thread.is_alive()

    snapshot = ledger.snapshot()
    record = snapshot["stages"]["callback_received|stk.tick"]
    assert 1 <= record["observed"] <= 128
    assert record["sequence"] == 1000
    assert snapshot["hot_path"]["capacity"] == 128
    assert snapshot["hot_path"]["pending"] == 0
    assert snapshot["hot_path"]["overflow_count"] >= 872
    assert snapshot["hot_path"]["non_blocking"] is True


def test_worker_observations_keep_success_and_failure_counts() -> None:
    ledger = DataFlowHealthLedger(component="market_daemon")
    identity = DataFlowIdentity(stream_id="STK:2330", symbol="2330", sequence=9)
    ledger.observe(DataFlowStage.INGEST_ACCEPTED, lane="market.tick", identity=identity)
    ledger.observe(
        DataFlowStage.MARKET_RUNTIME_ACKED,
        lane="market.tick",
        identity=identity,
        accepted=False,
        error="simulated ack failure",
    )

    stages = ledger.snapshot()["stages"]
    assert stages["ingest_accepted|market.tick"]["accepted"] == 1
    assert stages["market_runtime_acked|market.tick"]["failed"] == 1
    assert stages["market_runtime_acked|market.tick"]["last_error"] == "simulated ack failure"


def test_health_ledger_bounds_dynamic_stage_records() -> None:
    ledger = DataFlowHealthLedger(component="market_daemon", record_capacity=32)
    for index in range(40):
        ledger.observe(
            DataFlowStage.CALLBACK_RECEIVED,
            lane=f"dynamic.{index}",
            observed_epoch_ns=index + 1,
        )

    snapshot = ledger.snapshot()

    assert snapshot["record_path"] == {"capacity": 32, "count": 32, "bounded": True}
    assert "callback_received|dynamic.0" not in snapshot["stages"]
    assert "callback_received|dynamic.39" in snapshot["stages"]


def test_snapshot_publisher_writes_atomic_readable_contract(tmp_path: Path) -> None:
    path = tmp_path / "market_daemon.json"
    ledger = DataFlowHealthLedger(component="market_daemon", instance_id="instance-1")
    ledger.set_context(generation=3, trading_date="2026-09-01", session="DAY")
    ledger.observe(DataFlowStage.MARKET_RUNTIME_ACKED, lane="quote")
    publisher = DataFlowSnapshotPublisher(ledger, path=path)

    published = publisher.publish_once()
    loaded = read_dataflow_snapshot(path)

    assert published["schema"] == DATAFLOW_HEALTH_SCHEMA
    assert loaded["schema"] == DATAFLOW_HEALTH_SCHEMA
    assert loaded["process"]["component"] == "market_daemon"
    assert loaded["process"]["instance_id"] == "instance-1"
    assert loaded["context"]["generation"] == 3
    assert not list(tmp_path.glob("*.tmp"))


def test_atomic_snapshot_write_cleans_temp_file_after_replace_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "health.json"
    path.write_text('{"old":true}', encoding="utf-8")

    def fail_replace(_source, _target):
        raise OSError("simulated replace failure")

    from service.platform import atomic_files

    monkeypatch.setattr(atomic_files, "replace_file", fail_replace)
    with pytest.raises(OSError, match="replace failure"):
        dataflow_health_module.atomic_write_snapshot(path, {"new": True})

    assert path.read_text(encoding="utf-8") == '{"old":true}'
    assert not list(tmp_path.glob("*.tmp"))


def test_snapshot_publisher_start_stop_is_idempotent(tmp_path: Path) -> None:
    publisher = DataFlowSnapshotPublisher(
        DataFlowHealthLedger(component="test"),
        path=tmp_path / "health.json",
        interval_seconds=0.2,
    )

    publisher.start()
    first_thread = publisher._thread
    publisher.start()
    assert publisher._thread is first_thread

    publisher.stop(timeout=2)
    assert publisher.status()["running"] is False


def test_snapshot_publisher_keeps_thread_reference_when_stop_times_out(tmp_path: Path) -> None:
    publisher = DataFlowSnapshotPublisher(
        DataFlowHealthLedger(component="blocked"),
        path=tmp_path / "health.json",
        interval_seconds=0.2,
    )
    entered = threading.Event()
    release = threading.Event()
    original_publish = publisher.publish_once

    def blocked_publish():
        entered.set()
        release.wait(timeout=2)
        return original_publish()

    publisher.publish_once = blocked_publish
    publisher.start()
    assert entered.wait(timeout=1)
    first_thread = publisher._thread

    publisher.stop(timeout=0)
    assert publisher.status()["running"] is True
    publisher.start()
    assert publisher._thread is first_thread

    release.set()
    first_thread.join(timeout=2)
    publisher.publish_once = original_publish
    publisher.stop(timeout=2)
    assert publisher.status()["running"] is False
    assert (tmp_path / "health.json").exists()

    publisher.stop(timeout=2)
    assert publisher.status()["running"] is False


def test_concurrent_callbacks_count_every_pulse_pushed_out() -> None:
    """Pulses kept + pulses pushed out = pulses sent, with many callback threads at once."""
    ledger = DataFlowHealthLedger(component="market_daemon", hot_capacity=128)
    threads, per_thread = 8, 5_000
    start = threading.Barrier(threads)

    def produce() -> None:
        start.wait()
        for sequence in range(per_thread):
            ledger.pulse_hot_fields("ingest_accepted", lane="trade", symbol="2330", sequence=sequence)

    workers = [threading.Thread(target=produce) for _ in range(threads)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join()
    hot = ledger.snapshot()["hot_path"]
    assert hot["drained"] + hot["overflow_count"] == threads * per_thread
