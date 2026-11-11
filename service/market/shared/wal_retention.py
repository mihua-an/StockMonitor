"""WAL retention cutoff: which market dates the raw WAL may drop (B14).

Market Runtime (Rust A) owns the WAL files and removes a leading segment only when every event in it is older
than the cutoff, never past its own checkpoint, never the segment being written (``wal.prune``). This module owns
the business half: the cutoff. It is decided from what the session owners recorded, for EVERY source that writes
the WAL (Shioaji and Futu share it), read-only:

- a session's events stay while it is the one its market shows: the newest session of its (source, market, session)
  family, until the next one starts -- Market Runtime and Rust B rebuild the shown session from the WAL after a
  restart (they never read the materialized store);
- a session's events stay until it is materialized: not sealed yet, or its materialization not SUCCEEDED / NO_INPUT
  (pending, running, retryable, or FAILED_TERMINAL -- an operator's retry needs the WAL);
- everything else goes at once (user 10-14: a materialized session no longer shown is a duplicate). History replay
  and closed-session paging read the materialized store, not the WAL;
- nothing stays past ``hard_cap_days``: a session that never seals (a stuck owner) must not grow the WAL without bound.

The cutoff is the first event time of the oldest session that must stay (``before_ns``): Market Runtime removes a
leading segment only when every event in it is older.

The request goes through Health, the only controller: ``<jobs_root>/wal_retention/request.json``.
Evidence rows are read as plain files (with delete sharing: Market Runtime rewrites them meanwhile) and never written
here: Market Runtime is their one writer (partition_evidence.py). A row of an earlier format names no ``accepted`` and
holds nothing here; its ``sealed`` / ``quarantined`` still say whether it may be pruned.
"""
from __future__ import annotations

import json
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Any, Iterable
from zoneinfo import ZoneInfo

from service.market.shared.materialization_jobs import default_jobs_root
from service.market.shared.materialization_ledger import FAILED_RETRYABLE, FAILED_TERMINAL, NO_INPUT, PENDING, RUNNING, SUCCEEDED
from service.market.shared.partition_evidence import default_evidence_root
from service.platform.atomic_files import read_text_shared, write_json_atomic
from service.market.shared.session_identity_contract import STK_AFTER_HOURS_END, futu_seal_due_at, partition_end
import logging
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)

TAIPEI = ZoneInfo("Asia/Taipei")
SOURCES = ("shioaji", "futu")
HARD_CAP_DAYS = 7
UNFINISHED = {PENDING, RUNNING, FAILED_RETRYABLE}
# A session-wide materialization in one of these is done: its WAL events duplicate the materialized store.
MATERIALIZED = {SUCCEEDED, NO_INPUT}
STATUS_SCHEMA = "wal-materialization-status-v1"
# A session whose window closed this long ago and is still unsealed is a stuck owner, not "the next merge".
SEAL_OVERDUE_SECONDS = 1800


def _date(text: Any) -> date | None:
    try:
        return date.fromisoformat(str(text)[:10])
    except ValueError:  # not an error: date coercion: text that is not an ISO date is None by contract
        return None


def ledger_records(jobs_root: Path, sources: Iterable[str] = SOURCES) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for source in sources:
        try:
            data = json.loads(read_text_shared(jobs_root / "ledger" / f"{source}.json"))
        except FileNotFoundError:  # not an error: no ledger for that source
            continue
        except (OSError, ValueError) as exc:
            record_failure(_failure_log, "reading the materialization ledger for WAL retention", exc)
            continue
        if isinstance(data, dict):
            rows.extend(value for value in data.values() if isinstance(value, dict))
    return rows


def evidence_rows(evidence_root: Path, sources: Iterable[str] = SOURCES) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for source in sources:
        for path in sorted((evidence_root / source).glob("*/*.json")):
            try:
                row = json.loads(read_text_shared(path))
            except (OSError, ValueError) as exc:
                record_failure(_failure_log, "reading a materialization record for WAL retention", exc)
                continue
            if isinstance(row, dict):
                date_text, _, session = path.stem.partition("_")
                rows.append({**row, "source": source, "market": path.parent.name, "trading_date": date_text, "session": session,
                             "_path": path})
    return rows


