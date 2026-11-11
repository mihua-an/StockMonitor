"""Multi-window live sampler for native Shioaji shard consumers.

This is observation-only: it reads the daemon health endpoint and never sends
events or changes runtime scheduling.  It intentionally requires a bottleneck
to repeat across windows and shards before reporting it as actionable.
"""
from __future__ import annotations

import argparse
import json
import time
from collections import Counter
from datetime import datetime, timezone
from urllib.request import urlopen


def fetch(url: str) -> dict:
    with urlopen(url, timeout=3) as response:  # noqa: S310 - operator supplied local URL
        return json.loads(response.read().decode("utf-8"))


def _rate(current: int, prior: dict | None, key: str, sampled_at: float) -> float | None:
    """Events per second between two samples of the same shard: the counter delta over the time between
    the two health reads. The first window has no earlier sample, so it has no rate -- never the daemon's lifetime
    total divided by one fetch's duration."""
    if prior is None:
        return None
    span = sampled_at - prior["sampled_at"]
    if span <= 0:
        return None
    return round(max(0, current - int(prior.get(key, 0))) / span, 2)


def sample_windows(url: str, windows: int, interval: float) -> dict:
    previous: dict[int, dict] = {}
    rows: list[dict] = []
    repeat = Counter()
    for window in range(1, windows + 1):
        started = time.monotonic()
        health = fetch(url)
        sampled_at = time.monotonic()
        shards = health.get("shards_detail") or []
        shard_rows = []
        for raw in shards:
            shard = int(raw.get("shard", -1))
            prior = previous.get(shard)
            tick_n = int(raw.get("tick_processed", 0) or 0)
            bidask_n = int(raw.get("bidask_processed", 0) or 0)
            stage_ratios = {
                key.removesuffix("_ratio"): float(value or 0)
                for key, value in raw.items() if key.endswith("_ratio")
            }
            dominant_stage = max(stage_ratios, key=stage_ratios.get) if stage_ratios else "none"
            tail = {
                "tick": float(raw.get("tick_processing_p99_ns", 0) or 0),
                "bidask": float(raw.get("bidask_processing_p99_ns", 0) or 0),
            }
            dominant_tail = max(tail, key=tail.get) if max(tail.values()) > 0 else "none"
            if dominant_stage != "none":
                repeat[(shard, dominant_stage)] += 1
            shard_rows.append({
                "shard": shard,
                "tick_throughput": _rate(tick_n, prior, "tick_processed", sampled_at),
                "bidask_throughput": _rate(bidask_n, prior, "bidask_processed", sampled_at),
                "tick_processed": tick_n,
                "bidask_processed": bidask_n,
                "stage_ratio": stage_ratios,
                "tick_p95_ns": raw.get("tick_processing_p95_ns", 0),
                "tick_p99_ns": raw.get("tick_processing_p99_ns", 0),
                "bidask_p95_ns": raw.get("bidask_processing_p95_ns", 0),
                "bidask_p99_ns": raw.get("bidask_processing_p99_ns", 0),
                "dominant_stage": dominant_stage,
                "dominant_tail": dominant_tail,
            })
            previous[shard] = {"tick_processed": tick_n, "bidask_processed": bidask_n, "sampled_at": sampled_at}
        rows.append({
            "window": window,
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "fetch_seconds": round(max(sampled_at - started, 1e-6), 4),
            "queue_pressure_ratio": health.get("pressure_ratio"),
            "tick_queue_full": (health.get("tick") or {}).get("queue_full"),
            "bidask_queue_full": (health.get("bidask") or {}).get("queue_full"),
            "tick_rejected": (health.get("tick") or {}).get("rejected"),
            "bidask_rejected": (health.get("bidask") or {}).get("rejected"),
            "shards": shard_rows,
        })
        if window < windows:
            time.sleep(max(0.0, interval - (time.monotonic() - started)))
    repeated = [
        {"shard": shard, "bottleneck": bottleneck, "windows": count}
        for (shard, bottleneck), count in repeat.items()
        if count >= 2
    ]
    return {"source": url, "windows": rows,
            "repeated_bottlenecks": repeated,
            "rule": "actionable only when repeated in >=2 windows; compare across shards before optimizing"}


def main() -> None:
    parser = argparse.ArgumentParser()
    # A standalone, no-project-import sampler that may point at a remote host: it holds no copy of the daemon's
    # address, so the health URL is always given.
    parser.add_argument("--url", required=True, help="the Shioaji daemon's /health URL, e.g. http://<host>:<port>/health")
    parser.add_argument("--windows", type=int, default=6)
    parser.add_argument("--interval", type=float, default=60.0)
    parser.add_argument("--output")
    args = parser.parse_args()
    result = sample_windows(args.url, max(1, args.windows), max(0.1, args.interval))
    payload = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as handle:
            handle.write(payload + "\n")
    print(payload)


if __name__ == "__main__":
    main()
