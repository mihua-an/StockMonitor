"""The phone's answers (service/account/mobile_api.py), on a small synthetic ledger.

The port was checked against the live GAS answers on the real ledger (16 of 18 identical; the two
rank ROIs differ in the 6th decimal because the old sheet divided by price x shares instead of the money actually
paid). These tests pin the rules, including the Decimal arithmetic the sheet version did not have.
"""
from datetime import date
from decimal import Decimal as D

from service.account import mobile_api as m


def leg(day, code, action, qty, price, *, market="台股", trade_type="現股", fee="0", tax="0", time="09:30", order=1):
    gross = D(qty) * D(price)
    return m.Leg(day, market, code, trade_type, action, D(qty), D(price), gross, D(tax), D(fee), time, order)


def match(day, code, profit, *, market="台股", trade_type="現股", direction="多", qty="1000", buy="10", sell="11",
          buy_amount="10000", sell_amount="11000", buy_ref="2026/09/01", sell_ref=None, tax="0", fee="0"):
    return m.Match(day, market, code, trade_type, direction, D(qty), D(buy), D(sell), D(buy_amount), D(sell_amount),
                   D(tax), D(fee), D(profit), buy_ref, sell_ref or day)


SECURITIES = {"2330": m.Security("台積電", "tse"), "6217": m.Security("中探針", "otc"), "0050": m.Security("元大台灣50", "tse")}
TERMS = {"amount_rounding": "floor", "fee_rate": "0.000399", "min_fee": "1", "fee_rounding": "ceil", "sell_tax_rate": "0.003", "tax_rounding": "floor"}


def data(legs=(), matches=(), holdings=(), performance=None):
    return m.MobileData(list(legs), list(matches), list(holdings), SECURITIES, performance or {})


def test_us_cents_add_exactly():
    # 0.1 + 0.2 in binary floating point is 0.30000000000000004; the ledger's amounts are Decimal end to end.
    d = data(matches=[match("2026/09/02", "NOK", "0.1", market="美股", buy_amount="1"),
                      match("2026/09/02", "NOK", "0.2", market="美股", buy_amount="2")])
    top = m.rank(d, "us", "profit")["data"][0]
    assert top["profit"] == 0.3
    assert top["rate"] == 0.1


def test_rank_rate_is_profit_over_the_money_paid_and_nameless_codes_are_left_out():
    d = data(matches=[match("2026/09/02", "2330", "600", buy_amount="10000"),
                      match("2026/09/03", "2330", "-100", buy_amount="5000"),
                      match("2026/09/03", "9999", "50")])
    answer = m.rank(d, "spot", "profit")
    assert [row["code"] for row in answer["data"]] == ["2330"]
    assert answer["data"][0]["profit"] == 500
    assert answer["data"][0]["rate"] == round(500 / 15000, 8)


def test_the_daily_report_has_a_row_for_a_day_with_only_buys():
    d = data(legs=[leg("2026/09/04", "2330", "買進", "1000", "10")],
             matches=[match("2026/09/02", "2330", "100"), match("2026/09/03", "2330", "-30", trade_type="當沖")])
    items = m.realized_report(d, "day")["items"]
    assert [item["date"] for item in items] == ["09/04", "09/03", "09/02"]
    assert items[0]["stockRealized"] == 0 and items[0]["stockAccumulated"] == 70
    assert items[1]["dayTradeRealized"] == -30
    assert [item["recentDayTradeAccumulated"] for item in items] == [0, -30, -30]


def test_summary_targets_are_taiwan_only_and_its_figures_are_the_ledgers_performance():
    performance = {"台股": {"normal_profit": D("7"), "daytrade_profit": D("-30"), "holding_cost": D("10000")}}
    d = data(matches=[match("2026/09/01", "2330", "-50", trade_type="當沖"), match("2026/09/02", "2330", "20", trade_type="當沖"),
                      match("2026/09/02", "NOK", "5", market="美股")], performance=performance)
    answer = m.summary(d)
    assert (answer["stockProfit"], answer["daytradingProfit"], answer["holdingCost"]) == (7, -30, 10000)
    assert answer["dayTarget"] == 30          # newest day +20, then -50: the running total first goes negative at -30


