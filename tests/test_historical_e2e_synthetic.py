"""Synthetic end-to-end closure of the historical write->read chain (no broker):

sealed synthetic session (WAL)
  -> intent proposed by a reader/API
  -> SessionOrchestrator (session owner) decides + submits through its ledger
  -> Rust Historical Materializer (the real binary)
  -> historical store
  -> HistoricalStore / repository / summary / panel readers
  -> training_ready flips only after materialization succeeded.
"""
from __future__ import annotations

import json
import struct
import subprocess
import zlib
from datetime import datetime, timezone, timedelta
from pathlib import Path

import pandas as pd
import pytest

from service.market.history.historical_store import (
    HistoricalMinuteTrendReader, HistoricalStore, HistoricalSummaryReader,
)
from service.market.lifecycle.rollover import SessionOrchestrator
from service.market.shared import materialization_ledger as ml
from service.market.shioaji.session_evidence_gate import ShioajiSessionEvidenceGate
from tests.market_runtime_evidence_fake import FakeMarketRuntimeEvidence
from tests import synthetic_runtime as rt

BINARY = rt.MATERIALIZER_EXE  # its --materialize mode
DATE = "2026-09-08"
TAIPEI = timezone(timedelta(hours=8))

rt.require_binaries(BINARY)


def _stored(store, market, code, date, kind, session=""):
    """The payloads of one kind the materializer stored in the partition(s), in durable order."""
    return [e["payload"] for e in store.iter_events(market, code, date, session) if (e.get("payload") or {}).get("kind") == kind]


def _tape_side(trade):
    """The side a print shows (event.rs tape_side): a call-auction, 盤後定價 or no-last-sale print has none."""
    return 0 if trade.get("auction") or trade.get("after_hours") or trade.get("no_last_sale") else trade["side"]


def _ns(hh: int, mm: int, ss: int) -> int:
    return int(datetime(2026, 9, 8, hh, mm, ss, tzinfo=TAIPEI).timestamp() * 1_000_000_000)


def _event(seq, symbol, market, code, ts, payload):
    return {"schema_version": 2, "durable_sequence": seq, "symbol": symbol, "provider": "shioaji", "market": market, "code": code,
            "session": "DAY", "trading_date": DATE, "generation": 1, "sequence": seq,
            "exchange_ts_ns": ts, "arrival_ns": ts + 5_000_000, "payload": payload}


def _trade(price, volume, total, side, minute, tid):
    return {"kind": "trade", "price": int(price * 10_000), "volume": volume, "total_volume": total, "side": side,
            "trade_id": tid, "minute": minute, "open": 1_000_000, "high": 1_020_000,
            "low": 1_000_000, "average": 1_010_000, "total_amount": 0.0, "amount": 0.0}


def write_wal(directory: Path, events: list[dict]) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    body = b"STKMWAL1"
    for event in events:
        payload = json.dumps(event, separators=(",", ":")).encode()
        body += struct.pack("<I", len(payload)) + payload + struct.pack("<I", zlib.crc32(payload) & 0xFFFFFFFF)
    (directory / f"wal-{1:020d}.bin").write_bytes(body)


@pytest.fixture()
def synthetic(tmp_path):
    wal = tmp_path / "wal"
    events = [
        _event(1, "shioaji:STK:2330", "STK", "2330", _ns(9, 0, 1), _trade(100.0, 2, 2, 1, 540, "t1")),
        _event(2, "shioaji:STK:2330", "STK", "2330", _ns(9, 0, 30), _trade(101.0, 3, 5, 1, 540, "t2")),
        _event(3, "shioaji:STK:2330", "STK", "2330", _ns(9, 1, 2), _trade(102.0, 1, 6, -1, 541, "t3")),
        _event(4, "shioaji:STK:2330", "STK", "2330", _ns(9, 1, 3),
               {"kind": "order_book", "bids": [{"price": 1_010_000, "volume": 5}], "asks": [{"price": 1_020_000, "volume": 7}]}),
        _event(5, "shioaji:STK:2317", "STK", "2317", _ns(9, 0, 5), _trade(500.0, 1, 1, 1, 540, "u1")),
        _event(6, "shioaji:IDX:TAIEX", "IDX", "TAIEX", _ns(9, 0, 10),
               {"kind": "quote", "current": 220_000_000, "open": 219_500_000,
                "high": 220_500_000, "low": 219_000_000, "total_volume": 0, "total_amount": 0.0, "status": "live",
                "minute": 540, "average": 0, "volume": 0, "amount": 0.0}),
        # 昨收 is a partition's Reference event, never a field of a print or a quote (D01-02).
        _event(7, "shioaji:STK:2330", "STK", "2330", _ns(9, 0, 2), {"kind": "reference", "prev_close": 990_000}),
        _event(8, "shioaji:IDX:TAIEX", "IDX", "TAIEX", _ns(9, 0, 11), {"kind": "reference", "prev_close": 219_000_000}),
    ]
    write_wal(wal, events)
    return tmp_path, wal


