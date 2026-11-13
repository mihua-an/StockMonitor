"""資金: a ledger's principal, settlement dates and daily trading limit, and the paper ledger's trading rules.

Each trade settles on its settlement date: 台股 T+2 TWSE trading days (config/market_holidays.json), 美股 T+1 NYSE
trading days. The principal changes only then -- a buy today leaves the principal where it is until it settles; until
then the amount is 待交割. A trade's cash is the ledger's own (order_legs): buy -(價金 + 手續費 + 稅), sell
+(價金 - 手續費 - 稅).

Settings live in the ledger's own meta (the account domain is their only writer), per market because the two
currencies differ. Each ledger has its own scope (CapitalScope): the actual ledger keeps only 每日交易額度 for 台股 and
美股 (its money is the broker's, so it has no 起始本金); the paper ledger is 台股 only and keeps 起始本金 and
每日交易額度 (user 2026-10-16). The paper ledger enforces its limit and the Taiwan lot rules when a trade is saved;
the actual ledger records trades that already happened, so it only reports them.

Taiwan lot rules (paper ledger): an order is 整股 (whole lots of 1,000 shares) or 零股 (1-999 shares). 零股 cannot
be day-traded: shares bought as 零股 cannot be sold the same day, and a 零股 sell can only sell shares held from
before that day. 整股 can be day-traded both ways (buy then sell, or sell first in whole lots). 每日交易額度 counts
the day's buys and its sell-first (short) part, in 價金; a buy that covers a short takes none.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from functools import lru_cache
from typing import Any, Iterable
from zoneinfo import ZoneInfo

from config.market_holidays import tw_is_trading_day
from service.account.account_types import invalid_account_input
from service.account.accounting_core import TW_FEE_RATE, TW_LIST_FEE_RATE, AccountingCore


ZERO = Decimal("0")
LOT = Decimal("1000")
MARKETS = ("台股", "美股")
SETTLEMENT_DAYS = {"台股": 2, "美股": 1}
MARKET_ZONES = {"台股": "Asia/Taipei", "美股": "America/New_York"}
SETTING_FIELDS = ("initial_principal", "daily_limit")
FIELD_LABELS = {"initial_principal": "起始本金", "daily_limit": "每日交易額度", "fee_discount": "手續費折扣",
                "odd_lot_matching": "零股交易"}
# 模擬下單's 零股交易 (decisions.md 模擬零股的成交方式, user 11-13): `direct` fills at the whole-lot book's best price,
# `queue` subscribes the stock's 盤中零股 and queues at its matches. A choice, not an amount: the first is the default.
CHOICE_FIELDS = {"odd_lot_matching": ("direct", "queue")}


@dataclass(frozen=True)
class CapitalScope:
    """The markets a ledger trades and the 資金 settings it keeps."""
    markets: tuple[str, ...]
    fields: tuple[str, ...]

    def describe(self) -> dict[str, list[str]]:
        return {"markets": list(self.markets), "fields": list(self.fields)}


ACTUAL_SCOPE = CapitalScope(MARKETS, ("daily_limit",))
# fee_discount: the paper ledger's 手續費 折數 (2.8 = 2.8 折 of the list rate; 0 = the actual account's 2.8 折).
PAPER_SCOPE = CapitalScope(("台股",), SETTING_FIELDS + ("fee_discount", "odd_lot_matching"))


# ---------------------------------------------------------------------------------------------------------------
# Trading days
# ---------------------------------------------------------------------------------------------------------------
def _observed(day: date) -> date:
    """A fixed-date NYSE holiday on a weekend is observed on the Friday before / Monday after."""
    if day.weekday() == 5:
        return day - timedelta(days=1)
    if day.weekday() == 6:
        return day + timedelta(days=1)
    return day


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    first = date(year, month, 1)
    return first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (n - 1))


def _last_weekday(year: int, month: int, weekday: int) -> date:
    last = (date(year, month + 1, 1) if month < 12 else date(year + 1, 1, 1)) - timedelta(days=1)
    return last - timedelta(days=(last.weekday() - weekday) % 7)


def _easter(year: int) -> date:
    """Gregorian Easter Sunday (anonymous algorithm)."""
    a, b, c = year % 19, year // 100, year % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7  # noqa: E741 -- the algorithm's own name
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    return date(year, month, (h + l - 7 * m + 114) % 31 + 1)


# Full-day NYSE closures outside its recurring rules (national days of mourning, Hurricane Sandy). A new one is
# added here when the exchange announces it.
NYSE_SPECIAL_CLOSURES = frozenset({
    date(2012, 10, 29), date(2012, 10, 30),   # Hurricane Sandy
    date(2018, 12, 5),                        # President George H. W. Bush
    date(2025, 1, 9),                         # President Jimmy Carter
})


@lru_cache(maxsize=16)
def nyse_holidays(year: int) -> frozenset[date]:
    """The NYSE's full-day closures of `year` by its published rules (New Year's Day falling on a Saturday is not
    observed on the Friday before)."""
    days = {
        date(year, 1, 1) if date(year, 1, 1).weekday() != 5 else None,
        _observed(date(year, 1, 1)) if date(year, 1, 1).weekday() == 6 else None,
        _nth_weekday(year, 1, 0, 3),            # Martin Luther King Jr. Day
        _nth_weekday(year, 2, 0, 3),            # Washington's Birthday
        _easter(year) - timedelta(days=2),      # Good Friday
        _last_weekday(year, 5, 0),              # Memorial Day
        _observed(date(year, 6, 19)) if year >= 2022 else None,  # Juneteenth
        _observed(date(year, 7, 4)),            # Independence Day
        _nth_weekday(year, 9, 0, 1),            # Labor Day
        _nth_weekday(year, 11, 3, 4),           # Thanksgiving
        _observed(date(year, 12, 25)),          # Christmas
    }
    return frozenset({day for day in days if day is not None} | {day for day in NYSE_SPECIAL_CLOSURES if day.year == year})


def is_trading_day(market: str, day: date) -> bool:
    if day.weekday() >= 5:
        return False
    if market == "美股":
        return day not in nyse_holidays(day.year)
    return tw_is_trading_day(day)


def settlement_date(market: str, trade_date: str) -> str:
    """The date a trade of `trade_date` settles on: T+2 (台股) / T+1 (美股) trading days."""
    day = date.fromisoformat(str(trade_date)[:10])
    remaining = SETTLEMENT_DAYS.get(market, 2)
    while remaining:
        day += timedelta(days=1)
        if is_trading_day(market, day):
            remaining -= 1
    return day.isoformat()


@lru_cache(maxsize=4)
def _zone(market: str) -> ZoneInfo:
    # Read when first needed, not at import: importing the ledger must not load the time-zone database.
    return ZoneInfo(MARKET_ZONES[market])


def market_today(market: str, now: datetime | None = None) -> str:
    return (now or datetime.now(_zone(market))).astimezone(_zone(market)).date().isoformat()


# ---------------------------------------------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------------------------------------------
def _meta_key(market: str, field: str) -> str:
    return f"capital.{market}.{field}"


def _amount(value: Any, label: str) -> Decimal:
    text = str(value if value is not None else "").replace(",", "").strip()
    if text == "":
        return ZERO
    try:
        number = Decimal(text)
    except InvalidOperation:
        raise invalid_account_input(f"{label}必須是數字") from None
    if not number.is_finite() or number < 0:
        raise invalid_account_input(f"{label}不可為負數")
    return number


def read_settings(get_meta, scope: CapitalScope) -> dict[str, dict[str, str]]:
    """{market: {field: value}} of the scope's markets and fields as stored: an amount as decimal text ("0" when not
    set), a choice as its value (its first when not set)."""
    def stored(market: str, field: str) -> str:
        default = CHOICE_FIELDS[field][0] if field in CHOICE_FIELDS else "0"
        return get_meta(_meta_key(market, field), default) or default
    return {market: {field: stored(market, field) for field in scope.fields} for market in scope.markets}


def settings_to_meta(payload: dict[str, Any], scope: CapitalScope) -> dict[str, str]:
    """A settings payload ({markets: {台股: {...}, ...}}) validated into meta values; a market or a field outside
    the ledger's scope is refused."""
    markets = (payload or {}).get("markets")
    if not isinstance(markets, dict):
        raise invalid_account_input("缺少 markets")
    values: dict[str, str] = {}
    for market, entry in markets.items():
        if market not in scope.markets:
            raise invalid_account_input(f"不支援的市場：{market}")
        if not isinstance(entry, dict):
            raise invalid_account_input(f"{market} 的設定格式不正確")
        for field, value in entry.items():
            if field not in scope.fields:
                raise invalid_account_input(f"這個帳本沒有{FIELD_LABELS.get(field, field)}設定")
            if field in CHOICE_FIELDS:
                if value not in CHOICE_FIELDS[field]:
                    raise invalid_account_input(f"{FIELD_LABELS[field]}必須是 {'、'.join(CHOICE_FIELDS[field])} 之一")
                values[_meta_key(market, field)] = value
                continue
            amount = _amount(value, f"{market}{FIELD_LABELS[field]}")
            if field == "fee_discount" and amount > 10:
                raise invalid_account_input("手續費折扣是 0～10 折")
            values[_meta_key(market, field)] = str(amount)
    return values