def retired_session_label(row: dict[str, Any]) -> bool:
    session = str(row.get("session") or "").upper()
    if not session:
        return False
    from service.market.shared.session_identity_contract import wal_sessions

    return session not in wal_sessions(str(row.get("source") or ""), str(row.get("market") or ""))


NOT_A_BUSINESS_SESSION = "NOT_A_BUSINESS_SESSION"


def non_business_sessions(rows: list[dict[str, Any]]) -> list[tuple[str, str, str, str]]:
    """The evidence rows, not quarantined yet, of a day their market had no session: (source, market, date, session).

    Weekend reconnect snapshots carried Saturday / Sunday exchange times and were admitted as Shioaji STK / IDX "DAY"
    sessions of a weekend. Nothing opens or seals such a session, so its row held the whole WAL (286 segments,
    18 GB). Admission refuses such events (rust_live, Market Runtime); rows made before that are candidates the
    row's owner asks Market Runtime to close (``evidence.quarantine``; it is the rows' one writer) -- retention only
    reads the quarantined state."""
    from service.market.shared.session_identity_contract import is_business_session

    return [(str(row.get("source")), str(row.get("market")), str(row.get("trading_date")), str(row.get("session")))
            for row in rows
            if not row.get("quarantined") and not is_business_session(row.get("source"), row.get("market"),
                                                                     row.get("session"), row.get("trading_date"))]


def retention_before_ns(now: datetime, ledger: list[dict[str, Any]], evidence: list[dict[str, Any]], *,
                        hard_cap_days: int = HARD_CAP_DAYS) -> tuple[int, list[str]]:
    """The exchange time before which the WAL may go (``before_ns``), and the sessions holding it (see the module doc)."""
    before: int | None = None
    held: list[str] = []
    for row, why in _holds(now, ledger, evidence, hard_cap_days=hard_cap_days):
        if why is None:
            continue
        first = int(row["first_ts_ns"])
        before = first if before is None else min(before, first)
        source, market, day, session = _session_key(row)
        held.append(f"{source}:{market} {day} {session} {why}")
    return (before if before is not None else int(now.timestamp()) * 1_000_000_000), sorted(held)


def _session_key(row: dict[str, Any]) -> tuple[str, str, str, str]:
    return str(row.get("source")), str(row.get("market")), str(row.get("trading_date"))[:10], str(row.get("session"))


def _holds(now: datetime, ledger: list[dict[str, Any]], evidence: list[dict[str, Any]], *,
           hard_cap_days: int) -> list[tuple[dict[str, Any], str | None]]:
    """Every evidence row with WAL events, and why the WAL must keep its session (None: it need not)."""
    floor_ns = int((now - timedelta(days=max(0, hard_cap_days))).timestamp()) * 1_000_000_000
    state = {_session_key(r): str(r.get("state") or "") for r in ledger if not r.get("instrument")}
    rows = [r for r in evidence if int(r.get("accepted") or 0) > 0 and int(r.get("first_ts_ns") or 0) > 0
            and not retired_session_label(r) and not r.get("quarantined")]
    shown: dict[tuple[str, str, str], str] = {}
    for row in rows:
        family = (str(row.get("source")), str(row.get("market")), str(row.get("session")))
        shown[family] = max(shown.get(family, ""), str(row.get("trading_date"))[:10])
    holds: list[tuple[dict[str, Any], str | None]] = []
    for row in rows:
        source, market, day, session = _session_key(row)
        if int(row["first_ts_ns"]) < floor_ns:
            why = None
        elif day == shown[(source, market, session)]:
            why = "shown"
        elif not row.get("sealed"):
            why = "not sealed"
        elif state.get(_session_key(row)) not in MATERIALIZED:
            why = f"materialization {state.get(_session_key(row)) or 'not recorded'}"
        else:
            why = None
        holds.append((row, why))
    return holds


