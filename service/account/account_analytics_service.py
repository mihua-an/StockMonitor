from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

from service.account.accounting_core import ZERO
from service.account.trade_metrics import (ENTRY_TIME_BANDS, HOLD_TIME_BANDS, band_descriptions, entry_band_index, hold_band_index,
                                           metric_summary, profit_total, return_rate, trade_weekday, win_rate)
import logging
from service.platform.failure_record import record_failure


ACCOUNT_MARKETS = ("台股", "美股")


def _checked_market(market: Any) -> str:
    value = str(market or "")
    if value not in ACCOUNT_MARKETS:
        raise ValueError(f"market must be one of {', '.join(ACCOUNT_MARKETS)}, not {value!r}")
    return value


def _checked_date(date: Any) -> str:
    from datetime import date as calendar_date

    value = str(date or "")
    try:
        if len(value) != 10 or calendar_date.fromisoformat(value).isoformat() != value:
            raise ValueError(value)
    except ValueError as exc:
        raise ValueError(f"date must be YYYY-MM-DD, not {value!r}") from exc
    return value

_failure_log = logging.getLogger(__name__)


def business_date() -> date:
    """The ledger's business date: the day 今日／本週／本月 are counted from (market_performance) and the dashboard is a
    function of (_dashboard_signature). Read here only, so the figures and the cache always agree on the day."""
    return date.today()


