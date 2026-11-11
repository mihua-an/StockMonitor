"""Whether online-v3 replaces online-v2: both ways trained on the same samples and judged on the same test days.

    python -m service.analysis.online_training.spec_comparison --dataset <online-v3 dataset dir> [--out <report.json>]

Rust B runs one FeatureSpec at a time and every slot switches together (user 10-29), so the switch is decided once,
on evidence over every allowed horizon and both directions (the 10 slots): online-v3 is a superset of online-v2 (its columns first, unchanged; 179 since the 11-08 removal), so one online-v3
dataset holds both. The old way (trainer.ONLINE_V2_RECIPE) reads those columns of the minute's last samples, unweighted; the new
way (trainer.RECIPE) reads every column, the candidates' category columns and every 15-second sample, each stock
weighted the same. Each of the last TEST_DAYS trading dates is the test day in turn: both ways train on the 完整 dates
before it only (the newest of them validates, picking each slot's candidate as the daily run does) and are scored on
the same test samples -- all of that day's. Per slot and way: unweighted log loss (the measure), the mean of each
stock's own log loss, AUC; each again over the more and the less traded half of the stocks (mean daily amount on the
dates before the first test day).

Verdict, over the test days' mean: the new way has a lower log loss in at least MIN_BETTER_SLOTS of the slots and the
less traded half's per-stock log loss, averaged over the slots, is not worse -> SWITCH; otherwise KEEP_ONLINE_V2, and
the report goes to the user. It is formal only with at least FORMAL_DATES trading dates: the behaviour columns need
10 earlier sessions to have values, so with 13 every one of the last TEST_DAYS test days has them (user 10-29);
before that it is shown as a preview.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Iterable

import numpy as np

from service.analysis.inference.contract import load_horizon_authority, prediction_key
from service.analysis.online_training import models
from service.analysis.online_training.dataset import load_dataset
from service.analysis.online_training.labels import label_columns
from service.analysis.online_training.trainer import (
    ONLINE_V2_RECIPE, RECIPE, OnlineModelTrainer, Recipe, _by_time, _metrics, _purge,
)

TEST_DAYS = 3
MIN_BETTER_SLOTS = 7
FORMAL_DATES = 13
RECIPES = (ONLINE_V2_RECIPE, RECIPE)


def liquidity_halves(frame, before: str) -> tuple[set[str], set[str]]:
    """The stocks above and at-or-below the median mean daily amount (each date's last log_amount_today) before `before`."""
    earlier = frame[frame["trading_date"] < before]
    if earlier.empty:
        earlier = frame
    daily = earlier.groupby(["code", "trading_date"])["log_amount_today"].max()
    mean = daily.groupby(level="code").mean().sort_values()
    median = float(mean.median())
    return set(mean[mean > median].index), set(mean[mean <= median].index)


def _train_validation(frame, dates: list[str], minutes: int):
    """The newest date validates and the rest train; one date is cut 80 / 20 by time and purged."""
    if len(dates) >= 2:
        return frame[frame["trading_date"].isin(dates[:-1])], frame[frame["trading_date"] == dates[-1]]
    (train, val), boundaries = _by_time(frame[frame["trading_date"] == dates[0]], (0.80,))
    train, val, _purged = _purge(train, val, {"boundaries_ns": [boundaries[0], None]}, minutes)
    return train, val


def _scores(label: str, part, probability: np.ndarray, halves: tuple[set[str], set[str]]) -> dict[str, Any]:
    known = part[label].notna().to_numpy()
    y = part[label].to_numpy()[known].astype(int)
    p, codes = probability[known], part["code"].astype(str).to_numpy()[known]
    out = {"all": _metrics(y, p, codes)}
    for name, members in zip(("high_liquidity", "low_liquidity"), halves):
        mask = np.isin(codes, list(members))
        out[name] = _metrics(y[mask], p[mask], codes[mask])
    return out


def compare(dataset_dir: Path, *, test_only_dates: Iterable[str] = (), horizons_minutes: Iterable[int] | None = None,
            directions: Iterable[str] = ("up", "down"), test_days: int = TEST_DAYS, random_state: int = 0) -> dict[str, Any]:
    frame, dataset = load_dataset(dataset_dir)
    authority = load_horizon_authority()
    horizons = authority.validate_enabled(horizons_minutes if horizons_minutes is not None else authority.allowed_minutes)
    directions = list(directions)
    dates = sorted(frame["trading_date"].unique())
    incomplete = set(test_only_dates)
    tests = dates[-test_days:]
    halves = liquidity_halves(frame, tests[0])
    trainer = OnlineModelTrainer(None, random_state=random_state)
    slots: dict[str, Any] = {}
    for minutes in horizons:
        up_col, down_col = label_columns(minutes)
        for direction in directions:
            slot = prediction_key(minutes, direction)
            label = up_col if direction == "up" else down_col
            days = []
            for day in tests:
                trained_on = [d for d in dates if d < day and d not in incomplete]
                if not trained_on:
                    days.append({"test_day": day, "status": "NO_EARLIER_COMPLETE_DATE"})
                    continue
                train, val = _train_validation(frame, trained_on, minutes)
                test = frame[frame["trading_date"] == day]
                entry: dict[str, Any] = {"test_day": day, "trained_on": trained_on}
                for recipe in RECIPES:
                    entry[recipe.name] = _run(trainer, recipe, slot, label, train, val, test, dataset, halves)
                days.append(entry)
            slots[slot] = {"days": days, "mean": _mean(days)}
    return {"dataset_id": dataset["dataset_id"], "feature_spec": dataset["feature_spec"], "trading_dates": dates,
            "test_days": tests, "liquidity_halves": {"high": sorted(halves[0]), "low": sorted(halves[1])},
            "recipes": [r.__dict__ for r in RECIPES], "slots": slots, "verdict": verdict(slots, len(dates))}


def _run(trainer: OnlineModelTrainer, recipe: Recipe, slot: str, label: str, train, val, test, dataset, halves) -> dict[str, Any]:
    numeric, categorical = recipe.numeric(dataset["numeric_columns"]), recipe.categorical(dataset["category_columns"])
    fitted = trainer.fit_slot(slot, label, {"train": recipe.samples(train), "validation": recipe.samples(val)},
                              numeric, categorical, recipe)
    if fitted["status"] != "TRAINED":
        return {"status": fitted["status"], "reason": fitted.get("reason")}
    winner = fitted["winner"]
    probability = models.predict_onnx(winner["onnx"], winner["matrix"].matrix(test))
    return {"status": "TRAINED", "winner": winner["kind"], "counts": fitted["counts"],
            "validation": winner["metrics"]["validation"], "test": _scores(label, test, probability, halves)}


def _mean(days: list[dict[str, Any]]) -> dict[str, Any]:
    """Each way's test metrics averaged over the test days it was trained on."""
    out: dict[str, Any] = {}
    for recipe in RECIPES:
        runs = [d[recipe.name]["test"] for d in days if d.get(recipe.name, {}).get("status") == "TRAINED"]
        values: dict[str, Any] = {"test_days": len(runs)}
        for part in ("all", "high_liquidity", "low_liquidity"):
            for metric in ("log_loss", "per_stock_log_loss", "auc"):
                found = [r[part].get(metric) for r in runs if r[part].get(metric) is not None]
                values[f"{part}.{metric}"] = float(np.mean(found)) if found else None
        out[recipe.name] = values
    return out


def verdict(slots: dict[str, Any], trading_dates: int) -> dict[str, Any]:
    old, new = ONLINE_V2_RECIPE.name, RECIPE.name
    better, compared, low_old, low_new = [], 0, [], []
    for slot, result in slots.items():
        mean = result["mean"]
        a, b = mean[old]["all.log_loss"], mean[new]["all.log_loss"]
        if a is None or b is None:
            continue
        compared += 1
        if b < a:
            better.append(slot)
        la, lb = mean[old]["low_liquidity.per_stock_log_loss"], mean[new]["low_liquidity.per_stock_log_loss"]
        if la is not None and lb is not None:
            low_old.append(la)
            low_new.append(lb)
    low_ok = bool(low_old) and float(np.mean(low_new)) <= float(np.mean(low_old))
    decision = "SWITCH" if len(better) >= MIN_BETTER_SLOTS and low_ok else "KEEP_ONLINE_V2"
    return {"decision": decision, "formal": trading_dates >= FORMAL_DATES, "trading_dates": trading_dates,
            "slots_compared": compared, "slots_better": better, "min_better_slots": MIN_BETTER_SLOTS,
            "low_liquidity_per_stock_log_loss": {old: float(np.mean(low_old)) if low_old else None,
                                                  new: float(np.mean(low_new)) if low_new else None},
            "low_liquidity_not_worse": low_ok}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--test-only-date", action="append", default=[], help="an incomplete date: never trained on")
    args = parser.parse_args(argv)
    report = compare(args.dataset, test_only_dates=args.test_only_date)
    text = json.dumps(report, indent=1, ensure_ascii=False, default=str)
    if args.out:
        args.out.write_text(text, encoding="utf-8")
    print(json.dumps(report["verdict"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
