from __future__ import annotations

import json
import logging
import sqlite3
import threading
import uuid
from collections import Counter
from contextlib import contextmanager

from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Iterable

logger = logging.getLogger(__name__)


from service.account.account_repository import AccountRepository
from service.account.accounting_core import AccountingCore


from service.platform.change_feed import ChangeFeed
from service.account.account_types import ActualAccountError, Order, Leg, TradeInfoError
from service.account.local_trade_input import LocalTradeInput
from service.account import capital
from service.account.account_read_service import AccountReadService
from service.account.account_analytics_service import AccountAnalyticsService


# Meta key: why the derived ledger recompute after a schema change failed ("" = nothing pending).
DERIVED_REBUILD_PENDING = "derived_rebuild_pending"
# The shape of the derived tables (orders, order_legs, realized_matches, positions) a rebuild writes.
# A ledger built by another version is rebuilt once at start -- the only upgrade path; readers never patch around an
# older shape.
DERIVED_VERSION = "3"
DERIVED_VERSION_KEY = "derived_version"
# The traded-codes file Market Runtime reads (native/market_runtime/src/storage.rs TRADED_CODES_SCHEMA).
TRADED_CODES_SCHEMA = "traded-codes-v1"

class AccountLedgerService(AccountReadService, AccountAnalyticsService):
    """Command/import/rebuild orchestrator for the single account ledger.

    Google Sheet 的「交易明細表單」只保留原始交易：
    時間戳記 / 交易日期 / 市場 / 交易類型 / 股號 / 交易資訊 / 交易時間 / trade_id。

    本服務把原始交易同步到 SQLite，再由 Python 統一重建 Fill、當沖/一般拆分、
    FIFO、庫存與已實現損益。讀取及 analytics 由無自有 state 的協作 service
    提供，仍共享此處唯一的 repository、lock、meta 與 dashboard cache。
    """

    def __init__(
        self,
        db_path: str | Path,
        config_path: str | Path,
        security_master_path: str | Path | None = None,
        accounting_core: AccountingCore | None = None,
        enable_remote_integrations: bool = False,
        traded_codes_path: str | Path | None = None,
    ) -> None:
        self.db_path = Path(db_path)
        # Where this ledger publishes the codes it has traded (publish_traded_codes); None = not published.
        self.traded_codes_path = Path(traded_codes_path) if traded_codes_path is not None else None
        self.config_path = Path(config_path)
        # Where the ledger lives and where stock names come from are given by the composition root (api/components.py),
        # never looked up in the market storage layout from here. No security master: names are blank.
        self.security_master_path = Path(security_master_path) if security_master_path is not None else None
        # Screens showing live holdings are told when the positions change; see service/platform/change_feed.py.
        self.positions_feed = ChangeFeed()
        self.accounting_core = accounting_core or AccountingCore()
        self.remote_integrations_enabled = bool(enable_remote_integrations)
        self._security_master_refresh_attempted = False
        self._lock = threading.RLock()

        # dashboard 計算包含 FIFO/個股/每日/當沖分析，資料未變時
        # 不需要每次切回實際帳務都完整重算。
        self._dashboard_cache_signature: tuple[Any, ...] | None = None
        self._dashboard_cache_value: dict[str, Any] | None = None

        # Status/bridge/mobile scheduler state is hydrated
        # once at startup and then maintained in memory. High-frequency status
        # polling must never open SQLite merely to read metadata.
        self._meta_cache: dict[str, str] = {}
        self._status_counts: dict[str, int] = {
            "raw_trades": 0, "fills": 0, "realized_matches": 0, "positions": 0, "errors": 0,
        }
        self._config_runtime_status: dict[str, Any] = {}
        self._runtime_operation_counts: Counter[str] = Counter()
        self._shutdown_event = threading.Event()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.repository = AccountRepository(self.db_path, error_factory=ActualAccountError)
        self._init_db()
        self._update_config_runtime_status({})
        self.local_input = LocalTradeInput(self)
        self.publish_traded_codes()
        if self._get_meta(DERIVED_REBUILD_PENDING) or self._get_meta(DERIVED_VERSION_KEY) != DERIVED_VERSION:
            # The derived tables are recomputed from the raw trades when their version changed. A recompute that failed is a persisted, visible state: the derived tables still hold the
            # old shape, so status says DEGRADED, and the recompute is tried again at every start until one succeeds
            # (a manual 重新計算 clears it too), never just a log line.
            try:
                with self._lock:
                    raw_count = int(self._status_counts.get("raw_trades", 0))
                if raw_count > 0:
                    self.rebuild()
                else:
                    self._set_meta(DERIVED_REBUILD_PENDING, "")
                    self._set_meta(DERIVED_VERSION_KEY, DERIVED_VERSION)
            except Exception as exc:
                self._set_meta(DERIVED_REBUILD_PENDING, f"{type(exc).__name__}: {exc}"[:500])
                logging.getLogger(__name__).warning("account ledger: recompute after the schema change failed: %s", exc)

    # ------------------------------------------------------------------
    # config / remote GAS
    # ------------------------------------------------------------------


    def _update_config_runtime_status(self, config: dict[str, Any]) -> None:
        snapshot = {
            "configured": bool(str(config.get("gas_url") or "").strip()),
            "gas_url": str(config.get("gas_url") or ""),
            "has_token": bool(config.get("gas_token")),
            "auto_sync_on_page_open": bool(config.get("auto_sync_on_page_open")),
        }
        with self._lock:
            self._config_runtime_status = snapshot

    def _get_config_runtime_status(self) -> dict[str, Any]:
        with self._lock:
            return dict(self._config_runtime_status)

    def _count_runtime_operation(self, name: str) -> None:
        with self._lock:
            self._runtime_operation_counts[str(name or "unknown")] += 1

    def sqlite_runtime_diagnostics(self) -> dict[str, Any]:
        """Return in-memory SQLite caller counters without touching either DB."""
        with self._lock:
            operations = dict(self._runtime_operation_counts)
        return {**self.repository.diagnostics(), "operations": operations}

    def reset_sqlite_runtime_diagnostics(self) -> None:
        """Reset only diagnostic counters; persistent account state is untouched."""
        with self._lock:
            self._runtime_operation_counts.clear()
        self.repository.reset_diagnostics()


    # ------------------------------------------------------------------
    # GAS <-> Windows communication bridge
    # ------------------------------------------------------------------
    @staticmethod
    def _parse_bridge_revision(value: Any) -> int | None:
        try:
            if value is None or str(value).strip() == "":
                return None
            return int(value)
        except Exception:  # not an error: value coercion: a non-numeric value is None (missing) by contract
            return None

    def _get_bridge_instance_id(self) -> str:
        value = self._get_meta("bridge_instance_id").strip()
        if value:
            return value
        value = str(uuid.uuid4())
        self._set_meta("bridge_instance_id", value)
        return value


    def get_local_bridge_status(self) -> dict[str, Any]:
        self._count_runtime_operation("bridge_status")
        remote_revision = self._parse_bridge_revision(self._get_meta("bridge_last_remote_revision"))
        synced_revision = self._parse_bridge_revision(self._get_meta("bridge_last_synced_revision"))
        pending: bool | None
        if remote_revision is None or synced_revision is None:
            pending = None
        else:
            pending = remote_revision != synced_revision
        return {
            "enabled": bool(self._get_config_runtime_status().get("configured")),
            "instance_id": self._get_bridge_instance_id(),
            "timezone": "Asia/Taipei",
            "remote_revision": remote_revision,
            "synced_revision": synced_revision,
            "pending": pending,
            "last_check_at": self._get_meta("bridge_last_check_at"),
            "last_check_status": self._get_meta("bridge_last_check_status"),
            "last_check_message": self._get_meta("bridge_last_check_message"),
            "last_check_source": self._get_meta("bridge_last_check_source"),
            "last_ack_at": self._get_meta("bridge_last_ack_at"),
            "last_auto_sync_at": self._get_meta("bridge_last_auto_sync_at"),
            "last_auto_sync_error": self._get_meta("bridge_last_auto_sync_error"),
        }


    def local_save_trade(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self.local_input.local_save_trade(payload)

    # ------------------------------------------------------------------
    # 資金: principal, settlement and the daily limit (service/account/capital.py)
    # ------------------------------------------------------------------
    # The paper ledger refuses trades that break the Taiwan lot rules or its daily limit; the actual ledger records
    # trades that already happened and only reports them. capital_scope: the markets the ledger trades and the 資金
    # settings it keeps (the actual ledger has no 起始本金).
    enforces_trading_rules = False
    capital_scope = capital.ACTUAL_SCOPE
    # 模擬下單's working orders as capital trades (set by service/account/paper_orders.py on the paper ledger).
    working_reservations: Any = None

    def get_capital_settings(self) -> dict[str, Any]:
        return {"ok": True, "markets": capital.read_settings(self._get_meta, self.capital_scope),
                "scope": self.capital_scope.describe(), "enforced": self.enforces_trading_rules}

    def save_capital_settings(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._set_meta_many(capital.settings_to_meta(payload, self.capital_scope), caller="account.capital.settings")
        self._apply_fee_rate()
        return self.get_capital_settings()

    def _apply_fee_rate(self) -> None:
        """A ledger that keeps its own 手續費折扣 (the paper ledger) charges it; a changed rate recomputes every fee."""
        if "fee_discount" not in self.capital_scope.fields:
            return
        rate = capital.fee_rate(capital.read_settings(self._get_meta, self.capital_scope))
        if rate == self.accounting_core.tw_fee_rate:
            return
        self.accounting_core.tw_fee_rate = rate
        with self._lock:
            has_trades = int(self._status_counts.get("raw_trades", 0)) > 0
        if has_trades:
            self.rebuild()

    @property
    def write_lock(self) -> threading.RLock:
        """Held by every ledger write (rebuild). A caller that checks the ledger and then acts on what it read (the
        模擬下單 desk placing an order against the ledger's money) holds it across both, taken BEFORE its own lock --
        the ledger's write checks call back into the desk (working_reservations), so the order is always ledger, then
        desk."""
        return self._lock

    def _capital_trades_from(self, conn) -> list[Any]:
        orders, _errors = self._build_orders(conn.execute("SELECT * FROM raw_trades").fetchall())
        return capital.trades_from_orders(orders)

    def capital_trades(self) -> list[Any]:
        """Every trade of the ledger as the capital rules read it (one per raw trade, its total quantity and 價金)."""
        with self.repository.snapshot(caller="account.capital.trades") as conn:
            return self._capital_trades_from(conn)

    def get_capital(self, now: Any = None) -> dict[str, Any]:
        """The 資金 view now (`now`: the caller's clock, e.g. the 模擬下單 desk's): the legs and the trades from one
        snapshot of the ledger."""
        with self.repository.snapshot(caller="account.capital") as conn:
            legs = conn.execute("SELECT trade_id,trade_date,trade_time,source_order,market,code,action,qty,gross_amount,fee,tax "
                                "FROM order_legs ORDER BY trade_date,trade_time,source_order,id").fetchall()
            trades = self._capital_trades_from(conn)
        return capital.capital_view(legs, trades, capital.read_settings(self._get_meta, self.capital_scope),
                                    self.capital_scope, now=now)

    def ledger_revision(self) -> int:
        """The ledger's logical version (account_repository.LEDGER_REVISION)."""
        return self.repository.revision()

    def local_delete_trade(self, trade_id: str) -> dict[str, Any]:
        return self.local_input.local_delete_trade(trade_id)


    # ------------------------------------------------------------------
    # delayed mobile / Scriptable publish
    # ------------------------------------------------------------------


    # ------------------------------------------------------------------
    # database
    # ------------------------------------------------------------------
    def _connect(self, caller: str = "unspecified") -> sqlite3.Connection:
        return self.repository.connect(caller)

    @contextmanager
    def _connection(self, *, caller: str = "unspecified"):
        with self.repository.connection(caller=caller) as conn:
            yield conn

    def begin_shutdown(self) -> None:
        """Stop new GAS activity and new ordinary SQLite owners before draining."""
        self._shutdown_event.set()
        self.repository.begin_shutdown()

    def _wait_db_idle(self, timeout: float = 15.0) -> bool:
        return self.repository.wait_idle(timeout)

    def shutdown(self) -> dict[str, Any]:
        self.begin_shutdown()
        return self.repository.shutdown()

    def _init_db(self) -> None:
        meta, counts = self.repository.initialize()
        with self._lock:
            self._meta_cache = meta
            self._status_counts = counts

    def _set_meta_many(self, values: dict[str, Any], *, caller: str = "meta.write") -> None:
        normalized = {str(key): str(value) for key, value in values.items()}
        if not normalized:
            return
        self.repository.write_meta(normalized, caller=caller)
        with self._lock:
            self._meta_cache.update(normalized)

    def _set_meta(self, key: str, value: str) -> None:
        self._set_meta_many({key: value}, caller=f"meta.set:{key}")

    def _get_meta(self, key: str, default: str = "") -> str:
        with self._lock:
            return str(self._meta_cache.get(str(key), default))

    # ------------------------------------------------------------------
    # raw normalization / parser
    # ------------------------------------------------------------------
    @staticmethod
    def normalize_market(value: Any) -> str:
        text = str(value or "").strip()
        aliases = {"TW": "台股", "tw": "台股", "台灣": "台股", "US": "美股", "us": "美股"}
        return aliases.get(text, text)

    @staticmethod
    def normalize_action(value: Any) -> str:
        text = str(value or "").strip()
        if "買" in text:
            return "買進"
        if "賣" in text:
            return "賣出"
        return text

    @staticmethod
    def normalize_date(value: Any) -> str:
        if isinstance(value, datetime):
            return value.strftime("%Y-%m-%d")
        if isinstance(value, date):
            return value.strftime("%Y-%m-%d")
        text = str(value or "").strip().replace("/", "-")
        if not text:
            return ""
        for fmt in ("%Y-%m-%d", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
            try:
                return datetime.strptime(text[:19], fmt).strftime("%Y-%m-%d")
            except Exception:  # not an error: not that date format; the next format is tried and the raw text is the last resort
                pass
        return text[:10]

    @staticmethod
    def normalize_time(value: Any) -> str:
        if isinstance(value, datetime):
            return value.strftime("%H:%M:%S")
        text = str(value or "").strip()
        if not text:
            return ""
        # Sheets display value may be 09:31 / 09:31:12 or a date-time string.
        if " " in text and ":" in text:
            text = text.split()[-1]
        parts = text.replace("：", ":").split(":")
        if len(parts) >= 2:
            try:
                hh = int(parts[0])
                mm = int(parts[1])
                ss = int(float(parts[2])) if len(parts) >= 3 else 0
                return f"{hh:02d}:{mm:02d}:{ss:02d}"
            except Exception:  # not an error: a time text that is not H:M[:S] is kept as entered
                return text
        return text

    parse_trade_info = staticmethod(AccountingCore.parse_trade_info)

    def _normalize_remote_item(self, item: dict[str, Any], index: int) -> dict[str, Any]:
        # GAS uses snake_case; aliases keep this tolerant to Chinese headers.
        trade_id = str(item.get("trade_id") or item.get("tradeId") or "").strip()
        trade_date = self.normalize_date(item.get("trade_date") or item.get("交易日期") or item.get("date"))
        market = self.normalize_market(item.get("market") or item.get("市場"))
        action = self.normalize_action(item.get("action") or item.get("交易類型") or item.get("type"))
        code = str(item.get("code") or item.get("股號") or "").strip()
        trade_info = str(item.get("trade_info") or item.get("交易資訊") or "").strip()
        trade_time = self.normalize_time(item.get("trade_time") or item.get("交易時間") or "")
        source_order_text = item.get("source_order") or item.get("row") or index + 2
        try:
            source_order = int(source_order_text)
        except (TypeError, ValueError):
            raise ActualAccountError(f"第 {index + 2} 列的 source_order 不是整數：{source_order_text!r}",
                                     classification="INVALID_INPUT", status_code=422) from None

        if not trade_id:
            raise ActualAccountError(f"第 {index + 2} 列缺少 trade_id")
        if not trade_date or not market or not action or not code or not trade_info:
            raise ActualAccountError(f"{trade_id} 缺少必要交易欄位")
        if market not in {"台股", "美股"}:
            raise ActualAccountError(f"{trade_id} 不支援的市場：{market}")
        if action not in {"買進", "賣出"}:
            raise ActualAccountError(f"{trade_id} 不支援的交易類型：{action}")

        return {
            "trade_id": trade_id,
            "trade_date": trade_date,
            "market": market,
            "action": action,
            "code": code,
            "trade_info": trade_info,
            "trade_time": trade_time,
            "source_order": source_order,
            "raw_json": json.dumps(item, ensure_ascii=False, default=str),
        }

    def replace_raw_trades(self, items: Iterable[dict[str, Any]]) -> dict[str, Any]:
        normalized: list[dict[str, Any]] = []
        rejected: list[str] = []
        seen: set[str] = set()
        for index, item in enumerate(items):
            if not isinstance(item, dict):
                rejected.append(f"第 {index + 2} 列不是物件")
                continue
            try:
                row = self._normalize_remote_item(item, index)
                if row["trade_id"] in seen:
                    raise ActualAccountError(f"重複 trade_id：{row['trade_id']}")
                seen.add(row["trade_id"])
                # parser validation now, before replacing known-good local data.
                self.parse_trade_info(row["trade_info"], row["market"])
                normalized.append(row)
            except (ActualAccountError, TradeInfoError) as exc:
                rejected.append(exc)                    # the Sheet's data: raised together below, nothing replaced
            except Exception:
                logger.exception("normalizing Google Sheet row %d failed unexpectedly (trade_id=%r)",
                                 index + 2, item.get("trade_id") or item.get("tradeId"))
                raise

        if rejected:
            raise ActualAccountError("Google Sheet 原始交易有錯誤：\n" + "\n".join(str(error) for error in rejected[:20]))

        def write_raw(conn: sqlite3.Connection) -> None:
            conn.execute("DELETE FROM raw_trades")
            conn.executemany(
                """
                INSERT INTO raw_trades(
                    trade_id,trade_date,market,action,code,trade_info,trade_time,source_order,raw_json
                ) VALUES(?,?,?,?,?,?,?,?,?)
                """,
                [
                    (
                        row["trade_id"], row["trade_date"], row["market"], row["action"], row["code"],
                        row["trade_info"], row["trade_time"], row["source_order"], row["raw_json"],
                    )
                    for row in normalized
                ],
            )
        # One transaction for the raw rows and everything derived from them: committing the raw rows first left
        # positions / realized_matches from the previous raw set whenever the rebuild then failed or the process
        # died in between, and nothing repaired it.
        rebuild = self.rebuild(raw_writer=write_raw)
        return {"imported": len(normalized), "rejected": 0, **rebuild}

    # ------------------------------------------------------------------
    # fee/tax and rebuild engine
    # ------------------------------------------------------------------
    # _build_orders/_split_orders_to_legs/_match_normal_trades/parse_trade_info
    # stay as instance methods (not inlined into rebuild()) because
    # AccountReadService/AccountAnalyticsService call them as self.X(...) via
    # the multiple-inheritance MRO — they are the shared surface those mixins
    # depend on, not rebuild()-only wrappers.
    def _build_orders(self, rows: list[sqlite3.Row]) -> tuple[list[Order], list[tuple[str, str]]]:
        return self.accounting_core._build_orders(rows)

    def _split_orders_to_legs(self, orders: list[Order]) -> list[Leg]:
        return self.accounting_core._split_orders_to_legs(orders)

    def _match_normal_trades(self, legs: list[Leg]) -> tuple[list[dict[str, Any]], dict[tuple[str, str], dict[str, Decimal]], list[str]]:
        return self.accounting_core._match_normal_trades(legs)

    def rebuild(self, *, raw_writer: Callable[[sqlite3.Connection], None] | None = None) -> dict[str, Any]:
        """Rebuild the derived ledger; `raw_writer` changes raw_trades inside the same transaction first."""
        with self._lock, self._connection(caller="account.rebuild") as conn:
            # Bumped before the first write as well as after: a dashboard read overlapping this rebuild must see
            # a new generation even if it checks between the commit and the bump below.
            self._dashboard_generation = getattr(self, "_dashboard_generation", 0) + 1
            if raw_writer is not None:
                raw_writer(conn)
            self.repository.bump_revision(conn)
            previous_positions = {
                (str(row["market"]), str(row["code"])): (
                    self._decimal(row["qty"]),
                    self._decimal(row["cost_amount"]),
                    self._decimal(row["avg_cost"]),
                )
                for row in conn.execute(
                    "SELECT market,code,qty,cost_amount,avg_cost FROM positions"
                ).fetchall()
            }
            raw_rows = conn.execute(
                "SELECT * FROM raw_trades ORDER BY trade_date, trade_time, source_order"
            ).fetchall()
            orders, parse_errors = self._build_orders(raw_rows)
            legs = self._split_orders_to_legs(orders)
            day_matches, day_errors = self.accounting_core._match_day_trades(legs)
            normal_matches, positions, normal_errors = self._match_normal_trades(legs)
            all_matches = sorted(day_matches + normal_matches, key=lambda x: (x["realized_date"], x["sort_order"]))

            self.repository.replace_derived(
                conn, orders=orders, legs=legs, matches=all_matches,
                positions=positions, format_decimal=self.accounting_core._fmt,
            )

            current_positions = {
                (str(market), str(code)): (
                    self._decimal(position["qty"]),
                    self._decimal(position["cost"]),
                    self._decimal(position["avg"]),
                )
                for (market, code), position in positions.items()
            }
            positions_changed = previous_positions != current_positions
            revision_row = conn.execute(
                "SELECT value FROM meta WHERE key='positions_revision'"
            ).fetchone()
            positions_revision = int(revision_row[0] or 0) if revision_row else 0
            if positions_changed:
                positions_revision += 1
                conn.execute(
                    "INSERT INTO meta(key,value) VALUES('positions_revision',?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (str(positions_revision),),
                )

            errors = parse_errors + [("", msg) for msg in day_errors + normal_errors]
            conn.executemany("INSERT INTO rebuild_errors(trade_id,message) VALUES(?,?)", errors)
            last_rebuild_at = datetime.now().isoformat(timespec="seconds")
            conn.execute(
                "INSERT INTO meta(key,value) VALUES('last_rebuild_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (last_rebuild_at,),
            )
            conn.execute(
                "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (DERIVED_VERSION_KEY, DERIVED_VERSION),
            )
            counts = self.repository._read_status_counts_from_conn(conn)

        with self._lock:
            self._meta_cache["last_rebuild_at"] = last_rebuild_at
            self._meta_cache[DERIVED_VERSION_KEY] = DERIVED_VERSION
            self._meta_cache["positions_revision"] = str(positions_revision)
            self._status_counts = counts

        # SQLite 使用 WAL 時，主 .db 檔案的 mtime 不一定會在每次交易修改後立刻變動。
        # 主動清掉 dashboard cache，確保本機模擬錢包新增/修改/刪除後立即看到新資料；
        # 實際帳務重新計算後也同樣不會短暫顯示舊快取。
        with self._lock:
            self._dashboard_cache_signature = None
            self._dashboard_cache_value = None
            # A dashboard read that began before this write must not publish its result (get_dashboard).
            self._dashboard_generation = getattr(self, "_dashboard_generation", 0) + 1

        if positions_changed:
            self.positions_feed.publish({"revision": positions_revision, "count": len(positions), "updated_at": last_rebuild_at})
        if self._get_meta(DERIVED_REBUILD_PENDING):
            self._set_meta(DERIVED_REBUILD_PENDING, "")
        self.publish_traded_codes()

        return {
            "orders": len(orders),
            "fills": sum(len(order.fills) for order in orders),
            "legs": len(legs),
            "realized_matches": len(all_matches),
            "positions": len(positions),
            "positions_changed": positions_changed,
            "positions_revision": positions_revision,
            "errors": len(parse_errors) + len(day_errors) + len(normal_errors),
        }

    def publish_traded_codes(self) -> None:
        """The codes this ledger has a trade of, for Market Runtime's raw-history prune: their partitions are kept
        forever, whatever the retention (user 10-22; native/market_runtime/src/storage.rs). Written at start and after
        every rebuild -- every raw trade change is one -- as the store's partition names: 台股 -> shioaji STK,
        美股 -> futu US (``US.<code>``). Market Runtime removes nothing while a ledger's file is missing or unreadable,
        so a failure to write it is raised, never passed over."""
        if self.traded_codes_path is None:
            return
        from service.platform.atomic_files import write_json_atomic

        with self.repository.snapshot(caller="account.traded_codes") as conn:
            rows = conn.execute("SELECT DISTINCT market, code FROM raw_trades").fetchall()
        codes: dict[str, dict[str, set[str]]] = {"shioaji": {"STK": set()}, "futu": {"US": set()}}
        for row in rows:
            code = str(row["code"] or "").strip().upper()
            if not code:
                continue
            if row["market"] == "台股":
                codes["shioaji"]["STK"].add(code)
            elif row["market"] == "美股":
                codes["futu"]["US"].add(code if code.startswith("US.") else f"US.{code}")
        write_json_atomic(self.traded_codes_path, {
            "schema": TRADED_CODES_SCHEMA, "ledger": self.db_path.stem,
            "codes": {source: {market: sorted(found) for market, found in markets.items()} for source, markets in codes.items()},
        }, durable=True, indent=1)

    # ------------------------------------------------------------------
    # query DTOs for Electron
    # ------------------------------------------------------------------
    _decimal = staticmethod(AccountingCore._decimal)

    _number = staticmethod(AccountingCore._number)

