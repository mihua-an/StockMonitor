"""When a closed session's bookkeeping goes: its session evidence row and its materialization ledger records.

Both are read only while the session's flow runs -- recorded, sealed, materialized, then dropped from the WAL. Once
the WAL need not keep the session (``wal_retention.finished_sessions``, the same rule that cuts the WAL) nothing asks
for them again, and the session owner, the only writer of both, deletes them in one pass: its own record of the
session first (``forget``), then the evidence, then the ledger records. Each step only removes what a later step's
absence would make look like a crash: an owner record or a sealed row without a ledger record is a session sealed
but never submitted, which the owner submits again.

The same pass first closes the owner's rows that are no session of their market (``wal_retention.non_business_sessions``)
through Market Runtime (their one writer, at the owner's command); the closed rows then go with the finished sessions.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Callable

from service.market.shared.materialization_ledger import MaterializationLedger
from service.market.shared.partition_evidence import PartitionEvidence
from service.market.shared.wal_retention import (
    HARD_CAP_DAYS, NOT_A_BUSINESS_SESSION, evidence_rows, finished_sessions, non_business_sessions)

_log = logging.getLogger(__name__)


def prune_closed_sessions(source: str, *, evidence: PartitionEvidence, ledger: MaterializationLedger,
                          now: datetime, keep: set[tuple[str, str, str]] = frozenset(),
                          forget: Callable[[set[tuple[str, str, str]]], bool] | None = None) -> dict[str, int]:
    """Delete ``source``'s evidence rows and ledger records of sessions whose flow is over. ``keep``: the
    ``(market, trading_date, session)`` the owner still reads the ledger for. ``forget``: drops the owner's own
    records of the finished sessions and says whether that is durable; nothing else goes when it is not."""
    for _src, market, day, session in non_business_sessions(evidence_rows(evidence.root, [source])):
        evidence.quarantine(source, market, day, session, reason=NOT_A_BUSINESS_SESSION)
    rows = evidence_rows(evidence.root, [source])
    records = ledger.records()
    done = {(market, day, session) for _src, market, day, session in finished_sessions(now, records, rows)} - set(keep)
    # A record with no evidence row at all (recorded before evidence existed, or its row already gone) goes once the
    # WAL is past it. Which sessions have evidence is Market Runtime's records (an older format's file is no record:
    # only its prune reads it).
    with_evidence = {(market, day, session) for _src, market, day, session in evidence.sessions(source)}
    floor = (now.date() - timedelta(days=HARD_CAP_DAYS)).isoformat()
    session_of = lambda r: (str(r.get("market")), str(r.get("trading_date"))[:10], str(r.get("session")))  # noqa: E731
    unrecorded = {s for r in records if (s := session_of(r)) not in with_evidence and s not in keep and s[1] < floor}
    # The owner forgets every session whose ledger records this pass may delete: a record of its own left behind
    # would read as sealed but never submitted, and be submitted again (a job that reads the whole WAL for nothing).
    forgotten = done | unrecorded
    if forget is not None and forgotten and not forget(forgotten):
        return {"evidence_rows": 0, "ledger_records": 0}
    removed = {(market, day, session) for _src, market, day, session in evidence.prune(source, done)}
    # Only a session whose evidence row went loses its ledger records (a row kept back keeps them), and an unrecorded
    # one.
    finished = {r.get("key_id") for r in records if (session := session_of(r)) in removed or session in unrecorded}
    dropped = ledger.drop_records({str(k) for k in finished if k})
    if removed or dropped:
        _log.info("finished sessions of %s deleted: %d evidence rows, %d ledger records", source, len(removed), dropped)
    return {"evidence_rows": len(removed), "ledger_records": dropped}
