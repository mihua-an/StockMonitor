"""The ONE Python read boundary for historical market data.

Target (docs/system-architecture/03_protocol_and_storage.md §6): sealed WAL + session metadata
  -> Rust Historical Materializer -> historical store -> every Python reader.

The store is exactly what the Materializer writes (Rust B's ``analysis_runtime --materialize``, see
native/analysis_runtime/src/materialize.rs; folded by B's canonical engine):

  <root>/source=<s>/market=<M>/trading_date=<D>/session=<S>/<CODE>/
      manifest.json   completeness + counts (the "verified/promoted" marker)
      events.jsonl    every admitted MarketEvent, durable_sequence order
      state.json      B's fold of the partition (summary, minute trend with
                      quality/amount/average, final book)

This module only READS. It derives the frames the history readers expect (minute trend, session summary) in
memory from those files. It never writes, never rebuilds, and never falls back to any other historical store: a
partition the Materializer has not produced is reported ``unavailable`` and the caller may request intent through
the per-source session owner (see materialization_coordinator.py).
"""
from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path
from typing import Any, Iterator

import pandas as pd

from service.market.history.rust_historical_store_reader import default_historical_root, partition_dir
from service.platform.native_binaries import analysis_runtime_job_binary

logger = logging.getLogger(__name__)

from service.market.shared.native_values import units_to_price as _units  # noqa: E402
from service.market.shared.session_identity_contract import session_windows, wal_sessions  # noqa: E402
from service.market.shared.volume import to_volume  # noqa: E402
from service.platform.failure_record import record_failure

# WAL session tag per Shioaji market comes from the ONE identity contract.
SHIOAJI_SESSIONS = {m: wal_sessions("shioaji", m) for m in ("STK", "IDX", "FUT")}
UNAVAILABLE = "unavailable"
READY = "ready"


# A manifest's lane_report key for the order book (Rust B names lanes by the event's stream key).
ORDERBOOK_LANE = "orderbook"


# One verification run covers up to a whole session's partitions; a 1 GB partition takes about 7 s.
VERIFY_TIMEOUT_SECONDS = 1800


