"""The historical store's per-date index: ``<root>/source=../market=../trading_date=../totals.json``.

Written only by the store's manager, Rust B (native/market_runtime/src/historical_totals.rs, under the store lock,
after every publish and removal, and checked against the partitions at each of its prunes): every committed partition
of the date -- session, code, events per lane (``lanes``, by Rust B's lane names: trade, orderbook, quote, ...), the
events file's bytes (``events_bytes``), the partition's ``completeness`` and the bytes of all its files (``bytes``). A reader that wants a date's counts or
size reads this one file instead of every partition's manifest. No file: the date has no committed partition.

Here, not under service/market, because two layers read it -- 資料中心 (service/market/query) and the training job's
today counts (service/analysis/online_training/today.py) -- and service/analysis must not depend on service/market.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from service.platform.atomic_files import read_text_shared

FILE_NAME = "totals.json"
SCHEMA = "historical-date-totals-v3"


class TotalsUnreadable(ValueError):
    """The file is there but is not this schema's index."""


def date_partitions(date_dir: Path) -> list[dict[str, Any]] | None:
    """The date's committed partitions as its index lists them; None when the date has no index (no committed
    partition). Raises OSError when the file cannot be read and TotalsUnreadable when it is not this schema's."""
    path = Path(date_dir) / FILE_NAME
    try:
        text = read_text_shared(path)
    except FileNotFoundError:  # not an error: the date has no committed partition
        return None
    try:
        doc = json.loads(text)
    except ValueError as exc:
        raise TotalsUnreadable(f"{path}: not JSON: {exc}") from exc
    if not isinstance(doc, dict) or doc.get("schema") != SCHEMA or not isinstance(doc.get("partitions"), list):
        raise TotalsUnreadable(f"{path}: schema is not {SCHEMA}")
    return [p for p in doc["partitions"] if isinstance(p, dict)]


def market_date_dirs(market_dir: Path) -> dict[str, Path]:
    """trading date -> its folder, for every ``trading_date=`` folder of one market (none when the market has none)."""
    try:
        entries = list(Path(market_dir).iterdir())
    except FileNotFoundError:  # not an error: nothing of the market is stored
        return {}
    return {entry.name.split("=", 1)[1]: entry for entry in entries if entry.name.startswith("trading_date=") and entry.is_dir()}
