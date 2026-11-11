"""The phone's data (Scriptable widgets), computed here and published whole to the GAS Web App.

The GAS project does not compute these answers itself from sheets this
desktop app wrote back (交易明細／配對明細) and from spreadsheet formulas on top of them -- a second
implementation of the accounting that could drift from this one. Each builder below is a line-for-line
port of the GAS function named in its docstring, fed from the ledger instead of sheets, with Decimal
arithmetic throughout. Numbers leave as JSON only at the end (`_out`): amounts at the market's unit, rates
at the precision the phone reads.

Two answers depend on the day the phone asks (historyTrade's "N-th recent weekday", dayTradeEntryTime's
"which weekdays to show today"). They are published per date / per weekday, and the GAS side only selects
the key (docs/system-architecture/gas_mobile_design.md section 4).
"""
from __future__ import annotations

import csv
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any

from service.account.account_types import ledger_decimal
from service.account.trade_metrics import (ENTRY_TIME_BANDS, entry_band, entry_minute, invested_amount, metric_summary, return_rate,
                                           trade_weekday)

ZERO = Decimal("0")
CENT = Decimal("0.01")
RATE = Decimal("0.0001")          # GAS round4
FINE_RATE = Decimal("0.00000001")  # rates GAS did not round (rank): kept far below anything the phone shows
DAYTRADE = "當沖"
US = "美股"
TW = "台股"
WEEKDAY_LABELS = {1: "週一", 2: "週二", 3: "週三", 4: "週四", 5: "週五"}
HISTORY_WEEKDAYS = 10


def _dec(value: Any) -> Decimal:
    return ledger_decimal(value)


def _round(value: Decimal, step: Decimal) -> Decimal:
    return value.quantize(step, rounding=ROUND_HALF_UP)


def _out(value: Decimal) -> int | float:
    """A Decimal as a JSON number: an integer when it is one, otherwise the nearest double."""
    if value == value.to_integral_value():
        return int(value)
    return float(value)


def _slash_date(text: Any) -> str:
    return str(text or "").strip().replace("-", "/")[:10]


def _parse_date(text: Any) -> date | None:
    try:
        return datetime.strptime(_slash_date(text), "%Y/%m/%d").date()
    except ValueError:  # not an error: date coercion: text that is not a date is None by contract
        return None


def _monday(day: date) -> date:
    return day - timedelta(days=day.weekday())


@dataclass(frozen=True)
class Match:
    """One realized_matches row, the fields the phone reads (配對明細 in the old sheet)."""
    realized_date: str
    market: str
    code: str
    trade_type: str
    direction: str
    qty: Decimal          # shares (the TW day-trade display unit, 張, is derived in `volume`)
    buy_price: Decimal
    sell_price: Decimal
    buy_amount: Decimal
    sell_amount: Decimal
    tax: Decimal
    fee: Decimal
    profit: Decimal
    buy_ref: str
    sell_ref: str

    @property
    def is_daytrade(self) -> bool:
        return self.trade_type == DAYTRADE

    @property
    def volume(self) -> Decimal:
        return self.qty / Decimal(1000) if self.is_daytrade and self.market == TW else self.qty

    @property
    def invested(self) -> Decimal:
        return invested_amount(self.direction, self.buy_amount, self.sell_amount)


@dataclass(frozen=True)
class Leg:
    """One order_legs row (交易明細 in the old sheet)."""
    trade_date: str
    market: str
    code: str
    trade_type: str
    action: str
    qty: Decimal
    price: Decimal
    gross: Decimal
    tax: Decimal
    fee: Decimal
    trade_time: str
    order: int


@dataclass(frozen=True)
class Holding:
    code: str
    market: str
    qty: Decimal            # negative for a short
    avg_cost: Decimal
    cost: Decimal           # a long's paid with the buy fee; a short's brought in after fee and tax
    closing_terms: dict[str, str]   # what closing it would be charged, the ledger's own (AccountingCore.closing_terms)


@dataclass(frozen=True)
class Security:
    name: str
    market: str   # tse / otc


