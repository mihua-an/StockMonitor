"""Measure Shioaji callback-to-native ingress latency and admission pressure.

This benchmark never contacts a broker.  It exercises the production callback
adapter with a deterministic native stub, then emits JSON suitable for comparing
builds.  ``--slow-push-ms`` models a saturated native consumer.
"""
from __future__ import annotations

import argparse
import json
import collections
import threading
import sys
import time
from pathlib import Path
# A direct `python <this file>` run: every entry script sits two levels below the project root.
_ROOT = str(Path(__file__).resolve().parents[2])
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
from service.platform.project_root import PROJECT_ROOT
from types import SimpleNamespace

if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from service.market.shioaji.callback import ShioajiThinCallbackAdapter


class _Native:
    price_scale = 10000
    def __init__(self, capacity: int, slow_ms: float, mode: str):
        # Checked here too, not only on the command line: run() called directly with capacity 0 made a
        # blocking push wait forever on an empty queue.
        if isinstance(capacity, bool) or not isinstance(capacity, int) or capacity <= 0:
            raise ValueError(f"capacity must be a positive integer, got {capacity!r}")
        if not slow_ms >= 0:
            raise ValueError(f"slow_ms must be >= 0, got {slow_ms!r}")
        if mode not in ("nonblocking", "blocking"):
            raise ValueError(f"mode must be nonblocking or blocking, got {mode!r}")
        self.capacity = capacity
        self.slow_ms = slow_ms
        self.mode = mode
        self.queue = collections.deque()
        self.lock = threading.Condition()
        self.stop = False
        self.max_depth = 0
        self.accepted = 0
        self.rejected = 0
        self.worker = threading.Thread(target=self._drain, daemon=True)
        self.worker.start()

    def _drain(self):
        while True:
            with self.lock:
                while not self.queue and not self.stop:
                    self.lock.wait(0.01)
                if self.stop and not self.queue:
                    return
                self.queue.popleft()
                self.lock.notify_all()
            if self.slow_ms:
                time.sleep(self.slow_ms / 1000)

    def close(self):
        with self.lock:
            self.stop = True
            self.lock.notify_all()
        self.worker.join(timeout=2)

    def push_tick(self, *args, **kwargs):
        with self.lock:
            while len(self.queue) >= self.capacity and self.mode == "blocking" and not self.stop:
                self.lock.wait(0.001)
            if self.stop or len(self.queue) >= self.capacity:
                self.rejected += 1
                return False
            self.queue.append(1)
            self.max_depth = max(self.max_depth, len(self.queue))
            self.accepted += 1
            self.lock.notify()
            return True

    def push_bidask(self, *args, **kwargs):
        return self.push_tick(*args, **kwargs)


def _owner(native):
    return SimpleNamespace(
        native_runtime=native, _symbol_ids={"2330": 1},
        _price_scale_errors=0, _last_callback_epoch_ns=0,
        _int_value=lambda value: int(value or 0), _number=lambda value: value,
        _exchange_text=lambda value: str(value), _flag_bits=lambda value: 0,
        _mark_subscription_event=lambda *args, **kwargs: None,
        _timestamp_fields=lambda value: {"datetime": str(getattr(value, "datetime", ""))},
        TAIEX_CODE="IX0001", TXF_CODE="TXFR1",
        _value=lambda obj, name, default=None: getattr(obj, name, default),
    )


def _tick(i):
    return SimpleNamespace(code="2330", datetime=f"2026-09-09 09:00:{i % 60:02d}",
                            close=100, price_chg=0, open=100, high=101, low=99,
                            avg_price=100, volume=1, total_volume=i + 1,
                            total_amount=100, tick_type=1, pct_chg=0, chg_type=0,
                            bid_side_total_vol=0, ask_side_total_vol=0,
                            suspend=False, amount=100, simtrade=False)


def run(rate: int, duration: float, capacity: int, slow_ms: float, mode: str):
    native = _Native(capacity, slow_ms, mode)
    owner = _owner(native)
    adapter = ShioajiThinCallbackAdapter(owner)
    latencies = []
    sent = max(1, int(rate * duration))
    start = time.perf_counter()
    for i in range(sent):
        target = start + (i / rate)
        remaining = target - time.perf_counter()
        if remaining > 0:
            time.sleep(remaining)
        started = time.perf_counter_ns()
        adapter.on_stock_tick("TSE", _tick(i))
        latencies.append((time.perf_counter_ns() - started) / 1_000_000)
    elapsed = max(time.perf_counter() - start, 1e-9)
    native.close()
    latencies.sort()
    pct = lambda p: latencies[min(len(latencies) - 1, max(0, int(len(latencies) * p) - 1))] if latencies else 0.0
    return {"rate_target_per_sec": rate, "events": sent,
            "throughput_per_sec": round(sent / elapsed, 2),
            "callback_latency_ms": {"p50": round(pct(.50), 4), "p95": round(pct(.95), 4),
                                    "p99": round(pct(.99), 4), "p99_9": round(pct(.999), 4),
                                    "max": round(max(latencies or [0]), 4)},
            "native": {"accepted": native.accepted, "rejected": native.rejected,
                       "queue_capacity": capacity, "max_depth": native.max_depth,
                       "queue_depth_end": len(native.queue), "slow_push_ms": slow_ms,
                       "full_policy": "reject_newest" if mode == "nonblocking" else "wait_for_space",
                       "mode": mode}}


def _positive(kind):
    # capacity=0 made a blocking push wait forever on an empty queue; rates/duration must be > 0 too.
    def parse(text):
        value = kind(text)
        if not value > 0:
            raise argparse.ArgumentTypeError(f"must be > 0, got {text}")
        return value
    return parse


def _non_negative(kind):
    def parse(text):
        value = kind(text)
        if not value >= 0:
            raise argparse.ArgumentTypeError(f"must be >= 0, got {text}")
        return value
    return parse


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--duration", type=_positive(float), default=1.0)
    parser.add_argument("--capacity", type=_positive(int), default=1024)
    parser.add_argument("--slow-push-ms", type=_non_negative(float), default=0.0)
    parser.add_argument("--mode", choices=("nonblocking", "blocking"), default="nonblocking")
    parser.add_argument("--rates", default="1000,5000,10000,20000")
    args = parser.parse_args()
    rates = [_positive(int)(rate) for rate in args.rates.split(",") if rate.strip()]
    rows = [run(rate, args.duration, args.capacity, args.slow_push_ms, args.mode) for rate in rates]
    print(json.dumps({"benchmark": "shioaji_callback_ingress", "rows": rows}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
