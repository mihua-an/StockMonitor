from __future__ import annotations

from collections import deque
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_UP
from typing import Any
from datetime import datetime
from decimal import InvalidOperation
import logging
import sqlite3
from service.account.account_types import Fill, Order, Leg, TradeInfoError, ledger_decimal
from service.market.reference.security_master_service import SecurityMasterService

_log = logging.getLogger(__name__)

ZERO = Decimal("0")
ONE = Decimal("1")
CENT = Decimal("0.01")
TW_FEE_RATE = Decimal("0.000399")
# The broker's list rate; TW_FEE_RATE is it at the 2.8 折 the actual account pays. The paper ledger may set its own
# 折扣 (設定 → 資金, service/account/capital.py fee_discount).
TW_LIST_FEE_RATE = Decimal("0.001425")
US_FEE_RATE = Decimal("0.0008")
US_SELL_TAX_RATE = Decimal("0.0000206")
TW_STOCK_TAX = Decimal("0.003")
TW_STOCK_DAY_TAX = Decimal("0.0015")
TW_ETF_TAX = Decimal("0.001")
TW_ETF_DAY_TAX = Decimal("0.001")
# The instrument kinds (security master) taxed as ETFs (證交稅 0.1%, 當沖 too): ETF, ETN and REIT (受益證券).
TW_ETF_TAX_KINDS = frozenset({"etf", "etn", "reit"})