class MobileData:
    """The ledger facts every phone answer is built from."""

    def __init__(self, legs: list[Leg], matches: list[Match], holdings: list[Holding], securities: dict[str, Security],
                 performance: dict[str, dict[str, Decimal]]):
        self.legs = legs
        self.matches = matches
        self.holdings = holdings
        self.securities = securities
        # The ledger's one per-market performance (AccountAnalyticsService.market_performance), of this snapshot.
        self.performance = performance

    @classmethod
    def from_ledger(cls, ledger, security_master_path: Path) -> "MobileData":
        # One snapshot: legs, matches and positions of the same ledger version (a rebuild between separate reads
        # mixed two versions in one phone answer).
        with ledger.repository.snapshot(caller="account.mobile_api.read") as conn:
            legs = [Leg(_slash_date(r["trade_date"]), str(r["market"]), str(r["code"]), str(r["trade_type"]), str(r["action"]),
                        _dec(r["qty"]), _dec(r["avg_price"]), _dec(r["gross_amount"]), _dec(r["tax"]), _dec(r["fee"]),
                        str(r["trade_time"] or "")[:5], int(r["source_order"]))
                    for r in conn.execute("SELECT * FROM order_legs ORDER BY trade_date, source_order, id").fetchall()]
            matches = [Match(_slash_date(r["realized_date"]), str(r["market"]), str(r["code"]), str(r["trade_type"]),
                             str(r["direction"] or ""), _dec(r["qty"]), _dec(r["buy_price"]), _dec(r["sell_price"]),
                             _dec(r["buy_amount"]), _dec(r["sell_amount"]), _dec(r["tax"]), _dec(r["fee"]), _dec(r["profit"]),
                             str(r["buy_ref"] or ""), str(r["sell_ref"] or ""))
                       for r in conn.execute("SELECT * FROM realized_matches ORDER BY realized_date, sort_order, id").fetchall()]
            positions = conn.execute("SELECT market,code,qty,cost_amount,avg_cost FROM positions").fetchall()
            performance = ledger.market_performance(conn)
        # 個股明細 lists every open position, long or short, 台股 and 美股, in the order each code was first traded.
        first_traded: dict[str, int] = {}
        for leg in legs:
            first_traded.setdefault(leg.code, leg.order)
        holdings = []
        for row in positions:
            qty = _dec(row["qty"])
            market, code = str(row["market"]), str(row["code"])
            if market in (TW, US) and qty != 0:
                holdings.append(Holding(code, market, qty, _dec(row["avg_cost"]), _dec(row["cost_amount"]),
                                        ledger.accounting_core.closing_terms(market, code)))
        holdings.sort(key=lambda holding: (first_traded.get(holding.code, 1 << 62), holding.code))
        return cls(legs, matches, holdings, load_securities(security_master_path), performance)

    def name(self, market: str, code: str) -> str:
        if market == US:
            return code
        security = self.securities.get(code)
        return security.name if security else ""


def load_securities(path: Path | None) -> dict[str, Security]:
    securities: dict[str, Security] = {}
    if path is None or not path.exists():
        return securities
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            code = str(row.get("code") or "").strip().upper()
            if code:
                securities[code] = Security(str(row.get("name") or "").strip(), str(row.get("market") or "").strip().lower())
    return securities


# ------------------------------------------------------------------------------------------- per-stock tables

def _per_stock(data: MobileData, market: str) -> list[dict[str, Any]]:
    """個股損益 rows: per code, realized profit and its return on the matched buy amount, split 現股／當沖. Codes in the
    order the desktop's 個股數據 lists them (total profit high to low, then code)."""
    grouped: dict[str, list[Match]] = {}
    for match in data.matches:
        if match.market == market:
            grouped.setdefault(match.code, []).append(match)
    if market == TW:
        for holding in data.holdings:
            grouped.setdefault(holding.code, [])

    def rate(rows: list[Match]) -> Decimal | None:
        return return_rate((row.profit, row.invested) for row in rows)

    out = []
    for code, rows in grouped.items():
        normal = [row for row in rows if not row.is_daytrade]
        day = [row for row in rows if row.is_daytrade]
        out.append({
            "code": code,
            "total_profit": sum((row.profit for row in rows), ZERO),
            "normal_profit": sum((row.profit for row in normal), ZERO),
            "normal_rate": rate(normal),
            "daytrade_profit": sum((row.profit for row in day), ZERO),
            "daytrade_rate": rate(day),
            "rate": rate(rows),
        })
    out.sort(key=lambda item: (-item["total_profit"], item["code"]))
    return out


