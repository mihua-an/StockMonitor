"""The session evidence Market Runtime keeps for every WAL partition: read its files, send its owners' commands.

Market Runtime alone judges a partition's identity and keeps its completeness record (docs/decisions.md 分區身分與
分區完整性紀錄的擁有者; native/market_runtime/src/evidence.rs): what it stored, what a provider reported lost
(``ingest.loss``), what it refused, and every provider restart it saw (``ingest.hello``). It writes one file per
partition, ``<root>/<source>/<market>/<date>_<session>.json``, with the completeness it judged. Nothing here judges or
counts anything again: readers read the file, and a session owner's decisions -- seal, quarantine, mark repaired,
prune -- are commands to Market Runtime, answered once the file is written.

The files are read directly (not asked of Market Runtime) because the 收盤進度 and the WAL retention run in other
processes, also while Market Runtime is stopped.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Callable, Iterable

from service.platform import project_root as process_paths
from service.platform.atomic_files import read_bytes_shared
from service.platform.failure_record import record_failure

_log = logging.getLogger(__name__)

ENV_ROOT = "STOCK_MONITOR_SESSION_EVIDENCE_ROOT"
SCHEMA = "market-runtime-session-evidence-v1"
NO_EVIDENCE = {"observed": False, "completeness": "gap_detected", "reason": "NO_EVIDENCE_FOR_SESSION", "accepted": 0,
               "dropped": 0, "rejected_total": 0, "interruptions": 0, "gap_codes": [],
               "repaired_codes": []}

#: A command to Market Runtime on the provider's role: (command type, payload) -> the ack's payload.
Command = Callable[[str, dict[str, Any]], dict[str, Any]]


def default_evidence_root() -> Path:
    """Where Market Runtime writes the files (health/main.js names the same path for it)."""
    return Path(os.environ.get(ENV_ROOT) or (process_paths.OUTPUT_ROOT / "session_evidence"))


def evidence_path(root: Path, source: str, market: str, trading_date: str, session: str) -> Path:
    return Path(root) / str(source).lower() / str(market).upper() / f"{str(trading_date)[:10]}_{str(session).upper()}.json"


def read_record(root: Path, source: str, market: str, trading_date: str, session: str) -> dict[str, Any] | None:
    """The partition's record as Market Runtime last wrote it; None when it wrote none (or one of an earlier format,
    which only Market Runtime's prune reads)."""
    path = evidence_path(root, source, market, trading_date, session)
    try:
        value = json.loads(read_bytes_shared(path).decode("utf-8"))
    except FileNotFoundError:  # not an error: Market Runtime has no record of that partition
        return None
    except (OSError, ValueError) as exc:
        record_failure(_log, f"reading the session evidence {path.name}", exc)
        return None
    return value if isinstance(value, dict) and value.get("schema") == SCHEMA else None


def summary_of(record: dict[str, Any] | None) -> dict[str, Any]:
    """A record as owners read it: Market Runtime's own completeness, with the refusals summed."""
    if not record:
        return dict(NO_EVIDENCE)
    rejected = record.get("rejected") or {}
    return {**record, "observed": True, "rejected_total": int(sum(int(n) for n in rejected.values())),
            "reason": "" if record.get("completeness") == "complete" else "EVIDENCE_LOSS"}


