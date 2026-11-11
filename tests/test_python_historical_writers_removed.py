"""C5: Python has no Historical-Materializer-equivalent writer. The Rust store is
the only historical projection source; everything below is either gone, a
read-only reader, a compute-only projector, or an explicitly classified writer."""
from __future__ import annotations

import importlib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]

GONE_MODULES = [
    "service.market.history.trade_replay_preparation_service",
    "service.market.history.trade_replay_store",
    "service.market.shioaji.stock_session_repair",
    "service.market.projection.trade_detail_store",
    "service.market.projection.trade_detail_query",
    "service.market.projection.trade_detail_projection",
    "service.market.projection.minute_trend_store",
    "service.market.projection.session_projection_store",
    "service.market.futu.materialization_requests",
    "service.market.history.wal_trade_index",
    "service.market.history.futures_trades",
    # Broker K-bar daily summaries had no writer in the product; daily and minute K are kbar_store.rs and B's state.json.
    "service.market.shioaji.broker_kbar_store",
]


@pytest.mark.parametrize("module", GONE_MODULES)
def test_python_materializer_modules_are_gone(module: str) -> None:
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module(module)


READERS = {
    "service.market.history.historical_store": ["HistoricalStore", "HistoricalMinuteTrendReader", "HistoricalSummaryReader"],
}
WRITE_NAMES = {"write", "save", "materialize", "rebuild", "repack", "publish", "finalize", "persist", "store_", "put"}


@pytest.mark.parametrize("module", sorted(READERS))
def test_readers_and_projectors_expose_no_writer_method(module: str) -> None:
    mod = importlib.import_module(module)
    for name in READERS[module]:
        cls = getattr(mod, name)
        offenders = [m for m in dir(cls) if not m.startswith("_") and any(m.startswith(w) for w in WRITE_NAMES)]
        assert offenders == [], f"{name}: {offenders}"


def test_recorder_facade_is_not_a_writer_and_delegates_to_the_ledger(tmp_path) -> None:
    from service.market.shioaji.session_evidence_gate import ShioajiSessionEvidenceGate
    from service.market.shared.partition_evidence import PartitionEvidence

    recorder = ShioajiSessionEvidenceGate(jobs_root=tmp_path / "jobs", evidence=PartitionEvidence(root=tmp_path / "evidence"))
    for name in ("publish", "publish_lossless", "publish_batch", "finalize_materialized_session",
                 "project_native_wal_segment", "trade_detail_store", "minute_trend_store", "session_summary_store"):
        assert not hasattr(recorder, name), name
    for name in ("start", "stop", "flush", "stream_metrics", "stats", "passive_health"):
        assert not hasattr(recorder, name), f"the evidence gate has no recorder lifecycle: {name}"


def test_historical_repository_has_one_read_boundary_and_no_second_store() -> None:
    text = (ROOT / "service/market/shioaji/history_repository.py").read_text(encoding="utf-8")
    for legacy in ("TradeReplayStore", "TradeDetailMaterializedStore", "MinuteTrendMaterializedStore",
                   "SessionSummaryStore", "_catalog_paths", "raw_parts(", "trade_replay_store"):
        assert legacy not in text, legacy
    assert "HistoricalStore(historical_root)" in text, "the one store, over the root the composition root passes (CX-153)"

