"""收盤整理 progress: the next close to be materialized, read-only (資料中心's top card, user 10-29, 10-30).

A close is what one seal time ends. Shioaji: 期貨日盤 (FUT DAY, 13:45), 台股 (STK and IDX DAY, sealed together at
14:40) and 期貨夜盤 (FUT NIGHT, dated by its open, sealed at 05:00 the next day). Futu: one close per stored market
(美股 is US FULL, dated by its New York day and sealed by its owner after that day ends; crypto is never stored). The
card follows the next one: the earliest close whose materialization is not over yet; when every recorded close is
over, the newest one. Each session of a close as its owners recorded it:

- the session evidence Market Runtime writes (partition_evidence.py): events accepted, and whether the owner sealed it;
- the materialization ledger (materialization_ledger.py): the job's state, attempts, retry time and result;
- Health's progress.json (health/materializer_job_runner.js): the job process's phases as it reports them;
- settled/shioaji.json (materialization_jobs.publish_settled_session): when the whole STK day was settled, the moment
  the automatic training starts from.

Nothing here decides anything: ``stage`` names the first unfinished step of what those records say, in their order
(close -> seal -> materialize -> settle).

The time left is estimated here and only here (the card's 預估剩餘 and the 執行紀錄 row of a running job show the
same value). A job's phases count events (``read``: WAL records, ``write``: the session's events written), so a
phase's time is its events over a rate: the running phase's own rate once it has one, otherwise the rate the newest
finished job of the same market measured for that phase (a phase's cost per event differs, and by market), otherwise
the job's own latest rate. A phase not started yet takes its events from what is known: ``write``
the session's accepted events, ``scan`` and ``read`` the measured job's totals.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from service.market.shared.materialization_jobs import default_jobs_root
from service.market.shared.materialization_ledger import (
    FAILED_RETRYABLE, FAILED_TERMINAL, MAX_ATTEMPTS, PENDING, RUNNING,
)
from service.market.lifecycle.calendar import MarketSessionCalendar
from service.market.shared.partition_evidence import default_evidence_root
from service.market.shared.session_identity_contract import never_stored, wal_session
from service.market.shared.wal_retention import TAIPEI, evidence_rows, ledger_records, retired_session_label, session_end
import logging
from service.platform.atomic_files import read_text_shared
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)

SHIOAJI = "shioaji"
FUTU = "futu"
SOURCES = (SHIOAJI, FUTU)
PROGRESS_SCHEMA = "materialization-progress-v2"
# Shioaji's closes and their sessions; a close is named by its first session ("STK:DAY" is 台股: STK and IDX).
SHIOAJI_CLOSES = ((("FUT", "DAY"),), (("STK", "DAY"), ("IDX", "DAY")), (("FUT", "NIGHT"),))
# A materialization job's phases in order (native/analysis_runtime/src/materialize.rs); only Shioaji STK and IDX write
# the daily summary.
PHASES = ("scan", "read", "write", "summary")
SUMMARIZED = {(SHIOAJI, "STK"), (SHIOAJI, "IDX")}
# States of a sealed session whose materialization is still to come or under way ("none": not submitted yet).
ACTIVE = {PENDING, RUNNING, "intent_pending", "none"}
# Health's status of a job that ended with its result.
MATERIALIZED = "materialized"


def _read_json(path: Path, what: str) -> Any:
    try:
        return json.loads(read_text_shared(path))
    except FileNotFoundError:  # not an error: nothing recorded yet
        return None
    except (OSError, ValueError) as exc:
        record_failure(_failure_log, f"reading {what} for 收盤整理", exc)
        return None


def _progress_jobs(jobs_root: Path) -> dict[str, dict[str, Any]]:
    payload = _read_json(jobs_root / "progress.json", "the materializer job progress")
    if not isinstance(payload, dict) or payload.get("schema") != PROGRESS_SCHEMA or not isinstance(payload.get("jobs"), dict):
        return {}
    return {str(job_id): entry for job_id, entry in payload["jobs"].items() if isinstance(entry, dict)}


def _closes_of(source: str, rows: list[dict[str, Any]]) -> tuple[tuple[tuple[str, str], ...], ...]:
    """A source's closes: Shioaji's three, and one per Futu market it recorded that the WAL stores."""
    if source == SHIOAJI:
        return SHIOAJI_CLOSES
    markets = sorted({str(row.get("market")).upper() for row in rows if not never_stored(source, str(row.get("market")))})
    return tuple(((market, wal_session(source, market)),) for market in markets)


def _dates(rows: list[dict[str, Any]]) -> list[str]:
    return sorted({str(row.get("trading_date"))[:10] for row in rows if not row.get("instrument") and not row.get("quarantined")})


def _number(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _instant(value: Any) -> datetime | None:
    """An ISO time with its offset (Health writes UTC with a Z), or an epoch in seconds (the ledger's)."""
    if isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:   # not an error: a time that is not ISO is no known instant
            return None
        return parsed if parsed.tzinfo else None
    seconds = _number(value)
    return datetime.fromtimestamp(seconds, TAIPEI) if seconds is not None else None


def _rate(figures: Any) -> float | None:
    """Events a second of a phase's figures (None before it has done any)."""
    if not isinstance(figures, dict):
        return None
    done, elapsed_ms = _number(figures.get("done")), _number(figures.get("elapsed_ms"))
    return done / (elapsed_ms / 1000) if done and elapsed_ms else None


def _measured(progress: dict[str, dict[str, Any]]) -> dict[tuple[str, str, str], dict[str, float]]:
    """Each (source, market, phase): the newest materialized job's rate and total for it."""
    measured: dict[tuple[str, str, str], dict[str, float]] = {}
    finished = [entry for entry in progress.values() if entry.get("status") == MATERIALIZED]
    for entry in sorted(finished, key=lambda e: str(e.get("started_at") or "")):
        for phase, figures in (entry.get("phases") or {}).items():
            rate = _rate(figures)
            if rate:
                key = (str(entry.get("source") or "").lower(), str(entry.get("market") or "").upper(), str(phase))
                measured[key] = {"rate": rate, "total": float(figures.get("total") or 0)}
    return measured


def _job_remaining(source: str, market: str, accepted: int, entry: dict[str, Any] | None, now: datetime,
                   measured: dict[tuple[str, str, str], dict[str, float]]) -> float | None:
    """Seconds left of one session's job at ``now`` (None when some phase has neither a rate nor a size to go by)."""
    phases = PHASES if (source, market) in SUMMARIZED else PHASES[:3]
    entry = entry or {}
    figures = entry.get("phases") or {}
    current = entry.get("phase") if entry.get("phase") in phases else None
    at = phases.index(current) if current else -1
    # The job's own latest rate: the running phase's, else the last finished one's.
    own = next((r for r in (_rate(figures.get(p)) for p in reversed(phases[:at + 1])) if r), None)
    left = 0.0
    for index, phase in enumerate(phases):
        if index < at:
            continue
        mine = figures.get(phase) if index == at else None
        known = measured.get((source, market, phase))
        total = _number((mine or {}).get("total")) or (float(accepted) if phase == "write" and accepted else None) \
            or (known or {}).get("total")
        rate = _rate(mine) or (known or {}).get("rate") or own
        if total is None or not rate:
            return None
        done = _number((mine or {}).get("done")) or 0.0
        left += max(0.0, total - done) / rate
    # The figures are as of Health's last write; the running phase has gone on since.
    updated = _instant(entry.get("updated_at"))
    return max(0.0, left - max(0.0, (now - updated).total_seconds())) if updated and at >= 0 else left


def _job_view(entry: dict[str, Any] | None) -> dict[str, Any] | None:
    if not entry:
        return None
    return {key: entry.get(key) for key in ("job_id", "status", "error", "started_at", "ended_at", "updated_at", "phase", "phases")}


def _estimate(sessions: list[dict[str, Any]], now: datetime) -> dict[str, Any] | None:
    """已花時間, 預估剩餘 and the share done of what is still being materialized: the sealed sessions not finished, from
    the first of them to start; the close ends with its slowest job (the jobs run side by side)."""
    active = [s for s in sessions if s["sealed"] and s["state"] in ACTIVE]
    if not active:
        return None
    starts = [t for t in (_instant((s["job"] or {}).get("started_at")) or _instant(s["submitted_at"]) for s in active) if t]
    elapsed = max(0.0, (now - min(starts)).total_seconds()) if starts else 0.0
    lefts = [s["remaining_s"] for s in active]
    remaining = None if any(left is None for left in lefts) else max(lefts)
    fraction = elapsed / (elapsed + remaining) if remaining is not None and elapsed + remaining > 0 else None
    return {"elapsed_s": elapsed, "remaining_s": remaining, "fraction": fraction}


def _result_view(result: Any) -> dict[str, Any] | None:
    if not isinstance(result, dict):
        return None
    # The market events written: what Market Runtime accepted plus what a fill added (``backfilled``) -- never the
    # coverage and loss records Market Runtime also writes into the partitions, which its evidence does not count.
    return {"codes": result.get("codes_materialized"), "events": result.get("market_event_count"),
            "backfilled": result.get("backfill_event_count"),
            "completeness": result.get("completeness"), "completed_at": result.get("completed_at")}


def _stage(now: datetime, sessions: list[dict[str, Any]], settled_at: str | None) -> str:
    """The first unfinished step: waiting_close (before a seal time), waiting_seal, materializing, retry_wait, failed or done."""
    if not sessions:
        return "waiting_close"
    if any(s["seal_due_at"] and datetime.fromisoformat(s["seal_due_at"]) > now for s in sessions):
        return "waiting_close"
    if any(not s["sealed"] for s in sessions):
        return "waiting_seal"
    states = [s["state"] for s in sessions]
    if any(state in {PENDING, RUNNING, "intent_pending", "none"} for state in states):
        return "materializing"
    if FAILED_RETRYABLE in states:
        return "retry_wait"
    if FAILED_TERMINAL in states:
        return "failed"
    return "done"


def _session_view(source: str, market: str, session: str, trading_date: str, row: dict[str, Any] | None,
                  record: dict[str, Any], progress: dict[str, dict[str, Any]], now: datetime,
                  measured: dict[tuple[str, str, str], dict[str, float]]) -> dict[str, Any]:
    seal_due = session_end(source, market, trading_date, session)
    accepted = int((row or {}).get("accepted") or 0)
    sealed = bool((row or {}).get("sealed")) or bool(record)
    state = str(record.get("state") or "none")
    entry = progress.get(str(record.get("job_id") or ""))
    return {
        "id": f"{market}:{session}", "source": source, "market": market, "session": session,
        "seal_due_at": seal_due.astimezone(TAIPEI).isoformat(timespec="seconds") if seal_due else None,
        "accepted": accepted,
        # A job exists only for a sealed session: the owner submits it when it seals.
        "sealed": sealed,
        "state": state, "attempts": record.get("attempts"), "max_attempts": MAX_ATTEMPTS,
        "next_attempt_at": record.get("next_attempt_at"), "last_error": record.get("last_error"),
        "submitted_at": record.get("created_at"), "updated_at": record.get("updated_at"),
        "result": _result_view(record.get("result")),
        "job": _job_view(entry),
        # Seconds left of its materialization (the module documentation); None when it is not under way.
        "remaining_s": (_job_remaining(source, market, accepted, entry if (entry or {}).get("status") == "running" else None,
                                       now, measured) if sealed and state in ACTIVE else None),
    }


def _scheduled_after(after: datetime, from_date: date) -> dict[str, Any]:
    """The first Shioaji close on the trading calendar that seals after ``after``: FUT DAY and 台股 on a trading date,
    and that date's FUT NIGHT (sealed at 05:00 the next day)."""
    calendar = MarketSessionCalendar()
    day = calendar.next_trading_date(from_date)[0]
    while True:
        for members in SHIOAJI_CLOSES:
            market, session = members[0]
            seal_due = session_end(SHIOAJI, market, day.isoformat(), session)
            if seal_due is not None and seal_due > after:
                return {"id": f"{market}:{session}", "source": SHIOAJI, "trading_date": day.isoformat(), "seal_due_at": seal_due.isoformat(timespec="seconds")}
        day = calendar.next_trading_date(day + timedelta(days=1))[0]


def _total(results: list[dict[str, Any]], field: str) -> int | None:
    """A close's sum of one count; None when a session's result does not state it (unknown is not zero)."""
    values = [r.get(field) for r in results]
    return None if any(not isinstance(v, (int, float)) for v in values) else int(sum(values))


def _history_row(close: dict[str, Any]) -> dict[str, Any]:
    results = [s.get("result") or {} for s in close["sessions"]]
    ends = [str(r.get("completed_at") or "") for r in results]
    return {"id": close["id"], "trading_date": close["trading_date"], "stage": close["stage"],
            "ended_at": close["settled_at"] or max(ends) or None,
            "codes": sum(int(r.get("codes") or 0) for r in results), "events": _total(results, "events"),
            "backfilled": _total(results, "backfilled"),
            # The sessions whose history has a gap (a close is complete only when every one of its sessions is).
            "gaps": [s["id"] for s in close["sessions"] if (s.get("result") or {}).get("completeness") not in (None, "complete")]}


def _source_closes(source: str, now: datetime, evidence: list[dict[str, Any]], ledger: list[dict[str, Any]],
                   progress: dict[str, dict[str, Any]], stk: dict[str, Any] | None,
                   measured: dict[tuple[str, str, str], dict[str, float]]) -> list[dict[str, Any]]:
    def find(rows: list[dict[str, Any]], market: str, session: str, trading_date: str) -> dict[str, Any] | None:
        return next((row for row in rows if str(row.get("market")).upper() == market and str(row.get("session")).upper() == session
                     and str(row.get("trading_date"))[:10] == trading_date and not row.get("instrument")), None)

    closes: list[dict[str, Any]] = []
    for trading_date in _dates(evidence + ledger):
        for members in _closes_of(source, evidence + ledger):
            sessions = []
            for market, session in members:
                row = find(evidence, market, session, trading_date)
                record = find(ledger, market, session, trading_date)
                if row is None and record is None:
                    continue   # no event and no job of this session on that date (a holiday for it, or not recorded)
                sessions.append(_session_view(source, market, session, trading_date, row, record or {}, progress, now, measured))
            if not sessions:
                continue
            first = members[0]
            settled_at = (stk.get("settled_at") if source == SHIOAJI and first == ("STK", "DAY") and isinstance(stk, dict)
                          and stk.get("trading_date") == trading_date else None)
            closes.append({"id": f"{first[0]}:{first[1]}", "source": source, "trading_date": trading_date, "sessions": sessions,
                           "seal_due_at": max(s["seal_due_at"] or "" for s in sessions) or None,
                           "stage": _stage(now, sessions, settled_at), "settled_at": settled_at,
                           "estimate": _estimate(sessions, now)})
    return closes


def closing_progress(now: datetime | None = None, *, jobs_root: Path | None = None,
                     evidence_root: Path | None = None) -> dict[str, Any]:
    """The close to show (``id``, ``trading_date``, ``stage``, ``sessions``, ``settled_at``); ``last``: the newest close
    that ended, whole (執行紀錄 shows it until the shown close reaches its seal time); ``next``: the next close to
    start (the earliest recorded close still before its seal time, or the trading calendar's next Shioaji close if
    that seals first); and ``history``: the closes that ended, newest first, one of each kind (it stops where a kind
    would repeat)."""
    now = now or datetime.now(TAIPEI)
    jobs_root = jobs_root or default_jobs_root()
    evidence_dir = evidence_root or default_evidence_root()
    progress = _progress_jobs(jobs_root)
    settled = _read_json(jobs_root / "settled" / f"{SHIOAJI}.json", "the settled-session notice")
    stk = ((settled or {}).get("sessions") or {}).get("STK:DAY") if isinstance(settled, dict) else None
    closes: list[dict[str, Any]] = []
    for source in SOURCES:
        evidence = [row for row in evidence_rows(evidence_dir, (source,)) if not retired_session_label(row)]
        closes += _source_closes(source, now, evidence, ledger_records(jobs_root, (source,)), progress, stk, _measured(progress))
    closes.sort(key=lambda c: c["seal_due_at"] or "")
    evaluated = now.isoformat(timespec="seconds")
    if not closes:
        return {"ok": True, "id": None, "source": None, "trading_date": None, "stage": "waiting_close", "sessions": [],
                "settled_at": None, "estimate": None, "last": None, "next": _scheduled_after(now, now.date()), "history": [], "evaluated_at": evaluated}
    # A terminal failure is over too: it is listed in the history, never holds the card.
    over = {"done", "failed"}
    at = next((index for index, close in enumerate(closes) if close["stage"] not in over), len(closes) - 1)
    shown = closes[at]
    ended = [close for close in closes if close["stage"] in over]
    pick = lambda close: {key: close[key] for key in ("id", "source", "trading_date", "seal_due_at")}  # noqa: E731
    waiting = [pick(close) for close in closes if close["stage"] == "waiting_close" and close["seal_due_at"]]
    after = max(now, datetime.fromisoformat(shown["seal_due_at"])) if shown["seal_due_at"] else now
    scheduled = _scheduled_after(after, date.fromisoformat(shown["trading_date"]))
    upcoming = min([*waiting, scheduled], key=lambda close: datetime.fromisoformat(close["seal_due_at"]))
    history: list[dict[str, Any]] = []
    for close in reversed(ended):
        if any(row["id"] == close["id"] for row in history):
            break
        history.append(_history_row(close))
    return {"ok": True, **shown, "last": ended[-1] if ended else None, "next": upcoming, "history": history,
            "evaluated_at": evaluated}
