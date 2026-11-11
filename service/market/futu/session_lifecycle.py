"""FutuSessionLifecycleCoordinator: Futu's per-source session lifecycle owner.

docs/system-architecture/00_services_and_ports.md §2: session business-state mutation is per-source. Shioaji's
owner is ``SessionOrchestrator``; Futu's is this coordinator. Lifecycle of one
Futu session (identity = ``futu + market + trading_date + FULL``, the WAL
contract in session_identity_contract.py)::

    open -> expired -> sealed -> materialization pending -> materialized | retryable | failed

- identity: Market Runtime names every partition from the exchange time; this owner learns each session from the
  partition records Market Runtime keeps (partition_evidence.PartitionEvidence), never from a date of its own;
- ``expired``: the venue's local clock passed the date's end plus a grace for
  late callbacks; ``sealed``: Market Runtime froze the session's record at this owner's command
  (``evidence.seal``) -- accepted / dropped / refused / interrupted for exactly this session;
- completeness: ``complete`` / ``gap_detected`` / ``repaired``, as Market Runtime judged it in that record;
- materialization: the ONLY caller of ``MaterializationLedger.submit`` for
  source ``futu``; it also decides every intent proposed by readers/routes/scripts;
- previous-session promotion: the newest materialized date per market, and which
  older dates are safe to expire (never before the newer one is materialized).

It holds no market data. Health only runs the Rust job process.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo
from typing import Any, Callable

from service.market.shared.materialization_ledger import (
    FAILED_RETRYABLE, FAILED_TERMINAL, NO_INPUT, PENDING, RUNNING, SUCCEEDED,
    MaterializationKey, MaterializationLedger, drain_intents, settle_intent,
)
from service.market.shared.closed_session_retention import prune_closed_sessions
from service.market.shared.partition_evidence import PartitionEvidence
from service.platform.failure_record import record_failure
from service.market.shared.session_identity_contract import futu_seal_due_at, market_zone, wal_session

logger = logging.getLogger(__name__)

SOURCE = "futu"
# The day closed sessions are pruned by: the Taipei calendar, the same for every source.
TAIPEI = ZoneInfo("Asia/Taipei")
STATE_KEY = "session_lifecycle_v2"
seal_due_at = futu_seal_due_at   # shared with the WAL 下次合併 forecast (session_identity_contract), so it cannot drift
# A bound on the records only: a finished session's record goes with its evidence and ledger record (_forget).
KEEP_DATES = 14
_STATUS = {PENDING: "pending", RUNNING: "pending", SUCCEEDED: "materialized", NO_INPUT: "no_input",
           FAILED_RETRYABLE: "retryable", FAILED_TERMINAL: "failed"}


def market_of(code: str) -> str:
    return str(code).split(".", 1)[0].upper() if "." in str(code) else "US"



# A session record only moves forward: open -> expired -> sealed.
_STATE_RANK = {"open": 0, "expired": 1, "sealed": 2}


def _merge_session_record(persisted: dict[str, Any], held: dict[str, Any] | None) -> dict[str, Any]:
    """One date's record after the store became readable again: the one further along is kept (a persisted
    sealed/materialized state is never overwritten by an "open" made while the store could not be read)."""
    if not held:
        return persisted
    rank = lambda record: _STATE_RANK.get(str(record.get("state") or "open"), 0)  # noqa: E731
    return dict(persisted) if rank(persisted) >= rank(held) else dict(held)

class FutuSessionLifecycleCoordinator:
    def __init__(
        self, store: Any, *, event_sink: Any, now: Callable[[], datetime] | None = None,
        tick_seconds: float = 30.0, ledger: MaterializationLedger | None = None,
        jobs_root: Any = None, evidence: PartitionEvidence | None = None,
    ) -> None:
        self._store = store
        self._sink = event_sink
        # Market Runtime's partition records, read from their files and decided through the sink's commands.
        self._evidence = evidence if evidence is not None else getattr(event_sink, "evidence", None)
        if self._evidence is None:
            raise ValueError("FutuSessionLifecycleCoordinator needs the event sink's partition evidence")
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._tick_seconds = float(tick_seconds)
        self._last_tick = 0.0
        # `_lock` guards the in-memory session records only and is held for short, I/O-free sections. A tick (evidence,
        # Market Runtime commands, ledger, intent files, SQLite) runs under `_tick_lock`, one at a time, and never does
        # I/O while holding `_lock`.
        self._lock = threading.RLock()
        self._tick_lock = threading.Lock()
        self._dirty = False
        self._jobs_root = jobs_root
        self._ledger = ledger or MaterializationLedger(SOURCE, jobs_root=jobs_root)
        # Why the persisted state could not be read (None = it was): while set, nothing is written over it.
        self._state_error: str | None = None
        # market -> trading_date -> record
        self._sessions: dict[str, dict[str, dict[str, Any]]] = self._load()
        self._pruned_for: date | None = None

    # -- persistence ---------------------------------------------------------------------

    def _read(self) -> tuple[str | None, dict[str, Any] | None, str | None]:
        """(raw value, parsed state, error). raw is None when the store itself could not be read."""
        try:
            raw = self._store.read_state(STATE_KEY) or "{}"
        except Exception as exc:  # not an error: the read failure is returned to the caller as the state's stated error
            return None, None, f"read failed: {type(exc).__name__}: {exc}"
        try:
            value = json.loads(raw)
        except ValueError as exc:  # not an error: invalid JSON is returned to the caller as the state's stated error
            return raw, None, f"invalid JSON: {exc}"
        if not isinstance(value, dict):
            return raw, None, f"not an object: {type(value).__name__}"
        return raw, value, None

    def _load(self) -> dict[str, dict[str, dict[str, Any]]]:
        """The persisted session records. An unreadable state is never silently taken as empty and later written over:
        content that cannot be parsed is kept under a backup key before starting afresh, and a store
        that cannot be read at all leaves `_state_error` set -- nothing is saved until a re-read succeeds."""
        raw, value, error = self._read()
        if error is None:
            return value or {}
        if raw is not None:
            backup = f"{STATE_KEY}.unreadable.{self._now().strftime('%Y%m%dT%H%M%S')}"
            try:
                self._store.write_state(backup, raw)
                logger.warning(f"[FUTU SESSION] lifecycle state unreadable ({error}); kept as {backup}, starting afresh")
                return {}
            except Exception as exc:
                error = f"{error}; backup failed: {exc}"
        self._state_error = error
        logger.warning(f"[FUTU SESSION] lifecycle state unreadable ({error}); not persisting until it can be read")
        return {}

    def _save(self) -> bool:
        """Persist the records: serialized under `_lock`, read/written to the store outside it. True once written."""
        if self._state_error is not None:
            _raw, value, error = self._read()
            with self._lock:
                if error is not None:
                    self._state_error = error
                    return False
                for market, dates in (value or {}).items():
                    held = self._sessions.setdefault(market, {})
                    for date_text, record in (dates or {}).items():
                        held[date_text] = _merge_session_record(record, held.get(date_text))
                self._state_error = None
        with self._lock:
            for dates in self._sessions.values():
                for stale in sorted(dates)[:-KEEP_DATES]:
                    dates.pop(stale, None)
            text = json.dumps(self._sessions, sort_keys=True)
            self._dirty = False
        try:
            self._store.write_state(STATE_KEY, text)
        except Exception as exc:
            with self._lock:
                self._dirty = True
            logger.warning(f"[FUTU SESSION] state persist failed: {exc}")
            return False
        return True

    # -- identity ----------------------------------------------------------------------------

    def local_now(self, market: str) -> datetime:
        return self._now().astimezone(market_zone(market))

    def _key(self, market: str, trading_date: str) -> MaterializationKey:
        return MaterializationKey.for_session(SOURCE, market, trading_date)

    # -- lifecycle -------------------------------------------------------------------------------

    def _is_expired(self, market: str, date_text: str) -> bool:
        return self.local_now(market) >= seal_due_at(market, date_text)

    def _seal(self, market: str, date_text: str) -> None:
        """expired -> sealed: Market Runtime freezes the session's record (answered once written; I/O, outside
        `_lock`), which is then read as frozen, and materialization is requested. Market Runtime unreachable: the
        session stays expired and the next tick seals it.

        Market Runtime holding no record of the session (a finished one pruned since, or a day nothing was stored
        for): nothing is materialized. The WAL no longer holds such a session whole -- its record goes when the WAL
        stops keeping it -- and a job would publish what is left of it over the complete history."""
        session = wal_session(SOURCE, market)
        try:
            recorded = self._evidence.seal(SOURCE, market, date_text, session)
        except Exception as exc:
            record_failure(logger, f"sealing the Futu {market} {date_text} session in Market Runtime (sealed on the next tick)", exc)
            return
        if not recorded:
            logger.warning(f"[FUTU SESSION] {market} {date_text}: Market Runtime holds no record of the session; "
                           "not materialized (finished and pruned, or nothing stored)")
            with self._lock:
                self._sessions.get(market, {}).pop(date_text, None)
                self._dirty = True
            return
        evidence = self._evidence.summary(SOURCE, market, date_text, session)
        with self._lock:
            record = self._sessions.setdefault(market, {}).setdefault(date_text, {"state": "open"})
            record.update({"state": "sealed", "sealed_at": self._now().isoformat(),
                           "completeness": evidence["completeness"], "evidence": {
                               k: evidence.get(k) for k in ("accepted", "dropped", "rejected_total", "duplicates",
                                                            "interruptions", "observed")}})
        self._submit(market, date_text)

    def _submit(self, market: str, date_text: str) -> None:
        with self._lock:
            completeness = str((self._sessions.get(market, {}).get(date_text) or {}).get("completeness"))
        submitted = self._ledger.submit(self._key(market, date_text), completeness=completeness,
                                        close_operation_id=f"close:{SOURCE}:{market}:{date_text}")
        with self._lock:
            record = self._sessions.get(market, {}).get(date_text)
            if record is not None:
                record["materialization"] = _STATUS.get(str(submitted.get("state")), "pending")

    def _discover_sessions(self) -> int:
        """The sessions Market Runtime holds records of for this source: each one with stored events that this owner
        has not closed yet is taken into the lifecycle (Market Runtime named it from the exchange time; this owner
        never dates a session itself). The normal transition then enforces expiry and grace and submits through the
        deduplicating ledger."""
        found = []
        for source, market, date_text, session in self._evidence.sessions(SOURCE):
            if session != wal_session(SOURCE, market):
                continue
            try:
                datetime.fromisoformat(date_text)
            except ValueError:  # not an error: a directory name that is not an ISO date is not a session; skipped
                continue
            summary = self._evidence.summary(source, market, date_text, session)
            if not summary.get("accepted"):
                continue
            # Closed already: this owner sealed its evidence and the ledger holds its job. Only the newest KEEP_DATES
            # lifecycle records are persisted, so an older closed session is missing from them on every start -- it
            # is not an orphan. (Sealed without a job is the crash between sealing and submitting: adopted.)
            if summary.get("sealed") and self._ledger.status(self._key(market, date_text)) is not None:
                continue
            found.append((market, date_text))
        added = 0
        with self._lock:
            for market, date_text in found:
                dates = self._sessions.setdefault(market, {})
                if date_text not in dates:
                    dates[date_text] = {"state": "open"}
                    added += 1
            if added:
                self._dirty = True
        return added

    def _prune_closed_sessions(self) -> None:
        """Once a day: this owner deletes the evidence rows and ledger records of its finished sessions."""
        now = datetime.now(TAIPEI)
        if self._pruned_for == now.date():
            return
        prune_closed_sessions(SOURCE, evidence=self._evidence, ledger=self._ledger, now=now, forget=self._forget)
        self._pruned_for = now.date()

    def _forget(self, sessions: set[tuple[str, str, str]]) -> bool:
        """Drop the lifecycle records of finished sessions, durably: a sealed record left without its ledger record
        would be submitted again as a crash between sealing and submitting."""
        if self._state_error is not None:
            return False   # not an error: the unreadable state is recorded by _load; a save would merge the records back
        with self._lock:
            for market, date_text, _session in sessions:
                self._sessions.get(market, {}).pop(date_text, None)
            self._dirty = True
        return self._save()

    def tick(self, *, force: bool = False) -> int:
        """Advance lifecycle transitions, submit (deduped) jobs, mirror ledger states."""
        now = time.monotonic()
        if not force and now - self._last_tick < self._tick_seconds:
            return 0
        with self._tick_lock:
            self._last_tick = now
            changed = self._discover_sessions()
            with self._lock:
                for market, dates in self._sessions.items():
                    for date_text, record in dates.items():
                        if record.get("state") == "open" and self._is_expired(market, date_text):
                            record["state"] = "expired"
                            changed += 1
                expired = [(market, date_text) for market, dates in self._sessions.items()
                           for date_text, record in dates.items() if record.get("state") == "expired"]
            for market, date_text in expired:
                self._seal(market, date_text)
                changed += 1
            changed += self._process_intents()
            # Intents carry a TTL; this owner is the one that expires them.
            self._ledger.prune_intents()
            self._ledger.tick()
            self._prune_closed_sessions()
            with self._lock:
                sealed = [(market, date_text, record.get("materialization")) for market, dates in self._sessions.items()
                          for date_text, record in dates.items() if record.get("state") == "sealed"]
            for market, date_text, current in sealed:
                ledger = self._ledger.status(self._key(market, date_text))
                if ledger is None:
                    # A crash between sealing and submitting must not leave a sealed session jobless.
                    self._submit(market, date_text)
                    ledger = self._ledger.status(self._key(market, date_text))
                    changed += 1
                mirrored = _STATUS.get(str((ledger or {}).get("state")), current)
                if mirrored != current:
                    with self._lock:
                        record = self._sessions.get(market, {}).get(date_text)
                        if record is not None:
                            record["materialization"] = mirrored
                    changed += 1
            with self._lock:
                dirty = self._dirty
            if changed or dirty:
                self._save()
        return changed

    def _process_intents(self) -> int:
        """This owner alone decides intents proposed by readers/routes/scripts."""
        handled = 0
        for intent in drain_intents(SOURCE, jobs_root=self._jobs_root):
            market, date_text = str(intent.get("market") or "").upper(), str(intent.get("trading_date") or "")[:10]
            key_id = str(intent.get("key_id") or "")
            if not market or not date_text or not self._is_expired(market, date_text):
                continue  # session not over yet: the intent waits (expires by TTL)
            with self._lock:
                record = self._sessions.setdefault(market, {}).setdefault(
                    date_text, {"state": "open"})
                seal = record["state"] in {"open", "expired"}
                if seal:
                    record["state"] = "expired"
            if seal:
                self._seal(market, date_text)
            else:
                self._submit(market, date_text)  # ledger dedupes
            settle_intent(SOURCE, key_id, jobs_root=self._jobs_root)
            handled += 1
        return handled

    def status(self) -> dict[str, Any]:
        with self._lock:
            records = [r for dates in self._sessions.values() for r in dates.values()]
            return {
                "markets": len(self._sessions), "open": sum(1 for r in records if r.get("state") == "open"),
                "sealed": sum(1 for r in records if r.get("state") == "sealed"),
                "pending": sum(1 for r in records if r.get("materialization") == "pending"),
                "materialized": sum(1 for r in records if r.get("materialization") == "materialized"),
                "gap_detected": sum(1 for r in records if r.get("completeness") == "gap_detected"),
                "state_error": self._state_error,
            }
