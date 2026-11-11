"""Low-level job request/result file contract.

Do NOT call ``request_materialization`` directly: the only permitted caller is
``MaterializationLedger`` (materialization_ledger.py), owned by the per-source
session owner. Everyone else proposes an *intent*.

Health (health/materializer_job_runner.js) owns only the Rust job's process
lifecycle -- spawn/monitor/timeout. It never decides whether a session is
sealed and never mutates materialization_status; that is exclusively this
module's caller's job (SessionOrchestrator for Shioaji, in
service/market/lifecycle/rollover.py; FutuSessionLifecycleCoordinator for
Futu, in service/market/futu/session_lifecycle.py), matching
docs/system-architecture/00_services_and_ports.md §2's split exactly ("封盤／交易時段判斷由業務規則負責，Health 只管理程序").

File-based, not RPC: this process (a Shioaji/Futu daemon) and the Controller
process that runs Health have no existing RPC channel between them. Every
other cross-process signal in this app already goes through an atomically
written JSON file under output/ -- this reuses that convention rather than
inventing a new one. The request/result JSON shape here must stay in sync
with health/materializer_job_runner.js's own (mirrored, not shared, since
the two sides are different languages).

A job is in exactly one of three places: ``pending/`` (requested), ``claimed/`` (Health took it --
an atomic rename -- and runs it), ``done/`` (its result; written before the claim is removed). Read in that order
the stage is never guessed: none of the three means the request was lost. A request Health cannot read is moved to
``quarantine/`` and answered with an ``invalid_request`` result, never deleted.

A result is used only once :func:`validate_result` accepts it: this schema, the job id its file is named for, a known
status consistent with ``ok``, and (for every result Health writes after running a job) the request it answers naming
the job and the identity the ledger asked for. A result that fails is moved to ``done_quarantine/`` with an error
record and never changes the ledger; the job, no longer pending, claimed or done, is then retried as lost.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

from service.platform import project_root as process_paths
from service.platform.atomic_files import write_json_atomic
import logging
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)

REQUEST_SCHEMA = "materialization-job-request-v1"
RESULT_SCHEMA = "materialization-job-result-v1"
#: Every status a result may carry: the Rust job's (materialize.rs, main.rs) and Health's own (invalid_request,
#: retryable for a job that could not run or ended without a result).
RESULT_STATUSES = frozenset({"materialized", "no_matching_input", "invalid_identity", "invalid_request", "retryable"})
#: Returned by poll_materialization_result for a result that failed validation (quarantined, never used).
INVALID_RESULT = "invalid_result"


def default_jobs_root() -> Path:
    return process_paths.OUTPUT_ROOT / "materialization_jobs"


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    write_json_atomic(path, payload, ensure_ascii=True)


def request_materialization(
    *, source: str, market: str, code: str, trading_date: str, session: str,
    completeness: str, gap_codes: list[str] | tuple[str, ...] = (), repaired_codes: list[str] | tuple[str, ...] = (),
    logical_code: str = "",
    jobs_root: Path | None = None, job_id: str | None = None, close_operation_id: str | None = None,
    fill: dict[str, Any] | None = None,
) -> str:
    """Durably request the Rust Materializer job for one sealed session.

    Returns the job_id, which the caller must persist in its own durable
    session manifest (alongside materialization_status: "pending") so a
    later poll_materialization_result() call can find the matching outcome
    even across a daemon restart. ``jobs_root`` defaults to the real
    project's output/materialization_jobs/; callers that need isolation
    (tests, orchestrators constructed with a scratch manifest_dir) pass their
    own, so a test never writes a job request into the real output/ directory.
    """
    root = jobs_root or default_jobs_root()
    job_id = str(job_id or uuid.uuid4().hex)
    payload = {
        "schema": REQUEST_SCHEMA,
        "job_id": job_id,
        "source": str(source).strip().lower(),
        "market": str(market).strip().upper(),
        "code": str(code).strip().upper(),
        "logical_code": str(logical_code or code).strip().upper(),
        "trading_date": str(trading_date)[:10],
        "session": str(session).strip().upper(),
        "completeness": str(completeness),
        # The codes Market Runtime's partition record holds a broker-connection outage during trading for (its
        # ``gap_codes``): each of their partitions is a gap whatever the session's own completeness.
        "gap_codes": sorted({str(code).strip().upper() for code in gap_codes if str(code).strip()}),
        # The codes whose every such outage was filled from the broker's history and verified (its
        # ``repaired_codes``): repaired at best, the book of those spans is gone.
        "repaired_codes": sorted({str(code).strip().upper() for code in repaired_codes if str(code).strip()}),
        # The session close this job is a step of: the materializer's result echoes the request, so the
        # close can be followed through its jobs, retries and recoveries by this one id.
        "close_operation_id": close_operation_id,
    }
    if fill is not None:
        # A closed session folded again from the historical store with its gaps' fills (history_fill.py):
        # {"fills_dir": the `<CODE>.jsonl` fills, "unresolved_codes": codes the fill could not resolve}.
        payload["fill"] = {"fills_dir": str(fill["fills_dir"]), "unresolved_codes": sorted(str(c).upper() for c in fill.get("unresolved_codes") or ())}
    _atomic_write_json(root / "pending" / f"{job_id}.json", payload)
    return job_id


class InvalidResult(ValueError):
    """A result file that is not a result of the job it is named for."""


def validate_result(job_id: str, payload: Any, *, expected: dict[str, str] | None = None) -> dict[str, Any]:
    """The one check every result passes before anything reads it (see the module doc). ``expected``: the request
    identity the ledger asked for (source, market, code, trading_date, session)."""
    if not isinstance(payload, dict):
        raise InvalidResult("not a JSON object")
    if payload.get("schema") != RESULT_SCHEMA:
        raise InvalidResult(f"schema {payload.get('schema')!r}, expected {RESULT_SCHEMA}")
    if payload.get("job_id") != job_id:
        raise InvalidResult(f"job_id {payload.get('job_id')!r} in the result of {job_id}")
    status = payload.get("status")
    if status not in RESULT_STATUSES:
        raise InvalidResult(f"unknown status {status!r}")
    if not isinstance(payload.get("ok"), bool) or payload["ok"] != (status == "materialized"):
        raise InvalidResult(f"ok {payload.get('ok')!r} does not match status {status}")
    if status == "invalid_request":
        return payload   # Health could not read the request; there is none to echo
    request = payload.get("request")
    if not isinstance(request, dict) or request.get("job_id") != job_id:
        raise InvalidResult("the result does not carry the request of this job")
    for field, value in (expected or {}).items():
        if str(request.get(field) or "") != str(value):
            raise InvalidResult(f"request {field} {request.get(field)!r}, expected {value!r}")
    return payload


def _record_and_quarantine_result(root: Path, job_id: str, path: Path, reason: str) -> None:
    error = InvalidResult(f"materialization result {job_id}: {reason}")
    record_failure(_failure_log, "validating a materialization job result (moved to done_quarantine/)", error)
    target = root / "done_quarantine" / f"{job_id}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    path.replace(target)


def poll_materialization_result(job_id: str, *, jobs_root: Path | None = None,
                                expected: dict[str, str] | None = None) -> dict[str, Any] | str | None:
    """Read a completed job's result if it exists yet. The file stays until the caller has durably recorded it and calls
    :func:`ack_materialization_result` (deleting it on read, before the ledger saved, would let a crash in
    between lose the result and run the job again after its lease expired).

    Returns None while there is no result yet (or the file could not be opened this time: Health replaces it
    atomically, so a read error is retried on the next tick), the validated result, or ``INVALID_RESULT`` when the
    file is not valid JSON or fails :func:`validate_result` -- it is then in ``done_quarantine/`` and must not change
    the ledger. Never blocks.
    """
    if not job_id:
        return None
    root = jobs_root or default_jobs_root()
    path = root / "done" / f"{job_id}.json"
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:  # not an error: no result yet
        return None
    except OSError as exc:
        record_failure(_failure_log, "reading a materialization job result", exc)
        return None
    try:
        return validate_result(job_id, json.loads(text), expected=expected)
    except (ValueError, InvalidResult) as exc:
        try:
            _record_and_quarantine_result(root, job_id, path, str(exc))
        except OSError as move_error:
            record_failure(_failure_log, "moving an invalid materialization result to done_quarantine/", move_error)
        return INVALID_RESULT


def job_stage(job_id: str, *, jobs_root: Path | None = None) -> str:
    """PENDING, CLAIMED, DONE or LOST. Checked pending -> claimed -> done: each step creates the next file before the
    previous one goes, so a job moving while it is looked at is still found in a later place."""
    if not job_id:
        return "LOST"
    root = jobs_root or default_jobs_root()
    if (root / "pending" / f"{job_id}.json").is_file():
        return "PENDING"
    # The result is written before the claim goes: a claim next to a result is a finished job.
    if (root / "claimed" / f"{job_id}.json").is_file():
        return "DONE" if (root / "done" / f"{job_id}.json").is_file() else "CLAIMED"
    if (root / "done" / f"{job_id}.json").is_file():
        return "DONE"
    return "LOST"


SETTLED_SCHEMA = "session-settled-v1"


def publish_settled_session(*, source: str, market: str, trading_date: str, session: str, status: str,
                            settled_at: str, jobs_root: Path | None = None) -> None:
    """The session owner's notice that a whole session's materialization ended: ``settled/<source>.json`` keeps the
    newest settled session per ``MARKET:SESSION`` (one small file, never one per day). Health starts the automatic
    training from it (health/training_job_runner.js) and the training job reads the same entry to decide readiness
    (service/analysis/online_training/job.py), so the moment the day's data is usable is decided here only."""
    path = (jobs_root or default_jobs_root()) / "settled" / f"{source}.json"
    try:
        current = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:  # not an error: nothing published yet
        current = {}
    except (OSError, ValueError) as exc:
        # Rewritten whole below: every entry it held is the newest of its session again at that session's next close.
        record_failure(_failure_log, "reading the settled-session notice before updating it", exc)
        current = {}
    sessions = current.get("sessions") if isinstance(current, dict) and isinstance(current.get("sessions"), dict) else {}
    name = f"{market.upper()}:{session.upper()}"
    newest = sessions.get(name) if isinstance(sessions.get(name), dict) else {}
    if str(newest.get("trading_date") or "") > trading_date:
        # not an error: several closed days settling at one start (the App was off) settle in any order; an older
        # day never replaces a newer one, whose training already covers every older committed day.
        return
    sessions[name] = {"trading_date": trading_date, "status": status, "settled_at": settled_at}
    _atomic_write_json(path, {"schema": SETTLED_SCHEMA, "source": source, "sessions": sessions})


def ack_materialization_result(job_id: str, *, jobs_root: Path | None = None) -> bool:
    """Delete a job's result file once its outcome is durably recorded. True when no file remains."""
    if not job_id:
        return True
    path = (jobs_root or default_jobs_root()) / "done" / f"{job_id}.json"
    try:
        path.unlink()
    except FileNotFoundError:  # not an error: already gone is the goal of the acknowledgement
        pass
    except OSError as exc:
        record_failure(_failure_log, "deleting an acknowledged materialization result", exc)
        return False
    return True