def finished_sessions(now: datetime, ledger: list[dict[str, Any]], evidence: list[dict[str, Any]], *,
                      hard_cap_days: int = HARD_CAP_DAYS) -> set[tuple[str, str, str, str]]:
    """Sessions whose whole recorded flow is over: sealed by the owner, its session-wide materialization final, and
    out of the WAL (no longer the session its market shows, or past the hard cap -- where a terminal failure is final
    too, no retry can read the WAL any more). A row with no WAL events counts once sealed or quarantined. An unsealed
    row never does -- its owner has not closed it -- nor does a session whose job is still pending or retrying."""
    state = {_session_key(r): str(r.get("state") or "") for r in ledger if not r.get("instrument")}
    final = MATERIALIZED | {FAILED_TERMINAL}
    done = {_session_key(row) for row, why in _holds(now, ledger, evidence, hard_cap_days=hard_cap_days)
            if why is None and row.get("sealed") and state.get(_session_key(row)) in final}
    with_events = {_session_key(row) for row, _ in _holds(now, ledger, evidence, hard_cap_days=hard_cap_days)}
    done |= {_session_key(row) for row in evidence if _session_key(row) not in with_events
             and (row.get("sealed") or row.get("quarantined"))}
    return done


def session_end(source: Any, market: Any, trading_date: Any, session: Any) -> datetime | None:
    """When a session's window closes -- its owner seals it then, and the materializer runs right after.

    Evidence rows are dated the way their owner dates them: a TXF NIGHT by its open (15:00 -> 05:00 next day),
    a Futu US FULL by its close day (20:00 New York), Futu crypto (CC) by its New York calendar day.
    """
    day = _date(trading_date)
    if day is None:
        return None
    src, mkt, sess = str(source).lower(), str(market).upper(), str(session).upper()
    if src == "shioaji" and mkt in {"STK", "IDX"}:
        # Sealed after the 14:30 after-hours match, not at the 13:30 close.
        return datetime.combine(day, STK_AFTER_HOURS_END, tzinfo=TAIPEI)
    if src == "shioaji" and mkt == "FUT":
        return partition_end(src, mkt, day.isoformat(), sess)
    if src == "futu":
        # The Futu owner does not seal at the venue close but at the end of the venue-local date plus a grace
        # (session_identity_contract.futu_seal_due_at); forecasting the close would make 下次合併 hours early.
        return futu_seal_due_at(mkt, day.isoformat())
    return None


