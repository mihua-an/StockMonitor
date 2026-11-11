"""Materialization request authority: intents (anyone) -> ledger (session owner only).

Ownership (docs/system-architecture/03_protocol_and_storage.md §1):
- Manual/admin/API/read-side code may only *propose an intent* (``propose_intent``).
  Intents are durable, idempotent files; proposing never creates a job.
- The per-source session owner (SessionOrchestrator for Shioaji,
  FutuSessionLifecycleCoordinator for Futu) drains its own source's intents,
  decides whether the session is sealed, and is the ONLY caller of
  ``MaterializationLedger.submit``, the only code that writes a Rust
  Materializer job request.
- Health only runs the job process; it never sees this ledger.

ONE deterministic key builder (``MaterializationKey.for_session``): the identity
is exactly the WAL identity contract (session_identity_contract.py) -
``source + market + trading_date + session`` (+ an explicit ``instrument`` scope,
empty = every instrument of the session) + the materialization schema version.
No "*" string is passed around: the wildcard exists only at the Rust CLI edge.

State machine per key::

    PENDING -> RUNNING -> SUCCEEDED                       (valid artifact produced)
                       -> NO_INPUT   (terminal, NOT success: nothing matched)
                       -> FAILED_TERMINAL (invalid identity / attempts exhausted)
                       -> FAILED_RETRYABLE (bounded exponential backoff) -> PENDING
    RUNNING carries a lease; an expired lease (crashed/lost worker) -> FAILED_RETRYABLE.

FAILED_TERMINAL stays terminal for every automatic path (the owner's seal, a reader's intent). Only an EXPLICIT retry
-- an intent proposed with ``retry_terminal=True`` by an operator (scripts/maintenance/retry_terminal_materialization.py)
-- relaunches it with a fresh attempt budget, and the record keeps every such retry (``terminal_retries``: when, why,
and the attempts/error it replaced): a FUT night and day once exhausted five attempts against a
120 s job bound while their data was still in the WAL, and nothing could start them again.

Every launch is journaled: the record with its new job id and attempt is saved BEFORE the job request is written,
so no request exists that the ledger does not name. A crash between the two leaves a PENDING record whose request
is neither pending, claimed nor done -- the next tick reads that stage (LOST) and retries it like any lost request.
A failed request write is FAILED_RETRYABLE. A result is used only after materialization_jobs.validate_result
accepts it for this record's job and identity.

After a session's job SUCCEEDED (or found NO_INPUT: an IDX day the WAL never got, whose indexes the fill fetches
whole), its owner fills the session's gaps from the broker's history (history_fill.py) and
the record carries that step as ``fill``: ``preparing`` (fetching), ``submitted`` (a job folding the session again
from the historical store with the fills, ``<key_id>-fill``), then ``done`` (with that job's result), ``not_needed``
(every code complete) or ``failed`` (why). It never changes the record's own state: the session is materialized
either way, and a failed fill leaves its partitions as they were.

The ledger file is the authority: a missing one is an empty ledger, one that cannot be read or parsed raises
(``MaterializationLedgerUnreadable``) instead of being replaced by an empty ledger at the next save.
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from service.market.shared.materialization_jobs import (
    INVALID_RESULT, job_stage,
    ack_materialization_result, default_jobs_root, poll_materialization_result, request_materialization,
)
from service.market.shared.session_identity_contract import wal_session, wal_sessions
from service.platform.atomic_files import read_text_shared, write_json_atomic
import logging
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)

SCHEMA_VERSION = "historical-materialization-v1"
MAX_ATTEMPTS = 5
BACKOFF_BASE_SECONDS = 30.0
BACKOFF_CAP_SECONDS = 3600.0
INTENT_TTL_SECONDS = 3 * 24 * 3600.0

PENDING, RUNNING, SUCCEEDED = "pending", "running", "succeeded"
FAILED_RETRYABLE, FAILED_TERMINAL, NO_INPUT = "failed_retryable", "failed_terminal", "no_input"
ACTIVE_STATES = {PENDING, RUNNING}
WILDCARD_CLI = "*"  # Rust CLI edge only


@dataclass(frozen=True)
class MaterializationKey:
    source: str
    market: str
    trading_date: str
    session: str
    instrument: str = ""  # empty = every instrument in the session

    @classmethod
    def for_session(cls, source: str, market: str, trading_date: str, *, instrument: str = "",
                    session: str = "") -> "MaterializationKey":
        """The single builder: session tag comes from the WAL identity contract. A session-partitioned market
        (shioaji FUT: DAY / NIGHT) has no single session per date: its caller names the partition's."""
        if session and session.upper() in wal_sessions(source, market):
            return cls(source, market, trading_date, session.upper(), instrument).normalized()
        return cls(source, market, trading_date, wal_session(source, market), instrument).normalized()

    def normalized(self) -> "MaterializationKey":
        instrument = str(self.instrument or "").strip().upper()
        return MaterializationKey(
            str(self.source).strip().lower(), str(self.market).strip().upper(),
            str(self.trading_date)[:10], str(self.session).strip().upper(),
            "" if instrument in {"", WILDCARD_CLI} else instrument,
        )

    @property
    def key_id(self) -> str:
        n = self.normalized()
        raw = "|".join([n.source, n.market, n.trading_date, n.session, n.instrument, SCHEMA_VERSION])
        return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:20]

    @property
    def cli_code(self) -> str:
        return self.normalized().instrument or WILDCARD_CLI

    def as_dict(self) -> dict[str, str]:
        n = self.normalized()
        return {"source": n.source, "market": n.market, "trading_date": n.trading_date,
                "session": n.session, "instrument": n.instrument}

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "MaterializationKey":
        return cls(value["source"], value["market"], value["trading_date"], value["session"],
                   value.get("instrument", "")).normalized()