class AccountingCore:
    """Pure fills, order splits, FIFO, fees, tax and rounding for both ledgers."""

    def __init__(self, tw_fee_rate: Decimal = TW_FEE_RATE) -> None:
        self.tw_fee_rate = tw_fee_rate

    @staticmethod
    def ceil_decimal(value: Decimal) -> Decimal:
        return value.to_integral_value(rounding=ROUND_CEILING)

    @staticmethod
    def floor_decimal(value: Decimal) -> Decimal:
        return value.to_integral_value(rounding=ROUND_FLOOR)

    @staticmethod
    def instrument_kind(code: str) -> str:
        """A 台股 code's kind, the security master's own (SecurityMasterService.instrument_kind)."""
        return SecurityMasterService.instrument_kind(code)

    def fee_for_order(self, market: str, gross_amount: Decimal) -> Decimal:
        if market == "美股":
            return (gross_amount * US_FEE_RATE).quantize(CENT, rounding=ROUND_HALF_UP)
        return max(ONE, self.ceil_decimal(gross_amount * self.tw_fee_rate))

    def sell_tax_rate(self, market: str, code: str, trade_type: str) -> Decimal:
        """The tax rate on a sell of `code`: 美股's SEC fee, else 證交稅 by its instrument kind and 當沖 or not."""
        if market == "美股":
            return US_SELL_TAX_RATE
        return self.tw_sell_tax_rate(self.instrument_kind(code), trade_type)

    @staticmethod
    def tw_sell_tax_rate(instrument_kind: str, trade_type: str = "一般") -> Decimal:
        etf_taxed = instrument_kind in TW_ETF_TAX_KINDS
        if trade_type == "當沖":
            return TW_ETF_DAY_TAX if etf_taxed else TW_STOCK_DAY_TAX
        return TW_ETF_TAX if etf_taxed else TW_STOCK_TAX

    def tax_for_leg(self, leg: Any) -> Decimal:
        if leg.action != "賣出":
            return ZERO
        tax = leg.gross_amount * self.sell_tax_rate(leg.market, leg.code, leg.trade_type)
        if leg.market == "美股":
            return tax.quantize(CENT, rounding=ROUND_HALF_UP)
        return self.floor_decimal(tax)

    def closing_terms(self, market: str, code: str, trade_type: str = "一般") -> dict[str, str]:
        """What one more trade of `code` would be charged, as this ledger charges it: the amount's, fee's and tax's
        rate, minimum and rounding (TW: amount and tax rounded down, fee up with a minimum of 1; 美股: to the cent,
        half up). A screen pricing a trade not made yet -- closing a holding at the live price, a replayed pair at
        the replay price, an order ticket's estimate -- applies these (core/trade_costs.js) and never its own rates."""
        if market == "美股":
            return {"amount_rounding": "cent", "fee_rate": str(US_FEE_RATE), "min_fee": "0", "fee_rounding": "cent",
                    "sell_tax_rate": str(US_SELL_TAX_RATE), "tax_rounding": "cent"}
        return self.tw_closing_terms_of_kind(self.instrument_kind(code), trade_type)

    def tw_closing_terms_of_kind(self, instrument_kind: str, trade_type: str = "一般") -> dict[str, str]:
        """closing_terms of a 台股 trade of any code of `instrument_kind` (the paper funds' trade_terms per kind)."""
        return {"amount_rounding": "floor", "fee_rate": str(self.tw_fee_rate), "min_fee": "1", "fee_rounding": "ceil",
                "sell_tax_rate": str(self.tw_sell_tax_rate(instrument_kind, trade_type)), "tax_rounding": "floor"}

    @staticmethod
    def order_trade_info(fills: list[tuple[Any, Any]]) -> str:
        """The trade_info of one 模擬下單 order: each of its fills as qty@price, in the order they came (one order is
        one trade of the ledger, however many times it filled)."""
        return "_".join(f"{qty}@{price}" for qty, price in fills)

    @staticmethod
    def trade_cash(action: str, gross: Decimal, fee: Decimal, tax: Decimal) -> Decimal:
        """A trade's 應收付: a buy pays its amount, fee and tax; a sell brings in its amount less its fee and tax."""
        return -(gross + fee + tax) if action == "買進" else gross - fee - tax

    def trade_costs(self, rows: list[Any]) -> dict[str, dict[str, Any]]:
        """Each trade's 價金, fee, tax, 應收付 and whether part of it is 當沖, charged exactly as a ledger rebuild
        charges them (one fee per trade, the 當沖 split over the trades of a day and code, the tax per leg). `rows` are
        raw-trade rows (trade_id, trade_date, market, action, code, trade_info, trade_time, source_order); a row whose
        trade_info is not valid raises, since a caller pricing its own fills has nothing to show for it."""
        orders, errors = self._build_orders(rows)
        if errors:
            raise TradeInfoError("; ".join(f"{trade_id}: {reason}" for trade_id, reason in errors))
        out = {order.trade_id: {"gross": order.gross_amount, "fee": ZERO, "tax": ZERO, "daytrade": False, "action": order.action}
               for order in orders}
        for leg in self._split_orders_to_legs(orders):
            costs = out[leg.trade_id]
            costs["fee"] += leg.fee
            costs["tax"] += leg.tax
            costs["daytrade"] = costs["daytrade"] or leg.trade_type == "當沖"
        for costs in out.values():
            costs["cash"] = self.trade_cash(costs.pop("action"), costs["gross"], costs["fee"], costs["tax"])
        return out

    @staticmethod
    def allocate_order_part(total: Decimal, part_qty: Decimal, total_qty: Decimal,
                            market: str, remainder: Decimal | None = None) -> Decimal:
        if part_qty >= total_qty:
            return total
        raw = total * part_qty / total_qty
        value = raw.quantize(CENT, rounding=ROUND_HALF_UP) if market == "美股" else raw.to_integral_value(rounding=ROUND_FLOOR)
        return min(value, remainder) if remainder is not None else value

    _fee_for_order = fee_for_order
    _tax_for_leg = tax_for_leg
    _allocate_order_part = allocate_order_part

    @staticmethod
    def _sort_key(order: Order | Leg) -> tuple[str, str, int]:
        return (order.trade_date, order.trade_time or "99:99:99", int(order.source_order))


    def _build_orders(self, rows: list[sqlite3.Row]) -> tuple[list[Order], list[tuple[str, str]]]:
        orders: list[Order] = []
        errors: list[tuple[str, str]] = []
        for row in rows:
            trade_id = str(row["trade_id"])
            market = str(row["market"])
            try:
                fills = self.parse_trade_info(row["trade_info"], market)
                qty = sum((fill.qty for fill in fills), ZERO)
                gross = sum((fill.amount for fill in fills), ZERO)
                avg = gross / qty if qty else ZERO
                fee = self._fee_for_order(market, gross)
                orders.append(
                    Order(
                        trade_id=trade_id,
                        trade_date=str(row["trade_date"]),
                        market=market,
                        action=str(row["action"]),
                        code=str(row["code"]),
                        trade_info=str(row["trade_info"]),
                        trade_time=str(row["trade_time"]),
                        source_order=int(row["source_order"]),
                        fills=fills,
                        qty=qty,
                        gross_amount=gross,
                        avg_price=avg,
                        fee=fee,
                    )
                )
            except TradeInfoError as exc:
                # not an error: the user's trade text is answered with its trade; the ledger rebuild stores every one
                # in rebuild_errors (the capital readers build from the same rows the last rebuild recorded)
                errors.append((trade_id, str(exc)))
            except Exception:
                _log.exception("building order %s (%s) from its raw row failed unexpectedly", trade_id, market)
                raise
        orders.sort(key=self._sort_key)
        return orders, errors


    def _split_orders_to_legs(self, orders: list[Order]) -> list[Leg]:
        grouped: dict[tuple[str, str, str], list[Order]] = {}
        for order in orders:
            grouped.setdefault((order.trade_date, order.market, order.code), []).append(order)

        legs: list[Leg] = []
        for (_trade_date, market, _code), group in grouped.items():
            group.sort(key=self._sort_key)
            eligible = [o for o in group if market == "台股" and o.qty >= Decimal("1000")]
            total_buy = sum((o.qty for o in eligible if o.action == "買進"), ZERO)
            total_sell = sum((o.qty for o in eligible if o.action == "賣出"), ZERO)
            day_limit = min(total_buy, total_sell)
            remain_buy = day_limit
            remain_sell = day_limit

            for order in group:
                day_qty = ZERO
                if order in eligible:
                    if order.action == "買進":
                        day_qty = min(order.qty, remain_buy)
                        remain_buy -= day_qty
                    elif order.action == "賣出":
                        day_qty = min(order.qty, remain_sell)
                        remain_sell -= day_qty
                normal_qty = order.qty - day_qty

                gross_remaining = order.gross_amount
                fee_remaining = order.fee
                pieces: list[tuple[str, Decimal]] = []
                if day_qty > 0:
                    pieces.append(("當沖", day_qty))
                if normal_qty > 0:
                    pieces.append(("一般", normal_qty))

                for piece_index, (trade_type, qty) in enumerate(pieces):
                    is_last = piece_index == len(pieces) - 1
                    if is_last:
                        gross = gross_remaining
                        fee = fee_remaining
                    else:
                        gross = self._allocate_order_part(order.gross_amount, qty, order.qty, order.market, gross_remaining)
                        fee = self._allocate_order_part(order.fee, qty, order.qty, order.market, fee_remaining)
                    gross_remaining -= gross
                    fee_remaining -= fee
                    avg_price = gross / qty if qty else ZERO
                    leg = Leg(
                        trade_id=order.trade_id,
                        trade_date=order.trade_date,
                        market=order.market,
                        action=order.action,
                        code=order.code,
                        trade_time=order.trade_time,
                        source_order=order.source_order,
                        trade_type=trade_type,
                        qty=qty,
                        gross_amount=gross,
                        fee=fee,
                        tax=ZERO,
                        avg_price=avg_price,
                    )
                    leg.tax = self._tax_for_leg(leg)
                    legs.append(leg)
        legs.sort(key=self._sort_key)
        return legs


    def _allocate_lot(self, lot: dict[str, Any], qty: Decimal, field: str, market: str, rounding: str = "amount") -> Decimal:
        remain_qty: Decimal = lot["remaining_qty"]
        total: Decimal = lot[field]
        if qty >= remain_qty:
            value = total
        else:
            raw = total * qty / remain_qty
            if market == "美股":
                value = raw.quantize(CENT, rounding=ROUND_HALF_UP)
            else:
                if rounding == "ceil":
                    value = raw.to_integral_value(rounding=ROUND_CEILING)
                else:
                    value = raw.to_integral_value(rounding=ROUND_FLOOR)
                value = min(value, total)
        lot[field] -= value
        return value


    def _make_match(
        self,
        *,
        realized_date: str,
        market: str,
        code: str,
        trade_type: str,
        direction: str,
        qty: Decimal,
        buy_amount: Decimal,
        sell_amount: Decimal,
        buy_fee: Decimal,
        sell_fee: Decimal,
        sell_tax: Decimal,
        buy_ref: str,
        sell_ref: str,
        hold_period: str,
        sort_order: int,
    ) -> dict[str, Any]:
        fee = buy_fee + sell_fee
        profit = sell_amount - buy_amount - sell_tax - fee
        return {
            "realized_date": realized_date,
            "market": market,
            "code": code,
            "trade_type": trade_type,
            "direction": direction,
            "qty": qty,
            "buy_price": buy_amount / qty if qty else ZERO,
            "sell_price": sell_amount / qty if qty else ZERO,
            "buy_amount": buy_amount,
            "sell_amount": sell_amount,
            "tax": sell_tax,
            "fee": fee,
            "buy_fee": buy_fee,
            "sell_fee": sell_fee,
            "profit": profit,
            "buy_ref": buy_ref,
            "sell_ref": sell_ref,
            "hold_period": hold_period,
            "sort_order": sort_order,
        }


    def _match_day_trades(self, legs: list[Leg]) -> tuple[list[dict[str, Any]], list[str]]:
        grouped: dict[tuple[str, str, str], list[Leg]] = {}
        for leg in legs:
            if leg.trade_type == "當沖":
                grouped.setdefault((leg.trade_date, leg.market, leg.code), []).append(leg)

        matches: list[dict[str, Any]] = []
        errors: list[str] = []
        for (trade_date, market, code), group in grouped.items():
            group.sort(key=self._sort_key)
            # FIFO lots: deques, so taking the oldest lot is O(1) (list.pop(0) shifts the whole list).
            long_queue: deque[dict[str, Any]] = deque()
            short_queue: deque[dict[str, Any]] = deque()

            for leg in group:
                current = {
                    "remaining_qty": leg.qty,
                    "gross": leg.gross_amount,
                    "fee": leg.fee,
                    "tax": leg.tax,
                    "trade_id": leg.trade_id,
                    "time": leg.trade_time,
                    "order": leg.source_order,
                }

                if leg.action == "買進":
                    while current["remaining_qty"] > 0 and short_queue:
                        sell_lot = short_queue[0]
                        qty = min(current["remaining_qty"], sell_lot["remaining_qty"])
                        buy_amount = self._allocate_lot(current, qty, "gross", market)
                        buy_fee = self._allocate_lot(current, qty, "fee", market)
                        sell_amount = self._allocate_lot(sell_lot, qty, "gross", market)
                        sell_fee = self._allocate_lot(sell_lot, qty, "fee", market)
                        sell_tax = self._allocate_lot(sell_lot, qty, "tax", market, rounding="ceil")
                        matches.append(self._make_match(
                            realized_date=trade_date, market=market, code=code, trade_type="當沖", direction="空",
                            qty=qty, buy_amount=buy_amount, sell_amount=sell_amount, buy_fee=buy_fee,
                            sell_fee=sell_fee, sell_tax=sell_tax, buy_ref=str(leg.trade_time or "")[:5],
                            sell_ref=str(sell_lot["time"] or "")[:5],
                            hold_period=str(self._minute_diff(sell_lot["time"], leg.trade_time)), sort_order=leg.source_order,
                        ))
                        current["remaining_qty"] -= qty
                        sell_lot["remaining_qty"] -= qty
                        if sell_lot["remaining_qty"] <= 0:
                            short_queue.popleft()
                    if current["remaining_qty"] > 0:
                        long_queue.append(current)

                elif leg.action == "賣出":
                    while current["remaining_qty"] > 0 and long_queue:
                        buy_lot = long_queue[0]
                        qty = min(current["remaining_qty"], buy_lot["remaining_qty"])
                        buy_amount = self._allocate_lot(buy_lot, qty, "gross", market)
                        buy_fee = self._allocate_lot(buy_lot, qty, "fee", market)
                        sell_amount = self._allocate_lot(current, qty, "gross", market)
                        sell_fee = self._allocate_lot(current, qty, "fee", market)
                        sell_tax = self._allocate_lot(current, qty, "tax", market, rounding="ceil")
                        matches.append(self._make_match(
                            realized_date=trade_date, market=market, code=code, trade_type="當沖", direction="多",
                            qty=qty, buy_amount=buy_amount, sell_amount=sell_amount, buy_fee=buy_fee,
                            sell_fee=sell_fee, sell_tax=sell_tax, buy_ref=str(buy_lot["time"] or "")[:5],
                            sell_ref=str(leg.trade_time or "")[:5],
                            hold_period=str(self._minute_diff(buy_lot["time"], leg.trade_time)), sort_order=leg.source_order,
                        ))
                        current["remaining_qty"] -= qty
                        buy_lot["remaining_qty"] -= qty
                        if buy_lot["remaining_qty"] <= 0:
                            long_queue.popleft()
                    if current["remaining_qty"] > 0:
                        short_queue.append(current)

            if long_queue or short_queue:
                errors.append(f"{trade_date} {code} 當沖拆分後仍有未配對數量")
        return matches, errors


    def _match_normal_trades(self, legs: list[Leg]) -> tuple[list[dict[str, Any]], dict[tuple[str, str], dict[str, Decimal]], list[str]]:
        """現股 lots per stock, FIFO. A sell first closes what is held; what it sells beyond that is a short (sold
        first, not yet bought back) and is held as one -- a later buy covers it first, a 空 match. A position is the
        open lots of one side: long, qty > 0 and cost = what was paid with the buy fee; short, qty < 0 and cost = what
        the sell brought in after its fee and tax (avg = that per share, so (price - avg) * qty is the P&L either way)."""
        normal = [leg for leg in legs if leg.trade_type == "一般"]
        normal.sort(key=self._sort_key)
        open_lots: dict[tuple[str, str], deque[dict[str, Any]]] = {}
        matches: list[dict[str, Any]] = []
        errors: list[str] = []

        for leg in normal:
            key = (leg.market, leg.code)
            queue = open_lots.setdefault(key, deque())
            current = {
                "action": leg.action,
                "remaining_qty": leg.qty,
                "gross": leg.gross_amount,
                "fee": leg.fee,
                "tax": leg.tax if leg.action == "賣出" else ZERO,
                "date": leg.trade_date,
                "time": leg.trade_time,
                "trade_id": leg.trade_id,
                "order": leg.source_order,
            }
            while current["remaining_qty"] > 0 and queue and queue[0]["action"] != leg.action:
                lot = queue[0]
                buy_lot, sell_lot = (lot, current) if leg.action == "賣出" else (current, lot)
                qty = min(current["remaining_qty"], lot["remaining_qty"])
                buy_amount = self._allocate_lot(buy_lot, qty, "gross", leg.market)
                buy_fee = self._allocate_lot(buy_lot, qty, "fee", leg.market)
                sell_amount = self._allocate_lot(sell_lot, qty, "gross", leg.market)
                sell_fee = self._allocate_lot(sell_lot, qty, "fee", leg.market, rounding="ceil")
                sell_tax = self._allocate_lot(sell_lot, qty, "tax", leg.market)
                matches.append(self._make_match(
                    realized_date=leg.trade_date, market=leg.market, code=leg.code, trade_type="一般",
                    direction="" if leg.action == "賣出" else "空",
                    qty=qty, buy_amount=buy_amount, sell_amount=sell_amount, buy_fee=buy_fee, sell_fee=sell_fee,
                    sell_tax=sell_tax, buy_ref=buy_lot["date"], sell_ref=sell_lot["date"],
                    hold_period=str(self._day_diff(lot["date"], leg.trade_date)), sort_order=leg.source_order,
                ))
                current["remaining_qty"] -= qty
                lot["remaining_qty"] -= qty
                if lot["remaining_qty"] <= 0:
                    queue.popleft()
            if current["remaining_qty"] > 0:
                queue.append(current)

        positions: dict[tuple[str, str], dict[str, Decimal]] = {}
        for key, queue in open_lots.items():
            if not queue:
                continue
            qty = sum((lot["remaining_qty"] for lot in queue), ZERO)
            if queue[0]["action"] == "買進":
                cost = sum((lot["gross"] + lot["fee"] for lot in queue), ZERO)
                positions[key] = {"qty": qty, "cost": cost, "avg": cost / qty}
            else:
                proceeds = sum((lot["gross"] - lot["fee"] - lot["tax"] for lot in queue), ZERO)
                positions[key] = {"qty": -qty, "cost": proceeds, "avg": proceeds / qty}
        return matches, positions, errors


    @staticmethod
    def _minute_diff(start: str, end: str) -> int:
        def parse(value: str) -> int:
            parts = str(value or "").split(":")
            if len(parts) < 2:
                return 0
            return int(parts[0]) * 60 + int(parts[1])
        return max(0, parse(end) - parse(start))


    @staticmethod
    def _day_diff(start: str, end: str) -> int:
        try:
            return max(0, (datetime.strptime(end, "%Y-%m-%d") - datetime.strptime(start, "%Y-%m-%d")).days)
        except Exception:  # not an error: dates that are not ISO have no day difference (0) by contract
            return 0


    @staticmethod
    def parse_trade_info(trade_info: Any, market: str) -> list[Fill]:
        text = str(trade_info or "").strip()
        if not text:
            raise TradeInfoError("交易資訊空白")

        chunks = [part.strip() for part in text.split("_") if part.strip()]
        if not chunks:
            raise TradeInfoError("交易資訊沒有有效成交")

        fills: list[Fill] = []
        for index, chunk in enumerate(chunks, start=1):
            if chunk.count("@") != 1:
                raise TradeInfoError(f"第 {index} 段格式錯誤：{chunk}")
            qty_text, price_text = (part.strip() for part in chunk.split("@", 1))
            try:
                qty = Decimal(qty_text)
                price = Decimal(price_text)
            except InvalidOperation as exc:
                raise TradeInfoError(f"第 {index} 段不是有效數字：{chunk}") from exc
            if qty <= 0 or price <= 0:
                raise TradeInfoError(f"第 {index} 段股數/價格必須大於 0：{chunk}")
            if market == "台股" and qty != qty.to_integral_value():
                raise TradeInfoError(f"台股股數必須為整數：{chunk}")

            raw_amount = qty * price
            if market == "美股":
                amount = raw_amount.quantize(CENT, rounding=ROUND_HALF_UP)
            else:
                amount = raw_amount.to_integral_value(rounding=ROUND_FLOOR)
            fills.append(Fill(qty=qty, price=price, amount=amount))
        return fills


    @staticmethod
    def _decimal(value: Any) -> Decimal:
        return ledger_decimal(value)


    @staticmethod
    def _fmt(value: Decimal | Any) -> str:
        if not isinstance(value, Decimal):
            try:
                value = Decimal(str(value))
            except Exception:  # not an error: a non-numeric value is shown as entered
                return str(value)
        text = format(value, "f")
        if "." in text:
            text = text.rstrip("0").rstrip(".")
        return text or "0"


    @staticmethod
    def _number(value: Any) -> int | float:
        dec = AccountingCore._decimal(value)
        if dec == dec.to_integral_value():
            return int(dec)
        return float(dec)