class HistoricalStore:
    def __init__(self, root: str | Path | None = None, *, source: str = "shioaji", verifier: str | Path | None = None) -> None:
        self.root = Path(root) if root else default_historical_root()
        self.source = str(source).lower()
        # Rust B checks a partition against its manifest (hash, count, event schema): the writer's own rules. Without
        # an explicit one, each check runs the current build's job copy (native_binaries.analysis_runtime_job_binary).
        self.verifier = Path(verifier) if verifier else None
        # events.jsonl path -> lines of its current content that do not decode (skipped one by one, never the rest
        # of the partition). Set from the file each time it is read, never added up across reads.
        self.unreadable_lines: dict[str, int] = {}
        # events.jsonl path -> (size, mtime_ns of the content checked, what is wrong with it; "" = intact). One entry
        # per path, replaced when the file changes and dropped when it is gone.
        self._artifact_checks: dict[str, tuple[int, int, str]] = {}

    # -- discovery ------------------------------------------------------------------

    def _dir(self, market: str, code: str, trading_date: str, session: str) -> Path:
        return partition_dir(
            source=self.source, market=market, logical_code=code, trading_date=trading_date,
            session=session, historical_root=self.root,
        )

    def partitions(self, market: str, code: str, trading_date: str, session: str = "") -> list[Path]:
        """Existing, manifest-bearing partitions for a code/date (all sessions when session is empty)."""
        market_u = str(market).upper()
        code = str(code).upper()
        wal = SHIOAJI_SESSIONS.get(market_u, ("DAY", "NIGHT", "FULL"))
        # FUT DAY/NIGHT name partitions themselves; 全日 (FULL) is read by the frame readers as two partitions.
        wanted = [session.upper()] if session and session.upper() in wal else list(wal)
        found = []
        for name in wanted:
            try:
                path = self._dir(market_u, code, str(trading_date)[:10], name)
            except ValueError:  # not an error: not a storable identity: nothing was ever materialized under it
                return []   # not a storable identity: nothing was ever materialized under it
            if (path / "manifest.json").is_file():
                found.append(path)
        return found

    def manifest(self, market: str, code: str, trading_date: str, session: str = "") -> dict[str, Any] | None:
        for path in self.partitions(market, code, trading_date, session):
            payload = self._json(path / "manifest.json")
            if payload:
                return payload
        return None

    def completeness(self, code: str, trading_date: str, *, market: str) -> dict[str, Any]:
        """The materialized completeness of a code's trading date over every partition it has: "complete" only when
        each partition's manifest says so (its loss evidence is empty), "gap_detected" when any says otherwise, None
        when nothing is materialized. The one authority replay coverage reads."""
        market_u = market.upper()
        paths = self.partitions(market_u, code, trading_date)
        manifests = [self._json(path / "manifest.json") or {} for path in paths]
        if not manifests:
            return {"completeness": None, "loss_evidence": [], "partitions": 0, "fingerprint": ""}
        states = {str(m.get("completeness") or "gap_detected") for m in manifests}
        loss = [item for m in manifests for item in (m.get("loss_evidence") or [])]
        # The manifest describes what was written; the file is what a replay reads. A damaged events.jsonl is a gap
        # whatever the manifest says (its bytes must hash to the manifest's content hash).
        checks = self._artifact_problems(paths)
        for path in paths:
            problem = checks[path][1]
            if problem:
                states.add("gap_detected")
                loss.append(problem)
        # The fingerprint names the content checked and the verdict, so a cache built before the file was damaged
        # (or repaired) is stale even though no manifest changed.
        content = "|".join(f"{path}:{checks[path][0]}:{checks[path][1]}" for path in paths)
        return {"completeness": "complete" if states == {"complete"} else "gap_detected", "loss_evidence": loss,
                "partitions": len(manifests), "fingerprint": f"{self._fingerprint(manifests)}#{content}"}

    def _artifact_problems(self, paths: list[Path]) -> dict[Path, tuple[str, str]]:
        """Per partition: (the signature of its events.jsonl, what is wrong with it; "" = intact). Rust B checks each
        content once (verify.rs); a partition it cannot check is reported, never taken as intact."""
        result: dict[Path, tuple[str, str]] = {}
        pending: dict[Path, tuple[int, int]] = {}
        for path in paths:
            events_path = path / "events.jsonl"
            try:
                stat = events_path.stat()
            except OSError as exc:
                record_failure(logger, "checking a historical events file", exc)
                self._artifact_checks.pop(str(events_path), None)
                result[path] = ("missing", f"{events_path.name} of {path.name} is unreadable")
                continue
            known = self._artifact_checks.get(str(events_path))
            if known and known[:2] == (stat.st_size, stat.st_mtime_ns):
                result[path] = (f"{stat.st_size}:{stat.st_mtime_ns}", known[2])
            else:
                pending[path] = (stat.st_size, stat.st_mtime_ns)
        if not pending:
            return result
        verdicts = self._verify([str(path) for path in pending])
        for path, (size, mtime) in pending.items():
            verdict = verdicts.get(str(path))
            signature = f"{size}:{mtime}"
            if verdict is None:
                result[path] = (signature, f"{path.name} could not be verified")
                continue
            events_path = str(path / "events.jsonl")
            problem = str(verdict.get("problem") or "")
            self.unreadable_lines[events_path] = int(verdict.get("bad") or 0)
            self._artifact_checks[events_path] = (size, mtime, problem)
            result[path] = (signature, problem)
        return result

    def _verify(self, dirs: list[str]) -> dict[str, dict[str, Any]]:
        """Rust B's verdict per partition directory; {} when B could not be asked (recorded)."""
        try:
            verifier = self.verifier or analysis_runtime_job_binary()
        except OSError as exc:
            record_failure(logger, "verifying historical partitions (the analysis_runtime job copy)", exc)
            return {}
        if not verifier.is_file():
            record_failure(logger, "verifying historical partitions", FileNotFoundError(f"analysis_runtime not found: {verifier}"))
            return {}
        try:
            done = subprocess.run([str(verifier), "--verify-partitions", *dirs], capture_output=True, text=True,
                                  encoding="utf-8", timeout=VERIFY_TIMEOUT_SECONDS)
            payload = json.loads(done.stdout)
        except (OSError, subprocess.SubprocessError, ValueError) as exc:
            record_failure(logger, "verifying historical partitions", exc)
            return {}
        if done.returncode != 0 or not payload.get("ok"):
            record_failure(logger, "verifying historical partitions",
                           RuntimeError(f"analysis_runtime --verify-partitions exited {done.returncode}: {(done.stderr or '')[-300:]}"))
            return {}
        return {str(item.get("dir")): item for item in payload.get("partitions") or [] if isinstance(item, dict)}

    @staticmethod
    def _fingerprint(manifests: list[dict[str, Any]]) -> str:
        """What the materialized content is: each manifest's content hash and generation time. A cache built from the
        store is stale once this changes (a later materialization of the same date)."""
        return "|".join(sorted(f"{m.get('logical_code')}:{m.get('session')}:{m.get('content_hash_fnv1a64')}:{m.get('generated_at_epoch')}"
                               for m in manifests))

    def date_fingerprint(self, market: str, trading_date: str) -> str:
        return self._fingerprint(self.list_partitions(market, trading_date))

    def availability(self, market: str, code: str, trading_date: str, session: str = "") -> dict[str, Any]:
        manifest = self.manifest(market, code, trading_date, session)
        if manifest is None:
            return {"state": UNAVAILABLE, "reason": "HISTORICAL_PARTITION_NOT_MATERIALIZED",
                    "market": market, "code": code, "trading_date": str(trading_date)[:10], "session": session}
        return {"state": READY, "completeness": manifest.get("completeness"),
                "event_count": manifest.get("event_count"), "duplicate_count": manifest.get("duplicate_count"),
                "loss_evidence": manifest.get("loss_evidence"),
                "market": manifest.get("market"), "code": manifest.get("logical_code"),
                "trading_date": manifest.get("trading_date"), "session": manifest.get("session")}

    def artifact_status(self, market: str, trading_date: str, session: str) -> dict[str, Any]:
        """Validate the materialized artifact(s) of one session partition set (B: artifact valid).

        Valid = at least one manifest, and every partition non-empty and intact (Rust B's check: content hash, event
        count and event schema against its manifest). Independent of "the job succeeded".
        """
        base = self._source_root() / f"market={str(market).upper()}" / f"trading_date={str(trading_date)[:10]}" / f"session={str(session).upper()}"
        manifests = sorted(base.glob("[!.]*/manifest.json"))
        if not manifests:
            return {"valid": False, "reason": "NO_ARTIFACT", "partitions": 0, "events": 0}
        paths = [path.parent for path in manifests]
        checks = self._artifact_problems(paths)
        events = 0
        for path in paths:
            problem = checks[path][1]
            if problem:
                logger.warning(f"[HISTORICAL STORE] artifact of {market}:{trading_date}:{session} invalid: {problem}")
                return {"valid": False, "reason": "ARTIFACT_DAMAGED", "detail": problem, "partitions": len(manifests),
                        "events": events}
            count = int((self._json(path / "manifest.json") or {}).get("event_count") or 0)
            if count == 0:
                return {"valid": False, "reason": "EMPTY_ARTIFACT", "partitions": len(manifests), "events": events}
            events += count
        return {"valid": True, "partitions": len(manifests), "events": events}

    def fingerprint(self, market: str, trading_date: str, session: str = "") -> str:
        """Stable digest of the materialized artifacts of a date: changes when the store is rebuilt differently."""
        import hashlib
        digest = hashlib.sha1()
        base = self._source_root() / f"market={str(market).upper()}" / f"trading_date={str(trading_date)[:10]}"
        for manifest_path in sorted(base.glob("session=*/[!.]*/manifest.json")):
            if session and manifest_path.parent.parent.name != f"session={session.upper()}":
                continue
            manifest = self._json(manifest_path) or {}
            digest.update("|".join(str(manifest.get(k)) for k in (
                "source", "market", "logical_code", "trading_date", "session", "event_count",
                "content_hash_fnv1a64", "completeness", "schema")).encode())
        return digest.hexdigest()

    def _source_root(self) -> Path:
        return self.root / f"source={self.source}"

    def list_dates(self, market: str | None = None) -> list[str]:
        dates: set[str] = set()
        base = self._source_root()
        if not base.is_dir():
            return []
        for market_dir in base.glob("market=*"):
            if market and market_dir.name.split("=", 1)[1].upper() != str(market).upper():
                continue
            for date_dir in market_dir.glob("trading_date=*"):
                if any(True for _ in date_dir.glob("session=*/[!.]*/manifest.json")):
                    dates.add(date_dir.name.split("=", 1)[1])
        return sorted(dates, reverse=True)

    def list_partitions(self, market: str, trading_date: str) -> list[dict[str, Any]]:
        """Every materialized partition (manifest rows) of one market/date."""
        rows = []
        base = self._source_root() / f"market={str(market).upper()}" / f"trading_date={str(trading_date)[:10]}"
        for manifest_path in base.glob("session=*/[!.]*/manifest.json"):
            payload = self._json(manifest_path)
            if payload:
                rows.append(payload)
        return sorted(rows, key=lambda row: (str(row.get("logical_code")), str(row.get("session"))))

    def list_codes(self, trading_date: str, market: str = "STK") -> list[str]:
        return sorted({str(row.get("logical_code") or "").upper() for row in self.list_partitions(market, trading_date)})

    # -- raw reads --------------------------------------------------------------------

    @staticmethod
    def _json(path: Path) -> dict[str, Any] | None:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:  # not an error: no such historical file
            return None
        except (OSError, ValueError) as exc:
            record_failure(logger, "reading a historical store JSON file", exc)
            return None
        return value if isinstance(value, dict) else None

    def iter_events(self, market: str, code: str, trading_date: str, session: str = "") -> Iterator[dict[str, Any]]:
        """Every decodable event of the partition(s). A line that does not decode is skipped and counted on its own,
        never ending the read of its whole partition. The artifact check (content hash) is what says
        the file itself is damaged."""
        for path in self.partitions(market, code, trading_date, session):
            events_path = path / "events.jsonl"
            try:
                handle = events_path.open("r", encoding="utf-8")
            except OSError as exc:
                record_failure(logger, "opening a historical events file", exc)
                continue
            bad = 0
            last_error: ValueError | None = None
            try:
                with handle:
                    for line in handle:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            event = json.loads(line)
                        except ValueError as exc:
                            bad += 1
                            # Kept for the one record of this file, written with the count when the read ends.
                            last_error = exc
                            continue
                        if isinstance(event, dict):
                            yield event
            finally:
                # Also when the reader stops early: lines already skipped are recorded.
                if last_error is not None:
                    record_failure(logger, f"decoding {bad} line(s) of {events_path} (skipped)", last_error)
            self.unreadable_lines[str(events_path)] = bad

    def state(self, market: str, code: str, trading_date: str, session: str = "") -> dict[str, Any] | None:
        """Final materialized SymbolState of the (first available) session partition."""
        for path in self.partitions(market, code, trading_date, session):
            snapshot = self._json(path / "state.json")
            if snapshot and isinstance(snapshot.get("state"), dict):
                return snapshot
        return None

    # -- FUT 全日 over the per-session partitions ------------------------------------------------
    # A FUT (trading_date, DAY|NIGHT) is a partition identity (a NIGHT dated by the day it opened); only 全日
    # (session FULL of a trading date) spans two partitions: the night before it and its day.

    def _fut_session_frames(self, reader, code: str, trading_date: str, session: str, time_column: str) -> pd.DataFrame:
        frames = []
        for _src, _mk, partition_date, wal in session_windows("shioaji", "FUT", trading_date, session):
            frame = reader(code, partition_date, market="FUT", session=wal)
            if frame is not None and not frame.empty:
                frames.append(frame)
        if not frames:
            return pd.DataFrame()
        merged = pd.concat(frames, ignore_index=True)
        return merged.sort_values(time_column, kind="stable").reset_index(drop=True) if time_column in merged else merged

    def _is_fut_business_session(self, market: str, session: str) -> bool:
        return str(market).upper() == "FUT" and str(session).upper() == "FULL"

    # -- derived frames (in memory only) --------------------------------------------------

    def minute_trend(self, code: str, trading_date: str, *, market: str, session: str = "") -> pd.DataFrame:
        market_u = market.upper()
        if self._is_fut_business_session(market_u, session):
            return self._fut_session_frames(self.minute_trend, code, trading_date, session.upper(), "minute_timestamp")
        frames = []
        for path in self.partitions(market_u, code, trading_date, session):
            snapshot = self._json(path / "state.json")
            state = (snapshot or {}).get("state") or {}
            bars = state.get("minute_trend") or {}
            for key in sorted(bars, key=lambda item: int(item)):
                bar = bars[key]
                minute = int(bar.get("minute", key))
                # A FUT NIGHT partition's minutes continue past midnight (1440 = 00:00 the next day).
                stamp = pd.Timestamp(str(trading_date)[:10]) + pd.Timedelta(minutes=minute)
                frames.append({
                    "minute_timestamp": stamp, "price": _units(bar.get("close")),
                    "open": _units(bar.get("open")), "high": _units(bar.get("high")), "low": _units(bar.get("low")),
                    "minute_volume": to_volume(bar.get("volume")),
                    "average_price": _units(bar.get("average")), "amount": bar.get("amount"),
                    "actual_contract": str(code).upper(), "market": market_u,
                    "session": (snapshot or {}).get("session"),
                    "ingest_sequence": int((snapshot or {}).get("durable_sequence") or 0),
                    "source": "rust_historical_store",
                })
        return pd.DataFrame(frames)

    def summary(self, code: str, trading_date: str, *, market: str, session: str) -> dict[str, Any]:
        """One partition's session summary (B's state.json). A FUT summary is per partition (DAY or NIGHT): its 全日
        is two partitions and no summary of them is derived here."""
        market_u = market.upper()
        if market_u == "FUT" and str(session).upper() not in SHIOAJI_SESSIONS["FUT"]:
            raise ValueError(f"a FUT summary is one partition (DAY or NIGHT), not {session!r}")
        snapshot = self.state(market_u, code, trading_date, session)
        if not snapshot:
            return {}
        summary = (snapshot.get("state") or {}).get("summary") or {}
        manifest = self.manifest(market_u, code, trading_date, session) or {}
        return {
            "market": market_u, "logical_code": str(code).upper(), "actual_contract": str(code).upper(),
            "trading_date": str(trading_date)[:10], "session": snapshot.get("session"),
            "open": _units(summary.get("open")), "high": _units(summary.get("high")),
            "low": _units(summary.get("low")), "close": _units(summary.get("current")),
            # B's comparison price (Reference::comparison_price: the provider's 參考價, else its 昨收); null when the
            # session stated none.
            "current": _units(summary.get("current")), "prev_close": _units(summary.get("reference_price")),
            "limit_up": _units(summary.get("limit_up")), "limit_down": _units(summary.get("limit_down")),
            "total_volume": summary.get("total_volume"), "volume": summary.get("total_volume"),
            "amount": summary.get("total_amount"),
            "last_ingest_sequence": snapshot.get("durable_sequence"),
            "coverage_state": str(manifest.get("completeness") or "").upper(),
            "provenance": "rust_historical_materializer",
        }