def materialization_status(now: datetime, ledger: list[dict[str, Any]], evidence: list[dict[str, Any]]) -> dict[str, Any]:
    """What the WAL holds that no materialization covered yet, and when the next one is expected (連線診斷 WAL).

    ``pending_from_ns``: the oldest exchange time of a session that has events and is not sealed yet, or whose
    materialization is not final -- every WAL byte from there on is still 待合併. ``next_materialization_at``: the
    earliest of a queued job (now), a retry's next attempt, and an unsealed session's seal time. ``next_kind`` says
    which: ``running`` / ``queued`` (a job exists), ``retry`` (waiting for its attempt), ``session_close`` (waiting
    for the owner to seal -- past due still means waiting, not running). ``next`` names that session and its
    accepted event count; ``accepted_spans`` ([accepted, first_ts_ns, last_ts_ns] of every session with events) lets
    the reader turn that count into an approximate size against A's segment bytes -- the WAL interleaves every
    market, so no per-session byte count exists.

    Rows no owner will ever seal (a retired session label, a Shioaji weekend date) hold nothing here either, exactly
    as in ``retention_before_ns``: they would make the whole WAL read 待合併.
    """
    pending_from: int | None = None
    next_at: datetime | None = None
    next_key: tuple[str, str, str, str] | None = None
    next_kind: str | None = None

    def hold(ns: int | None) -> None:
        nonlocal pending_from
        if ns:
            pending_from = ns if pending_from is None else min(pending_from, ns)

    def expect(at: datetime | None, what: tuple[str, str, str, str], kind: str) -> None:
        nonlocal next_at, next_key, next_kind
        if at is not None and (next_at is None or at < next_at):
            next_at, next_key, next_kind = at, what, kind

    key = lambda r: (str(r.get("source")), str(r.get("market")), str(r.get("trading_date"))[:10], str(r.get("session")))  # noqa: E731
    first_ts = {key(r): r.get("first_ts_ns") for r in evidence}
    accepted = {key(r): int(r.get("accepted") or 0) for r in evidence}
    spans = [[int(r.get("accepted") or 0), int(r.get("first_ts_ns") or 0), int(r.get("last_ts_ns") or 0)]
             for r in evidence if int(r.get("accepted") or 0) > 0 and r.get("first_ts_ns") and r.get("last_ts_ns")]
    for row in evidence:
        if int(row.get("accepted") or 0) <= 0 or row.get("sealed"):
            continue
        if retired_session_label(row) or row.get("quarantined"):
            continue
        hold(int(row.get("first_ts_ns") or 0))
        end = session_end(row.get("source"), row.get("market"), row.get("trading_date"), row.get("session"))
        if end is not None and (end - now).total_seconds() > -SEAL_OVERDUE_SECONDS:
            expect(end, key(row), "session_close")
    for record in ledger:
        state = str(record.get("state") or "")
        if state not in UNFINISHED:
            continue
        day = _date(record.get("trading_date"))
        hold(int(first_ts.get(key(record)) or 0) or (cutoff_ns(day) if day else 0))
        retry = record.get("next_attempt_at")
        if state == FAILED_RETRYABLE and isinstance(retry, (int, float)):
            expect(datetime.fromtimestamp(float(retry), TAIPEI), key(record), "retry")
        else:
            expect(now, key(record), "running" if state == RUNNING else "queued")
    nxt = None
    if next_key is not None:
        source, market, trading_date, session = next_key
        nxt = {"source": source, "market": market, "trading_date": trading_date, "session": session,
               "accepted": accepted.get(next_key)}
    return {"schema": STATUS_SCHEMA, "evaluated_at": now.isoformat(timespec="seconds"), "pending_from_ns": pending_from,
            "next_materialization_at": next_at.isoformat(timespec="seconds") if next_at else None,
            "next_session": " ".join(next_key) if next_key else None, "next_kind": next_kind, "next": nxt,
            "accepted_spans": spans}


def write_status(status: dict[str, Any], *, jobs_root: Path | None = None) -> Path:
    target = (jobs_root or default_jobs_root()) / "wal_retention" / "status.json"
    write_json_atomic(target, status, ensure_ascii=True)
    return target


def cutoff_ns(cutoff: date) -> int:
    """The earliest exchange time a dated session could hold when its evidence has no first event time (a
    materialization record without evidence): one extra day before the date in Taipei, so a session whose events
    carry another zone's calendar (US) or cross midnight (TXF night) is never under-counted."""
    start = datetime.combine(cutoff - timedelta(days=1), time.min, tzinfo=TAIPEI)
    return int(start.timestamp()) * 1_000_000_000


def keep_from_text(before_ns: int) -> str:
    return datetime.fromtimestamp(before_ns / 1_000_000_000, TAIPEI).isoformat(timespec="seconds")


def request_retention(before_ns: int, *, jobs_root: Path | None = None, reason: str = "") -> Path:
    """A control request Health acts on (it prunes the WAL): durable before it counts as made."""
    target = (jobs_root or default_jobs_root()) / "wal_retention" / "request.json"
    write_json_atomic(target, {"before_ns": int(before_ns), "keep_from": keep_from_text(before_ns), "reason": reason,
                               "requested_at": datetime.now(TAIPEI).isoformat(timespec="seconds")},
                      durable=True, ensure_ascii=True)
    return target