def backoff_seconds(attempts: int) -> float:
    return min(BACKOFF_CAP_SECONDS, BACKOFF_BASE_SECONDS * (2 ** max(0, attempts - 1)))


def _atomic_json(path: Path, payload: Any) -> None:
    write_json_atomic(path, payload, sort_keys=True, ensure_ascii=True)


def _read_json(path: Path) -> Any:
    try:
        return json.loads(read_text_shared(path))
    except FileNotFoundError:  # not an error: no such ledger file
        return None
    except (OSError, ValueError) as exc:
        record_failure(_failure_log, "reading a materialization ledger file", exc)
        return None


class MaterializationLedgerUnreadable(RuntimeError):
    """The ledger file exists but cannot be read as the ledger."""


def _read_ledger(path: Path) -> dict[str, dict[str, Any]]:
    try:
        text = read_text_shared(path)
    except FileNotFoundError:  # not an error: no ledger yet is an empty one
        return {}
    except OSError as exc:
        record_failure(_failure_log, "reading the materialization ledger", exc)
        raise MaterializationLedgerUnreadable(f"{path}: {exc}") from exc
    try:
        data = json.loads(text)
    except ValueError as exc:
        record_failure(_failure_log, "parsing the materialization ledger", exc)
        raise MaterializationLedgerUnreadable(f"{path}: not JSON: {exc}") from exc
    if not isinstance(data, dict) or not all(isinstance(v, dict) for v in data.values()):
        error = MaterializationLedgerUnreadable(f"{path}: not a ledger (an object of records)")
        record_failure(_failure_log, "parsing the materialization ledger", error)
        raise error
    return data


# -- intents: the ONLY thing readers / routes / scripts may create ---------------------


def _intent_dir(source: str, jobs_root: Path | None) -> Path:
    return (jobs_root or default_jobs_root()) / "intents" / str(source).strip().lower()


def propose_intent(
    source: str, market: str, trading_date: str, *, instrument: str = "",
    reason: str = "", jobs_root: Path | None = None, now: float | None = None, session: str = "",
    retry_terminal: bool = False,
) -> dict[str, Any]:
    """Durably propose that a session be materialized. Idempotent; creates no job.

    The session tag is derived from the identity contract, so a proposer cannot
    invent a session that no WAL event carries. ``retry_terminal`` is the explicit operator request that may
    relaunch a FAILED_TERMINAL record (it needs a reason, which the record keeps).
    """
    if retry_terminal and not str(reason or "").strip():
        raise ValueError("an explicit terminal retry needs a reason")
    key = MaterializationKey.for_session(source, market, trading_date, instrument=instrument, session=session)
    record = {**key.as_dict(), "key_id": key.key_id, "reason": str(reason or ""),
              "proposed_at": float(now if now is not None else time.time())}
    if retry_terminal:
        record["retry_terminal"] = True
    path = _intent_dir(key.source, jobs_root) / f"{key.key_id}.json"
    existing = _read_json(path)
    if isinstance(existing, dict):
        record["proposed_at"] = existing.get("proposed_at", record["proposed_at"])
    _atomic_json(path, record)
    return {"state": "intent_pending", **record}