class PartitionEvidence:
    """Market Runtime's partition records for one provider: read from ``root``, decided through ``command`` (the
    provider's sink sends it on the provider's role, rust_live.RustDaemonEventSink.evidence_command)."""

    def __init__(self, *, root: str | Path | None = None, command: Command | None = None) -> None:
        self.root = Path(root if root is not None else default_evidence_root()).absolute()
        self._command = command

    # -- reading ---------------------------------------------------------------------------------

    def summary(self, source: str, market: str, trading_date: str, session: str) -> dict[str, Any]:
        return summary_of(read_record(self.root, source, market, trading_date, session))

    def combined(self, windows: list[tuple[str, str, str, str]]) -> dict[str, Any]:
        """Several partitions read as one (a STK close with its IDX day; a FUT 全日 of a NIGHT and a DAY): the worst
        completeness, the counts summed, every partition's own record in ``windows``."""
        parts = [self.summary(*window) for window in windows]
        observed = [p for p in parts if p.get("observed")]
        if not observed:
            return {**NO_EVIDENCE, "windows": parts}
        order = {"complete": 0, "repaired": 1, "gap_detected": 2}
        worst = max(observed, key=lambda p: order[str(p["completeness"])])["completeness"]
        return {"observed": True, "completeness": worst, "windows": parts,
                "gap_codes": sorted({code for p in observed for code in p.get("gap_codes") or []}),
                "repaired_codes": sorted({code for p in observed for code in p.get("repaired_codes") or []}
                                         - {code for p in observed for code in p.get("gap_codes") or []}),
                **{name: sum(int(p.get(name) or 0) for p in observed)
                   for name in ("accepted", "dropped", "rejected_total", "duplicates", "interruptions")}}

    def sessions(self, source: str = "", trading_date: str = "") -> list[tuple[str, str, str, str]]:
        """Every partition with a record of this format: (source, market, trading_date, session)."""
        found = []
        if self.root.is_dir():
            for path in self.root.glob("*/*/*.json"):
                date_text, _, session = path.stem.partition("_")
                src, market = path.parent.parent.name, path.parent.name
                if source and src != str(source).lower():
                    continue
                if trading_date and date_text != str(trading_date)[:10]:
                    continue
                if read_record(self.root, src, market, date_text, session) is not None:
                    found.append((src, market, date_text, session))
        return sorted(found)

    def traded_dates(self, source: str, market: str, session: str, *, excluding: Iterable[str] = ()) -> list[str]:
        """The dates, apart from `excluding`, of which the partition holds stored events and is a session of its market."""
        skip = {str(date)[:10] for date in excluding}
        suffix = f"_{str(session).upper()}"
        found = []
        for path in (self.root / str(source).lower() / str(market).upper()).glob(f"*{suffix}.json"):
            date_text = path.stem[:-len(suffix)]
            if date_text in skip:
                continue
            record = read_record(self.root, source, market, date_text, session)
            if record is not None and int(record.get("accepted") or 0) > 0 and not record.get("quarantined"):
                found.append(date_text)
        return sorted(found)

    # -- the owner's decisions (Market Runtime commands) -------------------------------------------

    def _send(self, kind: str, payload: dict[str, Any]) -> dict[str, Any]:
        if self._command is None:
            raise RuntimeError(f"{kind}: no connection to Market Runtime (this reader only reads the files)")
        return self._command(kind, payload)

    @staticmethod
    def _partition(market: str, trading_date: str, session: str) -> dict[str, str]:
        return {"market": str(market).upper(), "trading_date": str(trading_date)[:10], "session": str(session).upper()}

    def seal(self, source: str, market: str, trading_date: str, session: str) -> bool:
        """Freeze the partition (its file is written before this returns). False: Market Runtime has no record of it
        (sealing invents none). ``source`` is the provider's own: Market Runtime takes it from the connection."""
        del source
        return bool(self._send("evidence.seal", self._partition(market, trading_date, session)).get("ok"))

    def quarantine(self, source: str, market: str, trading_date: str, session: str, *, reason: str) -> bool:
        """Close for good a record that is no session of its market. False when there is none or it is closed."""
        del source
        return bool(self._send("evidence.quarantine", {**self._partition(market, trading_date, session), "reason": str(reason)}).get("ok"))

    def mark_repaired(self, source: str, market: str, trading_date: str, session: str, *, note: str) -> bool:
        """Only for a real, verified backfill or recovery; nothing infers it."""
        del source
        return bool(self._send("evidence.mark_repaired", {**self._partition(market, trading_date, session), "note": str(note)}).get("ok"))

    def prune(self, source: str, sessions: Iterable[tuple[str, str, str]]) -> list[tuple[str, str, str, str]]:
        """Delete the records of these finished ``(market, trading_date, session)`` that are closed (sealed or
        quarantined); returns what went."""
        payload = {"sessions": [self._partition(*session) for session in sorted(set(sessions))]}
        if not payload["sessions"]:
            return []
        removed = self._send("evidence.prune", payload).get("removed") or []
        return [(str(source).lower(), str(r["market"]), str(r["trading_date"]), str(r["session"])) for r in removed]