def run_health_job(pending_file: Path, wal: Path, out: Path, jobs: Path) -> dict:
    """What Health's job runner does for one request (spawn the Rust job, write done/<id>.json)."""
    request = json.loads(pending_file.read_text(encoding="utf-8"))
    proc = subprocess.run(
        [str(BINARY), "--materialize", "--data-dir", str(wal), "--out-dir", str(out), "--source", request["source"],
         "--market", request["market"], "--code", request["code"],
         "--logical-code", request.get("logical_code") or request["code"], "--trading-date", request["trading_date"],
         "--session", request["session"], "--completeness", request["completeness"]],
        capture_output=True, text=True, timeout=60,
    )
    result = json.loads(proc.stdout.strip().splitlines()[-1])
    (jobs / "done").mkdir(parents=True, exist_ok=True)
    (jobs / "done" / f"{request['job_id']}.json").write_text(json.dumps({"schema": "materialization-job-result-v1", "job_id": request["job_id"], "request": request, **result}))
    pending_file.unlink()
    return result


def test_sealed_session_flows_owner_to_materializer_to_readers(synthetic):
    tmp, wal = synthetic
    jobs, out = tmp / "jobs", tmp / "historical"
    recorder = ShioajiSessionEvidenceGate(jobs_root=jobs, evidence=FakeMarketRuntimeEvidence(tmp / "evidence"))
    recorder._historical = HistoricalStore(out)
    from types import SimpleNamespace
    for market in ("STK", "IDX"):  # the session's records as Market Runtime keeps them
        marker = SimpleNamespace(source="shioaji", market=market, trading_date=DATE, session="DAY", exchange_ts_ns=1)
        recorder.session_evidence.stored(marker)

    # 1. Before materialization: reader reports unavailable and training is NOT ready.
    store = HistoricalStore(out)
    assert store.availability("STK", "2330", DATE)["state"] == "unavailable"
    assert _stored(store, "STK", "2330", DATE, "trade") == []
    early = recorder.evaluate_session(market="STK", trading_date=DATE, session="DAY")
    assert early["historical_materialized"] is False and early["training_ready"] is False
    assert {v["state"] for v in early["materialized"]["jobs"].values()} == {"not_requested"}
    assert set(early["materialized"]["jobs"]) == {f"STK:{DATE}:DAY", f"IDX:{DATE}:DAY"}

    # 2. A reader/API proposes an intent; the session OWNER decides and submits (deduped).
    for _ in range(3):
        ml.propose_intent("shioaji", "STK", DATE, jobs_root=jobs, reason="user_replay")
        ml.propose_intent("shioaji", "IDX", DATE, jobs_root=jobs, reason="user_replay")
    orchestrator = SessionOrchestrator(app_provider=lambda: SimpleNamespace(live_event_sink=SimpleNamespace(evidence=recorder.session_evidence)), manifest_dir=tmp / "finalization",
                                       materialization_jobs_root=jobs)
    orchestrator._is_sealed = lambda market, trading_date, session='': True
    # 2026-09-08 is long past the WAL's hard cap today: the daily prune would take the finished session's records at
    # once. This test follows the session through its flow, not its retention.
    orchestrator._prune_closed_sessions = lambda: None
    assert orchestrator.process_materialization_intents() == 2
    pending = sorted((jobs / "pending").glob("*.json"))
    assert len(pending) == 2, "one STK session job + one IDX session job; never per-read jobs"
    orchestrator.process_materialization_intents()
    assert len(sorted((jobs / "pending").glob("*.json"))) == 2

    # 3. Health runs the real Rust job for each request.
    results = [run_health_job(path, wal, out, jobs) for path in pending]
    assert all(r["ok"] and r["status"] == "materialized" for r in results)

    # 4. The owner consumes results; only now is the session materialized.
    orchestrator.poll_materialization_jobs()
    assert {r["state"] for r in orchestrator._ledger.records()} == {ml.SUCCEEDED}

    # 5. Readers read the historical store.
    trades = _stored(store, "STK", "2330", DATE, "trade")
    assert [t["price"] for t in trades] == [1_000_000, 1_010_000, 1_020_000]
    # The session's first print in the 09:00 minute is the opening call-auction match: 不分內外盤, side 0, whatever the
    # broker's tick_type (the materializer classifies a recording as the ingest does, Engine::classify_recorded).
    assert [_tape_side(t) for t in trades] == [0, 1, -1]
    assert [r["prev_close"] for r in _stored(store, "STK", "2330", DATE, "reference")] == [990_000], "the partition's Reference"
    assert len(_stored(store, "STK", "2330", DATE, "order_book")) == 1
    trend = store.minute_trend("2330", DATE, market="STK")
    assert list(trend["minute_volume"]) == [5, 1]
    assert trend["minute_timestamp"].iloc[0] == pd.Timestamp(f"{DATE} 09:00:00")
    summary = HistoricalSummaryReader(store).load_any_contract(market="STK", trading_date=DATE, session="DAY", logical_code="2330")
    assert summary["provenance"] == "rust_historical_materializer" and summary["close"] == 102.0
    assert store.list_codes(DATE, "STK") == ["2317", "2330"]
    assert store.minute_trend("TAIEX", DATE, market="IDX")["price"].iloc[0] == 22000.0, "B's minute of the index quote"
    assert store.summary("TAIEX", DATE, market="IDX", session="DAY")["prev_close"] == 21900.0
    assert summary["prev_close"] == 99.0
    assert HistoricalMinuteTrendReader(store).catchup_status(
        type("Id", (), {"market": "STK", "logical_code": "2330", "trading_date": DATE, "session": "DAY"}))["ok"]

    # 6. training_ready flips only after evidence AND materialization are both ready.
    late = recorder.evaluate_session(market="STK", trading_date=DATE, session="DAY")
    assert late["historical_materialized"] is True
    assert late["evidence_ready"] is True and late["training_ready"] is True


