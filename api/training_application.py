"""Model center (訓練頁) reads and the manual training request, for model_api.

Training does not run here: it is a process Health starts (health/training_job_runner.js ->
service/analysis/online_training/job.py), after the close or when this API leaves a manual request. Everything served
here is what is already on disk -- the job's status, its run reports, the dataset manifest, the registry -- plus Rust
B's own status file, so stopping this API never stops a training run and no request waits on one.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from service.analysis.inference.contract import ContractError, load_horizon_authority, prediction_key
from service.analysis.online_training import job as training_job
from service.analysis.online_training.dataset import read_manifest
from service.analysis.online_training.labels import label_columns
import logging
from service.platform.atomic_files import write_json_atomic
from service.platform.failure_record import record_failure


_failure_log = logging.getLogger(__name__)


@dataclass
class TrainingDependencies:
    registry: Callable[[], Any]
    worker_status: Callable[[], dict[str, Any] | None]
    enabled_minutes: Callable[[], tuple[int, ...]]
    training_enabled: bool = True


def _job_process_alive(status: dict[str, Any]) -> bool:
    """Whether the process a RUNNING status names (pid + creation time) still runs. A job ended by force writes
    nothing, so its status stays RUNNING; the process is the truth."""
    from service.platform.process_observer import ProcessTableUnavailable, process_created_epoch_ns, process_exists

    try:
        if not process_exists(status.get("pid")):
            return False
    except ProcessTableUnavailable as exc:
        record_failure(_failure_log, "checking whether the training job process runs", exc)
        return True   # unknown is not ended: shown as the job reported it
    created = status.get("pid_created_ns")
    return created is None or process_created_epoch_ns(status.get("pid")) in (None, created)


def _requests_dir() -> Path:
    return training_job.training_root() / "requests"


def pending_request() -> str | None:
    try:
        names = sorted(p.stem for p in _requests_dir().glob("*.json"))
    except FileNotFoundError:  # not an error: no training requests directory yet
        return None
    except OSError as exc:
        record_failure(_failure_log, "listing training requests", exc)
        return None
    return names[0] if names else None


def job_view() -> dict[str, Any]:
    status = training_job.read_status()
    running = status.get("state") == "RUNNING" and not status.get("finished_at")
    if running and not _job_process_alive(status):
        running = False
        status = {**status, "state": "INTERRUPTED",
                  "reason": "the job process ended without a result (stopped by force or crashed)"}
    return {"job": status or None, "running": running, "pending_request": pending_request()}


def _training_state() -> tuple[dict[str, Any], str | None]:
    """The job's state ledger, or ({}, reason) when it is damaged -- shown as such, never as "nothing trained"."""
    try:
        return training_job.read_state(), None
    except training_job.TrainingLedgerCorrupt as exc:  # not an error: read_state recorded the damage; answered as the reason
        return {}, str(exc)