def drain_intents(source: str, *, jobs_root: Path | None = None) -> list[dict[str, Any]]:
    """Owner side: read (do not delete) this source's intents; owner calls ``settle_intent``."""
    directory = _intent_dir(source, jobs_root)
    rows = []
    if directory.is_dir():
        for path in sorted(directory.glob("*.json")):
            record = _read_json(path)
            if isinstance(record, dict):
                rows.append(record)
    return rows


def settle_intent(source: str, key_id: str, *, jobs_root: Path | None = None) -> None:
    try:
        (_intent_dir(source, jobs_root) / f"{key_id}.json").unlink()
    except FileNotFoundError:  # not an error: the intent was already settled
        pass
    except OSError as exc:
        record_failure(_failure_log, "settling a materialization intent", exc)


def intent_or_job_status(
    source: str, market: str, trading_date: str, *, instrument: str = "", jobs_root: Path | None = None,
    session: str = "",
) -> dict[str, Any]:
    """Read-only status for API callers, keyed by the SAME builder as propose_intent."""
    key = MaterializationKey.for_session(source, market, trading_date, instrument=instrument, session=session)
    root = jobs_root or default_jobs_root()
    ledger = _read_json(root / "ledger" / f"{key.source}.json")
    record = (ledger or {}).get(key.key_id) if isinstance(ledger, dict) else None
    if isinstance(record, dict):
        return {"state": record.get("state"), "key_id": key.key_id, "attempts": record.get("attempts"),
                "max_attempts": MAX_ATTEMPTS, "next_attempt_at": record.get("next_attempt_at"),
                "outcome": record.get("outcome"), "last_error": record.get("last_error"),
                "updated_at": record.get("updated_at")}
    if (_intent_dir(key.source, root) / f"{key.key_id}.json").is_file():
        return {"state": "intent_pending", "key_id": key.key_id}
    return {"state": "none", "key_id": key.key_id}


# -- ledger: owned by exactly one per-source session owner -----------------------------------