def _daily_realized(data: MobileData) -> list[dict[str, Any]]:
    """統計表 rows (台股): per realized date, 現股／當沖 realized and their running totals, oldest first."""
    # One row per date anything traded or was realized (either market); the values are 台股 only. A day with only
    # buys, or only 美股 sells, is still a row with zeros (the old 統計表 had one).
    by_date: dict[str, list[Match]] = {leg.trade_date: [] for leg in data.legs}
    for match in data.matches:
        bucket = by_date.setdefault(match.realized_date, [])
        if match.market == TW:
            bucket.append(match)
    rows, spot_total, day_total = [], ZERO, ZERO
    for day_text in sorted(by_date, key=lambda text: _parse_date(text) or date.min):
        matches = by_date[day_text]
        spot = sum((m.profit for m in matches if not m.is_daytrade), ZERO)
        day = sum((m.profit for m in matches if m.is_daytrade), ZERO)
        spot_total += spot
        day_total += day
        rows.append({"date": _parse_date(day_text), "spot": spot, "day": day,
                     "spot_acc": spot_total, "day_acc": day_total, "stock_acc": spot_total + day_total})
    return [row for row in rows if row["date"]]


# ------------------------------------------------------------------------------------------- the phone's answers

def summary(data: MobileData) -> dict[str, Any]:
    """getSummarysData + calcTarget. The realized and holding figures are the ledger's performance (台股)."""
    daily = _daily_realized(data)

    def target(profits: list[Decimal]) -> Decimal:
        running = ZERO
        for value in profits:
            running += value
            if running < 0:
                return abs(running)
        return ZERO

    newest_first = sorted(daily, key=lambda row: row["date"], reverse=True)
    weeks: dict[date, Decimal] = {}
    months: dict[date, Decimal] = {}
    for row in newest_first:
        weeks[_monday(row["date"])] = weeks.get(_monday(row["date"]), ZERO) + row["day"]
        month = row["date"].replace(day=1)
        months[month] = months.get(month, ZERO) + row["day"]
    return {
        "stockProfit": _out(data.performance[TW]["normal_profit"]),
        "daytradingProfit": _out(data.performance[TW]["daytrade_profit"]),
        "holdingCost": _out(data.performance[TW]["holding_cost"]),
        "dayTarget": _out(target([row["day"] for row in newest_first])),
        "weekTarget": _out(target([weeks[key] for key in sorted(weeks, reverse=True)])),
        "monthTarget": _out(target([months[key] for key in sorted(months, reverse=True)])),
    }


def holdings(data: MobileData) -> dict[str, Any]:
    """getHoldingsData: positions with the exchange channel the phone queries prices from and the terms closing each
    is priced at (the phone applies them as core/trade_costs.js does: shares < 0 is a short, closed by a buy)."""
    active, queue = [], []
    for holding in data.holdings:
        security = data.securities.get(holding.code) if holding.market == TW else None
        # The sheet version named every code tse_ unless it was in the OTC list -- 美股 included.
        ex_ch = f"{'otc' if security and security.market == 'otc' else 'tse'}_{holding.code}.tw"
        # 美股 cost per share is shown in cents; the total cost (valH) stays exact.
        avg_cost = _round(holding.avg_cost, CENT) if holding.market == US else holding.avg_cost
        shares, cost_per_share, cost = _out(holding.qty), _out(avg_cost), _out(holding.cost)
        active.append({"code": holding.code, "name": data.name(holding.market, holding.code), "shares": shares,
                       "costPerShare": cost_per_share, "valH": cost, "exCh": ex_ch,
                       "currentPrice": "", "unrealized": "", "roi": ""})
        queue.append({"code": holding.code, "shares": shares, "valH": cost, "exCh": ex_ch, "closingTerms": holding.closing_terms})
    return {"activeHoldings": active, "priceQueue": queue}


def rank(data: MobileData, kind: str, side: str) -> dict[str, Any]:
    """getRanksData: the 20 best or worst stocks by realized profit, 現股／當沖 (台股) or 美股."""
    rows = []
    if kind in ("spot", "daytrade"):
        for item in _per_stock(data, TW):
            name = data.name(TW, item["code"])
            if not name:
                continue  # the sheet version dropped a code without a name
            profit = item["normal_profit"] if kind == "spot" else item["daytrade_profit"]
            rate = item["normal_rate"] if kind == "spot" else item["daytrade_rate"]
            rows.append((item["code"], name, profit, rate if rate is not None else ZERO))
    else:
        for item in _per_stock(data, US):
            rows.append((item["code"], item["code"], item["total_profit"], item["rate"] if item["rate"] is not None else ZERO))
    if side == "profit":
        rows = sorted((row for row in rows if row[2] > 0), key=lambda row: -row[2])
    else:
        rows = sorted((row for row in rows if row[2] < 0), key=lambda row: row[2])
    top = [{"code": code, "name": name, "profit": _out(profit), "rate": _out(_round(rate, FINE_RATE))}
           for code, name, profit, rate in rows[:20]]
    return {"type": kind, "side": side, "count": len(top), "data": top}


