"""Deterministic synthetic historical store in the Rust Historical Materializer's exact layout.

Not market data and not evidence of predictive value: it exists so the training path (features ->
labels -> dataset -> training -> export -> registry) can be exercised end to end without broker data.
"""
from __future__ import annotations

import json
import random
from datetime import datetime
from pathlib import Path

from service.market.shared.session_identity_contract import market_zone, wal_session

DATES = ("2026-09-21", "2026-09-22", "2026-09-23")
CODES = ("2330", "2317", "2454", "2881")


def _ts(date: str, minute: int, second: int) -> int:
    y, m, d = (int(p) for p in date.split("-"))
    return int(datetime(y, m, d, minute // 60, minute % 60, second, tzinfo=market_zone("STK")).timestamp() * 1e9)


def write_store(root: Path, *, dates=DATES, codes=CODES, minutes=range(540, 601), seed: int = 7) -> Path:
    rng = random.Random(seed)
    sequence = 0
    partitions: dict[Path, list[dict]] = {}
    idx_session = wal_session("shioaji", "IDX")

    def emit(market, code, session, date, kind, minute, second, payload):
        nonlocal sequence
        sequence += 1
        event = {"schema_version": 2, "durable_sequence": sequence, "symbol": f"shioaji:{market}:{code}", "provider": "shioaji",
                 "market": market, "code": code, "session": session, "trading_date": date, "generation": 1,
                 "sequence": sequence, "exchange_ts_ns": _ts(date, minute, second), "arrival_ns": 1,
                 "payload": {"kind": kind, **payload}}
        path = root / f"source=shioaji/market={market}/trading_date={date}/session={session}/{code}/events.jsonl"
        partitions.setdefault(path, []).append(event)

    for date in dates:
        prices = {code: 100.0 + 20 * i for i, code in enumerate(codes)}
        index = 20000.0
        for minute in minutes:
            index *= 1 + rng.gauss(0, 0.0008)
            emit("IDX", "TAIEX", idx_session, date, "quote", minute, 0,
                 {"current": int(index * 1e4), "prev_close": 200000000, "open": 200000000, "high": 0, "low": 0,
                  "total_volume": 0, "total_amount": 0.0, "status": rng.choice(["Open", "", " "]), "minute": minute,
                  "average": 0, "volume": 0, "amount": 0.0})
            for code in codes:
                if rng.random() < 0.15:
                    continue  # a no-trade minute for this code
                for second in sorted(rng.sample(range(1, 59), rng.randint(1, 4))):
                    prices[code] *= 1 + rng.gauss(0, 0.004)
                    units = int(round(prices[code], 2) * 1e4)
                    emit("STK", code, "DAY", date, "trade", minute, second,
                         {"price": units, "volume": rng.randint(1, 30), "total_volume": 0,
                          "side": rng.choice([1, -1, 0]), "trade_id": "", "minute": minute,
                          "prev_close": 1000000, "open": 0, "high": 0, "low": 0, "average": 0,
                          "total_amount": 0.0, "amount": 0.0})
                if rng.random() < 0.3:
                    mid = int(round(prices[code], 2) * 1e4)
                    emit("STK", code, "DAY", date, "order_book", minute, 30,
                         {"bids": [{"price": mid - 500 * i, "volume": rng.randint(1, 50)} for i in range(1, 6)],
                          "asks": [{"price": mid + 500 * i, "volume": rng.randint(1, 50)} for i in range(1, 6)]})
    for path, events in partitions.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        data = ("\n".join(json.dumps(e) for e in events) + "\n").encode("utf-8")
        path.write_bytes(data)
        # Committed the way the Rust Historical Materializer commits: the manifest (count + content hash) last.
        (path.parent / "manifest.json").write_text(json.dumps(
            {"schema": "historical-materialization-v1", "event_count": len(events), "content_hash_fnv1a64": fnv1a64(data),
             "completeness": "complete"}), encoding="utf-8")
    return root


def fnv1a64(data: bytes) -> str:
    value = 0xCBF29CE484222325
    for byte in data:
        value = ((value ^ byte) * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"{value:016x}"
