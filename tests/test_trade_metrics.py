"""One set of trade-statistics rules for the desktop analytics and the mobile bundle (R14-29): the same win rate,
the same clock reading, the same 當沖 entry-time and hold-time bands and the same statistics of a set of trades; the
renderer keeps no copy of the bands, the 當沖分析 answer describes them."""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from pathlib import Path

from service.account import mobile_api, trade_metrics
from service.account.trade_metrics import (ENTRY_TIME_BANDS, HOLD_TIME_BANDS, band_descriptions, clock_minute, entry_band,
                                           entry_minute, hold_band_index, metric_summary, trade_weekday, win_rate)

ROOT = Path(__file__).resolve().parents[1]


def test_the_rules():
    assert win_rate([]) is None
    assert win_rate([Decimal(5), Decimal(0), Decimal(-1), Decimal(2)]) == Decimal("0.5"), "zero is not a win"
    assert [clock_minute(t) for t in ("09:31:12", "9:05", "", "25:00", "abc", "09")] == [571, 545, None, None, None, None]
    assert (entry_band(540), entry_band(809), entry_band(810), entry_band(None)) == ("09:00~09:10", "13:00~13:30", None, None)


def test_return_rate_is_total_profit_over_total_invested():
    """報酬率 (decisions.md): a 1,000 trade at +10% and a 100,000 trade at -1% made -900 on 101,000 put in (-0.89%),
    not the +4.5% an average of the two rates says. A 空 trade put in what it sold."""
    from service.account.trade_metrics import invested_amount, return_rate

    small, large = (Decimal(100), Decimal(1_000)), (Decimal(-1_000), Decimal(100_000))
    assert return_rate([small, large]) == Decimal(-900) / Decimal(101_000)
    assert return_rate([]) is None and return_rate([(Decimal(5), Decimal(0))]) is None
    assert invested_amount("空", Decimal(9_000), Decimal(10_000)) == Decimal(10_000)
    assert invested_amount("多", Decimal(9_000), Decimal(10_000)) == Decimal(9_000)
    assert invested_amount("", Decimal(9_000), Decimal(10_000)) == Decimal(9_000), "a 現股 sale bought first"


def test_the_bands_and_their_descriptions():
    assert (hold_band_index(0), hold_band_index(15), hold_band_index(239), hold_band_index(10_000), hold_band_index(None)) == (0, 1, 8, 9, None)
    assert (entry_minute("多", "09:05:00", "10:00:00"), entry_minute("空", "10:00:00", "09:05:00")) == (545, 545), "a 空 enters on its sell"
    assert [trade_weekday(date(2026, 10, day)) for day in (12, 16, 17)] == [1, 5, None] and trade_weekday(None) is None
    described = band_descriptions()
    assert [(b["label"], b["from_minute"], b["to_minute"]) for b in described["entry"]] == list(ENTRY_TIME_BANDS)
    assert [(b["label"], b["short_label"], b["from_minute"], b["to_minute"]) for b in described["hold"]] == list(HOLD_TIME_BANDS)
    assert described["hold"][-1]["to_minute"] is None


def test_the_daytrade_answer_carries_the_band_descriptions_and_no_renderer_keeps_a_copy(tmp_path):
    """The 當沖分析 answer and each 當沖 pair carry the bands (entry_band, the slice's `bands`); the renderer draws them."""
    from tests.support.paper_desk import make_desk

    _desk, ledger, _clock = make_desk(tmp_path)
    ledger.local_input.import_matched_orders([
        {"order_id": "B", "trade_date": "2026-10-15", "code": "2317", "action": "買進", "fills": [{"qty": 1000, "price": 50}],
         "trade_time": "09:05:00", "reasons": []},
        {"order_id": "S", "trade_date": "2026-10-15", "code": "2317", "action": "賣出", "fills": [{"qty": 1000, "price": 51}],
         "trade_time": "09:20:00", "reasons": []}])
    slice_ = ledger.get_daytrade_analysis("台股", "overview")
    assert slice_["bands"] == band_descriptions()
    assert [item["label"] for item in slice_["entry_time"]] == [band[0] for band in ENTRY_TIME_BANDS]
    assert [item["label"] for item in slice_["hold_time"]] == [band[0] for band in HOLD_TIME_BANDS]
    [pair] = slice_["pairs"]
    assert (pair["entry_minute"], pair["entry_band"]) == (545, "09:00~09:10")
    renderer = ROOT / "ui/renderer/js/features/account"
    for path in renderer.glob("*.js"):
        text = path.read_text(encoding="utf-8")
        for name in ("ACTUAL_ENTRY_BUCKETS", "ACTUAL_HOLD_BUCKETS", "daytradeEntryMinute", "540, 550", '"09:00~09:10"', '"0~10分"'):
            assert name not in text, f"{path.name} keeps its own band table or entry minute ({name})"


def test_the_statistics_of_a_set_of_trades():
    trades = [(Decimal(300), "多", Decimal(1000)), (Decimal(-100), "空", Decimal(1000)), (Decimal(0), "多", Decimal(2000))]
    stats = metric_summary(trades)
    assert (stats["total_profit"], stats["win_rate"], stats["expectancy"]) == (Decimal(200), Decimal(1) / 3, Decimal(200) / 3)
    assert (stats["avg_win"], stats["avg_loss"], stats["profit_loss_ratio"]) == (Decimal(300), Decimal(-100), Decimal(3))
    assert (stats["long_profit"], stats["short_profit"], stats["long_win_rate"]) == (Decimal(300), Decimal(-100), Decimal("0.5"))
    assert (stats["return_rate"], stats["long_return_rate"]) == (Decimal(200) / 4000, Decimal(300) / 3000)
    assert (stats["total_count"], stats["win_count"], stats["loss_count"], stats["long_count"], stats["short_count"]) == (3, 1, 1, 2, 1)
    empty = metric_summary([])
    assert empty["total_profit"] == 0 and empty["total_count"] == 0
    assert all(empty[key] is None for key in ("win_rate", "expectancy", "avg_win", "avg_loss", "profit_loss_ratio", "long_profit",
                                              "short_profit", "long_win_rate", "return_rate"))
    assert metric_summary([(Decimal(5), "多", Decimal(10))])["profit_loss_ratio"] is None, "no loss: no 盈虧比"


def test_desktop_and_mobile_read_one_module():
    for path in ("service/account/mobile_api.py", "service/account/account_analytics_service.py"):
        text = (ROOT / path).read_text(encoding="utf-8")
        assert "from service.account.trade_metrics import" in text, path
        assert "540, 550" not in text, f"{path} keeps no band table of its own"
    assert mobile_api.ENTRY_TIME_BANDS is trade_metrics.ENTRY_TIME_BANDS