def realized_report(data: MobileData, period: str) -> dict[str, Any]:
    """getRealizedReport: realized 現股／當沖 per day, week or month, newest first, 30 periods."""
    daily = _daily_realized(data)
    groups: dict[date, dict[str, Any]] = {}
    for row in daily:
        if period == "week":
            start = _monday(row["date"])
        elif period == "month":
            start = row["date"].replace(day=1)
        else:
            start = row["date"]
        group = groups.setdefault(start, {"start": start, "latest": row["date"], "spot": ZERO, "day": ZERO,
                                          "spot_acc": ZERO, "day_acc": ZERO, "stock_acc": ZERO})
        group["spot"] += row["spot"]
        group["day"] += row["day"]
        if row["date"] >= group["latest"]:
            group["latest"] = row["date"]
            group["spot_acc"], group["day_acc"], group["stock_acc"] = row["spot_acc"], row["day_acc"], row["stock_acc"]

    def label(start: date) -> str:
        if period == "week":
            return f"{start:%m}/W{(start.day - 1) // 7 + 1}"
        if period == "month":
            return f"{start:%y/%m}"
        return f"{start:%m/%d}"

    items, recent = [], ZERO
    for start in sorted(groups, reverse=True)[:30]:
        group = groups[start]
        recent += group["day"]
        items.append({
            "date": label(start),
            "spotRealized": _out(group["spot"]), "dayTradeRealized": _out(group["day"]),
            "stockRealized": _out(group["spot"] + group["day"]),
            "spotAccumulated": _out(group["spot_acc"]), "dayTradeAccumulated": _out(group["day_acc"]),
            "stockAccumulated": _out(group["stock_acc"]),
            "recentDayTradeAccumulated": _out(recent),
        })
    return {"period": period if period in ("week", "month") else "day", "items": items}


