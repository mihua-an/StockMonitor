"""A stand-in for Market Runtime's session evidence (native/market_runtime/src/evidence.rs) in Python tests.

Market Runtime alone writes a partition's record; the session owners read the file and decide through commands
(``evidence.seal`` and the like). This fake writes files of the same format with the same completeness rule, and
answers the commands on them, so an owner under test reads exactly what it would read in the App. The rule itself is
tested in Rust (src/evidence.rs, tests/e2e_evidence.rs); nothing here is a second implementation the App runs.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from service.market.shared.partition_evidence import SCHEMA, PartitionEvidence, evidence_path


def _judged(record: dict[str, Any]) -> dict[str, Any]:
    interruptions = sum(1 for restart in record.get("restarts") or [] if restart.get("during_trading"))
    loss = int(record.get("dropped") or 0) + sum(int(n) for n in (record.get("rejected") or {}).values()) + interruptions
    completeness = "complete" if loss == 0 else ("repaired" if record.get("repaired") else "gap_detected")
    gap_codes = sorted({code for outage in record.get("outages") or [] for code in outage.get("codes") or []})
    return {**record, "completeness": completeness, "gap_codes": gap_codes, "interruptions": interruptions}


class FakeMarketRuntimeEvidence(PartitionEvidence):
    """Partition records written as Market Runtime writes them, and its evidence.* commands answered on them."""

    def __init__(self, root: str | Path) -> None:
        super().__init__(root=root, command=self._answer)
        self.commands: list[tuple[str, dict[str, Any]]] = []

    # -- what Market Runtime records ----------------------------------------------------------

    def _load(self, source: str, market: str, trading_date: str, session: str) -> dict[str, Any]:
        path = evidence_path(self.root, source, market, trading_date, session)
        stored = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        return {**self._empty(source, market, trading_date, session), **stored}

    @staticmethod
    def _empty(source: str, market: str, trading_date: str, session: str) -> dict[str, Any]:
        return {"schema": SCHEMA, "source": str(source).lower(), "market": str(market).upper(), "trading_date": str(trading_date)[:10],
                "session": str(session).upper(), "accepted": 0, "first_ts_ns": 0, "last_ts_ns": 0, "dropped": 0, "outages": [],
                "rejected": {}, "duplicates": 0, "restarts": [], "instance": "", "recorded_until_ns": 0, "sealed": False,
                "quarantined": None, "repaired": None}

    def _closed_through_path(self) -> Path:
        return self.root / "closed_through.json"

    def _closed_through(self) -> dict[str, str]:
        path = self._closed_through_path()
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}

    def is_closed(self, source: str, market: str, trading_date: str, session: str) -> bool:
        """As Market Runtime judges it (evidence::Ledger::is_closed): a sealed or quarantined record, or no record and a
        day at or before the newest one sealed in its source + market + session."""
        path = evidence_path(self.root, source, market, trading_date, session)
        if path.exists():
            row = json.loads(path.read_text(encoding="utf-8"))
            return bool(row.get("sealed") or row.get("quarantined"))
        through = self._closed_through().get(f"{str(source).lower()}|{str(market).upper()}|{str(session).upper()}")
        return through is not None and str(trading_date)[:10] <= through

    def _save(self, record: dict[str, Any]) -> None:
        path = evidence_path(self.root, record["source"], record["market"], record["trading_date"], record["session"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(_judged(record)), encoding="utf-8")

    def record(self, source: str, market: str, trading_date: str, session: str, **fields: Any) -> dict[str, Any]:
        """Set fields of a partition's record (made when absent); counters given here replace the stored ones."""
        record = self._load(source, market, trading_date, session)
        if self.is_closed(source, market, trading_date, session):
            return record   # closed: refused (PARTITION_CLOSED), as in Market Runtime
        record.update(fields)
        self._save(record)
        return record

    def stored(self, event: Any, count: int = 1) -> None:
        """``count`` stored events like ``event`` (source, market, trading_date, session, exchange_ts_ns)."""
        record = self._load(event.source, event.market, event.trading_date, event.session)
        if self.is_closed(event.source, event.market, event.trading_date, event.session):
            return
        ts = int(getattr(event, "exchange_ts_ns", 0) or 0)
        record["accepted"] = int(record["accepted"]) + count
        if ts > 0:
            record["first_ts_ns"] = min(int(record["first_ts_ns"]) or ts, ts)
            record["last_ts_ns"] = max(int(record["last_ts_ns"]), ts)
        self._save(record)

    def lost(self, event: Any, count: int = 1) -> None:
        record = self._load(event.source, event.market, event.trading_date, event.session)
        if not self.is_closed(event.source, event.market, event.trading_date, event.session):
            record["dropped"] = int(record["dropped"]) + count
            self._save(record)

    # -- the owner's commands ------------------------------------------------------------------

    def _answer(self, kind: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.commands.append((kind, dict(payload)))
        if kind == "evidence.prune":
            removed = []
            for partition in payload["sessions"]:
                for path in self.root.glob(f"*/{partition['market']}/{partition['trading_date']}_{partition['session']}.json"):
                    row = json.loads(path.read_text(encoding="utf-8"))
                    if row.get("sealed") or row.get("quarantined"):
                        path.unlink()
                        removed.append({**partition, "source": path.parent.parent.name})
            return {"removed": removed}
        sources = {path.parent.parent.name for path in self.root.glob(f"*/{payload['market']}/{payload['trading_date']}_{payload['session']}.json")}
        if not sources:
            return {"ok": False}
        record = self._load(sources.pop(), payload["market"], payload["trading_date"], payload["session"])
        if kind == "evidence.seal":
            record["sealed"] = True
            through = self._closed_through()
            family = f"{record['source']}|{record['market']}|{record['session']}"
            through[family] = max(through.get(family, ""), record["trading_date"])
            self.root.mkdir(parents=True, exist_ok=True)
            self._closed_through_path().write_text(json.dumps(through), encoding="utf-8")
        elif kind == "evidence.quarantine":
            if record.get("quarantined"):
                return {"ok": False}
            record["quarantined"] = {"reason": payload["reason"], "at_ns": 1, "accepted": record["accepted"], "sealed": record["sealed"]}
        elif kind == "evidence.mark_repaired":
            record["repaired"] = {"note": payload["note"], "at_ns": 1}
        self._save(record)
        return {"ok": True, "written": True}


class FakeSink:
    """The parts of rust_live.RustDaemonEventSink a session owner reads: its partition records, what it has not had
    answered yet (``unconfirmed``: market -> exchange times), the market clock and its queue stats."""

    def __init__(self, evidence: FakeMarketRuntimeEvidence, *, unconfirmed: dict[str, list[int]] | None = None,
                 clock: dict[str, int] | None = None) -> None:
        self.evidence = evidence
        self.unconfirmed = unconfirmed or {}
        self.clock = clock or {}

    def unconfirmed_before(self, markets, end_ns: int) -> int:
        return sum(1 for market in markets for ts in self.unconfirmed.get(str(market).upper(), []) if ts < end_ns)

    def observed_market_clock(self, *markets: str) -> int:
        return max((ts for market, ts in self.clock.items() if not markets or market in markets), default=0)

    def stats(self) -> dict[str, Any]:
        return {"queue_depth": 0, "pending": 0}
