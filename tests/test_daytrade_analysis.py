"""當沖分析 is computed by the ledger only (AccountAnalyticsService.get_daytrade_analysis, `<ledger>/daytrade-analysis`):
the summary, mini report, periods, weekdays, hold / entry bands with their descriptions, the matrix and the rankings
of one mode, every group naming its pairs by id. The renderer only selects and formats them."""
from __future__ import annotations

import pytest

from service.account.trade_metrics import band_descriptions
from tests.support.paper_desk import make_desk


def _fill(trade_id: str, day: str, code: str, action: str, price: int, time: str) -> dict:
    return {"order_id": trade_id, "trade_date": day, "code": code, "action": action, "fills": [{"qty": 1000, "price": price}],
            "trade_time": time, "reasons": []}


@pytest.fixture()
def ledger(tmp_path):
    _desk, ledger, _clock = make_desk(tmp_path)
    ledger.local_input.import_matched_orders([
        _fill("B1", "2026-10-14", "2330", "買進", 100, "10:00:00"),     # 一般: not a 當沖
        _fill("S1", "2026-10-15", "2330", "賣出", 110, "10:00:00"),
        _fill("B2", "2026-10-15", "2317", "買進", 50, "09:05:00"),      # 當沖 多, Thursday, 15 minutes, a win
        _fill("S2", "2026-10-15", "2317", "賣出", 52, "09:20:00"),
        _fill("S3", "2026-10-16", "2303", "賣出", 40, "10:30:00"),      # 當沖 空, Friday, 75 minutes, a loss
        _fill("B3", "2026-10-16", "2303", "買進", 41, "11:45:00"),
    ])
    return ledger


def test_the_overview_slice_groups_every_daytrade_by_id(ledger):
    slice_ = ledger.get_daytrade_analysis("台股", "overview")
    assert slice_["available"] and slice_["label"] == "當沖"
    pairs = {pair["direction"]: pair for pair in slice_["pairs"]}
    long, short = pairs["多"], pairs["空"]
    assert [pair["id"] for pair in slice_["pairs"]] == [short["id"], long["id"]], "newest first"
    assert long["profit"] > 0 > short["profit"]
    assert (long["entry_band"], short["entry_band"]) == ("09:00~09:10", "10:00~11:00")

    summary = slice_["summary"]
    assert (summary["total_count"], summary["long_count"], summary["short_count"], summary["win_rate"]) == (2, 1, 1, 0.5)
    assert summary["total_profit"] == pytest.approx(long["profit"] + short["profit"])
    assert summary["expectancy"] == pytest.approx((long["profit"] + short["profit"]) / 2)

    # The bands are described by the answer; the renderer keeps no table of its own.
    assert slice_["bands"] == band_descriptions()
    assert slice_["matrix"]["columns"] == [band["short_label"] for band in band_descriptions()["hold"]]
    hold = {item["label"]: item["pair_ids"] for item in slice_["hold_time"] if item["pair_ids"]}
    entry = {item["label"]: item["pair_ids"] for item in slice_["entry_time"] if item["pair_ids"]}
    assert hold == {"10~20分": [long["id"]], "1~2h": [short["id"]]}
    assert entry == {"09:00~09:10": [long["id"]], "10:00~11:00": [short["id"]]}
    assert [item["bucket_index"] for item in slice_["hold_time"]] == list(range(len(band_descriptions()["hold"])))
    first_row = slice_["matrix"]["rows"][0]
    assert first_row["counts"][1] == 1 and first_row["values"][1] == pytest.approx(long["profit"])

    weekdays = {item["label"]: item["pair_ids"] for item in slice_["weekdays"]}
    assert weekdays == {"週一": [], "週二": [], "週三": [], "週四": [long["id"]], "週五": [short["id"]]}
    assert [(item["label"], item["pair_ids"]) for item in slice_["periods"]["week"]] == [("2026/10/W2", [short["id"], long["id"]])]
    assert [item["label"] for item in slice_["periods"]["month"]] == ["2026/10"]
    assert (slice_["top_wins"], slice_["top_losses"]) == ([long["id"]], [short["id"]])

    mini = slice_["mini_report"]
    assert (mini["avg_hold"], mini["biggest_win_hold"], mini["biggest_loss_hold"]) == (45.0, 15, 75)
    assert mini["breakeven_rate"] == pytest.approx(1 / (1 + summary["profit_loss_ratio"]))


def test_a_direction_mode_is_that_side_only(ledger):
    long = ledger.get_daytrade_analysis("台股", "long")
    assert long["label"] == "多單" and [pair["direction"] for pair in long["pairs"]] == ["多"]
    assert long["summary"]["short_count"] == 0 and long["summary"]["short_profit"] is None and long["top_losses"] == []
    short = ledger.get_daytrade_analysis("台股", "short")
    assert short["label"] == "空單" and [pair["direction"] for pair in short["pairs"]] == ["空"]
    assert short["summary"]["win_rate"] == 0.0 and short["mini_report"]["required_payoff_ratio"] is None


def test_a_market_without_daytrades_has_an_empty_slice(ledger):
    slice_ = ledger.get_daytrade_analysis("美股", "overview")
    assert slice_["pairs"] == [] and slice_["summary"]["total_count"] == 0 and slice_["summary"]["win_rate"] is None
    assert all(item["pair_ids"] == [] for item in slice_["hold_time"] + slice_["entry_time"] + slice_["weekdays"])
    assert slice_["mini_report"]["payoff_ratio"] is None
