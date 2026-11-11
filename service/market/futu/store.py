from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterator


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class FutuControlStore:
    """Small SQLite store for Futu *control* state only.

    It persists the user's watchlist and a few key/value runtime settings
    (the session lifecycle record). It holds no current-market state and no market history:
    quotes, minute bars, ticks and order books live only in Market Runtime,
    whose WAL/checkpoint is the sole live-durability authority.
    """

    def __init__(self, db_path: Path) -> None:
        self.db_path = Path(db_path)
        # The one process that writes the list keeps it: every 0.2 s cycle reads it, and it changes only on a save.
        self._watchlist: list[dict] | None = None

    @contextmanager
    def write_session(self) -> Iterator[sqlite3.Connection]:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(str(self.db_path), timeout=15.0)
        try:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA busy_timeout=15000")
            connection.execute("PRAGMA synchronous=NORMAL")
            yield connection
            connection.commit()
        finally:
            connection.close()

    @contextmanager
    def read_session(self) -> Iterator[sqlite3.Connection]:
        uri = f"{self.db_path.resolve().as_uri()}?mode=ro"
        connection = sqlite3.connect(uri, uri=True, timeout=15.0)
        try:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA query_only=ON")
            connection.execute("PRAGMA busy_timeout=15000")
            yield connection
        finally:
            connection.close()

    def initialize_schema(self) -> None:
        with self.write_session() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS watchlist (
                    code TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
                    sort_order INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS runtime_state (
                    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                """
            )

    def read_state(self, key: str) -> str:
        # A pure read takes the read-only connection, never the writer's (which creates the file and commits).
        if not self.db_path.exists():
            return ""
        with self.read_session() as db:
            row = db.execute("SELECT value FROM runtime_state WHERE key=?", (key,)).fetchone()
        return str(row[0]) if row else ""

    def write_state(self, key: str, value: str) -> None:
        with self.write_session() as db:
            db.execute(
                "INSERT INTO runtime_state(key,value,updated_at) VALUES(?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
                (key, value, _utc_now()),
            )

    def watchlist_rows(self) -> list[dict]:
        held = self._watchlist
        if held is None:
            with self.read_session() as db:
                rows = db.execute(
                    "SELECT code,name,sort_order,updated_at FROM watchlist WHERE enabled=1 ORDER BY sort_order,code"
                ).fetchall()
            held = [dict(row) for row in rows]
            self._watchlist = held
        return [dict(row) for row in held]

    def replace_watchlist(
        self,
        requested: list[tuple[str, str, int, str]],
        *,
        known_codes_snapshot: Callable,
        report_rejected: Callable,
    ) -> list:
        with self.write_session() as db:
            old_rows = [
                (str(row[0]), str(row[1] or ""), int(row[2] or 0), str(row[3] or ""))
                for row in db.execute(
                    "SELECT code,name,sort_order,updated_at FROM watchlist WHERE enabled=1 ORDER BY sort_order,code"
                ).fetchall()
            ]
            old_codes = {row[0] for row in old_rows}
            known_codes = set(known_codes_snapshot() or ())
            # New additions must exist in the local security master. Existing
            # persisted rows survive a temporary missing/stale master so an
            # OpenD outage never destroys the user's watchlist.
            normalized: list[tuple[str, str, int, str]] = []
            rejected: list[str] = []
            if not known_codes:
                # Bootstrap tolerance, identical to FutuMarketService.pollable_watch_codes():
                # on a fresh install (or after a failed master refresh) the local security
                # master does not exist yet, and "nothing is known" must not mean "nothing is
                # valid" -- that rejected the user's very first watchlist outright. Validation
                # is unchanged the moment a master IS populated.
                normalized = list(requested)
            else:
                for row in requested:
                    code = row[0]
                    if code in old_codes or code in known_codes:
                        normalized.append(row)
                    else:
                        rejected.append(code)
            report_rejected(rejected)
            if requested and not normalized:
                # DELETE-then-INSERT must never be the destructive half of a rejected write.
                # An empty `requested` is the user genuinely clearing the list and still
                # applies; a fully rejected non-empty request keeps what is already
                # persisted, so the 商品列 cannot be silently emptied by validation.
                return old_rows
            db.execute("DELETE FROM watchlist")
            db.executemany("INSERT INTO watchlist(code,name,sort_order,updated_at) VALUES(?,?,?,?)", normalized)
        self._watchlist = None
        return normalized