def test_the_phones_summary_and_the_desktops_cards_are_one_performance(tmp_path):
    """手機卡片's 現股已實現／當沖已實現／庫存總成本 and the 帳務 cards and home analytics read the same projection
    (AccountAnalyticsService.market_performance); a short's proceeds count in 庫存成本 on both."""
    from service.account.paper_wallet_service import PaperWalletService

    ledger = PaperWalletService(db_path=tmp_path / "p.db", config_path=tmp_path / "c.json", security_master_path=tmp_path / "m.csv")
    try:
        trade = lambda tid, day, code, action, info, time: ledger.local_save_trade(
            {"trade_id": tid, "trade_date": day, "market": "台股", "code": code, "action": action, "trade_info": info, "trade_time": time})
        trade("B1", "2026-10-14", "2330", "買進", "2000@100", "09:00:00")
        trade("S1", "2026-10-15", "2330", "賣出", "1000@105", "09:00:00")     # 一般
        trade("B2", "2026-10-15", "2317", "買進", "1000@50", "09:30:00")      # 當沖 多
        trade("S2", "2026-10-15", "2317", "賣出", "1000@49", "10:00:00")
        phone = m.summary(m.MobileData.from_ledger(ledger, ledger.security_master_path))
        cards = ledger.get_summary()
        home = ledger.get_analytics()["台股"]["home"]["overall"]
        assert phone["daytradingProfit"] == cards["daytrade_total"]["tw"] == home["daytrade_profit"] < 0
        assert phone["stockProfit"] == cards["realized_total"]["tw"] - cards["daytrade_total"]["tw"] == home["normal_profit"] > 0
        assert phone["holdingCost"] == cards["holding_cost"]["tw"] > 100000
    finally:
        ledger.shutdown()


def test_holdings_name_both_markets_and_round_us_cost_per_share_to_cents():
    d = data(holdings=[m.Holding("6217", "台股", D("5"), D("134.2"), D("671"), TERMS), m.Holding("NOK", "美股", D("2"), D("9.415"), D("18.83"), TERMS)])
    answer = m.holdings(d)
    assert [(h["code"], h["name"], h["exCh"]) for h in answer["activeHoldings"]] == [("6217", "中探針", "otc_6217.tw"), ("NOK", "NOK", "tse_NOK.tw")]
    assert answer["activeHoldings"][1]["costPerShare"] == 9.42
    assert answer["activeHoldings"][1]["valH"] == 18.83
    assert answer["priceQueue"][0]["closingTerms"] == TERMS
    assert "isETF" not in answer["priceQueue"][0]


def test_the_phone_gets_shorts_and_the_ledgers_closing_terms_for_every_position(tmp_path):
    """手機庫存 is 桌面's formula: each position carries the ledger's own closing_terms (ETF／ETN／REIT at 0.1% by the
    security master's kind, fee rounded up), and a short is listed with shares < 0."""
    from service.account.paper_wallet_service import PaperWalletService

    ledger = PaperWalletService(db_path=tmp_path / "p.db", config_path=tmp_path / "c.json", security_master_path=tmp_path / "m.csv")
    try:
        trade = lambda tid, code, action, info, time: ledger.local_save_trade(
            {"trade_id": tid, "trade_date": "2026-10-14", "market": "台股", "code": code, "action": action, "trade_info": info, "trade_time": time})
        trade("B1", "2330", "買進", "1000@100", "09:00:00")
        trade("B2", "0050", "買進", "1000@100", "09:01:00")
        trade("B3", "020000", "買進", "1000@10", "09:02:00")
        trade("S1", "2317", "賣出", "1000@50", "09:03:00")
        d = m.MobileData.from_ledger(ledger, ledger.security_master_path)
        queue = {item["code"]: item for item in m.holdings(d)["priceQueue"]}
        core = ledger.accounting_core
        for code in ("2330", "0050", "020000", "2317"):
            assert queue[code]["closingTerms"] == core.closing_terms("台股", code)
        assert queue["2330"]["closingTerms"]["sell_tax_rate"] == "0.003"
        assert queue["0050"]["closingTerms"]["sell_tax_rate"] == queue["020000"]["closingTerms"]["sell_tax_rate"] == "0.001"
        assert queue["2317"]["shares"] == -1000
        assert queue["2317"]["valH"] > 0, "a short's cost is what the sell brought in"
    finally:
        ledger.shutdown()


def test_history_trade_lists_buys_split_sells_and_day_trades_of_that_day():
    day = "2026/09/02"
    d = data(legs=[leg(day, "2330", "買進", "1000", "10", fee="20", order=5)],
             matches=[match(day, "2330", "300", sell_amount="11000", tax="33", fee="15", sell_ref=day),
                      match(day, "2330", "200", sell_amount="5500", sell_ref=day),
                      match(day, "6217", "-40", trade_type="當沖", direction="空", qty="2000", buy_ref="09:20", sell_ref="09:05")])
    answer = m.history_trade(d, date(2026, 9, 2))
    assert answer["date"] == day
    buys = [item for item in answer["normalTrade"]["items"] if item["type"] == "買進"]
    sells = [item for item in answer["normalTrade"]["items"] if item["type"] == "賣出"]
    assert buys[0]["settlement"] == -10020
    assert [s["pairGroupCount"] for s in sells] == [2, 2] and all(s["isSplitPair"] for s in sells)
    assert answer["dayTrade"]["items"][0]["volume"] == 2          # 台股當沖 shown in 張
    assert answer["settlement"]["tw"] == -10020 + (11000 - 33 - 15) + 5500 - 40
    assert answer["settlement"]["dayTrade"] == -40


