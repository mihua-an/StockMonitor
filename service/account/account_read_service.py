from __future__ import annotations

import json
import math
from typing import Any, Iterable

from service.account.accounting_core import ZERO
from service.account.account_types import ledger_decimal
from service.account.trade_metrics import entry_band, entry_minute, invested_amount, return_rate
import logging
from service.platform.failure_record import record_failure


_failure_log = logging.getLogger(__name__)


class AccountReadService:
    """Read-only ledger queries over the owning AccountLedgerService state.

    This mixin owns no repository, cache, lock or mutable ledger state.  The
    command service remains the single state authority and exposes these reads
    through its existing public API.
    """
    def _stock_names(self) -> dict[str, str]:
        def read_names() -> dict[str, str]:
            names: dict[str, str] = {}
            if self.security_master_path is None or not self.security_master_path.exists():
                return names
            try:
                import csv
                import io

                from service.platform.atomic_files import read_text_shared

                # Opened with delete sharing: the provider replaces the master while this reads it.
                text = read_text_shared(self.security_master_path, "utf-8-sig")
                for row in csv.DictReader(io.StringIO(text, newline="")):
                    code = str(row.get("code") or "").strip().upper()
                    name = str(row.get("name") or "").strip()
                    if code and name:
                        names[code] = name
            except Exception as exc:
                record_failure(_failure_log, "reading stock names for the account view", exc)
            return names

        names = read_names()

        # 商品名稱只讀取 Shioaji contracts 產生的本機 security master。
        return names

    def _sync_times(self) -> dict[str, Any]:
        """The last attempt and the last fully successful sync are stored separately; the screen shows the
        last success, which only a complete sync writes."""
        return {
            "last_sync_success_at": self._get_meta("last_sync_success_at"),
            "last_sync_attempt_at": self._get_meta("last_sync_attempt_at"),
            "last_sync_attempt_status": self._get_meta("last_sync_attempt_status"),
            "last_sync_attempt_error": self._get_meta("last_sync_attempt_error"),
        }

    def get_status(self) -> dict[str, Any]:
        """Return actual-account status from memory only; no SQLite or dashboard query."""
        self._count_runtime_operation("status")
        config = self._get_config_runtime_status()
        with self._lock:
            counts = dict(self._status_counts)
        return {
            "ok": True,
            "configured": bool(config.get("configured")),
            "gas_url": config.get("gas_url") or "",
            "has_token": bool(config.get("has_token")),
            "auto_sync_on_page_open": bool(config.get("auto_sync_on_page_open")),
            **self._sync_times(),
            "last_rebuild_at": self._get_meta("last_rebuild_at"),
            # The derived ledger awaits a recompute that failed after a schema change.
            "derived_state": "DEGRADED" if self._get_meta("derived_rebuild_pending") else "OK",
            "derived_error": self._get_meta("derived_rebuild_pending") or None,
            "positions_revision": int(self._get_meta("positions_revision", "0") or 0),
            "bridge": self.get_local_bridge_status(),
            "counts": counts,
        }

    def get_errors(self) -> list[dict[str, Any]]:
        """Each rebuild error with the market of the trade it names ("" when it names none or a trade that is gone),
        so a reader files it under a market without the trade list."""
        with self._connection(caller="account.read.errors") as conn:
            rows = conn.execute(
                "SELECT e.trade_id, e.message, COALESCE(t.market, '') AS market FROM rebuild_errors e "
                "LEFT JOIN raw_trades t ON t.trade_id = e.trade_id AND e.trade_id <> '' ORDER BY e.id").fetchall()
        return [dict(row) for row in rows]

    def get_raw_trades(self, limit: int | None = 300, *, trade_ids: Iterable[str] | None = None, start: str | None = None,
                       end: str | None = None, code: str | None = None, after: str | None = None,
                       market: str | None = None) -> list[dict[str, Any]]:
        """Raw transactions, newest first, with their fee / tax / 當沖 from the one versioned materialization.

        A caller that needs particular trades says which -- `trade_ids`, the dates `start`..`end` (inclusive),
        dates after `after`, a `code`, a `market` -- and gets every one of them, selected in SQL; `limit` (at most 5000; None =
        no limit, only with a filter) bounds the newest-first listing. Taking the newest N and filtering afterwards
        silently lost whatever was older.

        Fees come from order_legs, which the rebuild writes from the raw trades under DERIVED_VERSION: this
        read never re-parses, re-validates and re-splits the whole ledger on every dashboard. Only the
        rows returned are parsed, for their fills. While the materialization is not CURRENT, fee / tax are null
        (unavailable), never computed by a second path.
        """
        names = self._stock_names()
        where: list[str] = []
        params: list[Any] = []
        if trade_ids is not None:
            ids = [str(trade_id) for trade_id in trade_ids]
            if not ids:
                return []
            where.append("trade_id IN (%s)" % ",".join("?" * len(ids)))
            params.extend(ids)
        for clause, value in (("trade_date >= ?", start), ("trade_date <= ?", end), ("trade_date > ?", after), ("code = ?", code),
                              ("market = ?", market)):
            if value is not None:
                where.append(clause)
                params.append(str(value))
        if limit is None and not where:
            raise ValueError("an unbounded read of the raw trades needs a filter")
        current = self.ledger_state()["state"] == "CURRENT"
        sql = "SELECT * FROM raw_trades" + (" WHERE " + " AND ".join(where) if where else "") + \
              " ORDER BY trade_date DESC,trade_time DESC,source_order DESC"
        if limit is not None:
            sql += " LIMIT ?"
            params.append(max(1, min(int(limit), 5000)))
        with self._connection(caller="account.read.raw_trades") as conn:
            rows = conn.execute(sql, params).fetchall()
            leg_rows = []
            if current:
                # In batches: a whole market's trades are more ids than one statement may bind.
                ids = [str(row["trade_id"]) for row in rows]
                for offset in range(0, len(ids), 500):
                    batch = ids[offset:offset + 500]
                    leg_rows.extend(conn.execute(
                        "SELECT trade_id,trade_type,tax,fee FROM order_legs WHERE trade_id IN (%s)" % ",".join("?" * len(batch)),
                        batch).fetchall())
        leg_costs: dict[str, dict[str, Any]] = {}
        for leg in leg_rows:
            bucket = leg_costs.setdefault(str(leg["trade_id"]), {"fee": ZERO, "tax": ZERO, "trade_types": set()})
            bucket["fee"] += self._decimal(leg["fee"])
            bucket["tax"] += self._decimal(leg["tax"])
            bucket["trade_types"].add(str(leg["trade_type"] or ""))

        result = []
        for row in rows:
            trade_id = str(row["trade_id"])
            try:
                fills = self.parse_trade_info(row["trade_info"], str(row["market"]))
            except Exception as exc:
                record_failure(_failure_log, "parsing a trade's fills", exc)
                fills = []
            qty = sum((self._decimal(fill.qty) for fill in fills), ZERO)
            gross = sum((self._decimal(fill.amount) for fill in fills), ZERO)
            display_avg = (
                sum((self._decimal(fill.qty) * self._decimal(fill.price) for fill in fills), ZERO) / qty
                if qty else ZERO
            )
            costs = leg_costs.get(trade_id)
            result.append({
                "trade_id": trade_id,
                "date": row["trade_date"],
                "market": row["market"],
                "action": row["action"],
                "code": row["code"],
                "name": row["code"] if row["market"] == "美股" else names.get(str(row["code"]), ""),
                "trade_info": row["trade_info"],
                "time": row["trade_time"],
                "qty": self._number(qty),
                "avg_price": self._number(display_avg) if qty else 0,
                "gross_amount": self._number(gross),
                "fee": self._number(costs["fee"]) if costs else (0 if current else None),
                "tax": self._number(costs["tax"]) if costs else (0 if current else None),
                "is_daytrade": "當沖" in costs["trade_types"] if costs else False,
                # Who entered it: "paper_match" = a 模擬下單 fill (with its order), else typed in / synced.
                **self._trade_origin(row),
                "fills": [
                    {"qty": self._number(fill.qty), "price": self._number(fill.price), "amount": self._number(fill.amount)}
                    for fill in fills
                ],
            })
        return result

    @staticmethod
    def _trade_origin(row) -> dict[str, Any]:
        try:
            raw = json.loads(row["raw_json"] or "{}")
        except (TypeError, ValueError) as exc:
            record_failure(_failure_log, "reading a raw trade's raw_json", exc)
            raw = {}
        return {"source": str(raw.get("source") or ""), "order_id": str(raw.get("order_id") or ""),
                "fill_reason": str(raw.get("reason") or "")}

    def get_positions(self) -> list[dict[str, Any]]:
        names = self._stock_names()
        with self._connection(caller="account.read.positions") as conn:
            rows = conn.execute("SELECT * FROM positions ORDER BY market,code").fetchall()
        return [
            {
                "market": row["market"],
                "code": row["code"],
                "name": row["code"] if row["market"] == "美股" else names.get(str(row["code"]), ""),
                "qty": self._number(row["qty"]),
                "cost_amount": self._number(row["cost_amount"]),
                "avg_cost": self._number(row["avg_cost"]),
                # What closing it costs: 未實現 is net of the sell (or buy-back) fee and tax (live_position_marks.js).
                "closing_terms": self.accounting_core.closing_terms(str(row["market"]), str(row["code"])),
            }
            for row in rows
        ]

    def get_positions_revision(self) -> int:
        """Return the in-memory revision without opening SQLite."""
        return int(self._get_meta("positions_revision", "0") or 0)

    def get_realized(self, limit: int | None = 500, *, market: str | None = None,
                     realized_date: str | None = None) -> list[dict[str, Any]]:
        """Realized pairs, newest first; `market` / `realized_date` select in SQL, and with a filter `limit` may be None
        (every pair it selects). `limit` is at most 5000."""
        names = self._stock_names()
        where: list[str] = []
        params: list[Any] = []
        for clause, value in (("market = ?", market), ("realized_date = ?", realized_date)):
            if value is not None:
                where.append(clause)
                params.append(str(value))
        if limit is None and not where:
            raise ValueError("an unbounded read of the realized pairs needs a filter")
        sql = ("SELECT * FROM realized_matches" + (" WHERE " + " AND ".join(where) if where else "")
               + " ORDER BY realized_date DESC, sort_order DESC, id DESC")
        if limit is not None:
            sql += " LIMIT ?"
            params.append(max(1, min(int(limit), 5000)))
        with self._connection(caller="account.read.realized") as conn:
            rows = conn.execute(sql, params).fetchall()
        return [self._pair_row(row, names) for row in rows]

    def _pair_row(self, row: Any, names: dict[str, str]) -> dict[str, Any]:
        """One realized pair as every answer carries it (每日明細, 配對明細, 當沖分析, 個股數據, 歷史回放's 當沖 list): the
        ledger's amounts, its 報酬率 (profit over what was put in, trade_metrics), its entry and exit, the entry minute
        and entry-time band of a 當沖 (trade_metrics), and the closing_terms its replay prices the pair at the replay price with (core/trade_costs.js)."""
        direction = str(row["direction"] or "")
        trade_type = str(row["trade_type"] or "")
        market = str(row["market"])
        code = str(row["code"])
        buy_ref = str(row["buy_ref"] or "")
        sell_ref = str(row["sell_ref"] or "")
        profit = ledger_decimal(row["profit"])
        invested = invested_amount(direction, ledger_decimal(row["buy_amount"]), ledger_decimal(row["sell_amount"]))
        roi = return_rate([(profit, invested)])
        entry_ref, exit_ref = (sell_ref, buy_ref) if direction == "空" else (buy_ref, sell_ref)
        minute = entry_minute(direction, buy_ref, sell_ref) if trade_type == "當沖" else None
        try:
            hold_period: int | None = int(float(str(row["hold_period"] or "0")))
        except ValueError:  # not an error: a hold period that is not a number is shown as unknown
            hold_period = None
        return {
            "id": int(row["id"]),
            "realized_date": str(row["realized_date"]),
            "market": market,
            "code": code,
            "name": code if market == "美股" else names.get(code, ""),
            "trade_type": trade_type,
            "direction": direction,
            **{key: self._number(row[key]) for key in ("qty", "buy_price", "sell_price", "buy_amount", "sell_amount", "tax", "fee",
                                                        "buy_fee", "sell_fee")},
            "profit": self._number(profit),
            "roi": None if roi is None else float(roi),
            "invested_amount": self._number(invested),
            "buy_ref": buy_ref,
            "sell_ref": sell_ref,
            "entry_ref": entry_ref,
            "exit_ref": exit_ref,
            "entry_minute": minute,
            "entry_band": entry_band(minute),
            "hold_period": hold_period,
            "sort_order": int(row["sort_order"] or 0),
            "closing_terms": self.accounting_core.closing_terms(market, code, trade_type),
        }

    @staticmethod
    def _daytrade_cursor_from_row(row: Any) -> str:
        if not row:
            return ""
        return f"{str(row['realized_date'])}|{int(row['sort_order'] or 0)}|{int(row['id'] or 0)}"

    @staticmethod
    def _parse_daytrade_cursor(cursor: str | None) -> tuple[str, int, int] | None:
        text = str(cursor or "").strip()
        if not text:
            return None
        try:
            realized_date, sort_order, row_id = text.split("|", 2)
            if not realized_date:
                return None
            return realized_date, int(sort_order), int(row_id)
        except (TypeError, ValueError):  # not an error: a row without a numeric order is not sortable; None by contract
            return None

    def _serialize_daytrade_rows(self, rows: Iterable[Any]) -> list[dict[str, Any]]:
        names = self._stock_names()
        return [self._pair_row(row, names) for row in rows]

    @staticmethod
    def _resolve_daytrade_scope(
        *, scope: str | None, realized_date: str | None, code: str | None
    ) -> tuple[str, str, str]:
        """Validate the daytrade history query scope (overview / today / symbol), shared by
        ``get_daytrade_history_page`` and ``explain_daytrade_history_query`` so the two cannot drift."""
        target_date = str(realized_date or "").strip()
        target_code = str(code or "").strip()
        requested_scope = str(scope or "").strip().lower()
        if requested_scope not in {"overview", "today", "symbol"}:
            raise ValueError(f"invalid daytrade history scope: {requested_scope or '<missing>'}")
        query_scope = requested_scope

        if query_scope == "today" and not target_date:
            raise ValueError("today daytrade history requires date")
        if query_scope == "symbol" and not target_code:
            raise ValueError("symbol daytrade history requires code")
        return query_scope, target_date, target_code

    @staticmethod
    def _daytrade_where_clause(
        *, query_scope: str, target_date: str, target_code: str, market: str
    ) -> tuple[str, list[Any]]:
        clauses = ["market=?", "trade_type='當沖'"]
        params: list[Any] = [market]
        if query_scope == "today":
            clauses.append("realized_date=?")
            params.append(target_date)
        elif query_scope == "symbol":
            clauses.append("code=?")
            params.append(target_code)
        return " AND ".join(clauses), params

    def get_daytrade_history_page(
        self,
        *,
        scope: str | None = None,
        realized_date: str | None = None,
        code: str | None = None,
        market: str = "台股",
        page: int = 1,
        page_size: int = 50,
        direction: str = "jump",
        cursor: str | None = None,
    ) -> dict[str, Any]:
        """Return one indexed page of paired day trades.

        The query scope is explicit:
        - ``overview``: all historical paired day trades (still paginated; never fetch-all).
        - ``today``: all paired day trades for one Replay date.
        - ``symbol``: all historical paired day trades for one selected symbol.

        Adjacent navigation uses keyset cursors. Arbitrary page input falls back to
        indexed OFFSET; first/last have dedicated fast paths.
        """
        query_scope, target_date, target_code = self._resolve_daytrade_scope(
            scope=scope, realized_date=realized_date, code=code
        )

        size = max(1, min(int(page_size or 50), 200))
        requested_page = max(1, int(page or 1))
        nav = str(direction or "jump").strip().lower()
        if nav not in {"first", "prev", "next", "last", "jump"}:
            nav = "jump"

        where_sql, params = self._daytrade_where_clause(
            query_scope=query_scope, target_date=target_date, target_code=target_code, market=market
        )

        with self._connection(caller="history.daytrade.page") as conn:
            total_count = int(conn.execute(
                f"SELECT COUNT(*) FROM realized_matches WHERE {where_sql}",
                tuple(params),
            ).fetchone()[0])
            total_pages = max(1, math.ceil(total_count / size))
            target_page = min(requested_page, total_pages)
            parsed_cursor = self._parse_daytrade_cursor(cursor)

            rows = []
            if total_count <= 0:
                rows = []
            elif nav == "first" or target_page == 1:
                target_page = 1
                rows = conn.execute(
                    f"SELECT * FROM realized_matches WHERE {where_sql} "
                    "ORDER BY realized_date DESC, sort_order DESC, id DESC LIMIT ?",
                    (*params, size),
                ).fetchall()
            elif nav == "last":
                target_page = total_pages
                last_size = total_count - ((total_pages - 1) * size)
                rows = conn.execute(
                    f"SELECT * FROM realized_matches WHERE {where_sql} "
                    "ORDER BY realized_date ASC, sort_order ASC, id ASC LIMIT ?",
                    (*params, max(1, last_size)),
                ).fetchall()
                rows = list(reversed(rows))
            elif nav == "next" and parsed_cursor:
                c_date, c_sort, c_id = parsed_cursor
                rows = conn.execute(
                    f"SELECT * FROM realized_matches WHERE {where_sql} "
                    "AND (realized_date, sort_order, id) < (?, ?, ?) "
                    "ORDER BY realized_date DESC, sort_order DESC, id DESC LIMIT ?",
                    (*params, c_date, c_sort, c_id, size),
                ).fetchall()
            elif nav == "prev" and parsed_cursor:
                c_date, c_sort, c_id = parsed_cursor
                rows = conn.execute(
                    f"SELECT * FROM realized_matches WHERE {where_sql} "
                    "AND (realized_date, sort_order, id) > (?, ?, ?) "
                    "ORDER BY realized_date ASC, sort_order ASC, id ASC LIMIT ?",
                    (*params, c_date, c_sort, c_id, size),
                ).fetchall()
                rows = list(reversed(rows))
            else:
                offset = (target_page - 1) * size
                rows = conn.execute(
                    f"SELECT * FROM realized_matches WHERE {where_sql} "
                    "ORDER BY realized_date DESC, sort_order DESC, id DESC LIMIT ? OFFSET ?",
                    (*params, size, offset),
                ).fetchall()

        serialized = self._serialize_daytrade_rows(rows)
        return {
            "scope": query_scope,
            "date": target_date if query_scope == "today" else "",
            "code": target_code if query_scope == "symbol" else "",
            "items": serialized,
            "page": target_page,
            "page_size": size,
            "total_count": total_count,
            "total_pages": total_pages,
            "has_prev": target_page > 1,
            "has_next": target_page < total_pages,
            "prev_cursor": self._daytrade_cursor_from_row(rows[0]) if rows else "",
            "next_cursor": self._daytrade_cursor_from_row(rows[-1]) if rows else "",
        }

    def get_daytrade_symbol_date_rows(
        self,
        realized_date: str,
        code: str,
        market: str = "台股",
    ) -> list[dict[str, Any]]:
        """Small bounded dataset used by Replay trade-entry markers.

        This deliberately queries only one date + one symbol and is separate
        from the paginated table so chart markers never require full history.
        """
        target_date = str(realized_date or "").strip()
        target_code = str(code or "").strip()
        if not target_date or not target_code:
            return []
        with self._connection(caller="history.daytrade.symbol_date") as conn:
            rows = conn.execute(
                """
                SELECT * FROM realized_matches
                WHERE market=? AND trade_type='當沖' AND code=? AND realized_date=?
                ORDER BY realized_date DESC, sort_order DESC, id DESC
                """,
                (market, target_code, target_date),
            ).fetchall()
        return self._serialize_daytrade_rows(rows)

    def explain_daytrade_history_query(
        self,
        *,
        scope: str | None = None,
        realized_date: str | None = None,
        code: str | None = None,
        market: str = "台股",
    ) -> list[str]:
        """Diagnostic helper used by pagination tests/benchmarks."""
        query_scope, target_date, target_code = self._resolve_daytrade_scope(
            scope=scope, realized_date=realized_date, code=code
        )
        where_sql, params = self._daytrade_where_clause(
            query_scope=query_scope, target_date=target_date, target_code=target_code, market=market
        )
        sql = f"EXPLAIN QUERY PLAN SELECT * FROM realized_matches WHERE {where_sql} ORDER BY realized_date DESC, sort_order DESC, id DESC LIMIT 50"
        with self._connection(caller="history.daytrade.explain") as conn:
            rows = conn.execute(sql, tuple(params)).fetchall()
        return [str(row[3]) for row in rows]

    def get_summary(self) -> dict[str, Any]:
        """The 帳務 home cards: today / week / month / total / 當沖 realized and the holding cost per market, as
        AccountAnalyticsService.market_performance computes them (renamed to the cards' tw / us keys)."""
        with self._connection(caller="account.read.summary") as conn:
            performance = self.market_performance(conn)

        def pick(field: str) -> dict[str, float]:
            return {key: float(performance[market][field]) for key, market in (("tw", "台股"), ("us", "美股"))}

        return {
            "today": pick("today"),
            "week": pick("week"),
            "month": pick("month"),
            "holding_cost": pick("holding_cost"),
            "realized_total": pick("realized_total"),
            "daytrade_total": pick("daytrade_profit"),
            **self._sync_times(),
            "last_rebuild_at": self._get_meta("last_rebuild_at"),
        }

