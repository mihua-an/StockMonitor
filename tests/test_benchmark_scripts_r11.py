"""The benchmark scripts' own arithmetic and argument checks."""
from __future__ import annotations

import itertools

from scripts.benchmark import sample_shioaji_shards as sampler


def test_throughput_is_the_delta_between_two_samples_over_their_spacing(monkeypatch):
    clock = itertools.count(start=100.0, step=5.0)       # each monotonic() call advances 5 s
    reads = iter([{"shards_detail": [{"shard": 0, "tick_processed": 1_000_000, "bidask_processed": 10}]},
                  {"shards_detail": [{"shard": 0, "tick_processed": 1_000_300, "bidask_processed": 40}]}])
    monkeypatch.setattr(sampler, "fetch", lambda url: next(reads))
    monkeypatch.setattr(sampler.time, "monotonic", lambda: next(clock))
    monkeypatch.setattr(sampler.time, "sleep", lambda s: None)
    rows = sampler.sample_windows("http://x/health", windows=2, interval=0)["windows"]
    assert rows[0]["shards"][0]["tick_throughput"] is None, "no earlier sample: no rate, never lifetime/fetch time"
    second = rows[1]["shards"][0]
    # Samples at t=105 and t=120 (monotonic is read before and after each fetch, and once for the sleep).
    assert second["tick_throughput"] == round(300 / 15.0, 2)
    assert second["bidask_throughput"] == round(30 / 15.0, 2)


def test_ingress_benchmark_refuses_a_capacity_that_would_block_forever():
    import pytest

    from scripts.benchmark import benchmark_shioaji_ingress as bench

    for capacity in (0, -1, True):
        with pytest.raises(ValueError):
            bench.run(rate=10, duration=0.01, capacity=capacity, slow_ms=0.0, mode="blocking")
