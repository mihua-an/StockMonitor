"""資金 (service/account/capital.py): settlement dates, principal that changes only on settlement, the paper ledger's
Taiwan lot rules and daily limit, the actual ledger reporting without refusing, and each ledger's own scope (actual:
台股＋美股, 每日交易額度 only; paper: 台股 only, 起始本金＋每日交易額度)."""
from __future__ import annotations

from datetime import date, datetime
from zoneinfo import ZoneInfo

import pytest

from service.account import capital
from service.account.account_types import ActualAccountError
from service.account.actual_account_service import ActualAccountService
from service.account.paper_wallet_service import PaperWalletService


def _paper(tmp_path):
    return PaperWalletService(db_path=tmp_path / "paper.db", config_path=tmp_path / "config.json", security_master_path=tmp_path / "master.csv")


def _trade(ledger, trade_id, day, action, info, time="09:30", code="2330", market="台股"):
    return ledger.local_save_trade({"trade_id": trade_id, "trade_date": day, "market": market, "code": code,
                                    "action": action, "trade_info": info, "trade_time": time})


def test_settlement_dates_skip_weekends_and_holidays():
    assert capital.settlement_date("台股", "2026-10-16") == "2026-10-20"   # Fri -> Tue
    assert capital.settlement_date("美股", "2026-11-25") == "2026-11-27"   # Thanksgiving skipped
    assert capital.settlement_date("美股", "2026-07-02") == "2026-07-06"   # Jul 3 observed holiday, weekend
    assert date(2026, 4, 3) in capital.nyse_holidays(2026)                 # Good Friday
    assert date(2027, 12, 31) not in capital.nyse_holidays(2027)           # New Year's on a Saturday is not observed
    assert capital.settlement_date("美股", "2025-01-08") == "2025-01-10"   # the 2025-01-09 day of mourning


def test_principal_changes_only_on_settlement(tmp_path):
    ledger = _paper(tmp_path)
    ledger.save_capital_settings({"markets": {"台股": {"initial_principal": 100000}}})
    _trade(ledger, "B1", "2026-10-15", "買進", "100@500")          # 零股 50,000 + fee 20
    legs = [{"trade_id": "B1", "trade_date": "2026-10-15", "trade_time": "09:00", "source_order": 1, "market": "台股", "code": "2330",
             "action": "買進", "qty": "100", "gross_amount": "50000", "fee": "20", "tax": "0"}]
    trades = ledger.capital_trades()
    on_trade_day = capital.capital_view(legs, trades, capital.read_settings(ledger._get_meta, capital.PAPER_SCOPE), capital.PAPER_SCOPE,
                                        now=datetime(2026, 10, 15, 13, 0, tzinfo=ZoneInfo("Asia/Taipei")))["台股"]
    assert on_trade_day["principal"] == 100000, "before T+2 the principal is still 10 萬"
    # One settlement projection: the date's amount and the trades it is made of.
    assert on_trade_day["pending"] == [{"settlement_date": "2026-10-19", "amount": -50020, "trades": [
        {"trade_id": "B1", "date": "2026-10-15", "time": "09:00", "code": "2330", "action": "買進", "qty": 100,
         "gross_amount": 50000, "fee": 20, "tax": 0, "cash": -50020}]}]
    assert on_trade_day["principal_after_settlement"] == 49980
    settled = capital.capital_view(legs, trades, capital.read_settings(ledger._get_meta, capital.PAPER_SCOPE), capital.PAPER_SCOPE,
                                   now=datetime(2026, 10, 19, 9, 0, tzinfo=ZoneInfo("Asia/Taipei")))["台股"]
    assert settled["principal"] == 49980 and settled["pending"] == []
    # The dashboard carries the same block.
    assert set(ledger.get_dashboard()["capital"]) == {"台股"}, "the paper ledger is 台股 only"


