from __future__ import annotations

import csv
import io
from pathlib import Path
from typing import Any, Protocol, TypedDict
from service.market.futu.store import FutuControlStore
import logging
from service.platform.atomic_files import read_text_shared, write_bytes_atomic

_failure_log = logging.getLogger(__name__)


class WatchlistRow(TypedDict):
    code: str
    name: str
    sort_order: int
    updated_at: str


class FutuCatalogOwner(Protocol):
    """What the catalog needs from the Futu provider service that owns the security master and the watchlist."""

    def security_rows_snapshot(self) -> list[dict[str, Any]]: ...

    def replace_watchlist(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]: ...

    def last_watchlist_rejected_codes(self) -> list[str]: ...

    def refresh_security_master(self, timeout: float = 30.0) -> dict[str, Any]: ...

    def ensure_security_master_current(self, timeout: float = 30.0) -> dict[str, Any]: ...


class FutuProductCatalog:
    """Static product metadata: security-master file I/O/search and the watchlist.

    Reference/control data only. It carries no current-market fields; live
    quotes, trend, trades and books are read from Market Runtime by the
    renderer (RealtimeViewStore). Source controls are explicit commands back
    to the one OpenD worker; reads have no subscription or persistence side
    effects.
    """
    def __init__(self, store: FutuControlStore, *, security_master_path: Path, owner: FutuCatalogOwner) -> None:
        self.store = store
        self.security_master_path = security_master_path
        self._owner = owner

    # -- commands back to the one OpenD worker (the owner) --------------------------------------------------------

    def replace_watchlist(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return self._owner.replace_watchlist(items)

    def last_rejected_codes(self) -> list[str]:
        return self._owner.last_watchlist_rejected_codes()

    def refresh_security_master(self, timeout: float = 30.0) -> dict[str, Any]:
        return self._owner.refresh_security_master(timeout)

    def ensure_security_master_current(self, timeout: float = 30.0) -> dict[str, Any]:
        return self._owner.ensure_security_master_current(timeout)

    def read_security_master(self) -> list[dict[str, Any]]:
        if not self.security_master_path.exists():
            return []
        # Opened with delete sharing: the provider replaces this file while readers have it open.
        text = read_text_shared(self.security_master_path, 'utf-8-sig')
        return [dict(row) for row in csv.DictReader(io.StringIO(text, newline='')) if str(row.get('code') or '').strip()]

    def write_security_master(self, rows: list[dict[str, Any]]) -> None:
        fields = [
            "code", "name", "market", "type", "exchange_type", "lot_size",
            "listing_date", "stock_id", "delisting", "source", "updated_at",
        ]
        text = io.StringIO(newline="")
        writer = csv.DictWriter(text, fieldnames=fields)
        writer.writeheader()
        writer.writerows({key: row.get(key, "") for key in fields} for row in rows)
        write_bytes_atomic(self.security_master_path, text.getvalue().encode("utf-8-sig"), durable=True)


    def search_security_master(self, query: str, limit: int = 50) -> list[dict[str, Any]]:
        keyword = str(query or "").strip().lower()
        maximum = max(1, min(200, int(limit or 50)))
        source = self._owner.security_rows_snapshot()
        ranked: list[tuple[int, int, str, dict[str, Any]]] = []
        for row in source:
            code = str(row.get("code") or "").lower()
            symbol = code.split(".", 1)[1] if "." in code else code
            name = str(row.get("name") or "").lower()
            if not keyword:
                score, position = 8, 0
            elif keyword in {code, symbol}:
                score, position = 0, 0
            elif symbol.startswith(keyword):
                score, position = 1, 0
            elif keyword in symbol:
                score, position = 2, symbol.index(keyword)
            elif name == keyword:
                score, position = 3, 0
            elif name.startswith(keyword):
                score, position = 4, 0
            elif keyword in name:
                score, position = 5, name.index(keyword)
            else:
                continue
            ranked.append((score, position, code, row))
        ranked.sort(key=lambda item: (item[0], item[1], item[2]))
        return [item[3] for item in ranked[:maximum]]


    def watchlist(self) -> list[WatchlistRow]:
        return self.store.watchlist_rows()