def fee_rate(settings: dict[str, dict[str, str]]):
    """The 台股 fee rate a ledger's settings give: its 折扣 of the list rate, or the actual account's rate."""
    discount = Decimal(settings.get("台股", {}).get("fee_discount") or "0")
    return TW_LIST_FEE_RATE * discount / 10 if discount > 0 else TW_FEE_RATE


# ---------------------------------------------------------------------------------------------------------------
# Cash, settlement and the daily limit
# ---------------------------------------------------------------------------------------------------------------
@dataclass
class CapitalTrade:
    trade_id: str
    trade_date: str
    trade_time: str
    source_order: int
    market: str
    action: str
    code: str
    qty: Decimal
    gross: Decimal


@dataclass
class _Outcome:
    short_qty: Decimal = ZERO      # the part of a sell that sold shares not held (sell first)
    cover_qty: Decimal = ZERO      # the part of a buy that bought back a short
    violation: str = ""            # why the paper ledger could not have taken this trade ("" = it could)


def _order_key(trade: CapitalTrade) -> tuple[str, str, int]:
    return (trade.trade_date, trade.trade_time or "99:99:99", trade.source_order)


def simulate(trades: Iterable[CapitalTrade]) -> dict[str, _Outcome]:
    """One walk over every trade in time order, one inventory per (market, code): each trade's sell-first part and,
    for 台股, whether the lot rules allow it. The daily limit and the save-time checks both read this one result.

    台股: the day opens with what earlier days left. A 零股 sell may only sell from that opening stock (less what the
    day already sold); a 整股 sell may also sell the day's 整股 buys, and what it sells beyond that is sell-first, in
    whole lots. A 整股 buy first buys back what is short (its cover part, never sellable again that day); the day's
    零股 buys are never sellable that day and never cover a sell-first position. 美股: no lot rules; a sell beyond the
    position held is sell-first and a buy first covers it."""
    outcomes: dict[str, _Outcome] = {}
    state: dict[tuple[str, str], dict[str, Any]] = {}
    for trade in sorted(trades, key=_order_key):
        key = (trade.market, trade.code)
        book = state.setdefault(key, {"net": ZERO, "day": "", "open": ZERO, "whole_bought": ZERO, "sold": ZERO})
        if book["day"] != trade.trade_date:
            book.update(day=trade.trade_date, open=max(ZERO, book["net"]), whole_bought=ZERO, sold=ZERO)
        outcome = outcomes[trade.trade_id] = _Outcome()
        if trade.action == "買進" and not (trade.market == "台股" and trade.qty % LOT != 0):
            outcome.cover_qty = min(trade.qty, max(ZERO, -book["net"]))
        if trade.market == "台股":
            odd = trade.qty % LOT != 0
            if odd and trade.qty >= LOT:
                outcome.violation = f"台股一筆委託是整股（1,000 股的倍數）或零股（1~999 股），{_fmt(trade.qty)} 股要分成兩筆"
            elif trade.action == "買進":
                if not odd:
                    book["whole_bought"] += trade.qty - outcome.cover_qty
            elif odd:
                sellable = book["open"] - book["sold"]
                if trade.qty > sellable:
                    outcome.violation = (f"零股不能當日沖銷：{trade.code} 在 {trade.trade_date} 之前持有可賣 "
                                         f"{_fmt(max(ZERO, sellable))} 股，不能賣出 {_fmt(trade.qty)} 股")
            else:
                sellable = max(ZERO, book["open"] + book["whole_bought"] - book["sold"])
                outcome.short_qty = max(ZERO, trade.qty - sellable)
                if outcome.short_qty % LOT != 0:
                    outcome.violation = f"先賣後買只能以整股進行：{trade.code} 可賣 {_fmt(sellable)} 股"
            if trade.action == "賣出":
                book["sold"] += trade.qty
        elif trade.action == "賣出":
            outcome.short_qty = max(ZERO, trade.qty - max(ZERO, book["net"]))
        book["net"] += trade.qty if trade.action == "買進" else -trade.qty
    return outcomes


