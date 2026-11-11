"""The account page reads a day of one market, a market's trades, one stock's pairs and the 當沖分析 on demand; the
dashboard carries no trade or pair list (R14-23: they grew without bound and 每日明細 / 配對明細 lost days past 5,000
rows)."""
from __future__ import annotations

import pytest

from tests.support.paper_desk import make_desk


def _fill(trade_id: str, day: str, code: str, action: str, price: int, time: str) -> dict:
    return {"order_id": trade_id, "trade_date": day, "code": code, "action": action, "fills": [{"qty": 1000, "price": price}],
            "trade_time": time, "reasons": []}


@pytest.fixture()
def ledger(tmp_path):
    _desk, ledger, _clock = make_desk(tmp_path)
    ledger.local_input.import_matched_orders([
        _fill("B1", "2026-10-14", "2330", "買進", 100, "10:00:00"),     # held overnight
        _fill("S1", "2026-10-15", "2330", "賣出", 110, "10:00:00"),     # 一般, realized on the 15th
        _fill("B2", "2026-10-15", "2317", "買進", 50, "09:30:00"),      # 當沖 多 on the 15th
        _fill("S2", "2026-10-15", "2317", "賣出", 52, "11:00:00"),
    ])
    return ledger


def test_a_sell_with_stock_held_is_a_normal_sell_until_bought_back_the_same_day(tmp_path):
    """使用者 11-04: holding 現股, a sell is first a 現股 sell; bought back the same day it is a 當沖 (沖賣) instead,
    and the 現股 held stays whole -- the two never merge into one position."""
    _desk, ledger, _clock = make_desk(tmp_path)
    fill = lambda tid, day, action, qty, price, time: {**_fill(tid, day, "2344", action, price, time), "fills": [{"qty": qty, "price": price}]}
    qty_of = lambda: [(p["code"], float(p["qty"])) for p in ledger.get_positions()]
    pairs = lambda: [(p["trade_type"], p["direction"], float(p["qty"])) for p in ledger.get_realized(None, realized_date="2026-11-04")]
    ledger.local_input.import_matched_orders([fill("B0", "2026-11-03", "買進", 3000, 138, "10:00:00")])
    ledger.local_input.import_matched_orders([fill("S1", "2026-11-04", "賣出", 2000, 144, "09:05:24")])
    assert qty_of() == [("2344", 1000.0)] and pairs() == [("一般", "", 2000.0)]
    ledger.local_input.import_matched_orders([fill("B1", "2026-11-04", "買進", 2000, 142, "09:33:36")])
    assert qty_of() == [("2344", 3000.0)] and pairs() == [("當沖", "空", 2000.0)]


def test_a_day_holds_its_trades_and_the_pairs_realized_that_day(ledger):
    day = ledger.get_day("台股", "2026-10-15")
    assert day["ok"] and day["market"] == "台股" and day["date"] == "2026-10-15"
    assert {t["trade_id"] for t in day["trades"]} == {"S1", "B2", "S2"}
    assert {(p["code"], p["trade_type"], p["direction"]) for p in day["pairs"]} == {("2330", "一般", ""), ("2317", "當沖", "多")}
    earlier = ledger.get_day("台股", "2026-10-14")
    assert [t["trade_id"] for t in earlier["trades"]] == ["B1"] and earlier["pairs"] == []
    assert ledger.get_day("美股", "2026-10-15") == {"ok": True, "market": "美股", "date": "2026-10-15", "trades": [], "pairs": []}


