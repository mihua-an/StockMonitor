"""Operator tool: retrain every slot on all the training data after the FeatureSpec's columns changed.

    python -m scripts.maintenance.retrain_all            # check only: what a run would train on
    python -m scripts.maintenance.retrain_all --run      # check, then start the training and wait for its result

A FeatureSpec change (columns added or removed in native/analysis_runtime: features.rs and
spec/feature_spec_online_v3.json) gives the spec a new digest. Every stored shard and every model is bound to the old
one, so the next training run exports the features of every date again from the raw history, under the deployed
Rust B's spec (service/analysis/online_training/dataset.py), and trains all slots on them. This tool is that run,
started by hand right after the new B is deployed instead of waiting for the next close:

1. Check: the deployed B's FeatureSpec digest equals the repo's spec file (else B was not redeployed and the run would
   train the old columns); per trading date, what the run does with it, by the dataset builder's own decision: reuse
   a stored shard, export from the raw partitions, or nothing left to train on; the training window setting
   (window_trading_days) against the dates there are; whether a training job is already running.
2. Run (``--run``): the model center's own manual request (POST /api/training/run on realtime_api, the model_api
   part), so Health starts the job exactly as the 重新訓練 button does; then GET /api/training/runtime until the job
   ends, printing each step, and the result (dataset dates, which slots went live, which kept their model).

The App must be running (Health starts the job). Nothing here writes a model, a shard or a setting itself.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

SPEC_FILE = ROOT / "native" / "analysis_runtime" / "spec" / "feature_spec_online_v3.json"
POLL_SECONDS = 10
TERMINAL = {"SUCCEEDED", "FAILED", "INTERRUPTED", "NOT_READY", "SKIPPED_DISABLED", "SKIPPED_NOT_TRADING_DAY",
            "SKIPPED_ALREADY_TRAINED", "NOT_STARTED"}


def check() -> dict[str, Any]:
    from config.training_data_settings import training_data
    from service.analysis.inference.contract import load_horizon_authority
    from service.analysis.online_training import job as training_job
    from service.analysis.online_training.dataset import (OnlineDatasetBuilder, RustFeatureExporter, _raw_dates,
                                                          partition_fingerprint, stored_shards)
    from service.platform import project_root as process_paths

    repo_spec = json.loads(SPEC_FILE.read_text(encoding="utf-8"))
    # The context Health gives the job (health/main.js securityMaster): the shard identity depends on it.
    security_master = Path(process_paths.DATA_ROOT) / "reference" / "shioaji" / "security_master.csv"
    exporter = RustFeatureExporter(context=training_job.feature_context(security_master))
    deployed = exporter.spec()
    authority = load_horizon_authority()
    hist, shards = training_job.historical_root(), training_job.shard_root()
    builder = OnlineDatasetBuilder(hist, training_job.datasets_root(), exporter)
    horizons = tuple(authority.allowed_minutes)
    raw = _raw_dates(hist)
    dates = sorted(raw | {date for date, _directory, _manifest in stored_shards(shards)})
    rows = []
    for date in dates:
        entries = partition_fingerprint(hist, date)
        if builder.stored_shard(date, builder.shard_id(date, horizons, deployed, entries), horizons, deployed, entries):
            how = "stored shard (reused)"
        else:
            how = "export from raw history" if entries else "LOST: no raw history, only an older spec's shard"
        rows.append({"date": date, "raw": date in raw, "how": how})
    trainable = [r["date"] for r in rows if not r["how"].startswith("LOST")]
    window = int(training_data()["window_trading_days"])
    view = None
    try:
        from api.training_application import job_view

        view = job_view()
    except (ImportError, OSError) as exc:  # not an error: reported in the check as unknown
        view = {"error": f"{type(exc).__name__}: {exc}"}
    problems = []
    if deployed["schema_digest"] != repo_spec["schema_digest"]:
        problems.append(f"deployed Rust B computes {deployed.get('feature_version')} ({deployed['schema_digest'][:12]}), "
                        f"the repo's spec is {repo_spec.get('feature_version')} ({repo_spec['schema_digest'][:12]}): "
                        "deploy the new analysis_runtime first")
    if view and view.get("running"):
        problems.append("a training job is running now")
    return {
        "spec": {"repo": {k: repo_spec.get(k) for k in ("feature_version", "schema_digest")},
                 "deployed": {k: deployed.get(k) for k in ("feature_version", "schema_digest", "fold_version")},
                 "numeric_columns": sum(1 for c in repo_spec["columns"] if c.get("dtype") == "f64")},
        "horizons_minutes": list(authority.allowed_minutes),
        "dates": rows,
        "trainable_dates": len(trainable),
        "window_trading_days": window,
        "window_note": None if window >= len(trainable) else
        f"window_trading_days {window} < {len(trainable)} dates: a run trains on the newest {window} complete dates only "
        "(設定 → 模型訓練資料)",
        "job": {"running": view.get("running"), "pending_request": view.get("pending_request"),
                "last": {k: (view.get("job") or {}).get(k) for k in ("job_id", "state", "finished_at")}}
        if "error" not in view else view,
        "problems": problems,
    }


def _api(method: str, path: str) -> dict[str, Any]:
    from config.network_config import base_url, effective_from_disk
    from service.platform.project_root import AUTH_ROOT

    token = (Path(AUTH_ROOT) / "client_auth_token").read_text(encoding="ascii").strip()
    request = urllib.request.Request(base_url(effective_from_disk(), "realtime_api") + path, method=method,
                                     headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                                     data=b"{}" if method == "POST" else None)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:   # not an error: the API's refusal is the answer; run() prints it and stops
        return {"ok": False, "status": exc.code, "body": exc.read().decode("utf-8", "replace")[:500]}


def run() -> dict[str, Any]:
    started = _api("POST", "/api/training/run")
    print(json.dumps({"request": started}, ensure_ascii=False), flush=True)
    if not started.get("ok"):
        return {"ok": False, "error": "the training request was refused", "answer": started}
    job_id, last = started.get("job_id"), None
    while True:
        time.sleep(POLL_SECONDS)
        view = _api("GET", "/api/training/runtime")
        job = view.get("job") or {}
        if view.get("ok") is False:
            print(json.dumps({"runtime_error": view}, ensure_ascii=False), flush=True)
            continue
        if job.get("job_id") != job_id:
            # not an error: Health has not started this job yet (the request is still queued)
            continue
        step = (job.get("step"), job.get("current"), job.get("total"))
        if step != last:
            print(json.dumps({"state": job.get("state"), "step": job.get("step"), "current": job.get("current"),
                              "total": job.get("total")}, ensure_ascii=False), flush=True)
            last = step
        if job.get("state") in TERMINAL and not view.get("running"):
            return {"ok": job.get("state") == "SUCCEEDED", "job": job}


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--run", action="store_true", help="start the training and wait for its result")
    args = parser.parse_args(argv)
    report = check()
    print(json.dumps({"check": report}, ensure_ascii=False, indent=1), flush=True)
    if not args.run:
        return 0 if not report["problems"] else 1
    if report["problems"]:
        print(json.dumps({"ok": False, "error": "not started", "problems": report["problems"]}, ensure_ascii=False))
        return 1
    result = run()
    print(json.dumps({"result": result}, ensure_ascii=False, indent=1, default=str), flush=True)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