def history_trade(data: MobileData, day: date) -> dict[str, Any]:
    """getHistoryTrade for one date: that day's normal buys, every pair of its normal sells, its day trades."""
    day_text = f"{day:%Y/%m/%d}"
    normal, day_items = [], []
    tw_settlement = us_settlement = day_settlement = day_profit = ZERO

    for leg in data.legs:
        if leg.trade_date != day_text or leg.action != "買進" or leg.trade_type == DAYTRADE:
            continue
        settlement = -leg.gross - leg.fee
        if leg.market == US:
            us_settlement += settlement
        else:
            tw_settlement += settlement
        normal.append({"source": "trade", "order": leg.order, "market": leg.market, "code": leg.code,
                       "name": data.name(leg.market, leg.code), "type": "買進", "buyDate": day_text, "sellDate": "",
                       "volume": _out(leg.qty), "buyPrice": _out(leg.price), "sellPrice": "", "price": _out(leg.price),
                       "profit": _out(settlement), "settlement": _out(settlement), "tradeTime": leg.trade_time,
                       "pairGroupId": "", "pairGroupIndex": "", "pairGroupCount": "", "isSplitPair": False})

    sells = [m for m in data.matches if m.realized_date == day_text and not m.is_daytrade]
    # GAS grouped the pairs of one sell by (sell date, market, code, order); `order` came from a column the sheet
    # left empty, so it was always 0 -- kept so the answer is the same (listed as a GAS defect to decide on).
    group_count: dict[str, int] = {}
    for match in sells:
        key = f"{_slash_date(match.sell_ref)}_{match.market}_{match.code}_0"
        group_count[key] = group_count.get(key, 0) + 1
    group_index: dict[str, int] = {}
    for match in sells:
        key = f"{_slash_date(match.sell_ref)}_{match.market}_{match.code}_0"
        group_index[key] = group_index.get(key, 0) + 1
        sell_net = match.sell_amount - match.tax - match.fee
        if match.market == US:
            us_settlement += sell_net
        else:
            tw_settlement += sell_net
        normal.append({"source": "pair", "order": 0, "market": match.market, "code": match.code,
                       "name": data.name(match.market, match.code), "type": "賣出",
                       "buyDate": _slash_date(match.buy_ref), "sellDate": _slash_date(match.sell_ref),
                       "volume": _out(match.volume), "buyPrice": _out(match.buy_price), "sellPrice": _out(match.sell_price),
                       "price": _out(match.sell_price), "profit": _out(match.profit), "settlement": _out(sell_net),
                       "pairGroupId": key, "pairGroupIndex": group_index[key], "pairGroupCount": group_count[key],
                       "isSplitPair": group_count[key] > 1})

    for match in data.matches:
        if match.realized_date != day_text or not match.is_daytrade:
            continue
        day_profit += match.profit
        day_settlement += match.profit
        tw_settlement += match.profit
        day_items.append({"market": match.market, "code": match.code, "name": data.name(match.market, match.code),
                          "direction": match.direction, "volume": _out(match.volume), "buyPrice": _out(match.buy_price),
                          "sellPrice": _out(match.sell_price), "buyTime": match.buy_ref.strip(), "sellTime": match.sell_ref.strip(),
                          "profit": _out(match.profit), "settlement": _out(match.profit)})

    normal.sort(key=lambda item: (item["order"] or 0, item["pairGroupIndex"] or 0))
    tw_items = [item for item in normal if item["market"] != US]
    us_items = [item for item in normal if item["market"] == US]
    tw_profit = sum((_dec(item["profit"]) for item in tw_items), ZERO)
    us_profit = sum((_dec(item["profit"]) for item in us_items), ZERO)
    r2 = lambda value: _out(_round(value, CENT))
    return {
        "date": day_text,
        "totalSettlement": r2(tw_settlement),
        "dayTrade": {"profit": r2(day_profit), "items": day_items},
        "normalTrade": {"profit": r2(tw_profit), "settlement": r2(tw_settlement - day_settlement), "items": tw_items},
        "usTrade": {"profit": r2(us_profit), "settlement": r2(us_settlement), "items": us_items},
        "settlement": {"tw": r2(tw_settlement), "us": r2(us_settlement), "dayTrade": r2(day_settlement)},
    }


def _day_trades(data: MobileData, weekday: int | None) -> list[Match]:
    """台股 day trades, optionally only those realized on one weekday (trade_metrics.trade_weekday: 1 = Monday ... 5 =
    Friday)."""
    return [match for match in data.matches
            if match.is_daytrade and (weekday is None or trade_weekday(_parse_date(match.realized_date)) == weekday)]


def _stats(matches: list[Match]) -> dict[str, Any]:
    """trade_metrics.metric_summary of these trades: the phone formats its figures and computes none."""
    return metric_summary((m.profit, m.direction, m.invested) for m in matches)


def _rate(rate: Decimal | None, empty: Any = "-") -> Any:
    return empty if rate is None else _out(_round(rate, RATE))


def _money(value: Decimal | None, empty: Any = "-") -> Any:
    return empty if value is None else _out(_round(value, CENT))


def _band_item(stats: dict[str, Any]) -> dict[str, Any]:
    """One entry-time or entry-price band's figures ("-" where the band has no trade of that side)."""
    return {
        "totalProfit": _money(stats["total_profit"] if stats["total_count"] else None),
        "winRate": _rate(stats["win_rate"]),
        "longWinRate": _rate(stats["long_win_rate"]),
        "shortWinRate": _rate(stats["short_win_rate"]),
        "longProfit": _money(stats["long_profit"]),
        "shortProfit": _money(stats["short_profit"]),
    }


def day_trade_entry_time(data: MobileData, weekday: int | None) -> dict[str, Any]:
    """dayTradeEntryTime for one weekday, or the whole week (None): win rates and profit per entry-time band."""
    trades = _day_trades(data, weekday)
    whole = _stats(trades)
    by_band: dict[str, list[Match]] = {label: [] for label, _, _ in ENTRY_TIME_BANDS}
    for match in trades:
        if match.direction in ("多", "空"):
            label = entry_band(entry_minute(match.direction, match.buy_ref, match.sell_ref))
            if label is not None:
                by_band[label].append(match)
    items = [{"timeRange": label, **_band_item(_stats(band))} for label, band in by_band.items()]
    return {"weekday": weekday if weekday is not None else "", "weekdayLabel": WEEKDAY_LABELS.get(weekday, "整週"),
            "summary": {"longWinRate": _rate(whole["long_win_rate"]), "shortWinRate": _rate(whole["short_win_rate"])},
            "items": items}