def test_day_trade_entry_time_bands_by_entry_side_and_weekday():
    # 2026-09-07 is a Monday, 2026-09-08 a Tuesday.
    d = data(matches=[match("2026/09/07", "2330", "100", trade_type="當沖", direction="多", buy_ref="09:05", sell_ref="09:30"),
                      match("2026/09/07", "2330", "-60", trade_type="當沖", direction="空", buy_ref="10:30", sell_ref="09:15"),
                      match("2026/09/08", "2330", "10", trade_type="當沖", direction="多", buy_ref="13:10", sell_ref="13:20")])
    monday = m.day_trade_entry_time(d, 1)
    assert monday["weekdayLabel"] == "週一"
    assert monday["items"][0]["totalProfit"] == 100 and monday["items"][1]["totalProfit"] == -60
    assert monday["summary"] == {"longWinRate": 1, "shortWinRate": 0}
    week = m.day_trade_entry_time(d, None)
    assert week["weekdayLabel"] == "整週" and week["items"][-1]["longProfit"] == 10


def test_week_and_price_summaries():
    d = data(matches=[match("2026/09/07", "2330", "100", trade_type="當沖", direction="多", buy="45", buy_amount="45000"),
                      match("2026/09/07", "2330", "-50", trade_type="當沖", direction="空", sell="520", sell_amount="520000"),
                      match("2026/09/08", "2330", "30", trade_type="當沖", direction="多", buy="50", buy_amount="50000")])
    week = m.day_trade_week_summary(d)
    assert week["items"][0]["winRate"] == 0.5 and week["items"][0]["longReturnRate"] == round(100 / 45000, 4)
    assert week["dayTradeWinRate"] == round(2 / 3, 4)
    price = {item["range"]: item for item in m.day_trade_price_summary(d)["items"]}
    assert price["0~50"]["totalProfit"] == 130 and price[">500"]["shortProfit"] == -50
    assert price[">50~100"]["totalProfit"] == "-"


def test_the_bundle_has_every_key_the_phone_can_ask_for():
    empty = {"normal_profit": D("0"), "daytrade_profit": D("0"), "holding_cost": D("0")}
    bundle = m.build_bundle(data(performance={"台股": empty}), date(2026, 10, 7))
    assert {f"rank:{k}:{s}" for k in ("spot", "daytrade", "us") for s in ("profit", "loss")} <= set(bundle)
    assert {f"realizedReport:{p}" for p in ("day", "week", "month")} <= set(bundle)
    assert {f"dayTradeEntryTime:{w}" for w in (1, 2, 3, 4, 5, "week")} <= set(bundle)
    history = sorted(key for key in bundle if key.startswith("historyTrade:"))
    assert len(history) == 10 and history[-1] == "historyTrade:2026/10/07" and "historyTrade:2026/10/04" not in history


def test_the_paper_wallet_has_the_same_cards_on_the_desktop_only(tmp_path):
    """模擬帳務's 手機卡片 (使用者 10-17): the actual account's builder over the paper ledger, and no route publishes it."""
    from pathlib import Path
    from service.account.paper_wallet_service import PaperWalletService
    (tmp_path / "m.csv").write_text("code,name\n2330,台積電\n", encoding="utf-8")
    ledger = PaperWalletService(db_path=tmp_path / "p.db", config_path=tmp_path / "c.json", security_master_path=tmp_path / "m.csv")
    ledger.local_save_trade({"trade_id": "M1", "trade_date": "2026-10-16", "market": "台股", "code": "2330", "action": "買進",
                             "trade_info": "1000@100", "trade_time": "09:05:00"})
    preview = m.preview(ledger, date(2026, 10, 16))
    assert preview["ok"] and preview["today"] == "2026-10-16" and "last_publish_at" not in preview
    assert preview["entries"] == m.build_bundle(m.MobileData.from_ledger(ledger, ledger.security_master_path), date(2026, 10, 16))
    assert "2330" in str(preview["entries"]), "the paper holding is on its cards"
    routes = Path(__file__).resolve().parents[1] / "api" / "routes" / "account_routes.py"
    text = routes.read_text(encoding="utf-8")
    assert "/api/paper-wallet/mobile-preview" in text and "/api/paper-wallet/mobile-publish" not in text, "the paper cards are never published"