class WalRetentionPolicy:
    """Throttled owner-side trigger: at most one request per ``interval_seconds``, and only when ``before_ns`` moved.

    The materialization status (``status.json``: 連線診斷's 待合併／下次合併) is rewritten every
    ``status_interval_seconds`` -- it only reads the same handful of small files.

    A throttle time is taken only once its work is done: the status once written, the request once written (or once
    the evaluation found no request to make). A write that fails leaves that step due, so the next call retries it
    at once; the error is raised after both steps had their turn (the session owner records it).
    """

    def __init__(self, *, jobs_root: Path | None = None, evidence_root: Path | None = None,
                 interval_seconds: float = 1800.0, hard_cap_days: int = HARD_CAP_DAYS,
                 status_interval_seconds: float = 60.0) -> None:
        self.jobs_root = Path(jobs_root) if jobs_root is not None else None
        self.evidence_root = Path(evidence_root) if evidence_root is not None else None
        self.interval_seconds = float(interval_seconds)
        self.status_interval_seconds = float(status_interval_seconds)
        self._status_at: float | None = None
        self.hard_cap_days = hard_cap_days
        self._last_at: float | None = None
        self._last_before: int | None = None
        self.last: dict[str, Any] = {}

    def maybe_request(self, now: datetime, monotonic: float) -> dict[str, Any] | None:
        status_due = self._status_at is None or monotonic - self._status_at >= self.status_interval_seconds
        request_due = self._last_at is None or monotonic - self._last_at >= self.interval_seconds
        if not status_due and not request_due:
            return None
        jobs_root = self.jobs_root or default_jobs_root()
        ledger = ledger_records(jobs_root)
        evidence = evidence_rows(self.evidence_root or default_evidence_root())
        status_error: OSError | None = None
        if status_due:
            try:
                write_status(materialization_status(now, ledger, evidence), jobs_root=jobs_root)
                self._status_at = monotonic
            except OSError as exc:
                status_error = exc   # still due: the next call writes it again
        if not request_due:
            if status_error is not None:
                raise status_error
            return None
        result = self._request(now, monotonic, jobs_root, ledger, evidence)
        if status_error is not None:
            raise status_error
        return result

    def _request(self, now: datetime, monotonic: float, jobs_root: Path, ledger: list[dict[str, Any]],
                 evidence: list[dict[str, Any]]) -> dict[str, Any] | None:
        before, held = retention_before_ns(now, ledger, evidence, hard_cap_days=self.hard_cap_days)
        self.last = {"keep_from": keep_from_text(before), "held_by": held[:20], "evaluated_at": now.isoformat(timespec="seconds")}
        if before == self._last_before:
            # Health consumes even a failed request (runtime unavailable, checkpoint error, timeout).
            # Retry a matching failure at the normal interval instead of waiting for a different date.
            try:
                result = json.loads(read_text_shared(jobs_root / "wal_retention" / "result.json"))
            except FileNotFoundError:  # not an error: no retention result yet
                self._last_at = monotonic
                return None
            except (OSError, ValueError) as exc:
                record_failure(_failure_log, "reading the WAL retention result", exc)
                self._last_at = monotonic
                return None
            failed_request = result.get("request") if isinstance(result, dict) else None
            if (not isinstance(failed_request, dict) or result.get("ok") is not False
                    or failed_request.get("before_ns") != before
                    or (jobs_root / "wal_retention" / "request.json").exists()):
                self._last_at = monotonic
                return None
        # Raises on a failed write: neither the cutoff nor the throttle time is taken, so the next call asks again.
        request_retention(before, jobs_root=jobs_root, reason="; ".join(held[:5]) or "nothing shown or unmaterialized")
        self._last_before = before
        self._last_at = monotonic
        return self.last