class TrainingApplication:
    def __init__(self, deps: TrainingDependencies) -> None:
        self.deps = deps

    def runtime(self) -> dict[str, Any]:
        return {"ok": True, **job_view()}

    def today(self) -> dict[str, Any]:
        """今天的狀態: the day's phase for the automatic training, the next start, and the data it will train on."""
        from config.market_holidays import tw_is_trading_day
        from service.analysis.online_training.dataset import available_dates
        from service.analysis.online_training.today import date_data, training_today

        now = datetime.now(training_job.TAIPEI)
        root = training_job.historical_root()
        view = job_view()
        state, state_error = _training_state()
        try:
            schedule = training_job.read_schedule()
        except training_job.TrainingLedgerCorrupt as exc:  # not an error: read_schedule recorded the damage; answered as the reason
            state_error = state_error or str(exc)
        if state_error:
            return {"trading_date": now.date().isoformat(), "phase": "LEDGER_DAMAGED", "error": state_error}
        from config.training_data_settings import training_data

        try:
            window_days = int(training_data()["window_trading_days"])
        except (OSError, ValueError) as exc:  # not an error: recorded, and answered as the reason
            record_failure(_failure_log, "reading the training data settings", exc)
            return {"trading_date": now.date().isoformat(), "phase": "SETTINGS_UNREADABLE", "error": str(exc)}
        available = available_dates(root, training_job.shard_root())
        return training_today(now, schedule=schedule, window_days=window_days, state=state, job=view.get("job"),
                              running=bool(view.get("running")), available=available,
                              window=training_job.training_window(available, window_days, training_job.daily_summary_root()),
                              materialized=training_job.session_materialized(now.date().isoformat()),
                              is_trading=tw_is_trading_day, data_of=lambda day: date_data(root, day))

    def run(self) -> dict[str, Any]:
        """Leave a manual request for Health; one job at a time, and a second click joins the first."""
        if not self.deps.training_enabled:
            return {"ok": False, "error": "MODEL_TRAINING_DISABLED"}
        view = job_view()
        if view["running"]:
            return {"ok": True, "job_id": view["job"].get("job_id"), "state": "RUNNING", "joined": True}
        if view["pending_request"]:
            return {"ok": True, "job_id": view["pending_request"], "state": "QUEUED", "joined": True}
        job_id = f"manual-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:6]}"
        write_json_atomic(_requests_dir() / f"{job_id}.json", {
            "job_id": job_id, "requested_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "source": "model_api"})
        return {"ok": True, "job_id": job_id, "state": "QUEUED", "joined": False,
                "note": "Health starts the training job; progress is GET /api/training/runtime"}

    def console(self, horizon_minutes: int | None = None, direction: str = "up") -> dict[str, Any]:
        authority = load_horizon_authority()
        enabled = list(self.deps.enabled_minutes())
        horizons = {"allowed_minutes": list(authority.allowed_minutes), "default_enabled_minutes": list(authority.default_enabled_minutes),
                    "enabled_minutes": enabled}
        minutes = int(horizon_minutes) if horizon_minutes is not None else (enabled[0] if enabled else authority.allowed_minutes[0])
        if minutes not in authority.allowed_minutes or direction not in authority.directions:
            # Refused, never substituted: the page says so and asks for a supported one.
            return {"ok": False, "error": "UNSUPPORTED_TARGET", "requested": {"horizon_minutes": minutes, "direction": direction},
                    "prediction_horizons": horizons}
        key = prediction_key(minutes, direction)
        registry = self.deps.registry().status()
        worker = self.deps.worker_status() or {}
        report = training_job.latest_run_report() or {}
        state, state_error = _training_state()
        slot_run = (report.get("slots") or {}).get(key) or {}
        run, candidates, run_error = _slot_candidates(slot_run, self.deps.registry())
        dataset = self._dataset(report, minutes)
        warnings = []
        if not worker:
            warnings.append({"level": "warn", "message": "Rust B 尚未回報狀態：無法確認模型與即時特徵是否一致"})
        elif worker.get("stale"):
            warnings.append({"level": "warn", "message": "Rust B 狀態檔已過期（B 未在執行）"})
        if registry["slots"].get(key, {}).get("feature_spec") == "MISMATCH":
            warnings.append({"level": "error", "message": f"{key} 的模型特徵版本與 Rust B 不一致，B 不會使用它；請重新訓練"})
        if dataset and dataset.get("degraded"):
            warnings.append({"level": "warn", "message": "最近一次資料集有分區未通過完整性檢查（已排除），見資料集區塊"})
        if state_error:
            warnings.append({"level": "error", "message": f"訓練紀錄檔損毀，自動訓練停止：{state_error}"})
        if not self.deps.training_enabled:
            warnings.append({"level": "info", "message": "模型訓練已在設定中關閉"})
        try:
            schedule = training_job.load_config()
        except ValueError as exc:
            record_failure(_failure_log, "loading the training config", exc)
            schedule = {"error": str(exc)}          # the config's own validation message
        except OSError as exc:
            # An OSError names the file path: logged under an error_id, not returned.
            from service.platform.http.errors import internal_error

            schedule = {"error": internal_error("[TRAINING] schedule config read", exc)["error"]}
        return {
            "ok": True, "prediction_horizons": horizons, "directions": list(authority.directions),
            "selected": {"horizon_minutes": minutes, "direction": direction, "key": key},
            **job_view(), "schedule": schedule, "training_enabled": self.deps.training_enabled,
            "last_success": state.get("last_success"), "last_trained_trading_date": state.get("last_trained_trading_date"),
            "worker": {"feature_spec": worker.get("feature_spec"), "stale": worker.get("stale"),
                       "slots": ((worker.get("capability") or {}).get("slots") or [])},
            "registry": registry, "champion": registry["slots"].get(key),
            "run": {"run_id": report.get("run_id"), "split": report.get("split"), "slot": {k: v for k, v in slot_run.items() if k != "metrics"},
                    "selection": run.get("selection")},
            "candidates": candidates, "candidates_error": run_error, "dataset": dataset,
            "warnings": warnings,
        }

    def models(self) -> dict[str, Any]:
        """Every prediction slot with both of its trained models (the latest run), for the model center's cards."""
        authority = load_horizon_authority()
        enabled = set(self.deps.enabled_minutes())
        registry = self.deps.registry().status()
        report = training_job.latest_run_report() or {}
        slots = []
        for minutes in authority.allowed_minutes:
            for direction in authority.directions:
                key = prediction_key(minutes, direction)
                live = registry["slots"].get(key) or {}
                metrics = ((live.get("validation") or {}).get("metrics") or {}).get("validation") or {}
                run, candidates, run_error = _slot_candidates((report.get("slots") or {}).get(key) or {}, self.deps.registry())
                slots.append({
                    "key": key, "horizon_minutes": minutes, "direction": direction, "enabled": minutes in enabled,
                    "model": live.get("champion"), "kind": live.get("kind"), "deployable": live.get("deployable"),
                    # NONE (no model yet), OK, MODEL_UNUSABLE, CHAMPIONS_DAMAGED / CHAMPIONS_IO_ERROR -- never one for another.
                    "champion_state": live.get("champion_state"), "champion_reason": live.get("reason"),
                    # The live model stayed because the latest run's winner did not go live (e.g. BELOW_BASELINE).
                    "kept": live.get("kept"), "kept_reason": live.get("kept_reason"),
                    "validation_auc": metrics.get("auc"), "validation_log_loss": metrics.get("log_loss"),
                    "feature_importance": top_importance(live.get("feature_importance")),
                    "candidates": [{"kind": c.get("kind"), "winner": bool(c.get("winner")), "rejected": bool(c.get("rejected")),
                                    "validation_auc": ((c.get("metrics") or {}).get("validation") or {}).get("auc"),
                                    "validation_log_loss": ((c.get("metrics") or {}).get("validation") or {}).get("log_loss")}
                                   for c in candidates],
                    # What the winner had to beat to go live (trainer.py _baseline).
                    "baseline_log_loss": ((run.get("baseline") or {}).get("log_loss") or {}).get("validation"),
                    "candidates_error": run_error,
                })
        state, state_error = _training_state()
        return {"ok": True, **job_view(), "last_success": state.get("last_success"), "state_error": state_error,
                "champions_error": registry.get("champions_error"), "run_id": report.get("run_id"),
                "dataset": report.get("dataset"), "training_enabled": self.deps.training_enabled, "slots": slots,
                "today": self.today()}

    @staticmethod
    def _dataset(report: dict[str, Any], minutes: int) -> dict[str, Any] | None:
        dataset_id = (report.get("dataset") or {}).get("dataset_id")
        if not dataset_id:
            return None
        try:
            manifest = read_manifest(training_job.datasets_root() / dataset_id)
        except (OSError, ValueError):  # not an error: the dataset is reported as missing to the caller
            return {"dataset_id": dataset_id, "missing": True}
        labels = {col: manifest.get("label_stats", {}).get(col) for col in label_columns(minutes)}
        return {k: manifest.get(k) for k in ("dataset_id", "created_at", "trading_dates", "skipped_dates", "samples", "codes", "degraded",
                                              "feature_spec", "sampling_policy", "future_path_policy", "shards", "numeric_columns")} | {
            "label_policy": manifest.get("label_policy"), "labels": labels,
            "label_states": (manifest.get("label_states") or {}).get(f"{minutes}m")}


IMPORTANCE_TOP = 15


def top_importance(importance: dict[str, Any] | None, top: int = IMPORTANCE_TOP) -> dict[str, Any] | None:
    """A live model's 特徵權重 for its card: the `top` features by |value|, each with its share of the total |value|.
    None for a model trained before the manifest carried it."""
    values = (importance or {}).get("values")
    if not isinstance(values, dict) or not values:
        return None
    total = sum(abs(float(v)) for v in values.values())
    ranked = sorted(values.items(), key=lambda item: abs(float(item[1])), reverse=True)[:top]
    return {"kind": importance.get("kind"), "method": importance.get("method"), "signed": bool(importance.get("signed")),
            "features": len(values),
            "top": [{"name": name, "value": float(v), "share": abs(float(v)) / total if total > 0 else 0.0} for name, v in ranked]}


RUN_MISSING, RUN_DAMAGED, RUN_IO_ERROR = "RUN_MISSING", "RUN_DAMAGED", "RUN_IO_ERROR"


def _slot_candidates(slot_run: dict[str, Any], registry: Any) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, str] | None]:
    """A slot's run file, its candidates -- each trained kind (the winner marked) and those the export check
    eliminated -- and why the run file could not be read ({kind, detail}, None when it was or none is named). A run
    file that is missing, damaged or unreadable is that, not a slot without candidates. The run file is found from the
    model id under the registry root (a report names no absolute path)."""
    run: dict[str, Any] = {}
    error = None
    if slot_run.get("model_id"):
        try:
            run = registry.read_run(slot_run["model_id"])
        except FileNotFoundError as exc:
            record_failure(_failure_log, "reading a training run report (the model it names is gone)", exc)
            error = {"kind": RUN_MISSING, "detail": "run.json not found"}
        except OSError as exc:
            record_failure(_failure_log, "reading a training run report", exc)
            error = {"kind": RUN_IO_ERROR, "detail": exc.strerror or type(exc).__name__}
        except ValueError as exc:
            record_failure(_failure_log, "parsing a training run report", exc)
            error = {"kind": RUN_DAMAGED, "detail": f"not JSON ({exc})"}
        if not error and not isinstance(run, dict):
            error = {"kind": RUN_DAMAGED, "detail": "not an object"}
            record_failure(_failure_log, "parsing a training run report", ValueError(error["detail"]))
        if error:
            run = {}
    candidates = [{**candidate, "winner": candidate.get("kind") == run.get("winner")} for candidate in run.get("candidates") or []]
    # Eliminated by the export check: shown with why, never as a contender.
    for candidate in run.get("rejected_candidates") or slot_run.get("rejected_candidates") or []:
        candidates.append({"kind": candidate.get("kind"), "winner": False, "rejected": candidate,
                           "export_max_abs_diff": candidate.get("max_abs_diff")})
    return run, candidates, error


def create_training_application(deps: TrainingDependencies) -> TrainingApplication:
    return TrainingApplication(deps)


__all__ = ["ContractError", "TrainingApplication", "TrainingDependencies", "create_training_application", "job_view"]
