from __future__ import annotations
import json
import logging
import uuid
from datetime import datetime
from typing import Any
from service.account.account_types import ActualAccountError, invalid_account_input
from service.account import capital
from service.account.accounting_core import AccountingCore
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)

# raw_json `source` of a trade the 模擬下單 matching filled (service/account/paper_orders.py); manual ones are
# "paper_wallet". A matched fill belongs to its order: it is not edited or deleted on its own.
MATCHED_SOURCE = "paper_match"


def _matched(row) -> bool:
    try:
        return json.loads(row["raw_json"] or "{}").get("source") == MATCHED_SOURCE
    except (TypeError, ValueError) as exc:
        record_failure(_failure_log, "reading a raw trade's source", exc)
        return False


class LocalTradeInput:
    """Local transaction validation and persistence; no remote configuration."""
    def __init__(self, ledger) -> None:
        self.ledger = ledger

    def local_save_trade(self, payload: dict[str, Any]) -> dict[str, Any]:
        """只寫本機 SQLite 的交易；供模擬錢包使用，不呼叫 GAS / Google Sheet。"""
        raw_trade_id = str(payload.get("trade_id") or "").strip()
        trade_id = raw_trade_id or f"SIM-{uuid.uuid4()}"
        trade_date = self.ledger.normalize_date(payload.get("trade_date"))
        market = self.ledger.normalize_market(payload.get("market"))
        action = self.ledger.normalize_action(payload.get("action"))
        code = str(payload.get("code") or "").strip()
        trade_info = str(payload.get("trade_info") or "").strip()
        trade_time = self.ledger.normalize_time(payload.get("trade_time") or "")

        if not trade_date or not market or not action or not code or not trade_info:
            raise invalid_account_input("交易日期、市場、交易類型、股號、交易資訊不可空白")
        if market not in self.ledger.capital_scope.markets:
            raise invalid_account_input(f"這個帳本不支援的市場：{market}")
        if action not in {"買進", "賣出"}:
            raise invalid_account_input(f"不支援的交易類型：{action}")
        self.ledger.parse_trade_info(trade_info, market)

        # Raw row and derived ledger in one transaction.
        def write_raw(conn) -> None:
            existing = conn.execute(
                "SELECT source_order,trade_date,market,code,raw_json FROM raw_trades WHERE trade_id=?",
                (trade_id,),
            ).fetchone()
            if existing is not None and _matched(existing):
                raise invalid_account_input("這筆是模擬下單撮合的成交，不能單獨修改；要重來請在模擬下單刪除整筆委託")
            if existing is not None:
                source_order = int(existing[0])
            else:
                row = conn.execute("SELECT COALESCE(MAX(source_order), 0) + 1 FROM raw_trades").fetchone()
                source_order = int(row[0] or 1)

            raw_payload = {
                "trade_id": trade_id,
                "trade_date": trade_date,
                "market": market,
                "action": action,
                "code": code,
                "trade_info": trade_info,
                "trade_time": trade_time,
                "source_order": source_order,
                "source": "paper_wallet",
            }
            conn.execute(
                """
                INSERT INTO raw_trades(
                    trade_id,trade_date,market,action,code,trade_info,trade_time,source_order,raw_json
                ) VALUES(?,?,?,?,?,?,?,?,?)
                ON CONFLICT(trade_id) DO UPDATE SET
                    trade_date=excluded.trade_date,
                    market=excluded.market,
                    action=excluded.action,
                    code=excluded.code,
                    trade_info=excluded.trade_info,
                    trade_time=excluded.trade_time,
                    source_order=excluded.source_order,
                    raw_json=excluded.raw_json
                """,
                (
                    trade_id, trade_date, market, action, code, trade_info, trade_time,
                    source_order, json.dumps(raw_payload, ensure_ascii=False),
                ),
            )
            touched = [(trade_date, market, code)] + ([(str(existing[1]), str(existing[2]), str(existing[3]))] if existing is not None else [])
            self._check_trading_rules(conn, touched)

        rebuild = self.ledger.rebuild(raw_writer=write_raw)
        now_text = datetime.now().isoformat(timespec="seconds")
        self.ledger._set_meta_many(
            {
                # A local write is its own attempt and success (GAS syncs keep the two apart).
                "last_sync_attempt_at": now_text,
                "last_sync_attempt_status": "ok",
                "last_sync_success_at": now_text,
                "last_sync_count": str(self.ledger.get_status().get("counts", {}).get("raw_trades", 0)),
            },
            caller="paper_wallet.trade.meta",
        )
        return {
            "ok": True,
            "trade_id": trade_id,
            "created": not bool(raw_trade_id),
            "local_only": True,
            "rebuild": rebuild,
            "summary": self.ledger.get_summary(),
        }


    def _check_trading_rules(self, conn, touched: list[tuple[str, str, str]]) -> None:
        """The paper ledger's lot rules and daily limit over the ledger as this change leaves it, inside the same
        transaction (a refusal rolls the change back; two writes cannot both pass on the same stale usage).
        `touched` is (date, market, code) of the trade before and after the change."""
        if not self.ledger.enforces_trading_rules:
            return
        orders, _errors = self.ledger._build_orders(conn.execute("SELECT * FROM raw_trades").fetchall())
        stocks_from: dict[tuple[str, str], str] = {}
        for day, market, code in touched:
            stocks_from[(market, code)] = min(day, stocks_from.get((market, code), day))
        # 模擬下單's working orders count as filled (委託預扣): a change a working order relies on is refused too.
        reserved = self.ledger.working_reservations() if self.ledger.working_reservations else []
        capital.check_paper_ledger(capital.trades_from_orders(orders) + list(reserved),
                                   capital.read_settings(self.ledger._get_meta, self.ledger.capital_scope),
                                   stocks_from=stocks_from, limit_days={(market, day) for day, market, _code in touched})

    def local_delete_trade(self, trade_id: str) -> dict[str, Any]:
        """刪除模擬錢包本機交易並重算；不觸碰 GAS / Google Sheet。"""
        trade_id = str(trade_id or "").strip()
        if not trade_id:
            raise invalid_account_input("缺少 trade_id")

        def delete_raw(conn) -> None:
            row = conn.execute("SELECT trade_date,market,code,raw_json FROM raw_trades WHERE trade_id=?", (trade_id,)).fetchone()
            if row is not None and _matched(row):
                raise invalid_account_input("這筆是模擬下單撮合的成交，不能單獨刪除；要重來請在模擬下單刪除整筆委託")
            cursor = conn.execute("DELETE FROM raw_trades WHERE trade_id=?", (trade_id,))
            if not int(cursor.rowcount or 0):
                raise ActualAccountError("找不到這筆模擬交易", classification="NOT_FOUND", status_code=404)
            # A later sell may have sold the shares this trade bought: the stock is checked again without it.
            self._check_trading_rules(conn, [(str(row[0]), str(row[1]), str(row[2]))])

        rebuild = self.ledger.rebuild(raw_writer=delete_raw)
        return {
            "ok": True,
            "trade_id": trade_id,
            "deleted": True,
            "local_only": True,
            "rebuild": rebuild,
            "summary": self.ledger.get_summary(),
        }

    def import_matched_orders(self, orders: list[dict[str, Any]]) -> dict[str, Any]:
        """The 模擬下單 matching's filled orders into the ledger, in one rebuild: one order is one trade (its trade_id is
        the order's id), its fills the trade's qty@price parts -- an order that filled in several prints is still one
        trade, at the time of its first fill. An order that filled again is updated in place (its new fills added); one
        already in the ledger as it is is left alone (the results journal is read again after a restart). The lot rules
        and the daily limit were checked when the order was placed (with every working order reserved), so a fill the
        exchange would have made is never refused here. Each item: order_id, trade_date, code, action, fills
        [{qty, price}], trade_time, reasons."""
        if not orders:
            return {"ok": True, "imported": 0, "updated": 0}
        imported: list[str] = []
        updated: list[str] = []

        def write_raw(conn) -> None:
            ids = [o["order_id"] for o in orders]
            known = {str(r["trade_id"]): r for r in conn.execute(
                "SELECT trade_id,trade_info,source_order,raw_json FROM raw_trades WHERE trade_id IN (%s)" % ",".join("?" * len(ids)), ids)}
            source_order = int(conn.execute("SELECT COALESCE(MAX(source_order), 0) FROM raw_trades").fetchone()[0] or 0)
            for order in orders:
                trade_info = AccountingCore.order_trade_info([(f["qty"], f["price"]) for f in order["fills"]])
                self.ledger.parse_trade_info(trade_info, "台股")
                row = known.get(order["order_id"])
                if row is not None and str(row["trade_info"]) == trade_info:
                    continue
                if row is not None and not _matched(row):
                    raise invalid_account_input(f"帳本裡已有編號 {order['order_id']} 的手動交易")
                order_source = int(row["source_order"]) if row is not None else source_order + 1
                source_order = max(source_order, order_source)
                raw_payload = {"trade_id": order["order_id"], "trade_date": order["trade_date"], "market": "台股", "action": order["action"],
                               "code": order["code"], "trade_info": trade_info, "trade_time": order["trade_time"], "source_order": order_source,
                               "source": MATCHED_SOURCE, "order_id": order["order_id"], "reason": "、".join(order.get("reasons") or [])}
                if row is None:
                    conn.execute(
                        "INSERT INTO raw_trades(trade_id,trade_date,market,action,code,trade_info,trade_time,source_order,raw_json) "
                        "VALUES(?,?,?,?,?,?,?,?,?)",
                        (order["order_id"], order["trade_date"], "台股", order["action"], order["code"], trade_info, order["trade_time"],
                         order_source, json.dumps(raw_payload, ensure_ascii=False)))
                    imported.append(order["order_id"])
                else:
                    conn.execute("UPDATE raw_trades SET trade_info=?, raw_json=? WHERE trade_id=?",
                                 (trade_info, json.dumps(raw_payload, ensure_ascii=False), order["order_id"]))
                    updated.append(order["order_id"])

        rebuild = self.ledger.rebuild(raw_writer=write_raw)
        return {"ok": True, "imported": len(imported), "updated": len(updated), "trade_ids": imported + updated, "rebuild": rebuild}

    def check_matched_orders_deletable(self, trade_ids: list[str]) -> None:
        """Whether deleting these matched orders' trades keeps the paper rules (raises the reason when not); nothing
        changes."""
        if not trade_ids:
            return
        with self.ledger._connection(caller="paper_wallet.trade.delete_check") as conn:
            rows = conn.execute("SELECT trade_id,trade_date,market,code FROM raw_trades WHERE trade_id IN (%s)"
                                % ",".join("?" * len(trade_ids)), list(trade_ids)).fetchall()
            if not rows:
                return
            conn.execute("SAVEPOINT paper_delete_check")
            try:
                conn.execute("DELETE FROM raw_trades WHERE trade_id IN (%s)" % ",".join("?" * len(trade_ids)), list(trade_ids))
                self._check_trading_rules(conn, [(str(r["trade_date"]), str(r["market"]), str(r["code"])) for r in rows])
            finally:
                conn.execute("ROLLBACK TO SAVEPOINT paper_delete_check")
                conn.execute("RELEASE SAVEPOINT paper_delete_check")

    def delete_matched_orders(self, trade_ids: list[str]) -> dict[str, Any]:
        """Remove matched orders' trades (deleting a whole order, A4). The stocks they touched are checked again
        without them, like a manual delete: a later sell may have sold what they bought."""
        if not trade_ids:
            return {"ok": True, "deleted": 0}

        def delete_raw(conn) -> None:
            rows = conn.execute("SELECT trade_id,trade_date,market,code,raw_json FROM raw_trades WHERE trade_id IN (%s)"
                                % ",".join("?" * len(trade_ids)), list(trade_ids)).fetchall()
            if any(not _matched(row) for row in rows):
                raise invalid_account_input("只能刪除模擬下單撮合的成交")
            conn.execute("DELETE FROM raw_trades WHERE trade_id IN (%s)" % ",".join("?" * len(trade_ids)), list(trade_ids))
            self._check_trading_rules(conn, [(str(r["trade_date"]), str(r["market"]), str(r["code"])) for r in rows])

        rebuild = self.ledger.rebuild(raw_writer=delete_raw)
        return {"ok": True, "deleted": len(trade_ids), "rebuild": rebuild}