def test_a_pair_is_one_row_shape_everywhere_and_carries_the_ledgers_closing_terms(tmp_path):
    """每日明細 (get_day), 當沖分析 (get_daytrade_analysis), 個股數據 (get_pairs), 歷史回放's 當沖 list and get_realized hand
    over the same row;
    its closing_terms are the ledger's own (here 6 折, a 當沖's 0.15% tax), which 配對回放 prices the pair with."""
    _desk, ledger, _clock = make_desk(tmp_path)
    ledger.save_capital_settings({"markets": {"台股": {"fee_discount": 6}}})
    ledger.local_input.import_matched_orders([_fill("B2", "2026-10-15", "2317", "買進", 50, "09:30:00"),
                                             _fill("S2", "2026-10-15", "2317", "賣出", 52, "11:00:00")])
    day = ledger.get_day("台股", "2026-10-15")["pairs"]
    assert ledger.get_daytrade_analysis("台股")["pairs"] == day
    assert ledger.get_pairs("台股", "2317")["items"] == day
    assert ledger.get_realized(None, market="台股", realized_date="2026-10-15") == day
    assert ledger.get_daytrade_history_page(scope="today", realized_date="2026-10-15")["items"] == day
    assert ledger.get_daytrade_symbol_date_rows("2026-10-15", "2317") == day
    [pair] = day
    assert pair["closing_terms"] == {"amount_rounding": "floor", "fee_rate": "0.000855", "min_fee": "1", "fee_rounding": "ceil",
                                     "sell_tax_rate": "0.0015", "tax_rounding": "floor"}
    # 52,000 - 50,000 - fees 43 + 45 - tax 78; the renderer's pairNetAtPrice at 52 gives the same
    # (tests/renderer_trade_costs_contract.mjs holds this row).
    assert (pair["buy_fee"], pair["sell_fee"], pair["tax"], pair["profit"]) == (43, 45, 78, 1834)
    assert (pair["roi"], pair["entry_ref"], pair["entry_minute"], pair["hold_period"]) == (1834 / 50000, "09:30", 570, 90)
    assert pair["entry_band"] == "09:30~09:40"


def test_pair_days_sum_each_realized_date(ledger):
    pair_days = ledger.get_analytics()["台股"]["pair_days"]
    assert [d["date"] for d in pair_days] == ["2026-10-15"]
    day = pair_days[0]
    pairs = ledger.get_day("台股", "2026-10-15")["pairs"]
    profit = {p["trade_type"]: p["profit"] for p in pairs}
    assert day["total_count"] == 2
    assert day["total_profit"] == pytest.approx(profit["一般"] + profit["當沖"])
    assert day["daytrade_profit"] == pytest.approx(profit["當沖"]) and day["normal_profit"] == pytest.approx(profit["一般"])
    # 多 / 空 is a day trade's direction; an overnight (一般) pair has none.
    assert day["long_profit"] == pytest.approx(profit["當沖"]) and day["short_profit"] == 0


def test_a_market_has_every_trade_and_the_dashboard_carries_no_lists(ledger):
    assert [t["trade_id"] for t in ledger.get_market_trades("台股")["items"]] == ["S2", "S1", "B2", "B1"]
    assert ledger.get_market_trades("美股")["items"] == []
    dashboard = ledger.get_dashboard()
    assert "trades" not in dashboard and "realized" not in dashboard
    assert all("details" not in dashboard["analytics"][market] for market in ("台股", "美股"))


def test_pairs_are_read_for_one_stock(ledger):
    by_code = ledger.get_pairs("台股", "2330")
    assert by_code["available"] and [(p["code"], p["trade_type"]) for p in by_code["items"]] == [("2330", "一般")]
    assert ledger.get_pairs("美股", "2330")["items"] == []


def test_a_stock_carries_its_normal_trades_average_return(ledger):
    stock = next(s for s in ledger.get_analytics()["台股"]["stock_stats"] if s["code"] == "2330")
    pair = ledger.get_pairs("台股", "2330")["items"][0]
    assert stock["normal_return_rate"] == pytest.approx(pair["roi"]) and stock["normal_return_rate"] > 0


@pytest.mark.parametrize("market, code", [("台", "2330"), ("台股", "")])
def test_a_pairs_read_names_a_market_and_a_stock(ledger, market, code):
    with pytest.raises(ValueError):
        ledger.get_pairs(market, code)


@pytest.mark.parametrize("market, mode", [("台", "overview"), ("台股", ""), ("台股", "多")])
def test_a_daytrade_analysis_names_a_market_and_a_mode(ledger, market, mode):
    with pytest.raises(ValueError):
        ledger.get_daytrade_analysis(market, mode)


@pytest.mark.parametrize("market, date", [("台", "2026-10-15"), ("", "2026-10-15"), ("台股", "20261015"),
                                          ("台股", "2026-02-30"), ("台股", "")])
def test_a_malformed_market_or_date_is_refused(ledger, market, date):
    with pytest.raises(ValueError):
        ledger.get_day(market, date)


def test_an_error_names_the_market_of_its_trade(ledger):
    with ledger._connection(caller="test.errors") as conn:
        conn.executemany("INSERT INTO rebuild_errors(trade_id,message) VALUES(?,?)",
                         [("S1", "賣出超過庫存"), ("", "整批資料的問題")])
    errors = {e["message"]: e["market"] for e in ledger.get_errors()}
    assert errors["賣出超過庫存"] == "台股" and errors["整批資料的問題"] == ""