def used_limit(trades: list[CapitalTrade], market: str, day: str, outcomes: dict[str, _Outcome] | None = None) -> Decimal:
    """The 額度 a day used: its buys' 價金 less what bought back a short (covering takes no 額度), and its
    sells' sell-first part."""
    outcomes = outcomes if outcomes is not None else simulate(trades)
    used = ZERO
    for trade in trades:
        if trade.market != market or trade.trade_date != day or trade.qty <= 0:
            continue
        if trade.action == "買進":
            used += trade.gross * (trade.qty - outcomes[trade.trade_id].cover_qty) / trade.qty
        else:
            used += trade.gross * outcomes[trade.trade_id].short_qty / trade.qty
    return used


def capital_view(legs: Iterable[dict[str, Any]], trades: list[CapitalTrade], settings: dict[str, dict[str, str]],
                 scope: CapitalScope, *, now: datetime | None = None) -> dict[str, Any]:
    """Per market of the scope: what is still to settle (`pending`: one row per settlement date, its amount and the
    trades it is made of, each with its 價金, fee, tax and 應收付), the day's limit use, the 交割款 of today's trades
    (`today_cash`) and what settles today (`due_today`); with 起始本金 in the scope also the principal now (settled) and
    once everything has settled. `legs` are order_legs rows (trade_id, trade_date, trade_time, source_order, market,
    code, action, qty, gross_amount, fee, tax) in trade order; a trade's legs make one trade row. This is the one
    settlement projection: the 帳務 cards and the 模擬下單 desk's 交割款 (PaperOrderDesk.funds) select from it."""
    pending: dict[str, dict[str, Decimal]] = {market: {} for market in scope.markets}
    pending_trades: dict[str, dict[str, dict[str, dict[str, Any]]]] = {market: {} for market in scope.markets}
    settled: dict[str, Decimal] = {market: ZERO for market in scope.markets}
    today_cash: dict[str, Decimal] = {market: ZERO for market in scope.markets}
    due_today: dict[str, Decimal] = {market: ZERO for market in scope.markets}
    today = {market: market_today(market, now) for market in scope.markets}
    for leg in legs:
        market = str(leg["market"])
        if market not in scope.markets:
            continue
        gross, fee, tax = Decimal(str(leg["gross_amount"])), Decimal(str(leg["fee"])), Decimal(str(leg["tax"]))
        cash = AccountingCore.trade_cash(str(leg["action"]), gross, fee, tax)
        due = settlement_date(market, str(leg["trade_date"]))
        if str(leg["trade_date"]) == today[market]:
            today_cash[market] += cash
        if due == today[market]:
            due_today[market] += cash
        if due <= today[market]:
            settled[market] += cash
        else:
            pending[market][due] = pending[market].get(due, ZERO) + cash
            trade = pending_trades[market].setdefault(due, {}).setdefault(str(leg["trade_id"]), {
                "trade_id": str(leg["trade_id"]), "date": str(leg["trade_date"]), "time": str(leg["trade_time"]),
                "code": str(leg["code"]), "action": str(leg["action"]),
                "qty": ZERO, "gross_amount": ZERO, "fee": ZERO, "tax": ZERO, "cash": ZERO})
            for field, value in (("qty", Decimal(str(leg["qty"]))), ("gross_amount", gross), ("fee", fee), ("tax", tax), ("cash", cash)):
                trade[field] += value
    outcomes = simulate(trades)
    out: dict[str, Any] = {}
    for market in scope.markets:
        limit = Decimal(settings[market]["daily_limit"])
        money = ("qty", "gross_amount", "fee", "tax", "cash")
        due_rows = [{"settlement_date": due, "amount": _number(amount),
                     "trades": [{**trade, **{field: _number(trade[field]) for field in money}}
                                for trade in pending_trades[market][due].values()]}
                    for due, amount in sorted(pending[market].items())]
        pending_total = sum(pending[market].values(), ZERO)
        used = used_limit(trades, market, today[market], outcomes)
        view = out[market] = {
            "today": today[market],
            "pending": due_rows,
            "pending_total": _number(pending_total),
            "daily_limit": _number(limit),
            "used_today": _number(used),
            "remaining_today": _number(limit - used) if limit > 0 else None,
            "settlement_days": SETTLEMENT_DAYS[market],
            "today_cash": _number(today_cash[market]),
            "due_today": _number(due_today[market]),
        }
        if "initial_principal" in scope.fields:
            principal = Decimal(settings[market]["initial_principal"])
            view.update(initial_principal=_number(principal), principal=_number(principal + settled[market]),
                        principal_after_settlement=_number(principal + settled[market] + pending_total))
    return out


