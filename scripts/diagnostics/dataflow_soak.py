"""Read-only full-session soak recorder for the local data-flow ledgers (diagnostic tool, not a production dependency).

Reads producer-owned evidence: dataflow ledger snapshots (component names are
the producers' own: market_daemon, fastapi_gateway) and Health's
output/health_supervisor.json status file.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path
# A direct `python <this file>` run: every entry script sits two levels below the project root.
_ROOT = str(Path(__file__).resolve().parents[2])
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
from service.platform.project_root import OUTPUT_ROOT, PROJECT_ROOT
from typing import Any

ROOT = PROJECT_ROOT
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from service.market.shared.dataflow_health import dataflow_snapshot_path, read_dataflow_snapshot
import logging
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except FileNotFoundError:  # not an error: no snapshot yet
        return {}
    except (OSError, ValueError, TypeError) as exc:
        record_failure(_failure_log, "reading a dataflow snapshot", exc)
        return {}


def _sample(project_root: Path) -> dict[str, Any]:
    market = read_dataflow_snapshot(dataflow_snapshot_path("market_daemon"))
    gateway = read_dataflow_snapshot(dataflow_snapshot_path("fastapi_gateway"))
    supervisor = _read_json(OUTPUT_ROOT / "health_supervisor.json")
    return {
        "captured_at": datetime.now().astimezone().isoformat(timespec="milliseconds"),
        "supervisor": {
            "state": supervisor.get("state"),
            "healthy": supervisor.get("healthy"),
            "reasons": supervisor.get("reasons") or [],
            "observer_pid": supervisor.get("observer_pid"),
        },
        "market": {
            "revision": market.get("revision"),
            "process": market.get("process") or {},
            "context": market.get("context") or {},
            "component_state": market.get("component_state") or {},
            "stages": market.get("stages") or {},
        },
        "gateway": {
            "revision": gateway.get("revision"),
            "process": gateway.get("process") or {},
            "component_state": gateway.get("component_state") or {},
            "stages": gateway.get("stages") or {},
        },
    }


def _summary(samples: list[dict[str, Any]], *, started_at: str, finished_at: str) -> dict[str, Any]:
    states: dict[str, int] = {}
    reasons: dict[str, int] = {}
    market_instances: set[str] = set()
    gateway_instances: set[str] = set()
    revisions = {"market": [], "gateway": []}
    for sample in samples:
        supervisor = sample.get("supervisor") or {}
        state = str(supervisor.get("state") or "MISSING")
        states[state] = states.get(state, 0) + 1
        for reason in supervisor.get("reasons") or []:
            key = str(reason)
            reasons[key] = reasons.get(key, 0) + 1
        for key, instances in (("market", market_instances), ("gateway", gateway_instances)):
            block = sample.get(key) or {}
            instance = str((block.get("process") or {}).get("instance_id") or "")
            if instance:
                instances.add(instance)
            revision = block.get("revision")
            if isinstance(revision, int):
                revisions[key].append(revision)
    return {
        "schema": "stock-monitor-dataflow-soak-summary-v1",
        "started_at": started_at,
        "finished_at": finished_at,
        "sample_count": len(samples),
        "supervisor_states": states,
        "reason_counts": reasons,
        "market_instance_ids": sorted(market_instances),
        "gateway_instance_ids": sorted(gateway_instances),
        "revision_ranges": {
            key: {"first": values[0] if values else None, "last": values[-1] if values else None}
            for key, values in revisions.items()
        },
        "pass": bool(samples) and not any(state in states for state in ("DOWN", "STALLED")),
    }


def run(*, project_root: Path, duration_seconds: float, interval_seconds: float, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().astimezone().strftime("%Y%m%d_%H%M%S")
    samples_path = output_dir / f"dataflow_soak_{stamp}.jsonl"
    summary_path = output_dir / f"dataflow_soak_{stamp}_summary.json"
    started_at = datetime.now().astimezone().isoformat(timespec="seconds")
    deadline = time.monotonic() + max(0.0, duration_seconds)
    samples: list[dict[str, Any]] = []
    with samples_path.open("a", encoding="utf-8") as stream:
        while True:
            sample = _sample(project_root)
            samples.append(sample)
            stream.write(json.dumps(sample, ensure_ascii=False, separators=(",", ":")) + "\n")
            stream.flush()
            if time.monotonic() >= deadline:
                break
            time.sleep(min(max(0.1, interval_seconds), max(0.0, deadline - time.monotonic())))
    finished_at = datetime.now().astimezone().isoformat(timespec="seconds")
    summary_path.write_text(
        json.dumps(_summary(samples, started_at=started_at, finished_at=finished_at), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return summary_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--duration-seconds", type=float, default=19_200)
    parser.add_argument("--interval-seconds", type=float, default=5.0)
    parser.add_argument("--project-root", type=Path, default=PROJECT_ROOT)
    parser.add_argument("--output-dir", type=Path, default=None)
    args = parser.parse_args()
    root = args.project_root.resolve()
    output = (args.output_dir or OUTPUT_ROOT / "soak").resolve()
    summary = run(
        project_root=root,
        duration_seconds=args.duration_seconds,
        interval_seconds=args.interval_seconds,
        output_dir=output,
    )
    print(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
