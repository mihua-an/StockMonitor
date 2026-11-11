from __future__ import annotations

import uuid
import logging
import os
import sqlite3
import threading
import time
from collections import Counter
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Iterator

from service.platform.failure_record import record_failure

logger = logging.getLogger(__name__)


LEDGER_REVISION = "ledger_revision"


class AccountRepository:
    """Own SQLite connection admission, diagnostics, WAL and final checkpoint.

    The ledger's logical version is ``meta.ledger_revision``: every write transaction (the rebuild with its raw
    change, a meta write) increments it in the same transaction, so "has the ledger changed" is one row, never the
    file's size or mtime (in WAL mode the main file does not change on every commit). ``snapshot`` gives a read that
    sees one version across several statements.
    """

    def __init__(self, db_path: Path, *, error_factory: Callable[[str], Exception]) -> None:
        self.db_path = Path(db_path)
        self._error_factory = error_factory
        self._lock = threading.RLock()
        self._lifecycle = threading.Condition(threading.RLock())
        self._accepting = True
        self._active = 0
        self._open_total = 0
        self._open_by_caller: Counter[str] = Counter()
        self._last_open_at = ""
        self._log_enabled = str(os.getenv("STOCK_MONITOR_SQLITE_DIAGNOSTICS", "1")).strip().lower() not in {"0", "false", "no", "off"}

    def connect(self, caller: str = "unspecified") -> sqlite3.Connection:
        caller_tag = str(caller or "unspecified")
        conn = sqlite3.connect(self.db_path, timeout=15.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 15000")
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA wal_autocheckpoint = 1000")
        now_text = datetime.now().isoformat(timespec="milliseconds")
        with self._lock:
            self._open_total += 1
            self._open_by_caller[caller_tag] += 1
            self._last_open_at = now_text
        if self._log_enabled:
            logger.debug(f"[SQLite] DB open: {self.db_path} caller={caller_tag} thread={threading.current_thread().name} at={now_text}")
        return conn

    @contextmanager
    def connection(self, *, caller: str = "unspecified") -> Iterator[sqlite3.Connection]:
        caller_tag = str(caller or "unspecified")
        with self._lifecycle:
            if not self._accepting:
                raise self._error_factory(f"SQLite service is shutting down: {self.db_path}")
            self._active += 1
        conn = None
        try:
            conn = self.connect(caller_tag)
            try:
                yield conn
                conn.commit()
            except Exception:
                try:
                    conn.rollback()
                    if self._log_enabled: logger.debug(f"[SQLite] rollback: {self.db_path} caller={caller_tag}")
                finally:
                    raise
        finally:
            if conn is not None:
                conn.close()
                if self._log_enabled:
                    logger.debug(f"[SQLite] DB close: {self.db_path} caller={caller_tag} thread={threading.current_thread().name}")
            with self._lifecycle:
                self._active = max(0, self._active - 1)
                self._lifecycle.notify_all()

    @contextmanager
    def snapshot(self, *, caller: str = "unspecified") -> Iterator[sqlite3.Connection]:
        """A read transaction: every statement on it sees the ledger as of its first read (SQLite WAL snapshot), so
        a projection assembled from several tables is never two ledger versions."""
        with self.connection(caller=caller) as conn:
            conn.execute("BEGIN")
            yield conn

    @staticmethod
    def bump_revision(conn: sqlite3.Connection) -> int:
        """Increment the ledger revision inside the caller's write transaction; returns the new revision."""
        conn.execute(
            "INSERT INTO meta(key,value) VALUES(?, '1') "
            "ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER) + 1 AS TEXT)",
            (LEDGER_REVISION,),
        )
        return AccountRepository.read_revision(conn)

    @staticmethod
    def read_revision(conn: sqlite3.Connection) -> int:
        row = conn.execute("SELECT value FROM meta WHERE key=?", (LEDGER_REVISION,)).fetchone()
        return int(row[0]) if row is not None else 0

    def revision(self, *, caller: str = "ledger.revision") -> int:
        with self.connection(caller=caller) as conn:
            return self.read_revision(conn)

    def begin_shutdown(self) -> None:
        with self._lifecycle:
            self._accepting = False
            self._lifecycle.notify_all()

    def wait_idle(self, timeout: float = 15.0) -> bool:
        deadline = time.monotonic() + max(0.0, float(timeout))
        with self._lifecycle:
            while self._active > 0:
                remaining = deadline - time.monotonic()
                if remaining <= 0: return False
                self._lifecycle.wait(min(0.25, remaining))
            return True

    def shutdown(self) -> dict[str, Any]:
        result: dict[str, Any] = {"ok": True, "db_path": str(self.db_path)}
        self.begin_shutdown()
        if not self.wait_idle(15.0):
            record_failure(logger, f"draining the SQLite connections of {self.db_path} at shutdown "
                                   f"({self.active_connections} still active)")
            return {**result, "ok": False, "error": "active SQLite connections did not drain", "active_connections": self.active_connections}
        wal_path = Path(f"{self.db_path}-wal")
        try:
            before = wal_path.stat().st_size if wal_path.exists() else 0
            conn = self.connect("shutdown.checkpoint")
            try:
                conn.commit()
                row = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
                result["checkpoint"] = tuple(row) if row is not None else ()
            finally:
                conn.close()
            result["wal_size_before"] = before
            result["wal_size_after"] = wal_path.stat().st_size if wal_path.exists() else 0
        except Exception as exc:
            record_failure(logger, f"checkpointing {self.db_path} at shutdown", exc)
            result.update({"ok": False, "error": str(exc)})
        return result

    @property
    def active_connections(self) -> int:
        with self._lifecycle: return int(self._active)

    def diagnostics(self) -> dict[str, Any]:
        with self._lock:
            return {"db_path": str(self.db_path), "open_total": self._open_total,
                    "open_by_caller": dict(self._open_by_caller), "last_open_at": self._last_open_at,
                    "active_connections": self.active_connections}

    def reset_diagnostics(self) -> None:
        with self._lock:
            self._open_total = 0
            self._open_by_caller.clear()
            self._last_open_at = ""

    def initialize(self):
        with self.connection(caller="startup.init_db") as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL DEFAULT ''
                );

                CREATE TABLE IF NOT EXISTS raw_trades (
                    trade_id TEXT PRIMARY KEY,
                    trade_date TEXT NOT NULL,
                    market TEXT NOT NULL,
                    action TEXT NOT NULL,
                    code TEXT NOT NULL,
                    trade_info TEXT NOT NULL,
                    trade_time TEXT NOT NULL DEFAULT '',
                    source_order INTEGER NOT NULL DEFAULT 0,
                    raw_json TEXT NOT NULL DEFAULT '{}'
                );

                CREATE INDEX IF NOT EXISTS idx_raw_trades_date_code
                    ON raw_trades(trade_date, market, code, source_order);

                CREATE TABLE IF NOT EXISTS fills (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    trade_id TEXT NOT NULL,
                    fill_seq INTEGER NOT NULL,
                    qty TEXT NOT NULL,
                    price TEXT NOT NULL,
                    amount TEXT NOT NULL,
                    FOREIGN KEY(trade_id) REFERENCES raw_trades(trade_id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS order_legs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    trade_id TEXT NOT NULL,
                    trade_date TEXT NOT NULL,
                    market TEXT NOT NULL,
                    action TEXT NOT NULL,
                    code TEXT NOT NULL,
                    trade_time TEXT NOT NULL,
                    source_order INTEGER NOT NULL,
                    trade_type TEXT NOT NULL,
                    qty TEXT NOT NULL,
                    avg_price TEXT NOT NULL,
                    gross_amount TEXT NOT NULL,
                    tax TEXT NOT NULL,
                    fee TEXT NOT NULL,
                    FOREIGN KEY(trade_id) REFERENCES raw_trades(trade_id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS realized_matches (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    realized_date TEXT NOT NULL,
                    market TEXT NOT NULL,
                    code TEXT NOT NULL,
                    trade_type TEXT NOT NULL,
                    direction TEXT NOT NULL DEFAULT '',
                    qty TEXT NOT NULL,
                    buy_price TEXT NOT NULL,
                    sell_price TEXT NOT NULL,
                    buy_amount TEXT NOT NULL,
                    sell_amount TEXT NOT NULL,
                    tax TEXT NOT NULL,
                    fee TEXT NOT NULL,
                    buy_fee TEXT NOT NULL DEFAULT '0',
                    sell_fee TEXT NOT NULL DEFAULT '0',
                    profit TEXT NOT NULL,
                    buy_ref TEXT NOT NULL,
                    sell_ref TEXT NOT NULL,
                    hold_period TEXT NOT NULL DEFAULT '',
                    sort_order INTEGER NOT NULL DEFAULT 0
                );

                CREATE INDEX IF NOT EXISTS idx_realized_date
                    ON realized_matches(realized_date, market, code);

                -- History trade-detail reads are query-shaped and always paginated.
                -- The market/type/date index serves global overview + Replay-date pages; the
                -- market/type/code/date index serves selected-symbol history pages.
                CREATE INDEX IF NOT EXISTS idx_realized_market_type_date_order
                    ON realized_matches(market, trade_type, realized_date DESC, sort_order DESC, id DESC);

                CREATE INDEX IF NOT EXISTS idx_realized_market_type_code_date_order
                    ON realized_matches(market, trade_type, code, realized_date DESC, sort_order DESC, id DESC);

                CREATE TABLE IF NOT EXISTS positions (
                    market TEXT NOT NULL,
                    code TEXT NOT NULL,
                    qty TEXT NOT NULL,
                    cost_amount TEXT NOT NULL,
                    avg_cost TEXT NOT NULL,
                    PRIMARY KEY(market, code)
                );

                CREATE TABLE IF NOT EXISTS rebuild_errors (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    trade_id TEXT NOT NULL DEFAULT '',
                    message TEXT NOT NULL
                );
                """
            )

        with self.connection(caller="startup.init_db") as conn:
            meta_rows = conn.execute("SELECT key,value FROM meta").fetchall()
            meta_cache = {str(row[0]): str(row[1]) for row in meta_rows}
            if not str(meta_cache.get("bridge_instance_id") or "").strip():
                bridge_instance_id = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO meta(key,value) VALUES('bridge_instance_id',?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (bridge_instance_id,),
                )
                meta_cache["bridge_instance_id"] = bridge_instance_id

            counts = self._read_status_counts_from_conn(conn)
        return meta_cache, counts


    @staticmethod
    def _read_status_counts_from_conn(conn: sqlite3.Connection) -> dict[str, int]:
        return {
            "raw_trades": int(conn.execute("SELECT COUNT(*) FROM raw_trades").fetchone()[0]),
            "fills": int(conn.execute("SELECT COUNT(*) FROM fills").fetchone()[0]),
            "realized_matches": int(conn.execute("SELECT COUNT(*) FROM realized_matches").fetchone()[0]),
            "positions": int(conn.execute("SELECT COUNT(*) FROM positions").fetchone()[0]),
            "errors": int(conn.execute("SELECT COUNT(*) FROM rebuild_errors").fetchone()[0]),
        }


    @staticmethod
    def replace_derived(conn, *, orders, legs, matches, positions, format_decimal):
        """Persist a computed ledger in its caller-owned rebuild transaction."""
        conn.execute("DELETE FROM fills")
        conn.execute("DELETE FROM order_legs")
        conn.execute("DELETE FROM realized_matches")
        conn.execute("DELETE FROM positions")
        conn.execute("DELETE FROM rebuild_errors")

        for order in orders:
            for seq, fill in enumerate(order.fills, start=1):
                conn.execute(
                    "INSERT INTO fills(trade_id,fill_seq,qty,price,amount) VALUES(?,?,?,?,?)",
                    (order.trade_id, seq, format_decimal(fill.qty), format_decimal(fill.price), format_decimal(fill.amount)),
                )

        for leg in legs:
            conn.execute(
                """
                INSERT INTO order_legs(
                    trade_id,trade_date,market,action,code,trade_time,source_order,trade_type,
                    qty,avg_price,gross_amount,tax,fee
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    leg.trade_id, leg.trade_date, leg.market, leg.action, leg.code, leg.trade_time, leg.source_order,
                    leg.trade_type, format_decimal(leg.qty), format_decimal(leg.avg_price), format_decimal(leg.gross_amount),
                    format_decimal(leg.tax), format_decimal(leg.fee),
                ),
            )

        for match in matches:
            conn.execute(
                """
                INSERT INTO realized_matches(
                    realized_date,market,code,trade_type,direction,qty,buy_price,sell_price,
                    buy_amount,sell_amount,tax,fee,buy_fee,sell_fee,profit,buy_ref,sell_ref,hold_period,sort_order
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    match["realized_date"], match["market"], match["code"], match["trade_type"], match["direction"],
                    format_decimal(match["qty"]), format_decimal(match["buy_price"]), format_decimal(match["sell_price"]),
                    format_decimal(match["buy_amount"]), format_decimal(match["sell_amount"]), format_decimal(match["tax"]),
                    format_decimal(match["fee"]), format_decimal(match["buy_fee"]), format_decimal(match["sell_fee"]),
                    format_decimal(match["profit"]), match["buy_ref"], match["sell_ref"],
                    match["hold_period"], int(match["sort_order"]),
                ),
            )

        for (market, code), position in positions.items():
            conn.execute(
                "INSERT INTO positions(market,code,qty,cost_amount,avg_cost) VALUES(?,?,?,?,?)",
                (market, code, format_decimal(position["qty"]), format_decimal(position["cost"]), format_decimal(position["avg"])),
            )


    def write_meta(self, normalized, *, caller):
        if LEDGER_REVISION in normalized:
            raise ValueError("the ledger revision is advanced by the repository only")
        with self.connection(caller=caller) as conn:
            conn.executemany(
                "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                list(normalized.items()),
            )
            self.bump_revision(conn)