def test_odd_lots_cannot_be_day_traded(tmp_path):
    ledger = _paper(tmp_path)
    _trade(ledger, "B1", "2026-10-15", "買進", "200@500")
    with pytest.raises(ActualAccountError, match="零股不能當日沖銷"):
        _trade(ledger, "S1", "2026-10-15", "賣出", "200@505", time="10:00")
    _trade(ledger, "S2", "2026-10-16", "賣出", "200@505")   # the next day it is held stock
    with pytest.raises(ActualAccountError, match="零股不能當日沖銷"):
        _trade(ledger, "S3", "2026-10-16", "賣出", "100@505", time="10:00")   # nothing left from before
    with pytest.raises(ActualAccountError, match="整股（1,000 股的倍數）或零股"):
        _trade(ledger, "B2", "2026-10-16", "買進", "1500@500")


def test_whole_lots_can_be_day_traded_both_ways(tmp_path):
    ledger = _paper(tmp_path)
    _trade(ledger, "B1", "2026-10-15", "買進", "1000@500")
    _trade(ledger, "S1", "2026-10-15", "賣出", "1000@505", time="10:00")       # buy then sell
    _trade(ledger, "S2", "2026-10-15", "賣出", "2000@506", time="11:00")       # sell first, whole lots
    _trade(ledger, "B2", "2026-10-15", "買進", "2000@500", time="12:00")
    with pytest.raises(ActualAccountError, match="零股不能當日沖銷"):
        _trade(ledger, "S3", "2026-10-16", "賣出", "500@505")                    # no odd-lot short either


def test_the_daily_limit_refuses_a_trade_past_it(tmp_path):
    ledger = _paper(tmp_path)
    ledger.save_capital_settings({"markets": {"台股": {"daily_limit": 600000}}})
    _trade(ledger, "B1", "2026-10-15", "買進", "1000@500")
    with pytest.raises(ActualAccountError, match="每日交易額度"):
        _trade(ledger, "B2", "2026-10-15", "買進", "1000@200", time="10:00")
    _trade(ledger, "B3", "2026-10-16", "買進", "1000@200")                     # a new day, a new limit
    _trade(ledger, "S1", "2026-10-16", "賣出", "1000@510", time="10:00")       # selling held stock uses none
    # Editing a trade replaces it instead of counting it twice.
    _trade(ledger, "B1", "2026-10-15", "買進", "1000@550")


def test_odd_lot_buys_never_cover_a_sell_first_position(tmp_path):
    ledger = _paper(tmp_path)
    ledger.save_capital_settings({"markets": {"台股": {"daily_limit": 2_100_000}}})
    _trade(ledger, "B1", "2026-10-15", "買進", "500@1000")                     # 500,000 used
    # Sell first 2 lots: the odd-lot buy does not cover any of it, so 2,000,000 more is used -> past the limit.
    with pytest.raises(ActualAccountError, match="每日交易額度"):
        _trade(ledger, "S1", "2026-10-15", "賣出", "2000@1000", time="10:00")


def test_buying_back_a_short_takes_no_limit(tmp_path):
    ledger = _paper(tmp_path)
    ledger.save_capital_settings({"markets": {"台股": {"daily_limit": 600000}}})
    _trade(ledger, "S1", "2026-10-15", "賣出", "1000@491.5")                    # sell first: 491,500 used
    _trade(ledger, "B1", "2026-10-15", "買進", "1000@495", time="10:00")       # the cover uses none
    assert capital.used_limit(ledger.capital_trades(), "台股", "2026-10-15") == 491500
    # Only the part beyond the short counts: 500,000 short, then 1,000 covered + 1,000 new = 110,000 -> past 600,000.
    _trade(ledger, "S2", "2026-10-16", "賣出", "1000@500")
    with pytest.raises(ActualAccountError, match="每日交易額度"):
        _trade(ledger, "B2", "2026-10-16", "買進", "2000@110", time="10:00")
    _trade(ledger, "B3", "2026-10-16", "買進", "1000@110", time="10:00")


def test_edits_and_deletes_are_checked_against_the_trades_after_them(tmp_path):
    ledger = _paper(tmp_path)
    _trade(ledger, "B1", "2026-10-15", "買進", "500@100")
    _trade(ledger, "S1", "2026-10-16", "賣出", "500@105")                      # sells the 零股 held from 10-15
    with pytest.raises(ActualAccountError, match="零股不能當日沖銷"):
        ledger.local_delete_trade("B1")                                          # S1 would have nothing to sell
    with pytest.raises(ActualAccountError, match="零股不能當日沖銷"):
        _trade(ledger, "B1", "2026-10-16", "買進", "500@100", time="11:00")      # moving the buy after the sell
    assert {row["trade_id"] for row in ledger.get_raw_trades(limit=10)} == {"B1", "S1"}, "a refused change is rolled back"


