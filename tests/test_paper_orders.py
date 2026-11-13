"""模擬下單的委託台 (service/account/paper_orders.py): the checks when an order is placed, the commands it writes for
Rust B, and what it does with the matching's results (state, fills into the paper ledger, deletion, reservation).
The command lines must be what native/analysis_runtime/src/paper.rs reads: tests/fixtures/paper_commands.jsonl is
parsed by a Rust test, and the desk's own lines are compared with it here."""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import pytest

from service.account.account_types import ActualAccountError
from service.account.paper_orders import PaperOrderDesk, tick_size
from tests.support.paper_desk import TPE, append_results, make_desk, read_commands

FIXTURE = Path(__file__).parent / "fixtures" / "paper_commands.jsonl"


def test_tick_sizes():
    from decimal import Decimal as D
    assert tick_size(D("9.99"), "stock") == D("0.01")
    assert tick_size(D("49.95"), "stock") == D("0.05")
    assert tick_size(D("100"), "stock") == D("0.5")
    assert tick_size(D("1005"), "stock") == D("5")
    assert tick_size(D("49.99"), "etf") == D("0.01") and tick_size(D("150"), "etf") == D("0.05")
    assert tick_size(D("51"), "etn") == D("0.05") and tick_size(D("12.51"), "reit") == D("0.01")


def test_an_etn_or_reit_price_steps_on_the_etf_table(tmp_path):
    """The desk checks a price on the 升降單位 of the code's instrument kind (the security master's): an ETN at 50.05
    and a REIT at 12.51 are on the ETF table's 0.05 / 0.01; a stock would need 50.1 / 12.55."""
    from service.account.accounting_core import AccountingCore
    core = AccountingCore()
    assert [core.instrument_kind(code) for code in ("0050", "020000", "02001L", "01001T", "2330", "9103")] == [
        "etf", "etn", "etn", "reit", "stock", "stock"]
    desk, _ledger, _clock = make_desk(tmp_path)
    desk.place({"code": "020000", "side": "買進", "price": "50.05", "qty": 1000})
    desk.place({"code": "01001T", "side": "買進", "price": "12.51", "qty": 1000})
    with pytest.raises(ActualAccountError, match="升降單位"):
        desk.place({"code": "2330", "side": "買進", "price": "50.05", "qty": 1000})


def test_an_order_is_checked_before_it_is_written(tmp_path):
    desk, _ledger, clock = make_desk(tmp_path)
    with pytest.raises(ActualAccountError, match="升降單位"):
        desk.place({"code": "2330", "side": "買進", "price": "100.3", "qty": 1000})
    with pytest.raises(ActualAccountError, match="分成兩筆"):
        desk.place({"code": "2330", "side": "買進", "price": "100", "qty": 1500})
    with pytest.raises(ActualAccountError, match="預扣"):
        desk.place({"code": "2330", "side": "買進", "price_type": "market", "qty": 1000})
    clock.set("08:40")
    with pytest.raises(ActualAccountError, match="只接受 ROD"):
        desk.place({"code": "2330", "side": "買進", "price": "100", "qty": 1000, "tif": "IOC"})
    with pytest.raises(ActualAccountError, match="盤中零股委託時間"):
        desk.place({"code": "2330", "side": "買進", "price": "100", "qty": 10})
    clock.set("13:31")
    with pytest.raises(ActualAccountError, match="整股委託時間"):
        desk.place({"code": "2330", "side": "買進", "price": "100", "qty": 1000})
    clock.set("10:00", "2026-10-17")   # a Saturday
    with pytest.raises(ActualAccountError, match="不是交易日"):
        desk.place({"code": "2330", "side": "買進", "price": "100", "qty": 1000})
    assert not (desk.root / "orders.jsonl").exists(), "nothing refused was written"