def test_repository_reads_only_the_rust_store_and_reports_unavailable_otherwise(synthetic):
    from service.market.shioaji.history_repository import ShioajiHistoricalRepository

    tmp, wal = synthetic
    out = tmp / "historical"
    from service.market.storage.market_storage_layout import MarketStorageLayout

    repo = ShioajiHistoricalRepository(lambda: None, layout=MarketStorageLayout(data_root=tmp / "data"), historical_root=out)
    # Every path is the given layout's, none the process's data root.
    assert repo.historical.root == out
    assert _stored(repo.historical, "STK", "2330", DATE, "trade") == []
    request = {"source": "shioaji", "market": "STK", "code": "*", "logical_code": "*", "trading_date": DATE, "session": "DAY", "completeness": "complete"}
    jobs = tmp / "jobs"
    (jobs / "pending").mkdir(parents=True)
    pending = jobs / "pending" / "j.json"
    pending.write_text(json.dumps({**request, "job_id": "j"}))
    run_health_job(pending, wal, out, jobs)
    assert len(_stored(repo.historical, "STK", "2330", DATE, "trade")) == 3
    assert len(_stored(repo.historical, "STK", "2330", DATE, "order_book")) == 1
    assert repo.list_materialized_dates() == [DATE] and repo.list_materialized_codes(DATE) == ["2317", "2330"]


def test_the_data_center_reads_rust_bs_date_index_and_gets_the_manifests_numbers(synthetic, monkeypatch):
    """資料中心's date list and expanded date read the date index Rust B writes when it publishes (totals.json) and
    give the numbers the partition manifests give -- without reading one manifest."""
    from service.market.query.data_center_service import DataCenterService
    from service.market.query.historical_catalog import HistoricalEvidenceCatalog

    tmp, wal = synthetic
    out, jobs = tmp / "historical", tmp / "jobs"
    (jobs / "pending").mkdir(parents=True)
    for market in ("STK", "IDX"):
        pending = jobs / "pending" / f"{market}.json"
        pending.write_text(json.dumps({"source": "shioaji", "market": market, "code": "*", "logical_code": "*", "trading_date": DATE,
                                       "session": "DAY", "completeness": "complete", "job_id": market}))
        assert run_health_job(pending, wal, out, jobs)["status"] == "materialized"
    store = HistoricalStore(out)
    # What the manifests say, read the way the date list read them before.
    kinds = {"trade": "tick", "orderbook": "bidask", "quote": "quote"}
    expected = {"rows": {}, "bytes": 0, "products": 0}
    for market in ("STK", "IDX"):
        for manifest in store.list_partitions(market, DATE):
            expected["products"] += 1
            expected["bytes"] += int(manifest["events_bytes"])
            for lane, report in manifest["lane_report"].items():
                if lane in kinds:
                    expected["rows"][kinds[lane]] = expected["rows"].get(kinds[lane], 0) + int(report["events"])
    assert expected["rows"] == {"tick": 4, "bidask": 1, "quote": 1} and expected["bytes"] > 0

    monkeypatch.setattr(HistoricalStore, "list_partitions", lambda *_: pytest.fail("資料中心 read a partition manifest"))
    service = DataCenterService(HistoricalEvidenceCatalog(store), stock_markets=lambda: {"2330": "tse", "2317": "tse"},
                                materialization_status=lambda *_args, **_kw: {"state": "succeeded"}, day_complete=lambda _date: True)
    [day] = service.dates()["items"]
    assert day["date"] == DATE
    assert day["storage"]["ALL"] == {**expected, "industry_index_rows": 0}
    categories = {item["id"]: item for item in service.date_categories(DATE)["categories"]}
    assert categories["tse"]["products"] == 2 and categories["tse"]["rows"] == {"tick": 4, "bidask": 1, "quote": 0}
    assert categories["taiex"]["rows"]["quote"] == 1
    assert categories["tse"]["bytes"] + categories["taiex"]["bytes"] == expected["bytes"]