# -- adapters exposing the reader method names the history consumers already use ------------


class _Metadata:
    """Identity listings some consumers read as ``store.metadata.*_identities``."""

    def __init__(self, store: HistoricalStore) -> None:
        self._store = store

    def _rows(self, trading_date: str, market: str) -> list[dict[str, Any]]:
        return [
            {"logical_code": row.get("logical_code"), "actual_contract": row.get("logical_code"),
             "session": row.get("session"), "row_count": row.get("event_count"),
             "last_timestamp": row.get("generated_at_epoch")}
            for row in self._store.list_partitions(market, trading_date)
        ]

    def minute_trend_identities(self, *, trading_date: str, market: str) -> list[dict[str, Any]]:
        return self._rows(trading_date, market)


class HistoricalMinuteTrendReader:
    def __init__(self, store: HistoricalStore) -> None:
        self._store = store
        self.metadata = _Metadata(store)

    def load_date(self, *, market: str, trading_date: str, logical_code: str, actual_contract: str = "", session: str = "") -> pd.DataFrame:
        return self._store.minute_trend(logical_code, trading_date, market=market, session=session)

    def load_identity(self, identity: Any) -> pd.DataFrame:
        return self.load_date(
            market=identity.market, trading_date=identity.trading_date, logical_code=identity.logical_code,
            session=identity.session,
        )

    def catchup_status(self, identity: Any) -> dict[str, Any]:
        return _catchup(self._store, identity)

    def metrics(self) -> dict[str, Any]:
        return {"reader": "rust_historical_store"}


