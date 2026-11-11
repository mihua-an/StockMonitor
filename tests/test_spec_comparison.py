"""online-v3 vs online-v2 (spec_comparison.py) and the training recipes it compares (trainer.py).

The synthetic store's metrics are plumbing evidence only, never model quality.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from service.analysis.online_training import spec_comparison
from service.analysis.online_training.labels import MINUTE_NS
from service.analysis.online_training.trainer import ONLINE_V2_COLUMNS, ONLINE_V2_RECIPE, RECIPE, stock_weights
from tests.support.online_training_store import store  # noqa: F401  -- the module-scoped dataset fixture


def test_every_stock_weighs_the_same_in_total():
    frame = pd.DataFrame({"code": ["A"] * 6 + ["B"] * 2})
    weights = stock_weights(frame)
    assert weights[:6].sum() == pytest.approx(weights[6:].sum())
    assert weights.mean() == pytest.approx(1.0)


def test_the_online_v2_recipe_reads_the_minutes_last_sample_and_its_179_columns():
    second = 1_000_000_000
    frame = pd.DataFrame({"code": ["A"] * 5, "trading_date": ["d"] * 5, "session": ["DAY"] * 5,
                          "cutoff_ns": [0, 15 * second, 45 * second, MINUTE_NS + 5 * second, MINUTE_NS + 50 * second],
                          "durable_sequence": [1, 2, 3, 4, 5]})
    assert list(ONLINE_V2_RECIPE.samples(frame)["durable_sequence"]) == [3, 5], "each minute's last"
    assert len(RECIPE.samples(frame)) == 5, "the new way keeps every 15-second sample"
    columns = [f"c{i}" for i in range(ONLINE_V2_COLUMNS + 16)]
    assert ONLINE_V2_COLUMNS == 179, "online-v2's columns after the 11-08 removal of 15"
    assert ONLINE_V2_RECIPE.numeric(columns) == columns[:179] and RECIPE.numeric(columns) == columns
    assert ONLINE_V2_RECIPE.categorical(["industry", "stock"]) == [] and RECIPE.categorical(["industry", "stock"]) == ["industry", "stock"]


def _slot(old: float, new: float, low_old: float, low_new: float) -> dict:
    mean = lambda all_, low: {"all.log_loss": all_, "low_liquidity.per_stock_log_loss": low}  # noqa: E731
    return {"mean": {ONLINE_V2_RECIPE.name: mean(old, low_old), RECIPE.name: mean(new, low_new)}}


def test_the_switch_needs_seven_better_slots_and_a_low_liquidity_half_not_worse():
    better = {f"s{i}": _slot(0.6, 0.5, 0.7, 0.7) for i in range(7)}
    worse = {f"w{i}": _slot(0.5, 0.6, 0.7, 0.7) for i in range(3)}
    verdict = spec_comparison.verdict({**better, **worse}, trading_dates=13)
    assert verdict["decision"] == "SWITCH" and verdict["formal"] and len(verdict["slots_better"]) == 7
    six = {**{f"s{i}": _slot(0.6, 0.5, 0.7, 0.7) for i in range(6)}, **{f"w{i}": _slot(0.5, 0.6, 0.7, 0.7) for i in range(4)}}
    assert spec_comparison.verdict(six, trading_dates=13)["decision"] == "KEEP_ONLINE_V2"
    thin_worse = {f"s{i}": _slot(0.6, 0.5, 0.70, 0.71) for i in range(10)}
    verdict = spec_comparison.verdict(thin_worse, trading_dates=13)
    assert verdict["decision"] == "KEEP_ONLINE_V2" and not verdict["low_liquidity_not_worse"], "the thinly traded half got worse"
    assert not spec_comparison.verdict({**better, **worse}, trading_dates=12)["formal"], "fewer than 13 dates: a preview"


def test_both_ways_train_before_each_test_day_and_are_scored_on_the_same_samples(store):  # noqa: F811
    _root, directory, dataset, _exporter = store
    report = spec_comparison.compare(directory, horizons_minutes=[3], directions=["up"], test_days=2)
    assert report["test_days"] == dataset["trading_dates"][-2:]
    days = report["slots"]["3m_up"]["days"]
    for day in days:
        assert all(d < day["test_day"] for d in day["trained_on"]), "only dates before the test day are trained on"
        old, new = day[ONLINE_V2_RECIPE.name], day[RECIPE.name]
        assert old["status"] == new["status"] == "TRAINED", day
        assert old["test"]["all"]["samples"] == new["test"]["all"]["samples"], "the same test samples"
        assert old["counts"]["train"] < new["counts"]["train"], "the old way trains on the minute's last samples only"
        halves = new["test"]
        assert halves["high_liquidity"]["samples"] + halves["low_liquidity"]["samples"] == halves["all"]["samples"]
        assert np.isfinite(halves["all"]["per_stock_log_loss"])
    assert report["verdict"]["decision"] in ("SWITCH", "KEEP_ONLINE_V2") and not report["verdict"]["formal"]
    assert set(report["liquidity_halves"]["high"]).isdisjoint(report["liquidity_halves"]["low"])