def test_the_actual_ledger_reports_but_never_refuses(tmp_path):
    actual = ActualAccountService(db_path=tmp_path / "actual.db", config_path=tmp_path / "config.json", security_master_path=tmp_path / "m.csv")
    actual.save_capital_settings({"markets": {"台股": {"daily_limit": 1}}})
    actual.local_save_trade({"trade_id": "B1", "trade_date": "2026-10-15", "market": "台股", "code": "2330", "action": "買進", "trade_info": "200@500"})
    actual.local_save_trade({"trade_id": "S1", "trade_date": "2026-10-15", "market": "台股", "code": "2330", "action": "賣出", "trade_info": "200@505"})
    assert actual.get_capital_settings()["enforced"] is False
    view = actual.get_capital()
    assert set(view) == {"台股", "美股"} and "principal" not in view["台股"], "the actual ledger has no 起始本金"
    assert view["台股"]["daily_limit"] == 1


def test_each_ledger_keeps_only_its_own_settings(tmp_path):
    actual = ActualAccountService(db_path=tmp_path / "actual.db", config_path=tmp_path / "config.json", security_master_path=tmp_path / "m.csv")
    with pytest.raises(ActualAccountError, match="沒有起始本金"):
        actual.save_capital_settings({"markets": {"台股": {"initial_principal": 1}}})
    assert actual.get_capital_settings()["markets"] == {"台股": {"daily_limit": "0"}, "美股": {"daily_limit": "0"}}
    paper = _paper(tmp_path)
    with pytest.raises(ActualAccountError, match="不支援的市場"):
        paper.save_capital_settings({"markets": {"美股": {"daily_limit": 1}}})
    with pytest.raises(ActualAccountError, match="不支援的市場：美股"):
        _trade(paper, "U1", "2026-10-15", "買進", "1@100", code="NVDA", market="美股")
    assert paper.get_capital_settings()["scope"] == {"markets": ["台股"], "fields": ["initial_principal", "daily_limit", "fee_discount"]}


def test_the_paper_fee_discount_recomputes_every_fee(tmp_path):
    paper = _paper(tmp_path)
    _trade(paper, "B1", "2026-10-15", "買進", "1000@500")                    # 500,000
    fee = lambda: paper.get_raw_trades(limit=5)[0]["fee"]
    assert fee() == 200, "unset: the actual account's 2.8 折 (0.000399)"
    paper.save_capital_settings({"markets": {"台股": {"fee_discount": "6"}}})
    assert fee() == 428, "6 折 of 0.1425%: 500,000 x 0.000855 = 427.5 -> 428"
    with pytest.raises(ActualAccountError, match="0～10 折"):
        paper.save_capital_settings({"markets": {"台股": {"fee_discount": "11"}}})
    reopened = _paper(tmp_path)
    assert reopened.get_raw_trades(limit=5)[0]["fee"] == 428, "the rate is the ledger's setting, kept across a restart"


def test_settings_are_validated():
    with pytest.raises(ActualAccountError, match="不可為負數"):
        capital.settings_to_meta({"markets": {"台股": {"initial_principal": -1}}}, capital.PAPER_SCOPE)
    with pytest.raises(ActualAccountError, match="不支援的市場"):
        capital.settings_to_meta({"markets": {"港股": {"initial_principal": 1}}}, capital.PAPER_SCOPE)
    assert capital.settings_to_meta({"markets": {"台股": {"initial_principal": "1,000.5", "daily_limit": ""}}}, capital.PAPER_SCOPE) == {
        "capital.台股.initial_principal": "1000.5", "capital.台股.daily_limit": "0"}
    assert capital.settings_to_meta({"markets": {"美股": {"daily_limit": "2,000"}}}, capital.ACTUAL_SCOPE) == {"capital.美股.daily_limit": "2000"}
