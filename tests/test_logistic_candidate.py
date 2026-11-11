"""The logistic candidate: C chosen over held-out training days, values clipped to the training range (also in ONNX).

11-08 (run-20261107T195302Z-9bf87c): with scikit-learn's default C=1 on three training days the 30m_up logistic
ranked the validation day backwards (AUC 0.21, log loss 3.21 against the constant's 0.58) and gave test rows logits
up to 40 from values far outside the training range.
"""
from __future__ import annotations

import numpy as np
import pytest

from service.analysis.inference.contract import ContractError
from service.analysis.online_training import models


def test_the_folds_are_the_training_days_or_with_one_day_contiguous_time_blocks():
    dates = np.array(["2026-11-02", "2026-11-03", "2026-11-02", "2026-11-05"])
    folds = models.logistic_folds(dates, np.array([3, 1, 2, 0]))
    assert [m.tolist() for m in folds] == [[True, False, True, False], [False, True, False, False],
                                           [False, False, False, True]]
    one_day = models.logistic_folds(np.array(["2026-11-05"] * 10), np.arange(10)[::-1])
    assert len(one_day) == models.LOGISTIC_TIME_FOLDS
    assert sum(m.sum() for m in one_day) == 10 and not np.any(np.sum(one_day, axis=0) != 1)
    # Each block is a contiguous stretch of time: the first holds the earliest rows (the last two positions here).
    assert one_day[0].tolist() == [False] * 8 + [True, True]


def _two_regimes(rng, rows_per_day: int = 400):
    """Day A: the label follows `signal`; day B: it follows `signal` too, while `day_level` (one value per day, like an
    index's return) separates the days and means nothing for the label."""
    xs, ys, dates = [], [], []
    for day, level in (("2026-11-02", -1.0), ("2026-11-03", 1.0), ("2026-11-04", 0.0)):
        signal = rng.normal(size=rows_per_day)
        y = (signal + rng.normal(scale=1.0, size=rows_per_day) > 0).astype(int)
        y[: rows_per_day // 4] = 1 if level > 0 else y[: rows_per_day // 4]   # the days' base rates differ
        xs.append(np.column_stack([signal, np.full(rows_per_day, level) + rng.normal(scale=0.01, size=rows_per_day)]))
        ys.append(y)
        dates += [day] * rows_per_day
    return np.vstack(xs).astype(np.float32), np.concatenate(ys), np.array(dates)


def test_c_is_the_grid_value_with_the_lowest_held_out_day_log_loss_and_is_recorded():
    rng = np.random.default_rng(0)
    x, y, dates = _two_regimes(rng)
    folds = models.logistic_folds(dates, np.arange(len(y)))
    fitted = models.fit("logistic", x, y, folds=folds)
    chosen = models.params("logistic", fitted)
    losses = chosen["held_out_log_loss"]
    assert set(losses) == {repr(c) for c in models.LOGISTIC_C_GRID}
    assert chosen["C"] == float(min(losses, key=losses.get)) == fitted.named_steps["model"].C
    assert models.params("lightgbm", object()) == {}
    with pytest.raises(ContractError):
        models.fit("logistic", x, y)   # no folds: C cannot be chosen


def test_a_value_beyond_the_training_range_moves_the_probability_no_further_and_onnx_agrees():
    rng = np.random.default_rng(1)
    x = rng.normal(size=(500, 2)).astype(np.float32)
    y = (x[:, 0] + rng.normal(scale=0.5, size=500) > 0).astype(int)
    fitted = models.fit("logistic", x, y, folds=models.logistic_folds(np.array(["d"] * 500), np.arange(500)))
    edge = x[:, 0].max()
    rows = np.array([[edge, 0.0], [edge * 50, 0.0], [np.nan, 0.0]], dtype=np.float32)
    p = fitted.predict_proba(rows.astype(np.float64))[:, 1]
    assert p[1] == pytest.approx(p[0]), "50 times the largest training value is read as the largest"
    onnx_bytes = models.to_onnx("logistic", fitted, 2)
    check = models.export_check(onnx_bytes, fitted, np.vstack([x, rows]))
    assert check["ok"], check
    assert models.predict_onnx(onnx_bytes, rows)[1] == pytest.approx(p[0], abs=1e-6)
