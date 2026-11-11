"""The Shioaji daemon's provider verdict must survive the REAL daemon -> FastAPI chain, not only a faked cache.

FastAPI never builds its cache from /v1/health: it reads the daemon's passive DataFlow snapshot, written by
`DataFlowSnapshotPublisher` with `enrich=passive_runtime_health_payload`. This drives the actual chain:

    backend.shioaji.daemon_health.passive_runtime_health_payload()     (the daemon's real enrich)
    -> DataFlowSnapshotPublisher.publish_once()                (real snapshot file)
    -> read_dataflow_snapshot + assess_passive_health_snapshot  (what MarketDaemonClient reads)
    -> the producer block FastAPI adopts as cached_health()
"""
from __future__ import annotations

import time

import backend.shioaji.server as server
from backend.shioaji.daemon_health import passive_runtime_health_payload
from service.market.shared.dataflow_health import (
    DataFlowHealthLedger,
    DataFlowSnapshotPublisher,
    read_dataflow_snapshot,
)
from service.market.shioaji.daemon_contract import MARKET_DAEMON_IDENTITY
from service.market.shioaji.daemon_probe import assess_passive_health_snapshot


def _through_the_chain(tmp_path) -> dict:
    path = tmp_path / "market_daemon.json"
    publisher = DataFlowSnapshotPublisher(
        DataFlowHealthLedger(component="market_daemon", instance_id="test"),
        component="market_daemon", path=path,
        enrich=lambda: passive_runtime_health_payload(server.daemon_context, include_sessions=True))
    publisher.publish_once()
    passive = assess_passive_health_snapshot(
        read_dataflow_snapshot(path), now_epoch_ns=time.time_ns(), max_age_seconds=6.0)
    assert passive["snapshot_fresh"], passive
    producer = dict(passive["producer"])
    assert producer.get("identity") == MARKET_DAEMON_IDENTITY, "premise: FastAPI adopts only this identity"
    return producer


def test_the_shioaji_source_status_reaches_the_cache_fastapi_builds(tmp_path, monkeypatch):
    """Items 14/15, found by the packaged run: /api/status showed Shioaji as
    'starting / DAEMON_STATUS_UNAVAILABLE' while ticks were flowing, because the passive snapshot
    FastAPI reads had no source_status at all. A started runtime with a connected provider and a
    running sink must reach FastAPI as a real verdict, not the placeholder."""
    from types import SimpleNamespace

    from service.market.shared.provider_contract import provider_readiness

    readiness = provider_readiness(provider="shioaji", connected=True, worker_alive=True, market_data_ready=True)
    service = SimpleNamespace(
        broker_service=SimpleNamespace(lightweight_status=lambda: {
            "provider": "shioaji", "readiness": readiness, "connected": True, "running": True,
            "session_generation": 1, "last_error": None}),
        live_event_sink=SimpleNamespace(health=lambda: {"running": True}),
    )
    runtime = server.daemon_context.runtime
    monkeypatch.setattr(runtime, "service", service, raising=False)
    monkeypatch.setattr(runtime, "_lifecycle", "started")
    monkeypatch.setattr(runtime, "_services_started", True)
    monkeypatch.setattr(runtime, "last_error", None, raising=False)

    status = _through_the_chain(tmp_path).get("source_status")
    assert status is not None, "the snapshot FastAPI reads must carry the provider's own verdict"
    assert status["reason"] != "DAEMON_STATUS_UNAVAILABLE"
    assert status["lifecycle"] == "started" and status["services_started"] is True
    assert status["health"] in {"ready", "idle"}, status