def _catchup(store: HistoricalStore, identity: Any) -> dict[str, Any]:
    availability = store.availability(identity.market, identity.logical_code, identity.trading_date, identity.session)
    if availability["state"] != READY:
        return {"ok": False, "state": UNAVAILABLE, "reason": availability["reason"], "lag": 0}
    state = store.state(identity.market, identity.logical_code, identity.trading_date, identity.session) or {}
    watermark = int(state.get("durable_sequence") or 0)
    return {"ok": True, "state": READY, "raw_watermark": watermark, "materialized_watermark": watermark,
            "lag": 0, "coverage_prefix_missing": False, "coverage_tail_missing": False,
            "completeness": availability.get("completeness")}


class HistoricalSummaryReader:
    """Read-only session summaries of the Rust historical store (``provenance = rust_historical_materializer``)."""

    def __init__(self, store: HistoricalStore) -> None:
        self._store = store

    def load_any_contract(self, *, market: str, trading_date: str, session: str, logical_code: str) -> dict[str, Any]:
        return self._store.summary(logical_code, trading_date, market=market, session=session)

    def load(self, identity: Any) -> dict[str, Any]:
        return self.load_any_contract(
            market=identity.market, trading_date=identity.trading_date, session=identity.session,
            logical_code=identity.logical_code,
        )

    def list_date(self, *, market: str, trading_date: str, session: str = "DAY") -> list[dict[str, Any]]:
        rows: dict[str, dict[str, Any]] = {}
        for item in self._store.list_partitions(market, trading_date):
            if str(item.get("session")).upper() != session.upper():
                continue
            code = str(item.get("logical_code") or "").upper()
            row = self._store.summary(code, trading_date, market=market, session=session)
            if row:
                rows[code] = row
        return [rows[key] for key in sorted(rows)]

    def list_code(self, *, market: str, logical_code: str, session: str = "DAY") -> list[dict[str, Any]]:
        by_date: dict[str, dict[str, Any]] = {}
        for date_text in self._store.list_dates(market):
            row = self._store.summary(logical_code, date_text, market=market, session=session)
            if row:
                by_date[date_text] = row
        return [by_date[key] for key in sorted(by_date)]
