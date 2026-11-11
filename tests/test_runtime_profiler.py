"""The runtime profiler's snapshot is a service metrics document: each timing names its instance, unit and sample
window, and the window's sample count is apart from the total observed since the process started."""
from __future__ import annotations

from service.monitoring.runtime_profiler import RuntimeProfiler


def test_snapshot_is_a_metrics_document_with_window_and_total_counts():
    profiler = RuntimeProfiler(max_samples_per_metric=3)
    for value in range(10):
        profiler.observe("tick_path", value)
    profiler.startup_mark("ready", elapsed_ms=12.5)
    doc = profiler.snapshot(service_id="provider_shioaji", instance_id="i-1")
    assert doc["schema"] == "stock-monitor-service-metrics-v1" and doc["instance_id"] == "i-1" and doc["pid"]
    timing, startup = doc["metrics"]
    assert timing["schema"] == "stock-monitor-metric-snapshot-v1" and timing["name"] == "timing.tick_path"
    assert (timing["unit"], timing["kind"], timing["availability"]) == ("ms", "histogram", "OK")
    assert timing["samples"] == 3 and timing["total_count"] == 10, "the kept window is not the total"
    assert timing["p50"] == 8.0 and timing["max"] == 9.0 and isinstance(timing["window_ms"], int)
    assert (startup["name"], startup["value"], startup["kind"]) == ("startup.ready", 12.5, "gauge")
