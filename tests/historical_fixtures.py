"""Materialized partitions for tests, written the way the Rust materializer writes them: market events, then a manifest
naming their count and content hash. Rust B checks them (historical_store -> analysis_runtime --verify-partitions)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from service.platform.native_binaries import analysis_runtime_binary
from tests.online_training_fixtures import fnv1a64

needs_verifier = pytest.mark.skipif(not analysis_runtime_binary().is_file(), reason="analysis_runtime binary not built")


def event(sequence: int, *, market: str = "STK", code: str = "2330", session: str = "DAY", trading_date: str = "2026-09-23",
          exchange_ts_ns: int = 1, payload: dict | None = None) -> dict:
    # The current event format (schema 2); a source_status record is Market Runtime's own coverage control record.
    return {"schema_version": 2, "durable_sequence": sequence, "symbol": f"shioaji:{market}:{code}", "provider": "shioaji",
            "market": market, "code": code, "session": session, "trading_date": trading_date, "generation": 1,
            "sequence": sequence, "exchange_ts_ns": exchange_ts_ns,
            "time_quality": "coverage_control" if payload is None else "exchange",
            "payload": payload or {"kind": "source_status", "state": "subscribed", "detail": ""}}


def encode(lines: list[dict | str]) -> bytes:
    return "".join((line if isinstance(line, str) else json.dumps(line)) + "\n" for line in lines).encode("utf-8")


def write_partition(path: Path, lines: list[dict | str], **manifest) -> bytes:
    """events.jsonl of `lines` (a str line is written as is) and a manifest whose count and hash match it, unless
    `manifest` says otherwise. Returns the bytes written."""
    path.mkdir(parents=True, exist_ok=True)
    raw = encode(lines)
    (path / "events.jsonl").write_bytes(raw)
    (path / "manifest.json").write_text(json.dumps({"event_count": len(lines), "content_hash_fnv1a64": fnv1a64(raw),
                                                    **manifest}), encoding="utf-8")
    return raw