class AccountAnalyticsService:
    """Ledger analytics and dashboard projection over the single ledger state.

    No trades, positions or realized matches are duplicated here; analytics
    reads the command-owned repository and uses the command-owned dashboard
    cache.
    """
    def _win_rate(self, rows: list[dict[str, Any]]) -> float | None:
        """trade_metrics.win_rate of the rows' profits, as the number the desktop answers carry."""
        rate = win_rate(self._decimal(row.get("profit")) for row in rows)
        return None if rate is None else float(rate)

    def _profit_total(self, rows: list[dict[str, Any]]) -> Decimal:
        return profit_total(self._decimal(row.get("profit")) for row in rows)

    _RATE_FIELDS = ("win_rate", "profit_loss_ratio", "long_win_rate", "short_win_rate", "return_rate", "long_return_rate",
                    "short_return_rate")

    def _metric_summary(self, rows: list[dict[str, Any]], label: str = "") -> dict[str, Any]:
        """trade_metrics.metric_summary of pair rows, as the numbers the desktop answers carry (money exact, rates as
        floats, None kept)."""
        stats = metric_summary((self._decimal(row.get("profit")), str(row.get("direction") or ""),
                                self._decimal(row.get("invested_amount"))) for row in rows)
        output: dict[str, Any] = {"label": label}
        for key, value in stats.items():
            if value is None or isinstance(value, int):
                output[key] = value
            elif key in self._RATE_FIELDS:
                output[key] = float(value)
            else:
                output[key] = self._number(value)
        return output

    _DAYTRADE_MODES = {"overview": "當沖", "long": "多單", "short": "空單"}

    def get_daytrade_analysis(self, market: str, mode: str = "overview") -> dict[str, Any]:
        """當沖分析 of one market in one mode (overview / long / short), computed here and only here: the summary, the
        mini report, the week / month / weekday tables, the hold-time and entry-time bands (with their descriptions),
        the entry x hold matrix, the ten biggest wins and losses, and the pairs themselves (newest first). Every group
        names its pairs by id (`pair_ids`) so the page opens a group's trades without regrouping them."""
        market = _checked_market(market)
        if mode not in self._DAYTRADE_MODES:
            raise ValueError(f"mode must be one of {', '.join(self._DAYTRADE_MODES)}, not {mode!r}")
        ledger_state = self.ledger_state()
        if ledger_state["state"] != "CURRENT":
            return {"ok": True, "market": market, "mode": mode, "available": False, "ledger_state": ledger_state}
        directions = {"overview": ("多", "空"), "long": ("多",), "short": ("空",)}[mode]
        pairs = [row for row in self._analytics_match_rows(market, trade_type="當沖") if row["direction"] in directions]

        def group(rows: list[dict[str, Any]], label: str, **extra: Any) -> dict[str, Any]:
            return {**self._metric_summary(rows, label), **extra, "pair_ids": [row["id"] for row in rows]}

        def bands(index_of, table) -> list[dict[str, Any]]:
            buckets: list[list[dict[str, Any]]] = [[] for _ in table]
            for row in pairs:
                index = index_of(row)
                if index is not None:
                    buckets[index].append(row)
            return [group(rows, table[index][0], bucket_index=index) for index, rows in enumerate(buckets)]

        hold_index = lambda row: hold_band_index(row["hold_period"])
        entry_index = lambda row: entry_band_index(row["entry_minute"])
        matrix_rows = []
        for entry_position, (label, _lower, _upper) in enumerate(ENTRY_TIME_BANDS):
            cells: list[list[dict[str, Any]]] = [[] for _ in HOLD_TIME_BANDS]
            for row in pairs:
                if entry_index(row) == entry_position and hold_index(row) is not None:
                    cells[hold_index(row)].append(row)
            matrix_rows.append({"label": label, "counts": [len(cell) for cell in cells],
                                "values": [self._number(self._profit_total(cell)) if cell else None for cell in cells]})

        by_profit = sorted(pairs, key=lambda row: self._decimal(row["profit"]))
        return {
            "ok": True, "market": market, "mode": mode, "available": True, "ledger_state": ledger_state,
            "label": self._DAYTRADE_MODES[mode],
            "summary": self._metric_summary(pairs, self._DAYTRADE_MODES[mode]),
            "mini_report": self._daytrade_mini_report(pairs),
            "periods": {"week": self._daytrade_periods(pairs, "week", 10), "month": self._daytrade_periods(pairs, "month", 8)},
            "weekdays": [group([row for row in pairs if self._weekday(row) == weekday], label, weekday=weekday)
                         for weekday, label in enumerate(("週一", "週二", "週三", "週四", "週五"), start=1)],
            "bands": band_descriptions(),
            "hold_time": bands(hold_index, HOLD_TIME_BANDS),
            "entry_time": bands(entry_index, ENTRY_TIME_BANDS),
            "matrix": {"columns": [short for _label, short, _lower, _upper in HOLD_TIME_BANDS], "rows": matrix_rows},
            "top_losses": [row["id"] for row in by_profit if self._decimal(row["profit"]) < 0][:10],
            "top_wins": [row["id"] for row in reversed(by_profit) if self._decimal(row["profit"]) > 0][:10],
            "pairs": pairs,
        }

    @staticmethod
    def _weekday(row: dict[str, Any]) -> int | None:
        """trade_metrics.trade_weekday of a pair's realized date; None for a date that is not one."""
        try:
            day = date.fromisoformat(str(row["realized_date"]))
        except ValueError:  # not an error: a date that is not ISO belongs to no weekday by contract
            return None
        return trade_weekday(day)

    def _daytrade_periods(self, pairs: list[dict[str, Any]], kind: str, limit: int) -> list[dict[str, Any]]:
        """The newest `limit` weeks (from Monday; labelled YYYY/MM/Wn) or months (YYYY/MM) with 當沖 pairs."""
        groups: dict[str, tuple[str, list[dict[str, Any]]]] = {}
        for row in pairs:
            try:
                day = date.fromisoformat(str(row["realized_date"]))
            except ValueError:  # not an error: a date that is not ISO belongs to no period by contract
                continue
            if kind == "month":
                key, label = f"{day:%Y-%m}", f"{day:%Y/%m}"
            else:
                monday = day - timedelta(days=day.weekday())
                key, label = monday.isoformat(), f"{monday:%Y/%m}/W{(monday.day - 1) // 7 + 1}"
            groups.setdefault(key, (label, []))[1].append(row)
        return [{**self._metric_summary(rows, label), "pair_ids": [row["id"] for row in rows]}
                for _key, (label, rows) in sorted(groups.items(), reverse=True)[:limit]]

    def _daytrade_mini_report(self, pairs: list[dict[str, Any]]) -> dict[str, Any]:
        """數據小報表: the summary's figures with the average cost and hold times, the biggest win and loss, and how
        far the win rate and 盈虧比 are from breaking even. None where there is nothing to measure."""
        summary = metric_summary((self._decimal(row["profit"]), row["direction"], self._decimal(row["invested_amount"])) for row in pairs)
        wins = [row for row in pairs if self._decimal(row["profit"]) > 0]
        losses = [row for row in pairs if self._decimal(row["profit"]) < 0]
        mean = lambda values: sum(values, ZERO) / len(values) if values else None
        holds = lambda rows: [Decimal(row["hold_period"]) for row in rows if row["hold_period"] is not None]
        biggest_win = max(wins, key=lambda row: self._decimal(row["profit"]), default=None)
        biggest_loss = min(losses, key=lambda row: self._decimal(row["profit"]), default=None)
        rate, payoff = summary["win_rate"], summary["profit_loss_ratio"]
        required = (1 - rate) / rate if rate else None
        breakeven = 1 / (1 + payoff) if payoff is not None else None
        money = lambda value: None if value is None else self._number(value)
        ratio = lambda value: None if value is None else float(value)
        return {
            "total_count": summary["total_count"], "win_count": summary["win_count"], "loss_count": summary["loss_count"],
            "win_rate": ratio(rate),
            "avg_cost": money(mean([self._decimal(row["tax"]) + self._decimal(row["fee"]) for row in pairs])),
            "avg_hold": ratio(mean(holds(pairs))), "avg_win_hold": ratio(mean(holds(wins))), "avg_loss_hold": ratio(mean(holds(losses))),
            "biggest_win_hold": biggest_win["hold_period"] if biggest_win else None,
            "biggest_loss_hold": biggest_loss["hold_period"] if biggest_loss else None,
            "avg_win": money(summary["avg_win"]), "biggest_win_amount": biggest_win["profit"] if biggest_win else None,
            "avg_loss": money(summary["avg_loss"]), "biggest_loss_amount": biggest_loss["profit"] if biggest_loss else None,
            "payoff_ratio": ratio(payoff), "required_payoff_ratio": ratio(required),
            "payoff_gap": ratio(payoff - required) if payoff is not None and required is not None else None,
            "breakeven_rate": ratio(breakeven),
            "win_rate_gap": ratio(rate - breakeven) if rate is not None and breakeven is not None else None,
            "expectancy": money(summary["expectancy"]),
        }

    def _analytics_match_rows(self, market: str, *, code: str = "", trade_type: str = "") -> list[dict[str, Any]]:
        """A market's realized pairs, newest first; `code` / `trade_type` narrow them in SQL."""
        names = self._stock_names()
        where, params = ["market=?"], [market]
        if code:
            where.append("code=?")
            params.append(code)
        if trade_type:
            where.append("trade_type=?")
            params.append(trade_type)
        with self._connection(caller="account.analytics.matches") as conn:
            db_rows = conn.execute(
                f"""
                SELECT * FROM realized_matches
                WHERE {" AND ".join(where)}
                ORDER BY realized_date DESC, sort_order DESC, id DESC
                """,
                params,
            ).fetchall()

        return [self._pair_row(db_row, names) for db_row in db_rows]

    def ledger_state(self) -> dict[str, Any]:
        """Whether the derived tables are the current version's: CURRENT, or REBUILD_PENDING with why. Analytics
        read only a CURRENT materialization; anything else is reported unavailable, never patched from other tables."""
        from service.account.account_ledger_service import DERIVED_REBUILD_PENDING, DERIVED_VERSION, DERIVED_VERSION_KEY

        pending = self._get_meta(DERIVED_REBUILD_PENDING)
        version = self._get_meta(DERIVED_VERSION_KEY)
        if pending or version != DERIVED_VERSION:
            return {"state": "REBUILD_PENDING", "derived_version": version or None, "expected_version": DERIVED_VERSION,
                    "reason": pending or "the ledger was built by another version; it is rebuilt at the next start or by 重新計算"}
        return {"state": "CURRENT", "derived_version": version}

    def _stock_ledger_stats(self, market: str) -> dict[str, dict[str, Any]]:
        """每檔股票的現股 / 當沖成交金額、費稅與目前庫存 -- read from the one versioned materialization (order_legs,
        positions) the rebuild writes from the raw trades."""
        with self._connection(caller="account.analytics.stock_ledger") as conn:
            stored_legs = conn.execute(
                """
                SELECT code,trade_type,action,qty,gross_amount,tax,fee
                FROM order_legs
                WHERE market=?
                ORDER BY code,trade_type,id
                """,
                (market,),
            ).fetchall()
            stored_positions = conn.execute(
                "SELECT code,qty,cost_amount,avg_cost FROM positions WHERE market=?",
                (market,),
            ).fetchall()

        def blank_bucket() -> dict[str, Any]:
            return {
                "buy_qty": ZERO, "sell_qty": ZERO,
                "buy_amount": ZERO, "sell_amount": ZERO,
                "tax": ZERO, "fee": ZERO,
                "leg_count": 0,
            }

        result: dict[str, dict[str, Any]] = {}

        for row in stored_legs:
            code = str(row["code"])
            item = result.setdefault(code, {"normal": blank_bucket(), "daytrade": blank_bucket()})
            key = "daytrade" if str(row["trade_type"]) == "當沖" else "normal"
            bucket = item[key]
            bucket["leg_count"] += 1
            qty = self._decimal(row["qty"])
            amount = self._decimal(row["gross_amount"])
            if str(row["action"]) == "買進":
                bucket["buy_qty"] += qty
                bucket["buy_amount"] += amount
            else:
                bucket["sell_qty"] += qty
                bucket["sell_amount"] += amount
            bucket["tax"] += self._decimal(row["tax"])
            bucket["fee"] += self._decimal(row["fee"])

        for row in stored_positions:
            code = str(row["code"])
            item = result.setdefault(code, {"normal": blank_bucket(), "daytrade": blank_bucket()})
            item["position"] = {
                "qty": self._decimal(row["qty"]),
                "cost_amount": self._decimal(row["cost_amount"]),
                "avg_cost": self._decimal(row["avg_cost"]),
            }

        for item in result.values():
            item.setdefault("position", {"qty": ZERO, "cost_amount": ZERO, "avg_cost": ZERO})
        return result

    def _build_stock_stats(self, rows: list[dict[str, Any]], market: str) -> list[dict[str, Any]]:
        grouped: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            grouped.setdefault(str(row["code"]), []).append(row)

        if self.ledger_state()["state"] != "CURRENT":
            return []
        ledger = self._stock_ledger_stats(market)
        names = self._stock_names()
        codes = sorted(set(grouped) | set(ledger))
        output: list[dict[str, Any]] = []

        def rate(items: list[dict[str, Any]]) -> float | None:
            value = return_rate((self._decimal(row.get("profit")), self._decimal(row.get("invested_amount"))) for row in items)
            return None if value is None else float(value)

        win_rate, profit_sum = self._win_rate, self._profit_total

        for code in codes:
            items = grouped.get(code, [])
            metrics = self._metric_summary(items, code)
            normal_rows = [row for row in items if row.get("trade_type") != "當沖"]
            day_rows = [row for row in items if row.get("trade_type") == "當沖"]
            long_rows = [row for row in day_rows if row.get("direction") == "多"]
            short_rows = [row for row in day_rows if row.get("direction") == "空"]

            led = ledger.get(code) or {}
            normal = led.get("normal") or {}
            day = led.get("daytrade") or {}
            pos = led.get("position") or {"qty": ZERO, "cost_amount": ZERO, "avg_cost": ZERO}

            normal_buy = self._decimal(normal.get("buy_amount"))
            normal_sell = self._decimal(normal.get("sell_amount"))
            normal_tax = self._decimal(normal.get("tax"))
            normal_fee = self._decimal(normal.get("fee"))
            normal_buy_qty = self._decimal(normal.get("buy_qty"))
            normal_sell_qty = self._decimal(normal.get("sell_qty"))
            day_buy = self._decimal(day.get("buy_amount"))
            day_sell = self._decimal(day.get("sell_amount"))
            day_tax = self._decimal(day.get("tax"))
            day_fee = self._decimal(day.get("fee"))
            day_buy_qty = self._decimal(day.get("buy_qty"))
            day_sell_qty = self._decimal(day.get("sell_qty"))

            day_profit = profit_sum(day_rows)
            normal_profit = profit_sum(normal_rows)
            total_profit = profit_sum(items)
            day_metrics = self._metric_summary(day_rows, code)
            long_metrics = self._metric_summary(long_rows, code)
            short_metrics = self._metric_summary(short_rows, code)

            metrics.update({
                "code": code,
                "name": (code if market == "美股" else names.get(code, "")),
                "total_profit": self._number(total_profit),
                "avg_trade_profit": self._number(total_profit / Decimal(len(items))) if items else None,
                "return_rate": rate(items),

                "normal_profit": self._number(normal_profit),
                "normal_win_rate": win_rate(normal_rows),
                "normal_return_rate": rate(normal_rows),
                "normal_count": len(normal_rows),
                "normal_buy_qty": self._number(normal_buy_qty),
                "normal_sell_qty": self._number(normal_sell_qty),
                "normal_buy_amount": self._number(normal_buy),
                "normal_sell_amount": self._number(normal_sell),
                "normal_trade_diff": self._number(normal_sell - normal_buy),
                "normal_tax": self._number(normal_tax),
                "normal_fee": self._number(normal_fee),
                "normal_cost": self._number(normal_tax + normal_fee),

                "holding_qty": self._number(pos.get("qty", ZERO)),
                "holding_avg_cost": self._number(pos.get("avg_cost", ZERO)),
                "holding_cost": self._number(pos.get("cost_amount", ZERO)),

                "daytrade_profit": self._number(day_profit),
                "daytrade_win_rate": win_rate(day_rows),
                "daytrade_profit_loss_ratio": day_metrics.get("profit_loss_ratio"),
                "daytrade_count": len(day_rows),
                "avg_daytrade_profit": self._number(day_profit / Decimal(len(day_rows))) if day_rows else None,
                "daytrade_return_rate": rate(day_rows),
                "daytrade_buy_qty": self._number(day_buy_qty),
                "daytrade_sell_qty": self._number(day_sell_qty),
                "daytrade_buy_amount": self._number(day_buy),
                "daytrade_sell_amount": self._number(day_sell),
                "daytrade_trade_diff": self._number(day_sell - day_buy),
                "daytrade_tax": self._number(day_tax),
                "daytrade_fee": self._number(day_fee),
                "daytrade_cost": self._number(day_tax + day_fee),

                # 舊表中的多 / 空統計只代表當沖方向，不把一般現股混進去。
                "long_profit": self._number(profit_sum(long_rows)) if long_rows else None,
                "short_profit": self._number(profit_sum(short_rows)) if short_rows else None,
                "avg_long_profit": self._number(profit_sum(long_rows) / Decimal(len(long_rows))) if long_rows else None,
                "avg_short_profit": self._number(profit_sum(short_rows) / Decimal(len(short_rows))) if short_rows else None,
                "long_return_rate": rate(long_rows),
                "short_return_rate": rate(short_rows),
                "long_win_rate": win_rate(long_rows),
                "short_win_rate": win_rate(short_rows),
                "long_profit_loss_ratio": long_metrics.get("profit_loss_ratio"),
                "short_profit_loss_ratio": short_metrics.get("profit_loss_ratio"),
                "long_count": len(long_rows),
                "short_count": len(short_rows),
            })
            output.append(metrics)

        output.sort(key=lambda item: (-float(item.get("total_profit") or 0), str(item.get("code") or "")))
        return output

    def _daily_settlement_map(self, market: str) -> dict[str, Decimal]:
        """依交易日計算實際現金交割淨額。

        買進 = -(成交價金 + 手續費 + 稅)
        賣出 = +(成交價金 - 手續費 - 稅)

        order_legs 已包含同一委託拆分後的費稅，因此直接逐 leg 加總可保持
        與帳務核心相同的取整 / 美分精度規則。
        """
        with self._connection(caller="account.analytics.daily_settlement") as conn:
            rows = conn.execute(
                """
                SELECT trade_date,action,gross_amount,fee,tax
                FROM order_legs
                WHERE market=?
                ORDER BY trade_date,source_order,id
                """,
                (market,),
            ).fetchall()

        result: dict[str, Decimal] = {}
        for row in rows:
            trade_date = str(row["trade_date"] or "")
            gross = self._decimal(row["gross_amount"])
            fee = self._decimal(row["fee"])
            tax = self._decimal(row["tax"])
            if str(row["action"] or "") == "買進":
                cash = -(gross + fee + tax)
            else:
                cash = gross - fee - tax
            result[trade_date] = result.get(trade_date, ZERO) + cash
        return result

    def _daily_normal_trade_map(self, market: str) -> dict[str, Decimal]:
        """每天現股(一般)的純買賣差：賣出價金 - 買進價金，不含費稅。"""
        with self._connection(caller="account.analytics.daily_normal") as conn:
            db_rows = conn.execute(
                """
                SELECT trade_date,action,gross_amount
                FROM order_legs
                WHERE market=? AND trade_type='一般'
                ORDER BY trade_date,source_order,id
                """,
                (market,),
            ).fetchall()
        result: dict[str, Decimal] = {}
        for row in db_rows:
            trade_date = str(row["trade_date"] or "")
            gross = self._decimal(row["gross_amount"])
            value = gross if str(row["action"] or "") == "賣出" else -gross
            result[trade_date] = result.get(trade_date, ZERO) + value
        return result

    def _build_daily_stats(self, rows: list[dict[str, Any]], market: str) -> list[dict[str, Any]]:
        grouped: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            grouped.setdefault(str(row["realized_date"]), []).append(row)

        settlement_map = self._daily_settlement_map(market)
        normal_trade_map = self._daily_normal_trade_map(market)
        all_dates = set(grouped) | set(settlement_map) | set(normal_trade_map)
        output: list[dict[str, Any]] = []
        for trade_date in all_dates:
            items = grouped.get(trade_date, [])
            metrics = self._metric_summary(items, trade_date)
            day_items = [row for row in items if row["trade_type"] == "當沖"]
            normal_items = [row for row in items if row["trade_type"] != "當沖"]
            day_metrics = self._metric_summary(day_items, "當沖") if day_items else {}
            metrics.update({
                "date": trade_date,
                "settlement": self._number(settlement_map.get(trade_date, ZERO)),
                "normal_trade_diff": self._number(normal_trade_map.get(trade_date, ZERO)),
                "today_realized": metrics.get("total_profit"),
                "daytrade_profit": self._number(sum((self._decimal(row["profit"]) for row in day_items), ZERO)),
                "normal_profit": self._number(sum((self._decimal(row["profit"]) for row in normal_items), ZERO)),
                "daytrade_profit_loss_ratio": day_metrics.get("profit_loss_ratio"),
            })
            output.append(metrics)
        output.sort(key=lambda item: str(item.get("date") or ""), reverse=True)
        return output

    def market_performance(self, conn) -> dict[str, dict[str, Decimal]]:
        """The one per-market performance of a ledger: realized today / this week / this month / in total, its 當沖
        and 一般 parts, and the holding cost (every open position's cost_amount, a short's proceeds included). Summed
        by SQLite over `conn` (the caller's read, so a dashboard or a phone snapshot stays one ledger version), exactly
        and strictly as ledger Decimals (ledger_sum): a stored amount that is not a number raises LedgerDataError,
        never counts as zero. The 帳務 cards (get_summary), the home analytics and the phone's summary select from it."""
        today_date = business_date()
        today = today_date.isoformat()
        monday = (today_date - timedelta(days=today_date.weekday())).isoformat()
        month_start = today_date.replace(day=1).isoformat()
        errors: list[Exception] = []
        to_decimal = self._decimal

        class LedgerSum:
            def __init__(self) -> None:
                self.total = ZERO

            def step(self, value: Any) -> None:
                try:
                    self.total += to_decimal(value)
                except Exception as exc:  # carried out of SQLite (which would replace it with its own error) and raised
                    errors.append(exc)

            def finalize(self) -> str:
                return str(self.total)

        iso = "realized_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'"
        conn.create_aggregate("ledger_sum", 1, LedgerSum)
        realized = conn.execute(
            f"""SELECT market,
                       ledger_sum(CASE WHEN {iso} AND realized_date = ? THEN profit END) AS today,
                       ledger_sum(CASE WHEN {iso} AND realized_date BETWEEN ? AND ? THEN profit END) AS week,
                       ledger_sum(CASE WHEN {iso} AND realized_date BETWEEN ? AND ? THEN profit END) AS month,
                       ledger_sum(profit) AS realized_total,
                       ledger_sum(CASE WHEN trade_type = '當沖' THEN profit END) AS daytrade_profit,
                       ledger_sum(CASE WHEN trade_type <> '當沖' THEN profit END) AS normal_profit
                FROM realized_matches GROUP BY market""",
            (today, monday, today, month_start, today)).fetchall()
        holding = conn.execute("SELECT market, ledger_sum(cost_amount) AS cost FROM positions GROUP BY market").fetchall()
        if errors:
            raise errors[0]
        fields = ("today", "week", "month", "realized_total", "daytrade_profit", "normal_profit")
        output = {market: {**{field: ZERO for field in fields}, "holding_cost": ZERO} for market in ACCOUNT_MARKETS}
        for row in realized:
            if str(row["market"]) in output:
                output[str(row["market"])].update({field: Decimal(row[field]) for field in fields})
        for row in holding:
            if str(row["market"]) in output:
                output[str(row["market"])]["holding_cost"] = Decimal(row["cost"])
        return output

    def _build_home_analytics(self, rows: list[dict[str, Any]], stock_stats: list[dict[str, Any]], daily_stats: list[dict[str, Any]],
                              performance: dict[str, Decimal]) -> dict[str, Any]:
        overall = self._metric_summary(rows, "全部")
        overall["daytrade_profit"] = self._number(performance["daytrade_profit"])
        overall["normal_profit"] = self._number(performance["normal_profit"])
        overall["daytrade_count"] = sum(1 for row in rows if row["trade_type"] == "當沖")
        overall["normal_count"] = len(rows) - overall["daytrade_count"]
        realized_stock_stats = [item for item in stock_stats if int(item.get("total_count") or 0) > 0]
        best_stock = max(realized_stock_stats, key=lambda item: float(item.get("total_profit") or 0), default=None)
        worst_stock = min(realized_stock_stats, key=lambda item: float(item.get("total_profit") or 0), default=None)
        best_day = max(daily_stats, key=lambda item: float(item.get("total_profit") or 0), default=None)
        worst_day = min(daily_stats, key=lambda item: float(item.get("total_profit") or 0), default=None)
        return {
            "overall": overall,
            "best_stock": best_stock,
            "worst_stock": worst_stock,
            "best_day": best_day,
            "worst_day": worst_day,
            "recent_days": daily_stats[:8],
        }

    def _build_pair_days(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """配對明細's day rows: one per realized date, newest first, with its total / 當沖 / 一般 / 多 / 空 profit and pair
        count. A day's pairs themselves are read on demand (get_day)."""
        days: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            days.setdefault(str(row["realized_date"]), []).append(row)
        output = []
        for day in sorted(days, reverse=True):
            items = days[day]
            total = lambda keep: self._number(self._profit_total([row for row in items if keep(row)]))
            output.append({
                "date": day,
                "total_profit": total(lambda row: True),
                "daytrade_profit": total(lambda row: row["trade_type"] == "當沖"),
                "normal_profit": total(lambda row: row["trade_type"] == "一般"),
                "long_profit": total(lambda row: row["direction"] == "多"),
                "short_profit": total(lambda row: row["direction"] == "空"),
                "total_count": len(items),
            })
        return output

    def get_day(self, market: str, date: str) -> dict[str, Any]:
        """One day of one market: its trades (by trade date) and its realized pairs (by realized date) -- what 每日明細
        and 配對明細 show when the day is opened."""
        market, date = _checked_market(market), _checked_date(date)
        return {"ok": True, "market": market, "date": date,
                "trades": self.get_raw_trades(None, start=date, end=date, market=market),
                "pairs": self.get_realized(None, market=market, realized_date=date)}

    def get_market_trades(self, market: str) -> dict[str, Any]:
        """Every trade of one market, newest first (交易資料)."""
        market = _checked_market(market)
        return {"ok": True, "market": market, "items": self.get_raw_trades(None, market=market)}

    def get_pairs(self, market: str, code: str) -> dict[str, Any]:
        """One market's realized pairs of one stock (個股數據's trade list), in the analytics row shape. A ledger
        awaiting its rebuild has none (as get_analytics). 當沖分析 reads its slice (get_daytrade_analysis) instead."""
        market = _checked_market(market)
        code = str(code or "").strip()
        if not code:
            raise ValueError("pairs are read for a code, not a whole market")
        ledger_state = self.ledger_state()
        available = ledger_state["state"] == "CURRENT"
        items = self._analytics_match_rows(market, code=code) if available else []
        return {"ok": True, "market": market, "code": code, "available": available, "ledger_state": ledger_state,
                "items": items}

    def get_analytics(self) -> dict[str, Any]:
        state = self.ledger_state()
        output: dict[str, Any] = {"ledger_state": state}
        if state["state"] != "CURRENT":
            # Nothing is computed from a ledger awaiting its rebuild: not only 個股數據 but also
            # home, daily and pair days would otherwise come from the stale realized_matches.
            for market in ACCOUNT_MARKETS:
                output[market] = {"available": False, "home": None, "stock_stats": [], "daily_stats": [],
                                  "pair_days": []}
            return output
        with self._connection(caller="account.analytics.performance") as conn:
            performance = self.market_performance(conn)
        for market in ACCOUNT_MARKETS:
            rows = self._analytics_match_rows(market)
            stock_stats = self._build_stock_stats(rows, market)
            daily_stats = self._build_daily_stats(rows, market)
            output[market] = {
                "available": True,
                "home": self._build_home_analytics(rows, stock_stats, daily_stats, performance[market]),
                "stock_stats": stock_stats,
                "daily_stats": daily_stats,
                "pair_days": self._build_pair_days(rows),
            }
        return output

    def _dashboard_signature(self) -> tuple[Any, ...]:
        """What the dashboard is a function of: the ledger's logical revision (every write, trades and meta such as
        每日額度 alike, advances it -- account_repository.LEDGER_REVISION), the security master's names, and the
        business date."""
        def stat_signature(path: Path | None) -> tuple[int, int] | None:
            if path is None:
                return None
            try:
                stat = path.stat()
                return int(stat.st_size), int(stat.st_mtime_ns)
            except FileNotFoundError:  # not an error: no security master: names are blank
                return None
        # The dashboard's today / week / month figures depend on the business date, so a new day is a new
        # dashboard even when no file changed (yesterday's 今日損益 must not show after midnight).
        return (
            self.ledger_revision(),
            stat_signature(self.security_master_path),
            business_date().isoformat(),
        )

    def get_dashboard(self) -> dict[str, Any]:
        self._count_runtime_operation("dashboard")
        # The parts below are separate reads. A write landing between them would mix two ledger versions in ONE
        # response (0 positions next to the new buy), so a read that saw a write is thrown away and read
        # again. After two lost races the last attempt holds the ledger lock, which rebuild() also takes, so the
        # response is always one version and the retry is bounded.
        for attempt in range(3):
            signature = self._dashboard_signature()
            with self._lock:
                if (
                    self._dashboard_cache_value is not None
                    and self._dashboard_cache_signature == signature
                ):
                    return self._dashboard_cache_value
                generation = getattr(self, "_dashboard_generation", 0)
            if attempt < 2:
                value = self._read_dashboard()
            else:
                with self._lock:
                    value = self._read_dashboard()
            with self._lock:
                # The signature is the one taken BEFORE the reads, so a change during them can never be hidden;
                # a mixed result is neither returned nor cached.
                if getattr(self, "_dashboard_generation", 0) == generation and self._dashboard_signature() == signature:
                    self._dashboard_cache_signature = signature
                    self._dashboard_cache_value = value
                    return value
                after = (getattr(self, "_dashboard_generation", 0), self._dashboard_signature())
                if attempt == 2:
                    # Read under the lock, so no rebuild ran in between; only the file stat moved (a non-rebuild
                    # write such as meta). Consistent, just not cacheable under the old signature.
                    self._record_dashboard_reread(attempt + 1, (generation, signature), after)
                    return value
            # A write landed during the reads; the mixed result is thrown away and read again -- recorded.
            self._record_dashboard_reread(attempt + 1, (generation, signature), after)
        raise AssertionError("unreachable")

    def _record_dashboard_reread(self, attempt: int, before: tuple[Any, Any], after: tuple[Any, Any]) -> None:
        """Which ledger, and what moved under the read: its write generation and file signature before and
        after, so the event tells them apart."""
        try:
            from service.platform.remediation import emitter

            emitter().emit(component="account_dashboard", mechanism_id="account.dashboard_reread",
                           trigger_reason="ledger_changed_during_read", outcome="succeeded", attempt=attempt,
                           detail={"ledger": Path(str(self.db_path)).name if getattr(self, "db_path", None) else None,
                                   "generation_before": before[0], "generation_after": after[0],
                                   "signature_before": [str(part) for part in before[1]],
                                   "signature_after": [str(part) for part in after[1]]})
        except Exception as exc:
            record_failure(_failure_log, "recording the account dashboard re-read event", exc)

    def _read_dashboard(self) -> dict[str, Any]:
        return {
            "ok": True,
            "actual_account_engine_version": 32,
            "status": self.get_status(),
            "summary": self.get_summary(),
            "positions": self.get_positions(),
            "errors": self.get_errors(),
            "analytics": self.get_analytics(),
            "capital": self.get_capital(),
        }
