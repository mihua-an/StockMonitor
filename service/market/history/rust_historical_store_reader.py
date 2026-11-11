"""Read-only reader for the Rust Historical Materializer's output store (M12).

Isolation contract (docs/system-architecture/00_services_and_ports.md §2, the replay paragraph: 回放與盤中在結構上隔離): this
module and everything built on it may ONLY read files this store already
wrote. It never imports anything that could reach Market Runtime's
event.ingest, live WAL/checkpoint, or live subscription state -- there is no
such import here, by construction, not by discipline alone.

Layout matches health/materializer_job_runner.js's --out-dir and
analysis_runtime's materialize.rs partition scheme exactly (both read this
session, not guessed):
    <historical_root>/source=<source>/market=<MARKET>/trading_date=<DATE>/
        session=<SESSION>/<LOGICAL_CODE>/{manifest.json,events.jsonl,state.json}
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Iterator

from service.platform import project_root as process_paths
import logging
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)


def default_historical_root() -> Path:
    # The active 設定 → 資料儲存 location (config/storage_settings.py); the data root's `historical` by default.
    from config.storage_settings import historical_root

    return historical_root(data_root=process_paths.DATA_ROOT)


_SEGMENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,31}")
_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")


def partition_dir(
    *, source: str, market: str, logical_code: str, trading_date: str, session: str,
    historical_root: Path | None = None,
) -> Path:
    """Raises ValueError for an identity that is not a plain path segment: the parts come from a WebSocket query
    string, and `..` / separators / absolute paths would reach files outside the store."""
    parts = {"source": str(source).strip().lower(), "market": str(market).strip().upper(),
             "session": str(session).strip().upper(), "logical_code": str(logical_code).strip().upper()}
    date = str(trading_date)[:10]
    bad = [name for name, value in parts.items() if not _SEGMENT.fullmatch(value) or ".." in value]
    if not _DATE.fullmatch(date):
        bad.append("trading_date")
    if bad:
        raise ValueError(f"invalid historical identity: {', '.join(bad)}")
    root = historical_root or default_historical_root()
    path = (
        root
        / f"source={parts['source']}"
        / f"market={parts['market']}"
        / f"trading_date={date}"
        / f"session={parts['session']}"
        / parts["logical_code"]
    )
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("historical identity escapes the store root")
    return path


def read_manifest(
    *, source: str, market: str, logical_code: str, trading_date: str, session: str,
    historical_root: Path | None = None,
) -> dict[str, Any] | None:
    try:
        path = partition_dir(
            source=source, market=market, logical_code=logical_code, trading_date=trading_date,
            session=session, historical_root=historical_root,
        ) / "manifest.json"
    except ValueError:  # not an error: not a storable identity: nothing was ever materialized under it
        return None
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        record_failure(_failure_log, "reading a Rust historical manifest", exc)
        return None
    return payload if isinstance(payload, dict) else None


def iter_events(
    *, source: str, market: str, logical_code: str, trading_date: str, session: str,
    historical_root: Path | None = None,
) -> Iterator[dict[str, Any]]:
    """Yield each materialized MarketEvent in durable order.

    Yields nothing (not an error) when the partition doesn't exist -- a
    session that was never materialized, or was materialized with zero
    events, are both legitimate, silent no-op cases for a caller to handle
    (e.g. "no data available for this identity") rather than exceptions.
    """
    try:
        path = partition_dir(
            source=source, market=market, logical_code=logical_code, trading_date=trading_date,
            session=session, historical_root=historical_root,
        ) / "events.jsonl"
    except ValueError:  # not an error: not a storable identity: nothing was ever materialized under it
        return
    if not path.exists():
        return
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError as exc:
                record_failure(_failure_log, "decoding a Rust historical event line", exc)
                continue
            if isinstance(event, dict):
                yield event
