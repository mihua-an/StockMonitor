"""Durable Shioaji historical minute-K download, budget and retention manager.

The manager is deliberately daemon-owned.  FastAPI can submit and inspect work,
but only the daemon's ``api_provider`` is allowed to call ``usage``/``kbars``.
All state is persisted in the existing runtime SQLite database so a restart does
not create a second source of truth.

Four parts, one lock (a segment's claim and the retention's per-file decision must not interleave):

- ``KBarJobStore``: the SQLite schema, the jobs and their segments.
- ``UsageSampler``: the broker's daily quota (sampled, cached, backed off) and the per-day size estimate.
- ``DownloadedBars``: what a download brought, into the K-bar store through Rust B (one store, one retention).
- ``KBarDownloadManager``: plans and runs jobs over the three (reservation, download, the waits).
"""

from __future__ import annotations

import json
import math
import sqlite3
import subprocess
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

import pandas as pd

from config.market_holidays import tw_is_trading_day
from service.market.storage.market_storage_layout import process_market_layout
import logging
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)

MAX_KBARS_DAYS = 30
ESTIMATE_MODEL_VERSION = "shioaji-kbars-by-day-v1"
AGGREGATION_VERSION = "minute-to-daily-v1"
# Before any download was observed: an upper bound of one calendar day of 1-minute bars (about 270 rows of 7 numbers).
# The first download needs an estimate to reserve against, and is what teaches the real one.
FIRST_DOWNLOAD_BYTES_PER_DAY = 64 * 1024
# The daily quota is sampled in the background at most this often (and once after each login / new day), so a page
# that reads it -- 連線診斷 polls every 2 s -- is served from kbar_usage_samples and never calls the broker itself.
USAGE_SAMPLE_SECONDS = 600
# After a failed api.usage(), cached reads do not try the broker again for this long.
USAGE_FAILURE_BACKOFF_SECONDS = 60

# The states a job waits in when a segment cannot be reserved (KBarDownloadManager._wait_state): no estimate yet, the
# quota could not be read, or the quota is not enough.
WAITING_ESTIMATE = "WAITING_ESTIMATE"
WAITING_USAGE = "WAITING_USAGE"
WAITING_BUDGET = "WAITING_BUDGET"
# A job drain stops at a final state or a wait.
_DRAIN_STOPS = frozenset({"COMPLETED", "FAILED", "CANCELLED", "PAUSED", WAITING_BUDGET, WAITING_ESTIMATE, WAITING_USAGE})
_TAIPEI = timezone(timedelta(hours=8))


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime | None = None) -> str:
    return (value or _now()).isoformat(timespec="seconds")


def _date(value: Any) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return datetime.strptime(str(value)[:10], "%Y-%m-%d").date()


def _json_number(value: Any) -> int | None:
    try:
        if value is None:
            return None
        number = int(float(value))
        return number if number >= 0 else None
    except Exception:  # not an error: value coercion: a non-numeric value is None (missing) by contract
        return None


def _field(value: Any, names: tuple[str, ...]) -> Any:
    if isinstance(value, dict):
        for name in names:
            if name in value:
                return value[name]
        return None
    for name in names:
        try:
            result = getattr(value, name)
        except Exception:  # not an error: an SDK object without that attribute; the next attribute name is tried
            continue
        if result is not None:
            return result
    return None


def technical_history_job(code: str, before: str, *, trading_days: int = 20) -> dict[str, Any]:
    """The download job that fetches up to `trading_days` trading days before `before` for 技術分析: the payload of the
    job 資料中心's download creates (quota reservation, retention), so its bars reach the chart through the store the
    chart already reads. One broker request covers less than MAX_KBARS_DAYS calendar days."""
    end = _date(before) - timedelta(days=1)
    days = [day for day in (end - timedelta(days=back) for back in range(MAX_KBARS_DAYS))
            if tw_is_trading_day(day)][:max(1, int(trading_days))]
    if not days:
        raise ValueError(f"no trading day within {MAX_KBARS_DAYS} days before {before}")
    return {"code": str(code).strip().upper(), "start_date": days[-1].isoformat(), "end_date": days[0].isoformat(), "auto_resume": False}


def _record_kbar_recovery(trigger: str, detail: dict[str, Any]) -> None:
    """K-bar jobs taken up again after a restart or a new budget, recorded."""
    try:
        from service.platform.remediation import emitter

        emitter().emit(component="kbar_download", mechanism_id="kbar.job_recovered", trigger_reason=trigger,
                       outcome="succeeded", identity={"source": "shioaji"}, detail=detail)
    except Exception as exc:
        record_failure(_failure_log, "recording the kbar job recovery event", exc)


@dataclass(frozen=True)
class UsageSnapshot:
    used_bytes: int | None
    limit_bytes: int | None
    remaining_bytes: int | None
    observed_at: str
    fresh: bool = True
    error: str = ""

    @property
    def known(self) -> bool:
        return self.remaining_bytes is not None and self.limit_bytes is not None