def _number(value: Decimal) -> int | float:
    return int(value) if value == value.to_integral_value() else float(value)


# ---------------------------------------------------------------------------------------------------------------
# Paper ledger trade rules
# ---------------------------------------------------------------------------------------------------------------
def trades_from_orders(orders: Iterable[Any]) -> list[CapitalTrade]:
    return [CapitalTrade(o.trade_id, o.trade_date, o.trade_time, int(o.source_order), o.market, o.action, o.code, o.qty, o.gross_amount)
            for o in orders]


def check_paper_ledger(trades: list[CapitalTrade], settings: dict[str, dict[str, str]], *,
                       stocks_from: dict[tuple[str, str], str], limit_days: set[tuple[str, str]]) -> None:
    """Refuse a change of the paper ledger (invalid_account_input says why). `trades` is the ledger as it would be
    after the change. Checked: the lot rules of every trade of a changed stock from the earliest day the change
    touches (a later sell may now lack the shares it sold), and the limit of every day the change touches."""
    outcomes = simulate(trades)
    for trade in sorted(trades, key=_order_key):
        start = stocks_from.get((trade.market, trade.code))
        if start is not None and trade.trade_date >= start and outcomes[trade.trade_id].violation:
            raise invalid_account_input(f"{trade.trade_date} {trade.code} {trade.action} {_fmt(trade.qty)} 股：{outcomes[trade.trade_id].violation}")
    for market, day in sorted(limit_days):
        limit = Decimal(settings.get(market, {}).get("daily_limit") or "0")
        if limit > 0:
            used = used_limit(trades, market, day, outcomes)
            if used > limit:
                raise invalid_account_input(f"{day} {market}每日交易額度 {_fmt(limit)} 已不足：這個變更之後已用 {_fmt(used)}")


def _fmt(value: Decimal) -> str:
    return f"{value:,.0f}" if value == value.to_integral_value() else f"{value:,.2f}"
