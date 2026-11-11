from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any

from service.market.shared.materialization_ledger import MaterializationKey, MaterializationLedger, NO_INPUT, SUCCEEDED
from service.market.shared.partition_evidence import PartitionEvidence
from service.market.shared.session_identity_contract import session_windows
from service.market.history.historical_store import HistoricalStore

logger = logging.getLogger(__name__)


class ShioajiSessionEvidenceGate:
    """Whether a closed Shioaji session may count as data: its event evidence is complete and its historical
    partitions are materialized. It writes nothing -- live durability is Market Runtime's WAL, and the Rust
    Historical Materializer builds the partitions that ``SessionOrchestrator`` requests per sealed session
    (``service/market/shared/materialization_jobs.py``)."""

    def __init__(self, *, evidence: PartitionEvidence, jobs_root: str | Path | None = None,
                 historical_root: str | Path | None = None) -> None:
        # Read-only use: the session owner (SessionOrchestrator) alone submits jobs.
        self._ledger = MaterializationLedger("shioaji", jobs_root=jobs_root)
        # Market Runtime's partition records (read from its files) and the historical store
        # used ONLY to validate materialized artifacts.
        self.session_evidence = evidence
        self._historical = HistoricalStore(historical_root)

    def evaluate_session(self, *, market: str, trading_date: str, session: str,
                         actual_contract: str = "") -> dict[str, Any]:
        """The closed session's coverage proof and materialization state (idempotent, read-only)."""
        started = time.monotonic()
        market_u = str(market or "").upper()
        date_text = str(trading_date or "")[:10]
        session_u = str(session or "").upper()
        contract_u = str(actual_contract or "").upper()
        if not market_u or not date_text or not session_u:
            return {
                "ok": False, "training_ready": False, "reason": "INVALID_SESSION_IDENTITY",
                "market": market_u, "trading_date": date_text, "session": session_u,
            }
        windows = session_windows("shioaji", market_u, date_text, session_u)
        if market_u == "STK":
            windows += session_windows("shioaji", "IDX", date_text, "DAY")
        evidence = self.session_evidence.combined(windows)
        coverage = {
            "ok": True, "authority": "session_evidence",
            "complete": evidence["completeness"] in {"complete", "repaired"},
            "has_gaps": evidence["completeness"] == "gap_detected",
            "market": market_u, "trading_date": date_text, "session": session_u, "evidence": evidence,
        }

        materialized = self.materialization_state(market_u, date_text, session_u, contract_u)
        # A: evidence complete   B: materialized artifact valid (job success alone is not enough)
        evidence_ready = bool(coverage.get("complete") and not coverage.get("has_gaps"))
        historical_materialized = bool(materialized.get("ok"))
        # D (training dataset ready) is verified by the dataset builder against the artifacts it reads;
        # training_ready here only asserts A and B.
        training_ready = evidence_ready and historical_materialized
        return {
            "ok": evidence_ready,
            "evidence_ready": evidence_ready,
            "historical_materialized": historical_materialized,
            "training_ready": training_ready,
            "market": market_u,
            "trading_date": date_text,
            "session": session_u,
            "actual_contract": contract_u,
            "coverage": coverage,
            "materialized": materialized,
            "duration_ms": round((time.monotonic() - started) * 1000.0, 1),
        }

    def materialization_state(self, market: str, trading_date: str, session: str, actual_contract: str = "") -> dict[str, Any]:
        """Ledger + artifact validity of the WAL session(s) this business session requires (read-only)."""
        market_u = str(market).upper()
        windows = session_windows("shioaji", market_u, trading_date, session)
        if market_u == "STK":
            windows += session_windows("shioaji", "IDX", trading_date, "DAY")
        states: dict[str, Any] = {}
        ok = bool(windows)
        any_data = False
        for _src, mk, date_text, wal in windows:
            key = MaterializationKey.for_session("shioaji", mk, date_text, session=wal)
            record = self._ledger.status(key)
            state = (record or {}).get("state") or "not_requested"
            artifact = self._historical.artifact_status(mk, date_text, key.session) if state == SUCCEEDED else {"valid": False}
            states[f"{mk}:{date_text}:{key.session}"] = {"state": state, "artifact_valid": bool(artifact.get("valid")),
                                                        "events": artifact.get("events", 0)}
            succeeded = state == SUCCEEDED and bool(artifact.get("valid"))
            # FUT business sessions span several calendar-date partitions: a date with no events at all
            # (weekend/holiday) is empty, not a failure - but at least one partition must be real data.
            no_wal = state == "not_requested" and not self.session_evidence.summary("shioaji", mk, date_text, key.session).get("observed")
            empty_ok = mk == "FUT" and (state == NO_INPUT or no_wal)
            any_data = any_data or succeeded
            ok = ok and (succeeded or empty_ok)
        ok = ok and any_data
        return {"ok": ok, "delegated_to": "rust_historical_materializer", "jobs": states,
                "reason": "" if ok else "MATERIALIZATION_NOT_SUCCEEDED_OR_ARTIFACT_INVALID"}