class KBarJobStore:
    """The runtime SQLite database: the schema, the jobs and their segments."""

    def __init__(self, db_path: Path, *, lock: threading.RLock, clock: Callable[[], datetime]) -> None:
        self.db_path = Path(db_path)
        self._lock = lock
        self._clock = clock
        self._init_schema()

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=10.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=10000")
        return conn

    def _init_schema(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock, self.connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS kbar_usage_samples (
                  id INTEGER PRIMARY KEY AUTOINCREMENT, observed_at TEXT NOT NULL,
                  used_bytes INTEGER, limit_bytes INTEGER, remaining_bytes INTEGER,
                  observed_bytes INTEGER NOT NULL DEFAULT 0, row_count INTEGER NOT NULL DEFAULT 0,
                  day_count INTEGER NOT NULL DEFAULT 0, model_version TEXT NOT NULL,
                  external_interference INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS kbar_download_jobs (
                  job_id TEXT PRIMARY KEY, code TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
                  state TEXT NOT NULL, user_budget_bytes INTEGER, safety_reserve_bytes INTEGER NOT NULL DEFAULT 0,
                  auto_resume INTEGER NOT NULL DEFAULT 0, estimate_bytes INTEGER, conservative_estimate_bytes INTEGER,
                  estimate_confidence TEXT NOT NULL DEFAULT 'NONE', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                  last_error TEXT NOT NULL DEFAULT ''
                );
                CREATE TABLE IF NOT EXISTS kbar_download_segments (
                  segment_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, code TEXT NOT NULL,
                  start_date TEXT NOT NULL, end_date TEXT NOT NULL, state TEXT NOT NULL,
                  attempts INTEGER NOT NULL DEFAULT 0, estimate_bytes INTEGER, reserved_bytes INTEGER NOT NULL DEFAULT 0,
                  observed_bytes INTEGER, row_count INTEGER NOT NULL DEFAULT 0, source_version TEXT NOT NULL DEFAULT '',
                  aggregation_version TEXT NOT NULL DEFAULT '', started_at TEXT, completed_at TEXT,
                  last_error TEXT NOT NULL DEFAULT '', UNIQUE(job_id, code, start_date, end_date)
                );
                CREATE INDEX IF NOT EXISTS idx_kbar_segments_job ON kbar_download_segments(job_id, state, start_date);
                CREATE INDEX IF NOT EXISTS idx_kbar_segments_code ON kbar_download_segments(code, state, start_date);
                CREATE TABLE IF NOT EXISTS kbar_history_floor (
                  code TEXT PRIMARY KEY, floor_date TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                """
            )

    def recover_inflight(self) -> None:
        """A process restart cannot leave an in-memory SDK request reserved. What it put back is recorded --
        one event per segment (its job, code, dates, attempts, old and new state and why), and one per job whose
        state changed -- read before the update, so what the row's last_error is later overwritten with does not
        erase it. A segment is never one item of a job-wide list: the event detail keeps only scalars and short
        lists, and a long job lost most of its segments that way."""
        with self.connect() as conn:
            downloading = conn.execute(
                "SELECT job_id, segment_id, code, start_date, end_date, attempts FROM kbar_download_segments WHERE state='DOWNLOADING' ORDER BY job_id, start_date"
            ).fetchall()
            conn.execute(
                "UPDATE kbar_download_segments SET state='PENDING',reserved_bytes=0,last_error='RECOVERED_AFTER_RESTART' WHERE state='DOWNLOADING'"
            )
            resumed = [str(row[0]) for row in conn.execute(
                "SELECT job_id FROM kbar_download_jobs WHERE state='PARTIAL' AND EXISTS (SELECT 1 FROM kbar_download_segments s WHERE s.job_id=kbar_download_jobs.job_id AND s.state='PENDING')"
            )]
            conn.execute(
                "UPDATE kbar_download_jobs SET state='READY',last_error='RECOVERED_AFTER_RESTART',updated_at=? WHERE state='PARTIAL' AND EXISTS (SELECT 1 FROM kbar_download_segments s WHERE s.job_id=kbar_download_jobs.job_id AND s.state='PENDING')",
                (_iso(self._clock()),),
            )
        counts: dict[str, int] = {}
        for job_id, segment_id, code, start, end, attempts in downloading:
            counts[str(job_id)] = counts.get(str(job_id), 0) + 1
            _record_kbar_recovery("inflight_at_restart", {"job_id": str(job_id), "segment_id": segment_id, "code": code,
                                                          "start_date": start, "end_date": end, "attempts": attempts,
                                                          "old_state": "DOWNLOADING", "new_state": "PENDING",
                                                          "reason": "RECOVERED_AFTER_RESTART"})
        for job_id in sorted(resumed):
            _record_kbar_recovery("inflight_at_restart", {"job_id": job_id, "segments_recovered": counts.get(job_id, 0),
                                                          "job_old_state": "PARTIAL", "job_new_state": "READY",
                                                          "reason": "RECOVERED_AFTER_RESTART"})

    def insert_job(self, plan: dict[str, Any], *, state: str, user_budget_bytes: int | None,
                   safety_reserve_bytes: int, auto_resume: bool) -> str:
        job_id = uuid.uuid4().hex
        now = _iso(self._clock())
        with self._lock, self.connect() as conn:
            conn.execute("INSERT INTO kbar_download_jobs(job_id,code,start_date,end_date,state,user_budget_bytes,safety_reserve_bytes,auto_resume,estimate_bytes,conservative_estimate_bytes,estimate_confidence,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                         (job_id, plan["code"], plan["start_date"], plan["end_date"], state, user_budget_bytes, max(0, int(safety_reserve_bytes)), int(auto_resume), plan["estimate_bytes"], plan["conservative_estimate_bytes"], plan["estimate_confidence"], now, now))
            for segment in plan["segments"]:
                conn.execute("INSERT INTO kbar_download_segments(segment_id,job_id,code,start_date,end_date,state,estimate_bytes) VALUES(?,?,?,?,?,?,?)",
                             (uuid.uuid4().hex, job_id, segment["code"], segment["start_date"], segment["end_date"], "PENDING", segment["estimate_bytes"]))
        return job_id

    def job(self, job_id: str) -> dict[str, Any]:
        with self.connect() as conn:
            job = conn.execute("SELECT * FROM kbar_download_jobs WHERE job_id=?", (str(job_id),)).fetchone()
            if job is None:
                return {}
            result = dict(job)
            result["segments"] = [dict(row) for row in conn.execute("SELECT * FROM kbar_download_segments WHERE job_id=? ORDER BY start_date", (str(job_id),))]
            return result

    def list_jobs(self, limit: int = 50) -> list[dict[str, Any]]:
        with self.connect() as conn:
            ids = [str(row[0]) for row in conn.execute("SELECT job_id FROM kbar_download_jobs ORDER BY updated_at DESC LIMIT ?", (max(1, min(500, int(limit))),))]
        return [self.job(job_id) for job_id in ids]

    def inflight_reserved_bytes(self, conn: sqlite3.Connection | None = None) -> int:
        """What segments downloading now have reserved of the quota."""
        if conn is None:
            with self.connect() as own:
                return self.inflight_reserved_bytes(own)
        return int(conn.execute("SELECT COALESCE(SUM(reserved_bytes),0) FROM kbar_download_segments WHERE state='DOWNLOADING'").fetchone()[0] or 0)

    def set_job_state(self, job_id: str, state: str, error: str = "") -> None:
        with self.connect() as conn:
            conn.execute("UPDATE kbar_download_jobs SET state=?,last_error=?,updated_at=? WHERE job_id=?", (state, error, _iso(self._clock()), str(job_id)))

    def set_segment(self, segment_id: str, **values: Any) -> None:
        allowed = {key: value for key, value in values.items() if key in {"state", "row_count", "observed_bytes", "reserved_bytes", "source_version", "aggregation_version", "last_error", "completed_at"}}
        if allowed.get("state") == "COMPLETED":
            allowed.setdefault("completed_at", _iso(self._clock()))
            allowed.setdefault("reserved_bytes", 0)
        if not allowed:
            return
        with self.connect() as conn:
            conn.execute("UPDATE kbar_download_segments SET " + ",".join(f"{key}=?" for key in allowed) + " WHERE segment_id=?", (*allowed.values(), segment_id))

    def reset_segments(self, job_id: str) -> None:
        with self.connect() as conn:
            conn.execute("UPDATE kbar_download_segments SET state='PENDING',last_error='',reserved_bytes=0 WHERE job_id=? AND state IN ('FAILED','WAITING_BUDGET','WAITING_ESTIMATE')", (job_id,))

    def cancel_segments(self, job_id: str) -> None:
        with self.connect() as conn:
            conn.execute("UPDATE kbar_download_segments SET state='CANCELLED',reserved_bytes=0,last_error='CANCELLED_BY_USER' WHERE job_id=? AND state NOT IN ('COMPLETED','CANCELLED')", (job_id,))

    def auto_resume_waiting(self) -> list[tuple[str, str]]:
        """(job_id, state) of every auto-resume job waiting for the quota (too little, or unreadable)."""
        with self.connect() as conn:
            return [(str(row[0]), str(row[1])) for row in conn.execute(
                "SELECT job_id, state FROM kbar_download_jobs WHERE auto_resume=1 AND state IN (?, ?) ORDER BY updated_at",
                (WAITING_BUDGET, WAITING_USAGE))]

    def history_floor(self, code: str) -> str:
        """The date before which the broker was found to hold nothing of `code`; "" when not found yet."""
        with self.connect() as conn:
            row = conn.execute("SELECT floor_date FROM kbar_history_floor WHERE code=?", (code,)).fetchone()
        return str(row[0]) if row else ""

    def set_history_floor(self, code: str, floor_date: str) -> None:
        with self.connect() as conn:
            conn.execute("INSERT INTO kbar_history_floor(code,floor_date,updated_at) VALUES(?,?,?) "
                         "ON CONFLICT(code) DO UPDATE SET floor_date=MAX(floor_date,excluded.floor_date),updated_at=excluded.updated_at",
                         (code, floor_date, _iso(self._clock())))

    def latest_job_id(self, code: str) -> str:
        with self.connect() as conn:
            row = conn.execute("SELECT job_id FROM kbar_download_jobs WHERE code=? ORDER BY created_at DESC, rowid DESC LIMIT 1", (code,)).fetchone()
        return str(row[0]) if row else ""


class UsageSampler:
    """The broker's daily download quota: sampled into kbar_usage_samples, answered from the latest sample, and the
    per-day size estimate learned from what downloads observed."""

    def __init__(self, api_provider: Callable[[], Any | None], jobs: KBarJobStore, *, lock: threading.RLock,
                 clock: Callable[[], datetime], ttl_seconds: int) -> None:
        self._api_provider = api_provider
        self._jobs = jobs
        self._lock = lock
        self._clock = clock
        self.ttl_seconds = max(1, int(ttl_seconds))
        self.stopped = False
        self.thread: threading.Thread | None = None
        self._failed_at: datetime | None = None
        self._sampling = False

    def _usage_from_payload(self, payload: Any) -> UsageSnapshot:
        now = _iso(self._clock())
        used = _json_number(_field(payload, ("bytes", "used_bytes", "used")))
        limit = _json_number(_field(payload, ("limit_bytes", "limit", "quota_bytes")))
        remaining = _json_number(_field(payload, ("remaining_bytes", "remaining")))
        if remaining is None and limit is not None and used is not None:
            remaining = max(0, limit - used)
        return UsageSnapshot(used, limit, remaining, now, fresh=True)

    def _backing_off(self) -> bool:
        return self._failed_at is not None and (self._clock() - self._failed_at).total_seconds() < USAGE_FAILURE_BACKOFF_SECONDS

    def refresh(self, *, force: bool = False) -> dict[str, Any]:
        """``force``: ask the broker now. Otherwise answer from the latest sample: a sample from today is returned even
        past ``ttl_seconds`` (marked ``expired``) -- the background sampler keeps it current -- and the broker is asked
        only when there is no sample from today, at most once per failure backoff."""
        with self._lock:
            if not force:
                row = self.latest()
                if row and self._same_day(row["observed_at"]):
                    expired = self._age_seconds(row["observed_at"]) > self.ttl_seconds
                    return {"ok": True, **dict(row), "cached": True, "expired": expired, "known": row["remaining_bytes"] is not None}
                if self._backing_off():
                    return {"ok": False, "known": False, "expired": True, "error": "usage_backoff", "observed_at": _iso(self._clock())}
            if self.stopped:
                return {"ok": False, "known": False, "error": "shutdown_in_progress"}
            try:
                api = self._api_provider()
                usage = getattr(api, "usage", None) if api is not None else None
                if not callable(usage):
                    raise RuntimeError("Shioaji usage API unavailable")
                snapshot = self._usage_from_payload(usage())
            except Exception as exc:
                record_failure(_failure_log, "reading the Shioaji download usage", exc)
                self._failed_at = self._clock()
                return {"ok": False, "known": False, "expired": True, "error": str(exc), "observed_at": _iso(self._clock())}
            self._failed_at = None
            with self._jobs.connect() as conn:
                conn.execute(
                    "INSERT INTO kbar_usage_samples(observed_at,used_bytes,limit_bytes,remaining_bytes,model_version) VALUES(?,?,?,?,?)",
                    (snapshot.observed_at, snapshot.used_bytes, snapshot.limit_bytes, snapshot.remaining_bytes, ESTIMATE_MODEL_VERSION),
                )
            return {"ok": True, "used_bytes": snapshot.used_bytes, "limit_bytes": snapshot.limit_bytes,
                    "remaining_bytes": snapshot.remaining_bytes, "observed_at": snapshot.observed_at,
                    "known": snapshot.known, "cached": False, "expired": False}

    def sample_if_due(self, *, interval_seconds: float = USAGE_SAMPLE_SECONDS, background: bool = True) -> bool:
        """Keep one quota sample per ``interval_seconds`` while the broker is logged in (and a fresh one each day).

        Called from the daemon's once-a-minute maintenance; never blocks it (the broker call runs on its own thread)
        and never calls the broker while logged out. Returns whether a sample was started.
        """
        if self.stopped or self._sampling or self._api_provider() is None:
            return False
        row = self.latest()
        if row and self._same_day(row["observed_at"]) and self._age_seconds(row["observed_at"]) < interval_seconds:
            return False
        if self._backing_off():
            return False
        self._sampling = True

        def run() -> None:
            try:
                self.refresh(force=True)
            finally:
                self._sampling = False

        if background:
            self.thread = threading.Thread(target=run, name="shioaji-usage-sample", daemon=True)
            self.thread.start()
        else:
            run()
        return True

    def _same_day(self, stamp: str) -> bool:
        """The quota is daily (Taipei): yesterday's sample says nothing about today."""
        try:
            value = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
            current = self._clock()
            value = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
            current = current if current.tzinfo else current.replace(tzinfo=timezone.utc)
            return value.astimezone(_TAIPEI).date() == current.astimezone(_TAIPEI).date()
        except Exception:  # not an error: a value that is not a datetime is not today by contract
            return False

    def latest(self) -> sqlite3.Row | None:
        with self._jobs.connect() as conn:
            return conn.execute("SELECT * FROM kbar_usage_samples ORDER BY id DESC LIMIT 1").fetchone()

    def _age_seconds(self, stamp: str) -> float:
        try:
            value = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
            current = self._clock()
            if current.tzinfo is None:
                current = current.replace(tzinfo=timezone.utc)
            if value.tzinfo is None:
                value = value.replace(tzinfo=timezone.utc)
            return max(0.0, (current - value).total_seconds())
        except Exception:  # not an error: a value that is not a datetime has an unknown (infinite) age by contract
            return float("inf")

    def estimate_model(self) -> tuple[float | None, int, str]:
        """(bytes per day, samples, confidence) from what recent downloads observed."""
        with self._jobs.connect() as conn:
            rows = conn.execute(
                "SELECT observed_bytes,day_count FROM kbar_usage_samples WHERE observed_bytes>0 AND day_count>0 ORDER BY id DESC LIMIT 20"
            ).fetchall()
        if not rows:
            return float(FIRST_DOWNLOAD_BYTES_PER_DAY), 0, "NONE"
        values = [float(row["observed_bytes"]) / max(1, int(row["day_count"])) for row in rows]
        # Conservative estimate: max recent daily sample plus 25% headroom.
        return max(values) * 1.25, len(values), "MEDIUM" if len(values) >= 3 else "LOW"

    def record_download(self, segment: dict[str, Any], rows: int, observed: int) -> None:
        """What one segment's download used of the quota, as a sample for the estimate model. A usage difference is
        an observation, not an exact per-request bill: another process may have consumed the shared official quota."""
        with self._jobs.connect() as conn:
            conn.execute("UPDATE kbar_download_segments SET observed_bytes=? WHERE segment_id=?", (int(observed), segment["segment_id"]))
            conn.execute("UPDATE kbar_usage_samples SET observed_bytes=?,row_count=?,day_count=?,external_interference=? WHERE id=(SELECT id FROM kbar_usage_samples ORDER BY id DESC LIMIT 1)", (int(observed), int(rows), max(1, (_date(segment["end_date"]) - _date(segment["start_date"])).days + 1), 0))


class DownloadedBars:
    """What a download brought, into the K-bar store: one Rust B run per product (`--import-kbars`), which keeps each date
    at the finest timeframe the active retention still allows at its age and ages it with every other date afterwards.
    Nothing is kept anywhere else."""

    def __init__(self, kbar_root: Callable[[], Path], runner: Callable[[Path, dict[str, Any]], dict[str, Any]]) -> None:
        self._kbar_root = kbar_root
        self._runner = runner

    @property
    def root(self) -> Path:
        return Path(self._kbar_root())

    def held_dates(self, code: str) -> set[str]:
        """The dates the store holds of `code`: a date with a daily bar needs no download."""
        path = self.root / "source=shioaji" / "market=STK" / f"{code}.json"
        try:
            session = json.loads(path.read_bytes())["sessions"].get("DAY", {})
        except FileNotFoundError:  # not an error: a product the store holds nothing of
            return set()
        return set(session.get("daily", {})) | set(session.get("intraday", {}))

    def save(self, code: str, frame: pd.DataFrame) -> None:
        """``frame``: the 1-minute bars the broker returned for a download job."""
        if frame is None or frame.empty:
            return
        value = frame.copy()
        value["datetime"] = pd.to_datetime(value["datetime"], errors="coerce")
        value = value.dropna(subset=["datetime"]).sort_values("datetime", kind="stable")
        self.validate(value)
        days = [{"date": day, "minutes": self.minute_rows(group)}
                for day, group in value.groupby(value["datetime"].dt.strftime("%Y-%m-%d"), sort=True)]
        answer = self._runner(self.root, {"source": "shioaji", "market": "STK", "session": "DAY", "code": code, "days": days})
        if answer.get("ok") is not True:
            raise RuntimeError(f"KBAR_IMPORT_FAILED: {answer.get('error')}")

    @staticmethod
    def validate(frame: pd.DataFrame) -> None:
        for column in ("open", "high", "low", "close", "volume"):
            if column not in frame.columns:
                raise RuntimeError(f"KBAR_COLUMN_MISSING: {column}")
        for column in ("open", "high", "low", "close", "volume"):
            values = pd.to_numeric(frame[column], errors="coerce")
            if values.isna().any() or (values < 0).any():
                raise RuntimeError(f"KBAR_VALUE_INVALID: {column}")
        high = pd.to_numeric(frame["high"], errors="coerce")
        low = pd.to_numeric(frame["low"], errors="coerce")
        op = pd.to_numeric(frame["open"], errors="coerce")
        cl = pd.to_numeric(frame["close"], errors="coerce")
        if ((high < op) | (high < cl) | (low > op) | (low > cl)).any():
            raise RuntimeError("KBAR_OHLC_INCONSISTENT")

    @staticmethod
    def minute_rows(day: pd.DataFrame) -> list[list[Any]]:
        """[minute, open, high, low, close, volume]. The broker stamps a minute bar with the minute's END (a stock day's
        first bar is 09:01): the row carries the minute the bar covers, as Market Runtime's minutes do."""
        minutes = day["datetime"].dt.hour * 60 + day["datetime"].dt.minute - 1
        return [[int(minute), float(open_), float(high), float(low), float(close), float(volume)]
                for minute, open_, high, low, close, volume
                in zip(minutes, day["open"], day["high"], day["low"], day["close"], day["volume"])]


def import_into_kbar_store(kbar_root: Path, payload: dict[str, Any]) -> dict[str, Any]:
    """The Rust B run that writes `payload` under the store's own lock, retention and fold (kbar_store.rs)."""
    from config.config_revisions import config_root
    from service.platform.native_binaries import analysis_runtime_job_binary

    with tempfile.TemporaryDirectory(prefix="kbar-import-") as folder:
        source = Path(folder) / "days.json"
        source.write_text(json.dumps(payload), encoding="utf-8")
        run = subprocess.run([str(analysis_runtime_job_binary()), "--import-kbars", "--kbar-dir", str(kbar_root),
                              "--retention-config-root", str(config_root()), "--input", str(source)],
                             capture_output=True, text=True, timeout=120, check=False)
    lines = run.stdout.strip().splitlines()
    if not lines:
        return {"ok": False, "error": run.stderr.strip() or f"exit {run.returncode}"}
    return json.loads(lines[-1])


def _kbar_root() -> Path:
    from service.platform.model_storage_layout import process_kbar_root

    return process_kbar_root()


class KBarDownloadManager:
    """Plans and runs K-bar download jobs: reserves each segment against the quota, downloads it, and waits when it
    cannot. The jobs, the quota and the minute files are its parts (``jobs``, ``usage``, ``minutes``)."""

    def __init__(
        self,
        api_provider: Callable[[], Any | None],
        repository: Any,
        *,
        db_path: str | Path | None = None,
        kbar_root: Callable[[], Path] = _kbar_root,
        import_runner: Callable[[Path, dict[str, Any]], dict[str, Any]] = import_into_kbar_store,
        clock: Callable[[], datetime] = _now,
        usage_ttl_seconds: int = 120,
    ) -> None:
        self.api_provider = api_provider
        self.repository = repository
        self.clock = clock
        # One lock for the parts: a segment's claim (here) and the retention's per-file decision (minutes) exclude
        # each other, and a quota refresh is one at a time.
        self._lock = threading.RLock()
        self._shutdown = False
        # Jobs a caller is draining right now: one runner per job.
        self._running_jobs: set[str] = set()
        self._jobs_idle = threading.Condition(self._lock)    # notified when a job runner ends (shutdown waits on it)
        self.jobs = KBarJobStore(Path(db_path or process_market_layout().metadata_db), lock=self._lock, clock=clock)
        self.usage = UsageSampler(api_provider, self.jobs, lock=self._lock, clock=clock, ttl_seconds=usage_ttl_seconds)
        self.bars = DownloadedBars(kbar_root, import_runner)
        # Products a request is being planned for right now: one job per product.
        self._planning: set[str] = set()
        self.jobs.recover_inflight()

    # -- what the routes and the daemon read and ask ---------------------------------------------------------------

    def refresh_usage(self, *, force: bool = False) -> dict[str, Any]:
        return self.usage.refresh(force=force)

    def sample_usage_if_due(self, *, interval_seconds: float = USAGE_SAMPLE_SECONDS, background: bool = True) -> bool:
        return self.usage.sample_if_due(interval_seconds=interval_seconds, background=background)

    def job(self, job_id: str) -> dict[str, Any]:
        return self.jobs.job(job_id)

    def list_jobs(self, limit: int = 50) -> list[dict[str, Any]]:
        return self.jobs.list_jobs(limit)

    # -- planning --------------------------------------------------------------------------------------------------

    def _missing_dates(self, code: str, start: date, end: date) -> list[str]:
        """The trading days of the range the K-bar store does not hold."""
        held = self.bars.held_dates(code)
        days = (day.date() for day in pd.date_range(start, end, freq="D"))
        return [day.isoformat() for day in days if tw_is_trading_day(day) and day.isoformat() not in held]

    @staticmethod
    def _segments(code: str, missing: list[str]) -> list[dict[str, Any]]:
        if not missing:
            return []
        days = [_date(value) for value in missing]
        result: list[dict[str, Any]] = []
        begin = days[0]
        previous = begin
        for current in days[1:]:
            # A held day between two missing ones costs less than another request: the store keeps its own rows.
            if (current - begin).days >= MAX_KBARS_DAYS:
                result.append({"code": code, "start_date": begin.isoformat(), "end_date": previous.isoformat()})
                begin = current
            previous = current
        result.append({"code": code, "start_date": begin.isoformat(), "end_date": previous.isoformat()})
        return result

    def preview(self, code: str, start_date: str, end_date: str, *, user_budget_bytes: int | None = None,
                safety_reserve_bytes: int = 0, refresh_usage: bool = True) -> dict[str, Any]:
        code = str(code or "").strip().upper()
        start, end = _date(start_date), _date(end_date)
        if not code or end < start:
            raise ValueError("invalid code/date range")
        usage = self.usage.refresh(force=bool(refresh_usage))
        missing = self._missing_dates(code, start, end)
        per_day, samples, confidence = self.usage.estimate_model()
        segments = self._segments(code, missing)
        for segment in segments:
            day_count = (_date(segment["end_date"]) - _date(segment["start_date"])).days + 1
            segment["estimate_bytes"] = math.ceil(per_day * day_count) if per_day is not None else None
        total = sum(int(row["estimate_bytes"] or 0) for row in segments) if per_day is not None else None
        official = usage.get("remaining_bytes") if usage.get("known") else None
        inflight = self.jobs.inflight_reserved_bytes()
        effective = None if official is None or total is None else max(0, min(int(official), int(user_budget_bytes) if user_budget_bytes is not None else int(official)) - max(0, int(safety_reserve_bytes)) - inflight)
        return {"ok": True, "code": code, "start_date": start.isoformat(), "end_date": end.isoformat(),
                "missing_dates": missing, "segments": segments, "segment_count": len(segments),
                "estimate_bytes": total, "conservative_estimate_bytes": total,
                "estimate_confidence": confidence, "sample_count": samples,
                "usage": usage, "inflight_reserved_bytes": inflight, "effective_available_bytes": effective,
                "can_execute": bool(not segments or (effective is not None and total is not None and effective >= total)),
                "estimate_model_version": ESTIMATE_MODEL_VERSION}

    def create_job(self, code: str, start_date: str, end_date: str, *, user_budget_bytes: int | None = None,
                   safety_reserve_bytes: int = 0, auto_resume: bool = False) -> dict[str, Any]:
        plan = self.preview(code, start_date, end_date, user_budget_bytes=user_budget_bytes,
                            safety_reserve_bytes=safety_reserve_bytes, refresh_usage=True)
        return self._create_job(plan, user_budget_bytes=user_budget_bytes, safety_reserve_bytes=safety_reserve_bytes, auto_resume=auto_resume)

    def _create_job(self, plan: dict[str, Any], *, user_budget_bytes: int | None = None, safety_reserve_bytes: int = 0,
                    auto_resume: bool = False) -> dict[str, Any]:
        state = "COMPLETED" if not plan["segments"] else (WAITING_ESTIMATE if plan["estimate_bytes"] is None else "READY")
        job_id = self.jobs.insert_job(plan, state=state, user_budget_bytes=user_budget_bytes,
                                      safety_reserve_bytes=safety_reserve_bytes, auto_resume=auto_resume)
        return self.job(job_id)

    # -- running ---------------------------------------------------------------------------------------------------

    @staticmethod
    def _wait_state(reason: str) -> str:
        """The job state a refused reservation leaves the job in -- one state per reason, so 額度 API 無法讀取
        (WAITING_USAGE) is never shown as 額度不足 (WAITING_BUDGET)."""
        if reason in (WAITING_ESTIMATE, WAITING_USAGE):
            return reason
        if reason.startswith("BUDGET_INSUFFICIENT"):
            return WAITING_BUDGET
        raise ValueError(f"unknown reservation outcome {reason!r}")

    def _reserve(self, job: dict[str, Any], segment: dict[str, Any]) -> tuple[bool, str]:
        estimate = segment.get("estimate_bytes")
        usage = self.usage.refresh(force=True)
        if estimate is None:
            return False, WAITING_ESTIMATE
        if not usage.get("known"):
            return False, WAITING_USAGE
        with self._lock, self.jobs.connect() as conn:
            inflight = self.jobs.inflight_reserved_bytes(conn)
            official = int(usage.get("remaining_bytes") or 0)
            safety = int(job.get("safety_reserve_bytes") or 0)
            user_budget = job.get("user_budget_bytes")
            observed = int(conn.execute("SELECT COALESCE(SUM(observed_bytes),0) FROM kbar_download_segments WHERE job_id=?", (job["job_id"],)).fetchone()[0] or 0)
            user_available = official if user_budget is None else max(0, int(user_budget) - observed - int(segment.get("reserved_bytes") or 0))
            effective = min(official, user_available) - safety - inflight
            if effective < int(estimate):
                return False, f"BUDGET_INSUFFICIENT: available={max(0,effective)} estimate={int(estimate)}"
            claimed = conn.execute("UPDATE kbar_download_segments SET state='DOWNLOADING',reserved_bytes=?,attempts=attempts+1,started_at=?,last_error='' WHERE segment_id=? AND state='PENDING'", (int(estimate), _iso(self.clock()), segment["segment_id"])).rowcount
            # The UPDATE only claims a segment that is still PENDING. Zero rows means another caller
            # took it between our read and this write -- it is theirs to download, not ours.
            if claimed != 1:
                return False, "SEGMENT_TAKEN"
            return True, "RESERVED"

    def run_next(self, job_id: str) -> dict[str, Any]:
        if self._shutdown:
            return {"ok": False, "state": "CANCELLED", "error": "shutdown_in_progress"}
        job = self.job(job_id)
        if not job:
            return {"ok": False, "error": "job_not_found"}
        if job.get("state") in {"PAUSED", "CANCELLED", "COMPLETED"}:
            return job
        segment = next((row for row in job.get("segments", []) if row.get("state") == "PENDING"), None)
        if segment is None:
            self.jobs.set_job_state(job_id, "COMPLETED")
            return self.job(job_id)
        allowed, reason = self._reserve(job, segment)
        if reason == "SEGMENT_TAKEN":
            return {**self.job(job_id), "skipped": reason}
        if not allowed:
            self.jobs.set_job_state(job_id, self._wait_state(reason), reason)
            return self.job(job_id)
        try:
            before_usage = self.usage.latest()
            before_remaining = int(before_usage["remaining_bytes"]) if before_usage and before_usage["remaining_bytes"] is not None else None
            frame = self.repository.fetch_broker_kbars_for_download(segment["code"], segment["start_date"], segment["end_date"])
            rows = int(len(frame))
            self.bars.save(segment["code"], frame)
            after_usage = self.usage.refresh(force=True)
            after_remaining = int(after_usage["remaining_bytes"]) if after_usage.get("known") else None
            observed = max(0, before_remaining - after_remaining) if before_remaining is not None and after_remaining is not None else 0
            self.jobs.set_segment(segment["segment_id"], state="COMPLETED", row_count=rows, observed_bytes=observed,
                                  source_version="shioaji-kbars-v1", aggregation_version=AGGREGATION_VERSION)
            self.jobs.set_job_state(job_id, "PARTIAL")
            self.usage.record_download(segment, rows, observed)
            if not any(row.get("state") == "PENDING" for row in self.job(job_id).get("segments", [])):
                self.jobs.set_job_state(job_id, "COMPLETED")
        except Exception as exc:
            record_failure(_failure_log, f"downloading the K bars of {segment['code']} {segment['start_date']}..{segment['end_date']}", exc)
            self.jobs.set_segment(segment["segment_id"], state="FAILED", last_error=str(exc), reserved_bytes=0)
            # A request the broker refused with the quota gone is a used-up quota, read from the quota itself.
            self.jobs.set_job_state(job_id, WAITING_BUDGET if self._quota_is_gone() else "FAILED", str(exc))
        return self.job(job_id)

    def run_job(self, job_id: str, *, max_segments: int = 1000) -> dict[str, Any]:
        """Drain ready segments until completion or a durable wait state. One runner per job: a second caller while
        one is draining it gets the job's current state back and downloads nothing."""
        with self._lock:
            if str(job_id) in self._running_jobs:
                return {**self.job(job_id), "busy": True}
            self._running_jobs.add(str(job_id))
        try:
            return self._drain(job_id, max_segments=max_segments)
        finally:
            with self._lock:
                self._running_jobs.discard(str(job_id))
                self._jobs_idle.notify_all()

    def _drain(self, job_id: str, *, max_segments: int) -> dict[str, Any]:
        result = self.job(job_id)
        for _ in range(max(1, int(max_segments))):
            if self._shutdown:
                return result         # shutting down: the segment in flight finished; the rest waits for next start
            if result.get("state") in _DRAIN_STOPS:
                return result
            result = self.run_next(job_id)
            if result.get("skipped"):
                return result
            if result.get("state") in _DRAIN_STOPS:
                return result
        return self.job(job_id)

    def _quota_is_gone(self) -> bool:
        usage = self.usage.refresh(force=True)
        return bool(usage.get("known")) and int(usage.get("remaining_bytes") or 0) <= 0

    # -- 技術分析's earlier bars ------------------------------------------------------------------------------------

    def request_older(self, code: str, before: str) -> dict[str, Any]:
        """Earlier bars of `code` before `before`, asked for by a chart scrolled to its oldest bar: answers at once, the
        download runs behind it. One job per product at a time; a product found to end is not asked of the broker again."""
        code = str(code or "").strip().upper()
        floor = self.jobs.history_floor(code)
        if floor and str(before) <= floor:
            return {"ok": True, "state": "END", "code": code}
        with self._lock:
            latest = self.job(self.jobs.latest_job_id(code)) if self.jobs.latest_job_id(code) else {}
            if code in self._planning or str(latest.get("job_id") or "") in self._running_jobs:
                return {"ok": True, "state": "RUNNING", "code": code}
            self._planning.add(code)
        try:
            job = technical_history_job(code, before)
            plan = self.preview(job["code"], job["start_date"], job["end_date"])
            if not plan["segments"]:
                return {"ok": True, "state": "DONE", "code": code, "rows": 0}
            if not plan["usage"].get("known"):
                reason = str(plan["usage"].get("error") or "USAGE_UNAVAILABLE")
                record_failure(_failure_log, f"reading the broker quota for the K bars of {code}", RuntimeError(reason))
                return {"ok": True, "state": "FAILED", "code": code, "error": reason}
            if not plan["can_execute"]:
                return {"ok": True, "state": "QUOTA_FULL", "code": code}
            created = self._create_job(plan)
            with self._lock:
                self._running_jobs.add(str(created["job_id"]))
            threading.Thread(target=self._run_older, args=(code, str(before), str(created["job_id"])),
                             name=f"kbar-older-{code}", daemon=True).start()
            return {"ok": True, "state": "RUNNING", "code": code}
        finally:
            with self._lock:
                self._planning.discard(code)

    def _run_older(self, code: str, before: str, job_id: str) -> None:
        try:
            result = self._drain(job_id, max_segments=1000)
            segments = result.get("segments") or []
            # The broker answered every part of the range and none held a bar: nothing older exists there.
            if result.get("state") == "COMPLETED" and segments and not sum(int(row.get("row_count") or 0) for row in segments):
                self.jobs.set_history_floor(code, before)
        except Exception as exc:
            record_failure(_failure_log, f"running the K-bar download {job_id} of {code}", exc)
            self.jobs.set_job_state(job_id, "FAILED", str(exc))
        finally:
            with self._lock:
                self._running_jobs.discard(job_id)
                self._jobs_idle.notify_all()

    def older_status(self, code: str) -> dict[str, Any]:
        """Where the latest request of `code` stands. DONE names the range, for the chart to read it back."""
        code = str(code or "").strip().upper()
        job_id = self.jobs.latest_job_id(code)
        with self._lock:
            running = job_id in self._running_jobs or code in self._planning
        if running or not job_id:
            return {"ok": True, "state": "RUNNING" if running else "IDLE", "code": code}
        job = self.job(job_id)
        state = str(job.get("state") or "")
        answer = {"ok": True, "code": code, "start_date": job.get("start_date"), "end_date": job.get("end_date")}
        rows = sum(int(row.get("row_count") or 0) for row in job.get("segments") or [])
        if state == "COMPLETED":
            return {**answer, "state": "DONE" if rows else "END", "rows": rows}
        if state == WAITING_BUDGET:
            return {**answer, "state": "QUOTA_FULL"}
        return {**answer, "state": "FAILED", "error": str(job.get("last_error") or state)}

    def set_action(self, job_id: str, action: str) -> dict[str, Any]:
        action = str(action or "").lower()
        if action == "pause":
            self.jobs.set_job_state(job_id, "PAUSED")
        elif action in {"resume", "retry"}:
            self.jobs.reset_segments(job_id)
            self.jobs.set_job_state(job_id, "READY")
        elif action == "cancel":
            self.jobs.cancel_segments(job_id)
            self.jobs.set_job_state(job_id, "CANCELLED")
        elif action == "run":
            return self.run_job(job_id)
        else:
            raise ValueError("invalid action")
        return self.job(job_id)

    def plan_auto_downloads(self, *, today: date) -> dict[str, Any]:
        """Entry point of the automatic download -- deliberately not implemented yet.

        Decided scope: every download feature stays; an automatic download is only ever for a stock the actual
        account has traded, never for any other. Left open by the user until it is built: when it runs (after the
        14:40 STK seal), which dates, how much of the daily quota it may take (through ``_reserve`` like every job)
        and how the daemon reads the traded stocks (read-only; the account data is never changed). The daily
        maintenance calls this so the hook and its report already exist; it creates nothing.
        """
        return {"ok": True, "enabled": False, "reason": "NOT_IMPLEMENTED", "date": today.isoformat(), "jobs_created": 0}

    def resume_auto_jobs(self) -> list[dict[str, Any]]:
        """Resume only jobs explicitly marked for post-reset continuation."""
        waiting = self.jobs.auto_resume_waiting()
        results = [self.run_job(job_id) for job_id, _state in waiting]
        # One event per job: a list cut at 20 lost which ones were resumed.
        for (job_id, old_state), result in zip(waiting, results):
            _record_kbar_recovery("budget_resume", {"job_id": job_id, "old_state": old_state,
                                                    "new_state": (result or {}).get("state") if isinstance(result, dict) else None})
        return results

    def shutdown(self, timeout: float = 5.0) -> dict[str, Any]:
        """No new job segment or usage sample starts, and a sample in flight is waited for (bounded): nothing of this
        manager calls the broker or writes after logout."""
        self._shutdown = True
        self.usage.stopped = True
        deadline = time.monotonic() + max(0.0, float(timeout))
        thread = self.usage.thread
        if thread is not None and thread.is_alive():
            thread.join(max(0.0, deadline - time.monotonic()))
        running = bool(thread is not None and thread.is_alive())
        # A job runner calls the broker too: it stops after the segment
        # in flight, and that is waited for within the same budget.
        with self._lock:
            self._jobs_idle.wait_for(lambda: not self._running_jobs, timeout=max(0.0, deadline - time.monotonic()))
            jobs = sorted(self._running_jobs)
        return {"ok": not running and not jobs, "usage_sample_running": running, "jobs_running": jobs}
