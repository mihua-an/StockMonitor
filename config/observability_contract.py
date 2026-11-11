"""Python mirror of config/js/observability_contract.js (07 section 2, 06 section 5).

Python services publish their own metrics in these shapes through their existing protocol (no extra port); Health
collects and aggregates. Field names and validation rules are identical to the Node module.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any, Mapping

from config.system_contract import contract

DESCRIPTOR_SCHEMA = "stock-monitor-service-descriptor-v1"
METRIC_SCHEMA = "stock-monitor-metric-snapshot-v1"
OPERATION_SCHEMA = "stock-monitor-apply-operation-v1"

_C = contract()
_AVAILABILITY = frozenset(_C["metric_availability"])
_KINDS = frozenset(_C["metric_kinds"])


def _number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def metric(name: str, service_id: str, *, sampled_at: str | None = None, value: float | int | None = None,
           unit: str, availability: str | None = None, reason: str | None = None, kind: str = "gauge",
           instance_id: str | None = None, stream: str | None = None, window_ms: int | None = None,
           capacity: float | int | None = None, **extra: Any) -> dict[str, Any]:
    has_value = _number(value)
    if not isinstance(unit, str) or not unit:
        raise ValueError(f"metric {name}: unit must be a non-empty string")
    if kind not in _KINDS:
        raise ValueError(f"metric {name}: unknown kind {kind}")
    if window_ms is not None and not (isinstance(window_ms, int) and not isinstance(window_ms, bool) and window_ms >= 0):
        raise ValueError(f"metric {name}: window_ms must be a non-negative integer or None")
    if capacity is not None and not (_number(capacity) and capacity >= 0):
        raise ValueError(f"metric {name}: capacity must be a non-negative number or None")
    if sampled_at is not None and not (isinstance(sampled_at, str) and sampled_at):
        raise ValueError(f"metric {name}: sampled_at must be a timestamp string")
    resolved = availability or ("OK" if has_value else "NO_SAMPLE")
    if resolved not in _AVAILABILITY:
        raise ValueError(f"unknown availability {resolved}")
    if resolved == "OK" and not has_value:
        raise ValueError(f"metric {name}: OK requires a finite value")
    if resolved not in ("OK", "STALE") and has_value:
        raise ValueError(f"metric {name}: {resolved} must not carry a value")
    out: dict[str, Any] = {
        "schema": METRIC_SCHEMA, "name": name, "service_id": service_id, "instance_id": instance_id, "stream": stream,
        "sampled_at": sampled_at or now_iso(), "window_ms": window_ms, "value": value if has_value else None,
        "unit": unit, "availability": resolved, "reason": reason, "kind": kind, **extra,
    }
    if capacity is not None:
        out["capacity"] = capacity
        out["utilization"] = (value / capacity) if has_value and capacity > 0 else None
    return out


def counter(name: str, service_id: str, value: int, *, unit: str = "count", **kw: Any) -> dict[str, Any]:
    return metric(name, service_id, value=int(value), unit=unit, kind="counter", **kw)


def histogram_summary(name: str, service_id: str, samples_us: list[float], *, start: str, end: str,
                      window_ms: int, **kw: Any) -> dict[str, Any]:
    """Latency percentiles with explicit endpoints and sample count (07 section 3)."""
    if not samples_us:
        return metric(name, service_id, unit="us", availability="NO_SAMPLE", reason="no samples in window",
                      kind="histogram", window_ms=window_ms, start=start, end=end, samples=0, **kw)
    ordered = sorted(samples_us)

    def pct(p: float) -> float:
        return float(ordered[min(len(ordered) - 1, int(math.ceil(p * len(ordered))) - 1)])

    return metric(name, service_id, value=pct(0.5), unit="us", kind="histogram", window_ms=window_ms,
                  start=start, end=end, samples=len(ordered), p50=pct(0.5), p95=pct(0.95), p99=pct(0.99),
                  max=float(ordered[-1]), **kw)


def service_metrics_document(service_id: str, instance_id: str, metrics: list[Mapping[str, Any]], *,
                             config_revision: Any = None, pid: int | None = None) -> dict[str, Any]:
    return {"schema": "stock-monitor-service-metrics-v1", "service_id": service_id, "instance_id": instance_id,
            "pid": pid, "config_revision": config_revision, "sampled_at": now_iso(), "metrics": list(metrics)}