class MaterializationLedger:
    def __init__(
        self, source: str, *, jobs_root: str | Path | None = None,
        clock: Callable[[], float] = time.time,
        submit_job: Callable[..., str] = request_materialization,
    ) -> None:
        self.source = str(source).strip().lower()
        self.jobs_root = Path(jobs_root) if jobs_root is not None else None
        self._clock = clock
        self._submit_job = submit_job
        self._lock = threading.RLock()
        self._path = (self.jobs_root or default_jobs_root()) / "ledger" / f"{self.source}.json"
        self._records: dict[str, dict[str, Any]] = {}
        self._reload()

    def _save(self) -> None:
        _atomic_json(self._path, self._records)

    def _reload(self) -> None:
        """Re-read the durable file so several instances in one process stay coherent."""
        self._records = _read_ledger(self._path)

    def status(self, key: MaterializationKey) -> dict[str, Any] | None:
        with self._lock:
            self._reload()
            record = self._records.get(key.normalized().key_id)
            return dict(record) if record else None

    def records(self) -> list[dict[str, Any]]:
        with self._lock:
            self._reload()
            return [dict(v) for v in self._records.values()]

    def _launch(self, key: MaterializationKey, record: dict[str, Any], completeness: str) -> None:
        """Journal the attempt (saved with its job id), then write the job request; on a failed write the record is
        FAILED_RETRYABLE (never stateless). The caller saves the outcome."""
        attempt = int(record.get("attempts") or 0) + 1
        # After an explicit terminal retry the attempt count restarts; the job id must not, or the first round's
        # finished result (done/<key>-a1.json) would be read as this attempt's.
        retries = len(record.get("terminal_retries") or ())
        job_id = f"{key.key_id}-r{retries}a{attempt}" if retries else f"{key.key_id}-a{attempt}"
        n = key.normalized()
        now = self._clock()
        record.update({"attempts": attempt, "completeness": completeness, "updated_at": now,
                       "state": PENDING, "job_id": job_id, "next_attempt_at": None})
        record.pop("fill", None)   # a session materialized again is filled again
        self._records[key.key_id] = record
        self._save()
        try:
            self._submit_job(
                source=n.source, market=n.market, code=key.cli_code, trading_date=n.trading_date,
                session=n.session, completeness=completeness, gap_codes=list(record.get("gap_codes") or ()),
                repaired_codes=list(record.get("repaired_codes") or ()),
                jobs_root=self.jobs_root, job_id=job_id,
                close_operation_id=record.get("close_operation_id"),
            )
        except OSError as exc:
            # not an error: recorded as the record's FAILED_RETRYABLE state and last_error, which the caller saves;
            # its retry emits the remediation with it (_relaunch)
            record.update({"state": FAILED_RETRYABLE, "job_id": None, "last_error": f"request write failed: {exc}",
                           "retry_cause": "request_write_failed", "next_attempt_at": now + backoff_seconds(attempt)})

    def _relaunch(self, record: dict[str, Any]) -> None:
        """A due retry: recorded with what failed before it, then launched -- or abandoned past the budget."""
        from service.platform.remediation import emitter

        key = MaterializationKey.from_dict(record)
        identity = {"source": key.source, "market": key.market, "code": key.instrument or None, "session": key.session,
                    "trading_date": key.trading_date}
        attempts = int(record.get("attempts") or 0)
        cause = str(record.get("retry_cause") or "job_failed")
        if attempts >= MAX_ATTEMPTS:
            record["state"] = FAILED_TERMINAL
            emitter().emit(component="materialization_ledger", mechanism_id="materialization.job_retry", trigger_reason=cause,
                           outcome="abandoned", attempt=attempts, identity=identity,
                           detail={"key_id": record.get("key_id"), "last_error": record.get("last_error"),
                                   "close_operation_id": record.get("close_operation_id")})
            return
        self._launch(key, record, str(record.get("completeness") or "gap_detected"))
        emitter().emit(component="materialization_ledger", mechanism_id="materialization.job_retry", trigger_reason=cause,
                       outcome="succeeded" if record.get("state") == PENDING else "failed", attempt=int(record.get("attempts") or 0),
                       identity=identity, detail={"key_id": record.get("key_id"), "job_id": record.get("job_id"),
                                                  "previous_error": record.get("last_error"),
                                                  "close_operation_id": record.get("close_operation_id")})

    def submit(self, key: MaterializationKey, *, completeness: str, gap_codes: list[str] | tuple[str, ...] = (),
               repaired_codes: list[str] | tuple[str, ...] = (),
               retry_terminal: bool = False, reason: str = "", close_operation_id: str | None = None) -> dict[str, Any]:
        """Session-owner entry point. Deterministic identity + dedupe + backoff.

        ``gap_codes``: the codes the session evidence holds a broker-connection outage during trading for; the job
        marks each of their partitions a gap (kept on the record, so a retry carries them too). ``repaired_codes``:
        the codes whose every such outage was filled from the broker's history and verified; their partitions are
        ``repaired`` at best (the book of those spans is gone).

        ``retry_terminal`` (an explicit operator intent only) relaunches a FAILED_TERMINAL record with a fresh attempt
        budget and appends what it replaced to ``terminal_retries``; anything else leaves a terminal record alone."""
        key = key.normalized()
        with self._lock:
            self._reload()
            record = self._records.get(key.key_id)
            now = self._clock()
            if record is None:
                # The close that asked for it owns it; a later close covering the same partition is listed.
                record = {**key.as_dict(), "key_id": key.key_id, "attempts": 0, "created_at": now,
                          "close_operation_id": close_operation_id, "gap_codes": sorted(gap_codes),
                          "repaired_codes": sorted(repaired_codes)}
                self._launch(key, record, completeness)
                self._save()
                return {**record, "deduped": False}
            if close_operation_id and close_operation_id != record.get("close_operation_id"):
                # Either way the record changed and is saved: a record without an owning close gets this one, any
                # other close covering the partition is listed.
                if record.get("close_operation_id") is None:
                    record["close_operation_id"] = close_operation_id
                    self._save()
                elif close_operation_id not in (record.get("related_close_operations") or []):
                    record.setdefault("related_close_operations", []).append(close_operation_id)
                    self._save()
            if record.get("state") == FAILED_RETRYABLE and float(record.get("next_attempt_at") or 0) <= now:
                record["completeness"] = completeness
                record["gap_codes"] = sorted(gap_codes)
                record["repaired_codes"] = sorted(repaired_codes)
                self._relaunch(record)
                self._save()
                return {**record, "deduped": False}
            if record.get("state") == FAILED_TERMINAL and retry_terminal:
                record.setdefault("terminal_retries", []).append({
                    "at": now, "reason": str(reason or ""), "previous_attempts": record.get("attempts"),
                    "previous_error": record.get("last_error"), "previous_outcome": record.get("outcome")})
                record.update({"attempts": 0, "next_attempt_at": None, "gap_codes": sorted(gap_codes),
                               "repaired_codes": sorted(repaired_codes)})
                self._launch(key, record, completeness)
                self._save()
                return {**record, "deduped": False, "terminal_retry": True}
            return {**record, "deduped": True}

    def tick(self) -> int:
        """Consume results, expire lost leases, relaunch due retries. Returns state changes."""
        changed = 0
        with self._lock:
            self._reload()
            root = self.jobs_root or default_jobs_root()
            now = self._clock()
            # Result files are deleted only after the ledger holding their outcome is saved.
            consumed: list[str] = []
            for record in self._records.values():
                job_id = str(record.get("job_id") or "")
                if record.get("state") not in ACTIVE_STATES:
                    # Recorded before a crash that kept its result file: the outcome is durable, the file can go.
                    if job_id and (root / "done" / f"{job_id}.json").exists():
                        consumed.append(job_id)
                    continue
                # Where the job is, never guessed from time.
                stage = job_stage(job_id, jobs_root=self.jobs_root)
                if stage in ("PENDING", "CLAIMED"):
                    wanted = PENDING if stage == "PENDING" else RUNNING
                    if record.get("state") != wanted:
                        record["state"] = wanted
                        changed += 1
                    continue
                if stage == "LOST":
                    record.update({"state": FAILED_RETRYABLE, "retry_cause": "request_lost",
                                   "last_error": "the request is neither pending, claimed nor done",
                                   "next_attempt_at": now + backoff_seconds(int(record.get("attempts") or 1))})
                    changed += 1
                    continue
                key = MaterializationKey.from_dict(record)
                result = poll_materialization_result(job_id, jobs_root=self.jobs_root, expected={
                    "source": key.source, "market": key.market, "code": key.cli_code,
                    "trading_date": key.trading_date, "session": key.session})
                if result is None:
                    continue   # a result being replaced right now: read on the next tick
                if result == INVALID_RESULT:
                    continue   # quarantined and recorded; the job is now LOST and retried on the next tick
                consumed.append(job_id)
                record["updated_at"] = now
                status = str(result.get("status") or "")
                record["outcome"] = result.get("outcome") or status
                if bool(result.get("ok")) and status == "materialized":
                    record.update({"state": SUCCEEDED, "last_error": None, "result": result})
                elif status == "no_matching_input":
                    record.update({"state": NO_INPUT, "last_error": str(result.get("error") or ""), "result": result})
                elif status in ("invalid_identity", "invalid_request"):
                    record.update({"state": FAILED_TERMINAL, "last_error": str(result.get("error") or ""), "result": result})
                else:
                    attempts = int(record.get("attempts") or 0)
                    record["last_error"] = str(result.get("error") or "materializer job failed")
                    record.update({"state": FAILED_RETRYABLE, "retry_cause": "job_failed",
                                   "next_attempt_at": now + backoff_seconds(attempts)})
                    if attempts >= MAX_ATTEMPTS:
                        self._relaunch(record)   # past the budget: terminal, recorded as abandoned
                changed += 1
            for record in list(self._records.values()):
                if record.get("state") == FAILED_RETRYABLE and float(record.get("next_attempt_at") or 0) <= now:
                    self._relaunch(record)
                    changed += 1
            fill_changes, fill_consumed = self._tick_fills(root)
            changed += fill_changes
            consumed += fill_consumed
            if changed:
                self._save()
            for job_id in consumed:
                ack_materialization_result(job_id, jobs_root=self.jobs_root)
        return changed

    # -- the fill of a materialized session's gaps --------------------------------------------------------------

    def fill_candidates(self) -> list[dict[str, Any]]:
        """Records whose session is materialized, or found no input (a whole IDX day the WAL never got, filled from the
        broker's history: history_fill.expected_codes), and has not been filled yet."""
        with self._lock:
            self._reload()
            return [dict(r) for r in self._records.values() if r.get("state") in (SUCCEEDED, NO_INPUT) and "fill" not in r]

    def fill_settled_newest(self) -> list[dict[str, Any]]:
        """The newest materialized record of each market and session whose fill has settled."""
        with self._lock:
            self._reload()
            newest: dict[tuple[str, str], dict[str, Any]] = {}
            for record in self._records.values():
                if record.get("state") != SUCCEEDED or (record.get("fill") or {}).get("state") in (None, "preparing", "submitted"):
                    continue
                family = (str(record["market"]), str(record["session"]))
                if family not in newest or str(record["trading_date"]) > str(newest[family]["trading_date"]):
                    newest[family] = record
            return [dict(r) for r in newest.values()]

    def fill_reopen(self, key_id: str, codes: list[str]) -> None:
        """The record is filled again, for `codes` the background list gained after it traded (asked once each)."""
        with self._lock:
            self._reload()
            record = self._records.get(key_id)
            if record is None:
                return
            record["fill_listed"] = sorted({*(record.get("fill_listed") or ()), *codes})
            record["fill_round"] = int(record.get("fill_round") or 0) + 1
            record.pop("fill", None)
            self._save()

    def fill_update(self, key_id: str, **fill: Any) -> None:
        """The record's fill step moved (``state`` and what it found)."""
        with self._lock:
            self._reload()
            record = self._records.get(key_id)
            if record is None:
                return
            record["fill"] = {**(record.get("fill") or {}), **fill, "updated_at": self._clock()}
            self._save()

    def fill_submit(self, key_id: str, *, fills_dir: Path, unresolved_codes: list[str], summary: dict[str, Any]) -> str:
        """Journal, then request, the job folding the session again with its fills (as `_launch` does)."""
        with self._lock:
            self._reload()
            record = self._records[key_id]
            key = MaterializationKey.from_dict(record)
            job_id = f"{key_id}-fill-{record['fill_round']}" if record.get("fill_round") else f"{key_id}-fill"
            record["fill"] = {"state": "submitted", "job_id": job_id, "summary": summary, "updated_at": self._clock()}
            self._save()
            n = key.normalized()
            try:
                self._submit_job(source=n.source, market=n.market, code=key.cli_code, trading_date=n.trading_date,
                                 session=n.session, completeness=str(record.get("completeness") or "gap_detected"),
                                 jobs_root=self.jobs_root, job_id=job_id, close_operation_id=record.get("close_operation_id"),
                                 fill={"fills_dir": str(fills_dir), "unresolved_codes": unresolved_codes})
            except OSError as exc:
                record_failure(_failure_log, f"requesting the fill job {job_id}", exc)
                record["fill"].update({"state": "failed", "error": f"request: {exc}"})
                self._save()
            return job_id

    def _tick_fills(self, root: Path) -> tuple[int, list[str]]:
        """Settle submitted fill jobs from their results (under the lock)."""
        changed, consumed = 0, []
        for record in self._records.values():
            fill = record.get("fill") or {}
            if fill.get("state") != "submitted":
                continue
            job_id = str(fill.get("job_id") or "")
            stage = job_stage(job_id, jobs_root=self.jobs_root)
            if stage in ("PENDING", "CLAIMED"):
                continue
            if stage == "LOST":
                fill.update({"state": "failed", "error": "the fill job request is neither pending, claimed nor done"})
                changed += 1
                continue
            key = MaterializationKey.from_dict(record)
            result = poll_materialization_result(job_id, jobs_root=self.jobs_root, expected={
                "source": key.source, "market": key.market, "code": key.cli_code, "trading_date": key.trading_date, "session": key.session})
            if result is None or result == INVALID_RESULT:
                continue
            consumed.append(job_id)
            ok = bool(result.get("ok")) and str(result.get("status") or "") == "materialized"
            codes = result.get("codes") or []
            fill.update({"state": "done" if ok else "failed", "error": None if ok else str(result.get("error") or result.get("status")),
                         "completeness": {k: sum(1 for c in codes if c.get("completeness") == k) for k in ("complete", "repaired", "gap_detected")},
                         "updated_at": self._clock()})
            changed += 1
        return changed, consumed

    def drop_records(self, key_ids: set[str]) -> int:
        """Drop these records of finished sessions (``closed_session_retention``). A record still changing --
        pending, running or retryable -- stays whatever the caller decided."""
        with self._lock:
            self._reload()
            old = [key_id for key_id, record in self._records.items()
                   if key_id in key_ids and record.get("state") in (SUCCEEDED, NO_INPUT, FAILED_TERMINAL)
                   and (record.get("fill") or {}).get("state") not in ("preparing", "submitted")]
            for key_id in old:
                del self._records[key_id]
            if old:
                self._save()
        return len(old)

    def prune_intents(self) -> int:
        removed = 0
        now = self._clock()
        for record in drain_intents(self.source, jobs_root=self.jobs_root):
            if now - float(record.get("proposed_at") or now) > INTENT_TTL_SECONDS:
                settle_intent(self.source, str(record.get("key_id")), jobs_root=self.jobs_root)
                removed += 1
        return removed