def test_the_commands_are_what_rust_b_reads(tmp_path):
    desk, _ledger, _clock = make_desk(tmp_path)
    order = desk.place({"code": "2330", "side": "買進", "price": "100.5", "qty": 2000, "tif": "ROD"})["order"]
    desk.reduce(order["order_id"], 1000)
    desk.replace(order["order_id"], "100")
    desk.cancel(order["order_id"])
    written = read_commands(desk)
    fixture = [json.loads(line) for line in FIXTURE.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert [sorted(c) for c in written] == [sorted(c) for c in fixture[:4]], "the same fields as the fixture Rust parses"
    assert [c["type"] for c in written] == ["new", "reduce", "replace", "cancel"]
    assert written[0]["price"] == 1_005_000 and written[0]["lot"] == "whole" and written[0]["side"] == "buy"
    assert written[2]["order_id"] == order["order_id"] and "new_order_id" not in written[2], "改價 is on the same order"


def test_an_odd_lot_order_carries_the_odd_lot_matching_set_when_it_was_placed(tmp_path):
    # decisions.md 模擬零股的成交方式 (user 11-13): 設定 → 資金 → 模擬帳務 → 零股交易, read when the order is placed.
    desk, ledger, _clock = make_desk(tmp_path)
    assert ledger.get_capital_settings()["markets"]["台股"]["odd_lot_matching"] == "direct", "直接成交 by default"
    first = desk.place({"code": "2330", "side": "買進", "price": "100.5", "qty": 37, "tif": "ROD"})["order"]
    ledger.save_capital_settings({"markets": {"台股": {"odd_lot_matching": "queue"}}})
    second = desk.place({"code": "2317", "side": "買進", "price": "100.5", "qty": 37, "tif": "ROD"})["order"]
    whole = desk.place({"code": "2454", "side": "買進", "price": "100.5", "qty": 1000, "tif": "ROD"})["order"]
    by_id = {c["order_id"]: c for c in read_commands(desk)}
    assert (by_id[first["order_id"]]["odd_matching"], by_id[second["order_id"]]["odd_matching"]) == ("direct", "queue")
    assert "odd_matching" not in by_id[whole["order_id"]], "a whole-lot order has none"
    fixture = [json.loads(line) for line in FIXTURE.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert sorted(by_id[second["order_id"]]) == sorted(fixture[4]), "the same fields as the fixture Rust parses"
    # The queued odd lot keeps the stock's 盤中零股 subscribed beside its quotes; the direct one only the quotes.
    assert desk.working_instruments() == [("2317", False), ("2317", True), ("2330", False), ("2454", False)]
    with pytest.raises(ActualAccountError, match="零股交易"):
        ledger.save_capital_settings({"markets": {"台股": {"odd_lot_matching": "fast"}}})


def test_an_order_carries_its_stock_name(tmp_path):
    """模擬帳務's 委託 shows 股號＋股名: the name is the security master's, as on the ledger's own rows."""
    (tmp_path / "m.csv").write_text("code,name\n2330,台積電\n", encoding="utf-8")
    desk, _ledger, _clock = make_desk(tmp_path)
    order = desk.place({"code": "2330", "side": "買進", "price": "100", "qty": 1000})["order"]
    assert order["name"] == "台積電"
    assert desk.orders()["orders"][0]["name"] == "台積電"


def test_results_drive_the_order_and_fills_reach_the_ledger_once(tmp_path):
    desk, ledger, _clock = make_desk(tmp_path)
    oid = desk.place({"code": "2330", "side": "買進", "price": "100", "qty": 3000})["order"]["order_id"]
    assert desk.view(oid)["state_label"] == "等待撮合"
    append_results(desk, {"type": "read", "id": f"{oid}-R", "cmd_id": oid, "order_id": oid, "after_sequence": 5})
    desk.poll()
    assert desk.view(oid)["state"] == "pending"
    ts = int(datetime(2026, 10, 16, 10, 0, 5, tzinfo=TPE).timestamp() * 1e9)
    append_results(desk, {"type": "entered", "id": f"{oid}-E", "cmd_id": oid, "order_id": oid, "sequence": 6, "exchange_ts_ns": ts},
            {"type": "fill", "id": f"{oid}-F1", "order_id": oid, "code": "2330", "side": "buy", "qty": 2000.0, "price": 1_000_000,
             "exchange_ts_ns": ts, "trading_date": "2026-10-16", "reason": "排隊輪到"})
    desk.poll()
    view = desk.view(oid)
    assert (view["state_label"], view["filled"], view["unfilled"]) == ("部分成交", 2000, 1000)
    assert "ahead_lots" not in view, "the place in the queue is the matching's own, never shown (user 2026-10-17)"
    trades = ledger.get_raw_trades(limit=10)
    assert [(t["trade_id"], t["qty"], t["time"], t["source"], t["order_id"]) for t in trades] == [(oid, 2000, "10:00:05", "paper_match", oid)]
    # The desk restarts and reads the journal again: the fill is not written twice.
    again = PaperOrderDesk(ledger, desk.root, now=_clock.now, clock_ns=_clock.ns)
    again.poll()
    assert len(ledger.get_raw_trades(limit=10)) == 1
    # A matched order's trade is not deleted on its own; the finished order is, with its trade.
    with pytest.raises(ActualAccountError, match="不能單獨刪除"):
        ledger.local_input.local_delete_trade(oid)
    with pytest.raises(ActualAccountError, match="還有效"):
        again.delete(oid)
    append_results(desk, {"type": "done", "id": f"{oid}-D", "order_id": oid, "state": "expired", "reason": "收盤未成交", "filled": 2000.0,
                   "unfilled": 1000.0, "exchange_ts_ns": 0})
    again.poll()
    assert again.view(oid)["state_label"] == "已失效"
    again.delete(oid)
    assert ledger.get_raw_trades(limit=10) == []
    assert again.orders("2026-10-16")["orders"] == []
    assert PaperOrderDesk(ledger, desk.root, now=_clock.now, clock_ns=_clock.ns).orders("2026-10-16")["orders"] == [], "the deletion is kept"


def test_the_order_history_lists_a_range_of_days_with_each_orders_steps(tmp_path):
    """帳務 → 模擬帳務 → 委託紀錄: the orders of start..end, newest first, each with its fills and 經過 in time order."""
    desk, _ledger, clock = make_desk(tmp_path)
    clock.set("10:00", "2026-10-15")
    old = desk.place({"code": "2317", "side": "賣出", "price": "212.5", "qty": 1000})["order"]["order_id"]
    clock.set("10:00", "2026-10-16")
    oid = desk.place({"code": "2330", "side": "買進", "price": "100", "qty": 3000})["order"]["order_id"]
    ts = lambda s: int(datetime(2026, 10, 16, 10, 0, s, tzinfo=TPE).timestamp() * 1e9)
    append_results(desk, {"type": "entered", "id": f"{oid}-E", "cmd_id": oid, "order_id": oid, "sequence": 6, "exchange_ts_ns": ts(1)},
            {"type": "fill", "id": f"{oid}-F1", "order_id": oid, "code": "2330", "side": "buy", "qty": 2000.0, "price": 1_000_000,
             "exchange_ts_ns": ts(5), "trading_date": "2026-10-16", "reason": "排隊輪到"})
    desk.poll()
    clock.value = datetime(2026, 10, 16, 10, 0, 7, tzinfo=TPE)   # the cancel is sent after the fill
    desk.cancel(oid)
    append_results(desk, {"type": "done", "id": f"{oid}-D", "order_id": oid, "state": "cancelled", "reason": "使用者刪單", "filled": 2000.0,
                   "unfilled": 1000.0, "exchange_ts_ns": ts(9)})
    desk.poll()
    both = desk.history("2026-10-15", "2026-10-16")["orders"]
    assert [o["order_id"] for o in both] == [oid, old]
    assert [o["trading_date"] for o in both] == ["2026-10-16", "2026-10-15"]
    steps = [s["text"] for s in both[0]["steps"]]
    assert steps[:3] == ["委託 3 張 @100 ROD", "進入撮合", "成交 2 張 @100（排隊輪到）"], steps
    assert steps[3:] == ["送出刪單", "已取消：使用者刪單"], steps
    assert both[0]["steps"][1]["time"] == "10:00:01.000"
    assert [o["order_id"] for o in desk.history("2026-10-16", "2026-10-16")["orders"]] == [oid]
    assert desk.history("2026-10-16", "2026-10-15")["start"] == "2026-10-15", "a reversed range is read the right way round"
    with pytest.raises(ActualAccountError, match="日期格式"):
        desk.history("2026/10/15", "2026-10-16")
    with pytest.raises(ActualAccountError, match="最多"):
        desk.history("2024-01-01", "2026-10-16")


def test_the_steps_are_in_the_order_things_happened_and_a_replace_states_what_the_matching_left(tmp_path):
    """10-22 (2603): a reduction still on its way when 改價 is sent leaves 1 張, not the 2 the desk had; an order that
    fills at once lists 委託 first although the PC clock that stamps it runs ahead of the exchange; 全部成交 once. A
    start that reads the journals from their beginning gives the same 經過."""
    desk, ledger, clock = make_desk(tmp_path)
    ts = lambda s: int(datetime(2026, 10, 16, 10, 0, s, tzinfo=TPE).timestamp() * 1e9)
    oid = desk.place({"code": "2330", "side": "買進", "price": "100", "qty": 2000})["order"]["order_id"]
    append_results(desk, {"type": "read", "id": f"{oid}-R", "cmd_id": oid, "order_id": oid},
                   {"type": "entered", "id": f"{oid}-E", "cmd_id": oid, "order_id": oid, "exchange_ts_ns": ts(0)})
    desk.poll()
    clock.value = datetime(2026, 10, 16, 10, 0, 20, tzinfo=TPE)
    desk.reduce(oid, 1000)
    append_results(desk, {"type": "read", "id": f"{oid}:r1-R", "cmd_id": f"{oid}:r1", "order_id": oid})
    desk.poll()
    clock.value = datetime(2026, 10, 16, 10, 0, 23, tzinfo=TPE)
    replaced = desk.replace(oid, "101")
    assert set(replaced) == {"ok", "order"}, "改價 answers with the same order, no second one"
    append_results(desk, {"type": "read", "id": f"{oid}:p2-R", "cmd_id": f"{oid}:p2", "order_id": oid},
                   {"type": "entered", "id": f"{oid}:r1-E", "cmd_id": f"{oid}:r1", "order_id": oid, "exchange_ts_ns": ts(21)},
                   {"type": "reduced", "id": f"{oid}:r1-D", "cmd_id": f"{oid}:r1", "order_id": oid, "qty": 1000.0, "exchange_ts_ns": ts(21)},
                   {"type": "entered", "id": f"{oid}:p2-E", "cmd_id": f"{oid}:p2", "order_id": oid, "exchange_ts_ns": ts(22)},
                   {"type": "replaced", "id": f"{oid}:p2-P", "cmd_id": f"{oid}:p2", "order_id": oid, "qty": 1000.0,
                    "price": 1_010_000, "exchange_ts_ns": ts(22)})
    desk.poll()
    clock.value = datetime(2026, 10, 16, 10, 0, 41, tzinfo=TPE)   # the PC clock, 1 s ahead of the exchange's 40
    sell = desk.place({"code": "2330", "side": "賣出", "price": "99", "qty": 1000})["order"]["order_id"]
    append_results(desk, {"type": "read", "id": f"{sell}-R", "cmd_id": sell, "order_id": sell},
                   {"type": "entered", "id": f"{sell}-E", "cmd_id": sell, "order_id": sell, "exchange_ts_ns": ts(40)},
                   {"type": "fill", "id": f"{sell}-F1", "order_id": sell, "code": "2330", "side": "sell", "qty": 1000.0, "price": 995_000,
                    "exchange_ts_ns": ts(40), "trading_date": "2026-10-16", "reason": "吃單"},
                   {"type": "done", "id": f"{sell}-D", "order_id": sell, "state": "filled", "reason": "", "exchange_ts_ns": ts(40)})
    desk.poll()

    def steps(d):
        return {o: [s["text"] for s in d.view(o)["steps"]] for o in (oid, sell)}

    want = {oid: ["委託 2 張 @100 ROD", "進入撮合", "送出減量 1 張", "送出改價 @101", "減量 1 張 完成", "改價完成 @101（剩 1 張）"],
            sell: ["委託 1 張 @99 ROD", "進入撮合", "成交 1 張 @99.5（吃單）", "全部成交"]}
    assert steps(desk) == want
    # The same order, still working at its new price, with the change (from 100 to 101 at the exchange's 10:00:22).
    view = desk.view(oid)
    assert (view["state"], view["price"], view["unfilled"]) == ("working", 101, 1000)
    assert view["price_changes"] == [{"time": "10:00:22", "from": 100, "to": 101}]
    assert [o["order_id"] for o in desk.orders()["orders"]] == [sell, oid], "two orders, the re-priced one once"
    desk.close()
    (desk.root / "checkpoint.json").unlink()
    again = PaperOrderDesk(ledger, desk.root, now=clock.now, clock_ns=clock.ns)
    assert steps(again) == want, "read from the journals: each command where the matching read it"
    again.close()


def test_working_orders_are_reserved_against_the_limit_and_the_cash(tmp_path):
    desk, ledger, _clock = make_desk(tmp_path)
    ledger.save_capital_settings({"markets": {"台股": {"daily_limit": 250_000, "initial_principal": 1_000_000}}})
    desk.place({"code": "2330", "side": "買進", "price": "100", "qty": 2000})          # 200,000 reserved
    with pytest.raises(ActualAccountError, match="每日交易額度"):
        desk.place({"code": "2317", "side": "買進", "price": "100", "qty": 1000})      # +100,000 > 250,000
    funds = desk.funds()["capital"]
    assert (funds["used_today"], funds["reserved_limit"], funds["remaining_with_orders"]) == (0, 200_000, 50_000)
    assert funds["available_cash"] == 799_920, "1,000,000 - 200,000 - its fee 80 (Codex 10-17 #11)"
    assert funds["trade_terms"] == {kind: {"amount_rounding": "floor", "fee_rate": "0.000399", "min_fee": "1", "fee_rounding": "ceil",
                                           "sell_tax_rate": tax, "tax_rounding": "floor"}
                                     for kind, tax in (("stock", "0.003"), ("etf", "0.001"), ("etn", "0.001"), ("reit", "0.001"))}, \
        "the order ticket prices at the ledger's own terms (2.8 折 by default), per instrument kind"
    assert funds["price_policy"]["tick_table_of_kind"] == {"stock": "stock", "etf": "etf", "etn": "etf", "reit": "etf"}, \
        "the ticket steps prices on the policy's tables"
    ledger.save_capital_settings({"markets": {"台股": {"daily_limit": 0, "initial_principal": 250_000, "fee_discount": 6}}})
    assert desk.funds()["capital"]["trade_terms"]["stock"]["fee_rate"] == "0.000855", "the paper 手續費折扣 (6 折) is the rate used"
    desk.place({"code": "2317", "side": "買進", "price": "100", "qty": 1000})
    assert desk.funds()["capital"]["available_cash"] < 0, \
        "the principal is not a limit: 台股 settles T+2, a buy within the 額度 is accepted (user 11-06)"


def test_paper_lot_rules_apply_to_orders(tmp_path):
    desk, _ledger, _clock = make_desk(tmp_path)
    with pytest.raises(ActualAccountError, match="零股不能當日沖銷"):
        desk.place({"code": "2330", "side": "賣出", "price": "100", "qty": 100})
    desk.place({"code": "2330", "side": "賣出", "price": "100", "qty": 1000})           # 整股 sell first is allowed


def test_a_refused_replace_leaves_the_order_and_a_done_replace_changes_its_price(tmp_path):
    desk, _ledger, _clock = make_desk(tmp_path)
    oid = desk.place({"code": "2330", "side": "買進", "price": "100", "qty": 1000})["order"]["order_id"]
    desk.replace(oid, "99.5")
    assert desk.view(oid)["state_label"] == "刪改中"
    with pytest.raises(ActualAccountError, match="改價中"):
        desk.replace(oid, "99")
    append_results(desk, {"type": "refused", "id": f"{oid}:p1-X", "cmd_id": f"{oid}:p1", "order_id": oid, "reason": "價格超出漲跌停，改價失敗"})
    desk.poll()
    view = desk.view(oid)
    assert (view["state"], view["price"], view["price_changes"]) == ("submitted", 100, []), "refused: the order as it was"
    assert view["messages"] == ["價格超出漲跌停，改價失敗"]
    desk.replace(oid, "99")
    append_results(desk, {"type": "replaced", "id": f"{oid}:p2-P", "cmd_id": f"{oid}:p2", "order_id": oid, "qty": 1000.0, "price": 990_000})
    desk.poll()
    view = desk.view(oid)
    assert (view["price"], [c["to"] for c in view["price_changes"]]) == (99, [99])
    assert len(desk.orders()["orders"]) == 1, "one order, its number kept"
    assert desk.working_instruments() == [("2330", False)]
    # Its reservation is at the price it has now: 99 x 1,000 and its fee.
    assert desk.funds()["capital"]["reserved_limit"] == 99_000


def test_an_order_filled_in_several_prints_is_one_trade_and_one_pair(tmp_path):
    """使用者 11-04: one order number is one trade -- 華邦電 bought 2 張 @142 in two prints 0.4 s apart was two ledger
    trades and two realized pairs. Now the second print adds to the order's trade (same id, first fill's time) and the
    sell before it pairs with it once, with one fee for the buy."""
    desk, ledger, _clock = make_desk(tmp_path)
    at = lambda h, m, s, us=0: int(datetime(2026, 10, 16, h, m, s, us, tzinfo=TPE).timestamp() * 1e9)
    sell = desk.place({"code": "2344", "side": "賣出", "price": "144", "qty": 2000})["order"]["order_id"]
    append_results(desk, {"type": "fill", "id": f"{sell}-F1", "order_id": sell, "code": "2344", "side": "sell", "qty": 2000.0, "price": 1_440_000,
                          "exchange_ts_ns": at(9, 5, 24), "trading_date": "2026-10-16", "reason": "吃單"})
    desk.poll()
    buy = desk.place({"code": "2344", "side": "買進", "price": "142", "qty": 2000})["order"]["order_id"]
    append_results(desk, {"type": "fill", "id": f"{buy}-F1", "order_id": buy, "code": "2344", "side": "buy", "qty": 1000.0, "price": 1_420_000,
                          "exchange_ts_ns": at(9, 33, 36, 302000), "trading_date": "2026-10-16", "reason": "排隊輪到"})
    desk.poll()
    append_results(desk, {"type": "fill", "id": f"{buy}-F2", "order_id": buy, "code": "2344", "side": "buy", "qty": 1000.0, "price": 1_420_000,
                          "exchange_ts_ns": at(9, 33, 36, 730000), "trading_date": "2026-10-16", "reason": "排隊輪到"})
    desk.poll()
    trades = {t["trade_id"]: t for t in ledger.get_raw_trades(limit=10)}
    assert sorted(trades) == sorted([sell, buy]), trades.keys()
    assert (trades[buy]["qty"], trades[buy]["time"], len(trades[buy]["fills"])) == (2000, "09:33:36", 2)
    pairs = ledger.get_realized(None, realized_date="2026-10-16")
    assert [(p["trade_type"], p["direction"], p["qty"]) for p in pairs] == [("當沖", "空", 2000)], pairs
    # A restart reads the journal again: the order's trade stays one, unchanged.
    PaperOrderDesk(ledger, desk.root, now=_clock.now, clock_ns=_clock.ns).poll()
    assert [t["trade_id"] for t in ledger.get_raw_trades(limit=10)].count(buy) == 1


def test_the_fills_tab_lists_matched_and_manual_trades_with_their_cash(tmp_path):
    desk, ledger, _clock = make_desk(tmp_path)
    ledger.local_save_trade({"trade_id": "M1", "trade_date": "2026-10-16", "market": "台股", "code": "2317", "action": "買進",
                             "trade_info": "1000@100", "trade_time": "09:05:00"})
    oid = desk.place({"code": "2330", "side": "買進", "price": "100", "qty": 1000})["order"]["order_id"]
    ts = int(datetime(2026, 10, 16, 10, 0, 5, tzinfo=TPE).timestamp() * 1e9)
    append_results(desk, {"type": "fill", "id": f"{oid}-F1", "order_id": oid, "code": "2330", "side": "buy", "qty": 1000.0, "price": 1_000_000,
                   "exchange_ts_ns": ts, "trading_date": "2026-10-16", "reason": "吃單"})
    desk.poll()
    fills = {f["trade_id"]: f for f in desk.fills("2026-10-16")["fills"]}
    assert (fills["M1"]["origin"], fills[oid]["origin"], fills[oid]["fill_reason"]) == ("手動", "撮合", "吃單")
    assert fills["M1"]["cash"] == -(100_000 + 40), "買進 -(價金 + 手續費 40)"
    capital = desk.funds()["capital"]
    assert capital["today_cash"] == -2 * 100_040 and capital["due_today"] == 0
    # 交割款 opens on its trades: both settle on Tuesday 10-20 (T+2 from Friday).
    assert {row["settlement_date"]: sorted(t["trade_id"] for t in row["trades"]) for row in capital["pending"]} == {"2026-10-20": sorted(["M1", oid])}
    [due] = capital["pending"]
    assert due["amount"] == sum(t["cash"] for t in due["trades"]) == -2 * 100_040, "the date's amount is its trades' 應收付"


def test_the_history_sorts_trades_into_cash_day_trade_and_odd_lot(tmp_path):
    """委託紀錄's 類型 (使用者 10-17): 999 股以內 零股; a buy and a sell the ledger pairs on the same day 當沖; else 現股.
    An order takes its trade's 類型 (零股 by its lot)."""
    desk, ledger, _clock = make_desk(tmp_path)
    for trade_id, code, action, info, at in (("M1", "2330", "買進", "1000@100", "09:05:00"), ("M2", "2330", "賣出", "1000@101", "10:00:00"),
                                             ("M3", "2317", "買進", "1000@100", "09:10:00"), ("M4", "0050", "買進", "300@198", "09:20:00")):
        ledger.local_save_trade({"trade_id": trade_id, "trade_date": "2026-10-16", "market": "台股", "code": code, "action": action,
                                 "trade_info": info, "trade_time": at})
    oid = desk.place({"code": "2454", "side": "買進", "price": "100", "qty": 1000})["order"]["order_id"]
    append_results(desk, {"type": "fill", "id": f"{oid}-F1", "order_id": oid, "code": "2454", "side": "buy", "qty": 1000.0, "price": 1_000_000,
                   "exchange_ts_ns": int(datetime(2026, 10, 16, 10, 0, 5, tzinfo=TPE).timestamp() * 1e9), "trading_date": "2026-10-16",
                   "reason": "吃單"})
    desk.poll()
    odd = desk.place({"code": "0050", "side": "買進", "price": "198", "qty": 100})["order"]["order_id"]
    history = desk.history("2026-10-16", "2026-10-16")
    kinds = {f["trade_id"]: f["kind"] for f in history["fills"]}
    assert kinds == {"M1": "當沖", "M2": "當沖", "M3": "現股", "M4": "零股", oid: "現股"}, kinds
    assert [f["trade_id"] for f in history["fills"]][:2] == [oid, "M2"], "newest first"
    assert {o["order_id"]: o["kind"] for o in history["orders"]} == {oid: "現股", odd: "零股"}
    origin = {f["trade_id"]: (f["origin"], f["order_id"]) for f in history["fills"]}
    assert origin["M1"] == ("手動", "") and origin[oid] == ("撮合", oid)


def test_a_coverage_notice_stays_with_the_order(tmp_path):
    desk, _ledger, _clock = make_desk(tmp_path)
    oid = desk.place({"code": "2330", "side": "買進", "price": "100", "qty": 1000})["order"]["order_id"]
    append_results(desk, {"type": "entered", "id": f"{oid}-E", "cmd_id": oid, "order_id": oid},
            {"type": "notice", "id": f"{oid}-N1", "order_id": oid, "reason": "行情中斷（訂閱中止）：這段期間無法撮合"})
    desk.poll()
    view = desk.view(oid)
    assert view["state"] == "working" and view["messages"] == ["行情中斷（訂閱中止）：這段期間無法撮合"]



def test_a_price_change_holds_one_reservation(tmp_path):
    """Codex 10-17 #9: while a 改價 is on its way, the original holds the reservation and the replacement none."""
    desk, ledger, _clock = make_desk(tmp_path)
    ledger.save_capital_settings({"markets": {"台股": {"daily_limit": 250_000}}})
    oid = desk.place({"code": "2330", "side": "買進", "price": "100", "qty": 2000})["order"]["order_id"]
    desk.replace(oid, "99.5")
    assert desk.funds()["capital"]["reserved_limit"] == 200_000
    desk.place({"code": "2317", "side": "買進", "price": "50", "qty": 1000})                  # 250,000 in all: still fits


def test_a_manual_change_a_working_order_relies_on_is_refused(tmp_path):
    """Codex 10-17 #10: deleting the holdings a working sell will deliver is refused while the sell works."""
    desk, ledger, _clock = make_desk(tmp_path)
    ledger.local_save_trade({"trade_id": "B0", "trade_date": "2026-10-15", "market": "台股", "code": "2330", "action": "買進",
                             "trade_info": "500@100", "trade_time": "09:30:00"})
    desk.place({"code": "2330", "side": "賣出", "price": "101", "qty": 500})                  # 零股 sell of yesterday's shares
    with pytest.raises(ActualAccountError, match="零股不能當日沖銷"):
        ledger.local_input.local_delete_trade("B0")
    assert [t["trade_id"] for t in ledger.get_raw_trades(limit=5)] == ["B0"]


def test_a_deletion_cut_short_is_finished_and_results_are_applied_once(tmp_path):
    """Codex 10-17 #12 / #13: the tombstone comes first and a restart finishes the ledger part; a result written
    twice counts once."""
    desk, ledger, clock = make_desk(tmp_path)
    oid = desk.place({"code": "2330", "side": "買進", "price": "100", "qty": 1000})["order"]["order_id"]
    ts = int(datetime(2026, 10, 16, 10, 0, 5, tzinfo=TPE).timestamp() * 1e9)
    fill = {"type": "fill", "id": f"{oid}-F1", "order_id": oid, "code": "2330", "side": "buy", "qty": 1000.0, "price": 1_000_000,
            "exchange_ts_ns": ts, "trading_date": "2026-10-16", "reason": "吃單"}
    append_results(desk, fill, fill, {"type": "done", "id": f"{oid}-D", "order_id": oid, "state": "filled", "reason": "全部成交", "filled": 1000.0})
    desk.poll()
    assert desk.view(oid)["filled"] == 1000 and len(ledger.get_raw_trades(limit=5)) == 1
    # The tombstone reached local.jsonl, the ledger write did not (a crash in between).
    with open(desk.root / "local.jsonl", "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"type": "deleted", "order_id": oid, "trades": [oid]}) + "\n")
    PaperOrderDesk(ledger, desk.root, now=clock.now, clock_ns=clock.ns)
    assert ledger.get_raw_trades(limit=5) == [], "the restart finished the deletion"


def test_a_restart_reads_the_checkpoint_and_finished_days_leave_memory_for_their_archive(tmp_path):
    """The desk keeps its state in checkpoint.json at the journals' offsets, so a start reads only what came after;
    the finished orders of earlier days are kept one file per day and still listed, viewed and deleted."""
    desk, ledger, clock = make_desk(tmp_path)
    oid = desk.place({"code": "2330", "side": "買進", "price": "100", "qty": 1000})["order"]["order_id"]
    ts = int(datetime(2026, 10, 16, 10, 0, 5, tzinfo=TPE).timestamp() * 1e9)
    append_results(desk, {"type": "fill", "id": f"{oid}-F1", "order_id": oid, "code": "2330", "side": "buy", "qty": 1000, "price": 1_000_000,
                   "exchange_ts_ns": ts, "trading_date": "2026-10-16", "reason": "吃單"},
            {"type": "done", "id": f"{oid}-D", "order_id": oid, "state": "filled", "reason": "全部成交", "filled": 1000})
    desk.poll()
    checkpoint = json.loads((desk.root / "checkpoint.json").read_text(encoding="utf-8"))
    assert checkpoint["schema"] == "paper-desk-checkpoint-v1"
    assert checkpoint["results_offset"] == (desk.root / "results.jsonl").stat().st_size
    assert checkpoint["orders_offset"] == (desk.root / "orders.jsonl").stat().st_size
    desk.close()
    # A restart the same day: the journals before the offsets are not read again (a damaged early line is past them).
    with open(desk.root / "orders.jsonl", "r+b") as fh:
        fh.write(b"#")
    same_day = PaperOrderDesk(ledger, desk.root, now=clock.now, clock_ns=clock.ns)
    assert same_day.view(oid)["filled"] == 1000 and len(ledger.get_raw_trades(limit=5)) == 1
    same_day.close()
    # The next trading day: yesterday's finished order moves to history/2026-10-16.json and out of memory.
    clock.set("10:00", "2026-10-19")
    next_day = PaperOrderDesk(ledger, desk.root, now=clock.now, clock_ns=clock.ns)
    assert oid not in next_day._orders and oid not in json.dumps(json.loads((desk.root / "checkpoint.json").read_text("utf-8")))
    archived = json.loads((desk.root / "history" / "2026-10-16.json").read_text(encoding="utf-8"))
    assert archived["schema"] == "paper-desk-day-v1" and oid in archived["orders"]
    assert [o["order_id"] for o in next_day.history("2026-10-16", "2026-10-19")["orders"]] == [oid]
    assert [o["order_id"] for o in next_day.orders("2026-10-16")["orders"]] == [oid]
    assert next_day.view(oid)["state"] == "filled"
    assert next_day._next_order_id("2026-10-19").endswith("-0001")
    next_day.delete(oid)
    assert ledger.get_raw_trades(limit=5) == [] and next_day.history("2026-10-16", "2026-10-19")["orders"] == []
    next_day.close()


def test_an_unreadable_checkpoint_falls_back_to_the_journals(tmp_path):
    desk, ledger, clock = make_desk(tmp_path)
    oid = desk.place({"code": "2330", "side": "買進", "price": "100", "qty": 1000})["order"]["order_id"]
    desk.close()
    (desk.root / "checkpoint.json").write_text("{broken", encoding="utf-8")
    again = PaperOrderDesk(ledger, desk.root, now=clock.now, clock_ns=clock.ns)
    assert again.view(oid)["state"] == "submitted"
    assert json.loads((desk.root / "checkpoint.json").read_text(encoding="utf-8"))["schema"] == "paper-desk-checkpoint-v1"
    again.close()