def day_trade_week_summary(data: MobileData) -> dict[str, Any]:
    """dayTradeWeekSummary: per weekday win rates, profit and 報酬率, 多／空 separately."""
    items = []
    for weekday, name in zip(range(1, 6), "一二三四五"):
        stats = _stats(_day_trades(data, weekday))
        items.append({
            "weekday": name,
            "totalProfit": _money(stats["total_profit"]),
            "winRate": _rate(stats["win_rate"], ""),
            "longWinRate": _rate(stats["long_win_rate"]),
            "shortWinRate": _rate(stats["short_win_rate"]),
            "longProfit": _money(stats["long_profit"], ""),
            "longReturnRate": _rate(stats["long_return_rate"], ""),
            "shortProfit": _money(stats["short_profit"], ""),
            "shortReturnRate": _rate(stats["short_return_rate"], ""),
        })
    whole = _stats(_day_trades(data, None))
    return {"items": items, "dayTradeLongWinRate": _rate(whole["long_win_rate"], 0),
            "dayTradeShortWinRate": _rate(whole["short_win_rate"], 0), "dayTradeWinRate": _rate(whole["win_rate"], 0)}


def day_trade_price_summary(data: MobileData) -> dict[str, Any]:
    """dayTradePriceSummary: win rates and profit per entry-price band (50-dollar steps, then >500)."""
    bands = [("0~50" if i == 1 else f">{(i - 1) * 50}~{i * 50}", Decimal((i - 1) * 50), Decimal(i * 50)) for i in range(1, 11)]
    bands.append((">500", Decimal(500), None))
    grouped: dict[str, list[Match]] = {label: [] for label, _, _ in bands}
    for match in data.matches:
        if not match.is_daytrade:
            continue
        price = match.buy_price if match.direction == "多" else match.sell_price if match.direction == "空" else ZERO
        if price <= 0:
            continue
        for label, lower, upper in bands:
            if price > lower and (upper is None or price <= upper):
                grouped[label].append(match)
                break
    return {"items": [{"range": label, **_band_item(_stats(grouped[label]))} for label, _, _ in bands]}


def recent_weekdays(today: date, count: int = HISTORY_WEEKDAYS) -> list[date]:
    """The `count` most recent weekdays up to and including `today` (GAS getRecentTradingDateByOffset)."""
    days, cursor = [], today
    while len(days) < count:
        if cursor.isoweekday() <= 5:
            days.append(cursor)
        cursor -= timedelta(days=1)
    return days


def preview(ledger, today: date | None = None) -> dict[str, Any]:
    """The 手機卡片 of a ledger for the desktop's view, computed now and sent nowhere: the actual account's preview
    (account_report_publisher adds when it was last published) and the paper wallet's, which is never published
    (使用者 10-17: 模擬帳務 has 手機卡片 on the desktop only)."""
    today = today or date.today()
    data = MobileData.from_ledger(ledger, ledger.security_master_path)
    return {"ok": True, "today": today.isoformat(), "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "entries": build_bundle(data, today)}


def build_bundle(data: MobileData, today: date) -> dict[str, Any]:
    """Every answer the phone can ask for, keyed the way the GAS reader looks them up."""
    bundle: dict[str, Any] = {
        "summary": summary(data),
        "holdings": holdings(data),
        "dayTradeWeekSummary": day_trade_week_summary(data),
        "dayTradePriceSummary": day_trade_price_summary(data),
    }
    for kind in ("spot", "daytrade", "us"):
        for side in ("profit", "loss"):
            bundle[f"rank:{kind}:{side}"] = rank(data, kind, side)
    for period in ("day", "week", "month"):
        bundle[f"realizedReport:{period}"] = realized_report(data, period)
    for day in recent_weekdays(today):
        bundle[f"historyTrade:{day:%Y/%m/%d}"] = history_trade(data, day)
    for weekday in range(1, 6):
        bundle[f"dayTradeEntryTime:{weekday}"] = day_trade_entry_time(data, weekday)
    bundle["dayTradeEntryTime:week"] = day_trade_entry_time(data, None)
    return bundle
