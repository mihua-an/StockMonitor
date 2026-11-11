"""The training job: one process, started by Health, never inside an API.

    python -m service.analysis.online_training.job --mode auto|manual --job-id <id> --security-master <csv>
        [--trading-date YYYY-MM-DD] [--request-file <requests/<id>.json>] [--start-gate stdin]

With ``--start-gate stdin`` the job does nothing until it reads ``start`` on stdin: Health sends it only once its owner
record of this process (pid + OS creation time, health/training_job_runner.js) is on disk, so a later Health always
knows which process may still be training. A Health that dies before that closes stdin and the job ends untouched.

Health starts it after the close (``auto``, config/model_training.json) or when model_api left a manual request
(``manual``); stopping FastAPI does not touch it. One run: Rust B exports the features of the last
``window_trading_days`` 完整 trading dates with training data (config/training_data_settings.py; a day's 完整 is its
daily summary's ``tick_complete``) and of every incomplete date since the first of them, which is test data only
(dataset.py, reusing the stored shards, which outlive the raw partitions) -> labels -> every allowed
horizon/direction trained and exported to ONNX -> registered; each slot's winner goes live by the one promotion rule,
trainer.PROMOTION_RULE (recorded in every promotion) -> model_api's inference config hands it to Rust B.

Progress goes to ``<model>/online_training/status.json`` (model_api serves it); the run report to ``runs/``; the last
line on stdout is the result Health reads. An ``auto`` run on a date whose data is not committed yet answers
NOT_READY; a date already trained, a market holiday, or training switched off answers SKIPPED_*.

An auto run is started by Health for the trading date the Shioaji session owner published settled (the whole STK
day materialized, ``settled_stk_day``), not by a clock. The auto schedule is this domain's own durable ledger,
``<model>/online_training/schedule.json``: each auto attempt is recorded when it starts (attempt number, and when the
next one is due -- ``auto.retry_minutes`` later, so an attempt that dies without a result is still followed by one)
and when it ends (DONE for a trained or skipped date; a FAILED one keeps its due time; a NOT_READY one has none and
waits for the next settled notice). Health only starts an auto job the ledger says is due; it keeps no retry timing of
its own. An attempt after an earlier one for the same date is a ``training.auto_retry`` remediation.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from service.platform.atomic_files import read_text_shared, write_bytes_atomic
from service.platform.model_storage_layout import process_model_layout
from service.platform import project_root as process_paths
import logging
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)

SCHEMA = "training-job-v1"
TAIPEI = ZoneInfo("Asia/Taipei")
KEEP_RUN_REPORTS = 30


def training_root() -> Path:
    return process_model_layout().training


def datasets_root() -> Path:
    return process_model_layout().datasets


def shard_root() -> Path:
    return datasets_root() / "shards"


def daily_summary_root() -> Path:
    return process_model_layout().daily_summary


def training_window(dates: list[str], window_days: int, summary_root: Path) -> tuple[list[str], list[str]]:
    """The dates one run uses, from the trainable `dates` (oldest first): the newest `window_days` 完整 dates (user
    10-28: every stock's ticks reconcile, the daily summary's ``tick_complete``) to train and validate on, and every
    other date the window reaches, which is test data only (trainer._split). The window reaches back to the first
    trained date or to the newest `window_days` trading dates, whichever is earlier (user 10-28: incomplete days
    before the first complete one are test data too)."""
    from service.platform.model_storage_layout import day_tick_complete

    complete = [d for d in dates if day_tick_complete(d, summary_root) is True]
    trained = complete[-window_days:] if window_days > 0 else []
    if not trained:
        return [], []
    start = min(trained[0], dates[-window_days:][0])
    test_only = [d for d in dates if d >= start and d not in complete]
    return trained, test_only


def feature_context(security_master: Path):
    """The day context Rust B's features read: the same summaries, industry table and security master Health gives
    the daemon (health/services/analysis_runtime_host.js), so a shard's features are the live ones. The security
    master is the market side's reference data: Health resolves its path once and hands it to both B and this job
    (``--security-master``)."""
    from service.analysis.online_training.dataset import FeatureContext

    return FeatureContext(summary_dir=daily_summary_root(),
                          industry_indexes=process_paths.PROJECT_ROOT / "config" / "tw_industry_indexes.json",
                          security_master=security_master)


def historical_root() -> Path:
    # The same folder the materializer writes and the readers read (config/storage_settings.py).
    from config.storage_settings import historical_root as active_historical_root

    return active_historical_root(data_root=Path(process_paths.DATA_ROOT))


def settled_sessions_path() -> Path:
    # The Shioaji session owner's settled-session notice (service/market/shared/materialization_jobs.py
    # publish_settled_session). Read as a file: the analysis side never imports market code.
    return Path(process_paths.OUTPUT_ROOT) / "materialization_jobs" / "settled" / "shioaji.json"


def settled_stk_day() -> dict[str, Any] | None:
    """The newest STK day session whose whole materialization (STK and IDX) ended: {trading_date, status,
    settled_at}, or None when none was published yet."""
    try:
        notice = json.loads(read_text_shared(settled_sessions_path()))
    except FileNotFoundError:  # not an error: no session settled since the notice exists
        return None
    except (OSError, ValueError) as exc:
        record_failure(_failure_log, "reading the settled-session notice", exc)
        return None
    entry = (notice.get("sessions") or {}).get("STK:DAY") if isinstance(notice, dict) else None
    return entry if isinstance(entry, dict) else None


def session_materialized(day: str) -> tuple[bool, str]:
    """Whether the STK day session of ``day`` was materialized WHOLE: the session owner published it settled
    (after the 14:40 seal, once STK and IDX both ended) and materialized."""
    entry = settled_stk_day()
    if not entry or str(entry.get("trading_date") or "")[:10] < day:
        return False, f"{day} STK session not materialized yet (sealed after the after-hours match)"
    if str(entry.get("trading_date"))[:10] > day:
        return False, f"{day} is not the newest settled STK session ({entry.get('trading_date')})"
    if entry.get("status") != "materialized":
        return False, f"{day} STK session materialization ended {entry.get('status')}"
    return True, "materialized"


def load_config() -> dict[str, Any]:
    config_path = process_paths.PROJECT_ROOT / "config" / "model_training.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    if config.get("schema") != "model-training-v1":
        raise ValueError(f"{config_path}: unknown schema {config.get('schema')!r}")
    return config


def _write(path: Path, payload: Any) -> None:
    # model_api and Health read status.json while the job rewrites it (every progress line): the replace must not
    # fail on an open reader, and the readers open with delete sharing (`_read`).
    write_bytes_atomic(path, json.dumps(payload, indent=1, default=str).encode("utf-8"))


class TrainingLedgerCorrupt(RuntimeError):
    """state.json or schedule.json exists but cannot be read as a JSON object."""


def _read(path: Path) -> dict[str, Any]:
    """Informational files (status.json, run reports): an unreadable one is recorded and shown as empty."""
    try:
        value = json.loads(read_text_shared(path))
        return value if isinstance(value, dict) else {}
    except FileNotFoundError:  # not an error: no file yet
        return {}
    except (OSError, ValueError) as exc:
        record_failure(_failure_log, "reading a training job JSON file", exc)
        return {}


def _read_authoritative(path: Path) -> dict[str, Any]:
    """The domain's own ledgers (state.json: which date was trained; schedule.json: attempts and next due time).

    Only an absent file is "nothing recorded yet". A damaged one raises: read as empty it would reset the attempt
    count or retrain a date already trained, and the next write would overwrite the damaged file."""
    try:
        text = read_text_shared(path)
    except FileNotFoundError:  # not an error: nothing recorded yet
        return {}
    except OSError as exc:
        record_failure(_failure_log, f"reading the training ledger {path.name}", exc)
        raise TrainingLedgerCorrupt(f"{path.name} cannot be read: {exc}") from exc
    try:
        value = json.loads(text)
    except ValueError as exc:
        record_failure(_failure_log, f"parsing the training ledger {path.name}", exc)
        raise TrainingLedgerCorrupt(f"{path.name} is not valid JSON: {exc}") from exc
    if not isinstance(value, dict):
        exc = TrainingLedgerCorrupt(f"{path.name} is not a JSON object")
        record_failure(_failure_log, f"parsing the training ledger {path.name}", exc)
        raise exc
    return value


def read_status() -> dict[str, Any]:
    return _read(training_root() / "status.json")


def read_state() -> dict[str, Any]:
    return _read_authoritative(training_root() / "state.json")


SCHEDULE_SCHEMA = "stock-monitor-training-schedule-v1"


def read_schedule() -> dict[str, Any]:
    return _read_authoritative(training_root() / "schedule.json")


def begin_auto_attempt(day: str, *, now: datetime | None = None) -> dict[str, Any]:
    """Record an auto attempt for `day` as started; returns the ledger entry before it (that date's, else {})."""
    moment = now or datetime.now(timezone.utc)
    previous = read_schedule()
    if previous.get("trading_date") != day:
        previous = {}
    retry_minutes = max(1, int((load_config().get("auto") or {}).get("retry_minutes") or 30))
    from datetime import timedelta

    entry = {"schema": SCHEDULE_SCHEMA, "trading_date": day, "attempts": int(previous.get("attempts") or 0) + 1,
             "state": "RUNNING", "started_at": moment.isoformat(timespec="seconds"),
             "next_due_at": (moment + timedelta(minutes=retry_minutes)).isoformat(timespec="seconds"),
             "last_result": previous.get("last_result")}
    _write(training_root() / "schedule.json", entry)
    return previous


def end_auto_attempt(day: str, result: dict[str, Any]) -> dict[str, Any]:
    entry = read_schedule()
    if entry.get("trading_date") != day:
        entry = {"schema": SCHEDULE_SCHEMA, "trading_date": day, "attempts": 1}
    state = str(result.get("state") or "FAILED")
    done = state == "SUCCEEDED" or state.startswith("SKIPPED")
    entry.update(state="DONE" if done else "WAITING", finished_at=_now(),
                 last_result={"state": state, "reason": result.get("reason") or result.get("error")})
    if state == "NOT_READY":
        # Nothing to retry on a clock: the next attempt waits for the session owner's next settled notice.
        entry["next_due_at"] = None
    _write(training_root() / "schedule.json", entry)
    return entry


def trained_settled_day(window: list[str]) -> str | None:
    """The newest materialized trading date (the session owner's settled notice, the same fact an auto run starts on)
    when `window` trained on it, else None: a manual run that did has trained that day's close, as the auto run would."""
    day = str((settled_stk_day() or {}).get("trading_date") or "")[:10]
    return day if day and day in window and session_materialized(day)[0] else None


def close_auto_by_manual(day: str, job_id: str) -> dict[str, Any]:
    """Records `day` DONE in the auto schedule: a manual run trained its close, so Health starts no auto attempt or
    retry for it."""
    entry = read_schedule()
    if str(entry.get("trading_date") or "") > day:
        return entry      # an attempt for a newer date than this run trained stands
    if entry.get("trading_date") != day:
        entry = {"schema": SCHEDULE_SCHEMA, "trading_date": day, "attempts": 0}
    entry.update(state="DONE", finished_at=_now(), next_due_at=None,
                 last_result={"state": "SUCCEEDED", "reason": f"trained by the manual run {job_id}"})
    _write(training_root() / "schedule.json", entry)
    return entry


def _record_auto_retry(day: str, previous: dict[str, Any], result: dict[str, Any], attempts: int) -> None:
    from service.platform.remediation import emitter

    last = previous.get("last_result") or {}
    prior = str(last.get("state") or "")
    trigger = ("not_ready" if prior == "NOT_READY" else "failed" if prior == "FAILED"
               else "interrupted")   # started, never recorded an end: killed, timed out or the machine stopped
    state = str(result.get("state") or "FAILED")
    emitter().emit(component="training_job", mechanism_id="training.auto_retry", trigger_reason=trigger,
                   outcome="succeeded" if state == "SUCCEEDED" or state.startswith("SKIPPED") else "failed",
                   attempt=attempts, identity={"trading_date": day},
                   detail={"previous_state": prior or "RUNNING", "state": state})


def latest_run_report() -> dict[str, Any] | None:
    runs = sorted((training_root() / "runs").glob("run-*.json"))
    return _read(runs[-1]) if runs else None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Job:
    def __init__(self, *, mode: str, job_id: str, trading_date: str | None = None, exporter: Any = None,
                 hist_root: Path | None = None, security_master: Path | None = None) -> None:
        if mode not in ("auto", "manual"):
            raise ValueError(f"mode {mode!r}")
        self.mode = mode
        self.job_id = job_id
        self.trading_date = trading_date
        self.exporter = exporter
        # Read only when the job builds its own exporter (the CLI always passes Health's path).
        self.security_master = security_master
        self.hist_root = Path(hist_root or historical_root())
        from service.platform.process_observer import process_created_epoch_ns

        # pid + creation time name this process exactly: a reader tells a RUNNING status of a job that ended without
        # writing its result (stopped by force, crashed) from a live one (api/training_application.py job_view).
        self.status: dict[str, Any] = {"schema": SCHEMA, "job_id": job_id, "mode": mode, "pid": os.getpid(),
                                       "pid_created_ns": process_created_epoch_ns(os.getpid()),
                                       "state": "RUNNING", "step": "starting", "current": 0, "total": 0,
                                       "started_at": _now(), "finished_at": None}

    def publish(self) -> None:
        """Writes this job's RUNNING status before anything slow (the training modules take seconds to import): from
        here on readers see this job, not the previous one's status."""
        _write(training_root() / "status.json", self.status)

    def _progress(self, step: str, current: int = 0, total: int = 0, detail: dict[str, Any] | None = None) -> None:
        """The current step, and every step so far in `log` (when it started and ended, and how it went once
        known, e.g. a date's shard reused or exported, and how far its phases are): the model center's 執行紀錄. A
        call naming the step already running only merges its `detail` into the step's (a date's progress does not
        replace whether its shard was reused)."""
        moment = _now()
        log = self.status.setdefault("log", [])
        if not log or log[-1]["step"] != step:
            if log and not log[-1].get("ended_at"):
                log[-1]["ended_at"] = moment
            log.append({"step": step, "started_at": moment, "ended_at": None})
        if detail:
            log[-1]["detail"] = {**(log[-1].get("detail") or {}), **detail}
        self.status.update(step=step, current=current, total=total, updated_at=moment)
        _write(training_root() / "status.json", self.status)

    def _finish(self, state: str, **detail: Any) -> dict[str, Any]:
        moment = _now()
        log = self.status.get("log") or []
        if log and not log[-1].get("ended_at"):
            log[-1]["ended_at"] = moment
        self.status.update(state=state, step=state.lower(), finished_at=moment, **detail)
        _write(training_root() / "status.json", self.status)
        return {"ok": state in ("SUCCEEDED",) or state.startswith("SKIPPED") or state == "NOT_READY", **self.status}

    def run(self) -> dict[str, Any]:
        from config.feature_settings import SHIOAJI_FEATURES
        from config.market_holidays import tw_trading_day
        from service.analysis.inference.contract import load_horizon_authority
        from service.analysis.online_training.dataset import OnlineDatasetBuilder, RustFeatureExporter, available_dates
        from service.analysis.online_training.registry import OnlineModelRegistry
        from service.analysis.online_training.trainer import OnlineModelTrainer

        self._progress("checking")
        if not SHIOAJI_FEATURES.model_training:
            return self._finish("SKIPPED_DISABLED", reason="model_training is switched off")
        config = load_config()
        from config.training_data_settings import training_data

        settings = training_data()
        state = read_state()
        last_day = None
        if self.mode == "auto":
            day = self.trading_date or datetime.now(TAIPEI).date().isoformat()
            self.status["trading_date"] = day
            if tw_trading_day(date.fromisoformat(day)) is False:
                return self._finish("SKIPPED_NOT_TRADING_DAY", reason=f"{day} is a market holiday")
            if state.get("last_trained_trading_date") == day:
                return self._finish("SKIPPED_ALREADY_TRAINED", reason=f"{day} already trained")
            ready, why = session_materialized(day)
            if not ready or day not in available_dates(self.hist_root, shard_root()):
                return self._finish("NOT_READY", reason=why if not ready else f"{day} has no committed STK partition yet")
            last_day = day
        authority = load_horizon_authority()
        if self.exporter is None and self.security_master is None:
            raise ValueError("no security master: Health passes its path with --security-master")
        exporter = self.exporter or RustFeatureExporter(context=feature_context(self.security_master))
        spec = exporter.spec()
        # Dates of shards computed under another FeatureSpec or other horizons cannot be trained on by this build.
        dates = [d for d in available_dates(self.hist_root, shard_root(), spec_digest=spec["schema_digest"],
                                            horizons=authority.allowed_minutes) if last_day is None or d <= last_day]
        if not dates:
            return self._finish("NOT_READY", reason="no trading date with training data")
        trained, test_only = training_window(dates, int(settings["window_trading_days"]), daily_summary_root())
        if not trained:
            return self._finish("NOT_READY", reason="no complete trading date (every stock's ticks reconciled) to train on")
        window = sorted(trained + test_only)
        self.status["window"] = window
        self.status["test_only_dates"] = test_only
        builder = OnlineDatasetBuilder(self.hist_root, datasets_root(), exporter)
        dataset = builder.build(window, horizons_minutes=authority.allowed_minutes,
                                progress=lambda i, n, step, detail=None: self._progress(step, i, n, detail))
        self.status["dataset"] = {k: dataset.get(k) for k in ("dataset_id", "samples", "codes", "trading_dates", "degraded")}
        registry = OnlineModelRegistry()
        report = OnlineModelTrainer(registry).train(datasets_root() / dataset["dataset_id"],
                                                     horizons_minutes=authority.allowed_minutes, test_only_dates=test_only,
                                                     progress=lambda i, n, step, detail=None: self._progress(step, i, n, detail))
        self._progress("publish")
        report["job"] = {"job_id": self.job_id, "mode": self.mode, "trading_date": self.status.get("trading_date")}
        report["dataset"] = self.status["dataset"]
        runs = training_root() / "runs"
        _write(runs / f"{report['run_id']}.json", report)
        for stale in sorted(runs.glob("run-*.json"))[:-KEEP_RUN_REPORTS]:
            stale.unlink(missing_ok=True)
        self.status["pruned"] = builder.prune(used=dataset, retention_days=settings["retention_days"],
                                              keep_datasets=int(config.get("keep_datasets") or 3),
                                              summary_root=daily_summary_root())
        trained = sorted(slot for slot, r in report["slots"].items() if r.get("status") == "TRAINED")
        # A trained slot's winner goes live only above the constant baseline; the others keep their model (trainer.py).
        summary = {"run_id": report["run_id"], "trained": trained,
                   "promoted": [slot for slot in trained if report["slots"][slot].get("promoted")],
                   "below_baseline": [slot for slot in trained if not report["slots"][slot].get("promoted")],
                   "not_trained": {slot: r.get("reason") or r.get("status") for slot, r in report["slots"].items()
                                   if r.get("status") != "TRAINED"}}
        state["last_success"] = {"job_id": self.job_id, "mode": self.mode, "finished_at": _now(), **summary,
                                 "dataset_id": dataset["dataset_id"]}
        # The newest settled date this run trained on: an auto run's own date; a manual run's when its window has it.
        trained_day = self.status["trading_date"] if self.mode == "auto" else trained_settled_day(window)
        if trained_day and trained_day > str(state.get("last_trained_trading_date") or ""):
            state["last_trained_trading_date"] = trained_day
        _write(training_root() / "state.json", state)
        if self.mode == "manual" and trained_day:
            try:
                self.status["schedule"] = close_auto_by_manual(trained_day, self.job_id)
            except TrainingLedgerCorrupt as exc:  # not an error: read_schedule recorded the damage; reported on the result
                self.status["schedule_error"] = str(exc)
        return self._finish("SUCCEEDED", result=summary)


def main(argv: list[str] | None = None) -> int:
    from service.platform.interpreter_guard import refuse_optimized_interpreter

    refuse_optimized_interpreter("training job")
    from service.platform.child_lifetime import bind_children_to_this_process

    try:
        # Rust B's feature export is this job's child: Health ending the job by force must not leave it running.
        bind_children_to_this_process()
    except OSError as exc:
        record_failure(_failure_log, "binding the training job's children to its lifetime", exc)
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--mode", choices=("auto", "manual"), required=True)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--trading-date", default=None)
    parser.add_argument("--request-file", default=None)
    parser.add_argument("--security-master", required=True, type=Path)
    parser.add_argument("--start-gate", choices=("stdin",), default=None)
    args = parser.parse_args(argv)
    if args.start_gate == "stdin" and sys.stdin.readline().strip() != "start":
        # not an error: Health ended (or refused this start) before recording the process; nothing was touched
        print(json.dumps({"ok": False, "state": "NOT_STARTED", "reason": "no start from Health"}), flush=True)
        return 0
    job = Job(mode=args.mode, job_id=args.job_id, trading_date=args.trading_date, security_master=args.security_master)
    job.publish()
    if args.request_file:
        # The manual request is the job's until its status is on disk: removed only now, so a reader always sees either
        # the request (queued) or this job (running), never the previous job's status in between.
        try:
            Path(args.request_file).unlink(missing_ok=True)
        except OSError as exc:
            record_failure(_failure_log, "removing the manual training request (Health removes it when the job ends)", exc)
    started = time.monotonic()
    day = (args.trading_date or datetime.now(TAIPEI).date().isoformat()) if args.mode == "auto" else None
    try:
        previous = begin_auto_attempt(day) if day else {}
    except TrainingLedgerCorrupt as exc:
        # The schedule ledger is left as it is for inspection; no attempt is recorded over it.
        result = job._finish("FAILED", error=f"training schedule ledger damaged: {exc}"[:1000])
        result["duration_s"] = round(time.monotonic() - started, 1)
        print(json.dumps(result, default=str), flush=True)
        return 0
    try:
        result = job.run()
    except Exception as exc:  # noqa: BLE001 -- reported to Health and the training page, never swallowed
        traceback.print_exc()
        result = job._finish("FAILED", error=f"{type(exc).__name__}: {exc}"[:1000])
    # Whatever happens after the run, the job's terminal result is printed: the runner reads it as the outcome.
    try:
        if day:
            try:
                entry = end_auto_attempt(day, result)
            except (TrainingLedgerCorrupt, OSError) as exc:
                traceback.print_exc()
                result = {**result, "ok": False, "schedule_error": f"{type(exc).__name__}: {exc}"[:1000]}
                entry = {}
            if previous and entry:
                result = _report_auto_retry(day, previous, result, int(entry.get("attempts") or 1))
            result["schedule"] = {k: entry.get(k) for k in ("attempts", "state", "next_due_at")}
    finally:
        result["duration_s"] = round(time.monotonic() - started, 1)
        print(json.dumps(result, default=str), flush=True)
    return 0


def _report_auto_retry(day: str, previous: dict[str, Any], result: dict[str, Any], attempts: int) -> dict[str, Any]:
    """Best effort: the retry's remediation record. A failure here is printed and noted on the result; events the
    emitter could not deliver are counted by its own loss marker. The job's outcome does not change."""
    try:
        _record_auto_retry(day, previous, result, attempts)
        from service.platform.remediation import emitter

        if not emitter().flush(2.0):
            result = {**result, "remediation": "not acknowledged within 2 s (counted by the emitter)"}
    except Exception as exc:  # noqa: BLE001 -- printed and noted; the trained result stands
        traceback.print_exc()
        result = {**result, "remediation": f"recording the retry failed: {type(exc).__name__}: {exc}"[:300]}
    return result


if __name__ == "__main__":
    raise SystemExit(main())
