"""Per horizon/direction training on an online-v3 dataset, exported to ONNX, registered.

Every slot is trained and judged on its OWN label column. A slot whose horizon is not allowed by the
authority, not labelled in the dataset, or without both classes in training is reported with the
reason and gets no model -- it is never filled with another horizon's model.

Split: chronological, never random. Only a 完整 day (every stock's ticks reconcile, user 10-28) is trained or
validated on; the job passes the dataset's other dates as ``test_only_dates`` and they are the test set, all of them.
The complete dates are then train and validation: with two or more, the last is validation and the rest train; with
one, its samples are ordered by exchange time and cut 80 / 20. Without test-only dates, three or more dates give
train / validation / test by date (the last test, the one before validation); fewer are cut by time 70 / 15 / 15. A
time cut purges, per slot, the samples whose label window (cutoff + horizon) reaches past their part's boundary: a
training sample labelled with validation-period prices leaked the answer into training.
How a slot is trained is a Recipe; the daily run's is ACTIVE_RECIPE. RECIPE (online-v3): every column of the dataset, the category columns each
candidate reads (models.CATEGORY_INPUTS), every 15-second sample, and each stock the same total weight in training
(user 10-29: a pooled model is otherwise pulled toward the stocks that print the most). ONLINE_V2_RECIPE trains as
online-v2 did -- its columns (online-v3 keeps them first; 179 since the 15 removed 11-08), no category, no weight,
the minute's last sample --
for the comparison that decides the switch (spec_comparison.py).
Candidates: logistic and LightGBM (models.py); the run's winner is the lowest validation log loss, unweighted, measured
on the EXPORTED model's own (ONNX Runtime) probabilities -- what Rust B will compute. Every part's metrics also carry
the mean of each stock's own log loss (per_stock_log_loss), which a few heavy stocks cannot dominate. A candidate whose export does not
reproduce the fitted model within EXPORT_TOLERANCE on every training row is eliminated from its slot and recorded
(worst row, rows over, ratio); the slot is trained from the candidates that pass, and fails alone (EXPORT_REJECTED)
only when none does (one candidate's converter error must not fail the whole job). A candidate whose library cannot fit, export or load it (a broken LightGBM install, a converter or ONNX
Runtime error: CANDIDATE_ERRORS) is eliminated the same way with its error recorded, and the slot fails alone
(CANDIDATES_FAILED) only when no candidate is left; any other exception is a program error and stops the run.
Offline metrics are recorded as offline
evidence only -- they are not a production validation. The winner's feature importance (models.importance: logistic
standardised coefficients, LightGBM normalised gain) goes into its manifest and the slot's report, for 特徵權重.

Going live (user decisions): every day's data is trained on, and the run's winner becomes the slot's model when its
validation log loss is below the constant baseline's -- the training part's positive ratio predicted for every row
(``baseline``). A winner that is not has learned nothing a constant does not know, so it does not go live and the slot
keeps the model it already has (it beat the baseline on its own validation day); a slot that has none stays without
one. A model trained on newer data that
scores worse than yesterday's is the model the newer data asked for -- the weights move with the data -- so it is not
held back by comparing it with yesterday's. The run's decisions go live together once every slot is trained: one
registry operation (``promote``) replaces ``champions.json`` with every winner and every slot that keeps its model,
each with its promotion record (which model replaced which, or why the winner did not), so a run that stops before it changes nothing live
and one that passes it has every slot decided; the run report is written after.

The model manifest carries the dataset's FeatureSpec (the one Rust B computed the features with). Rust B refuses a
model bound to any other: dataset, model and worker agree on one digest.
"""
from __future__ import annotations

import hashlib
import json
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

import numpy as np
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score

from service.analysis.inference.contract import MODEL_MANIFEST_SCHEMA, ContractError, load_horizon_authority, prediction_key
from service.analysis.online_training import models
from service.analysis.online_training.dataset import _git_commit, load_dataset
from service.analysis.online_training.labels import LABEL_POLICY, MINUTE_NS, label_columns
from service.analysis.online_training.registry import OnlineModelRegistry

CANDIDATES = models.CANDIDATES
PROMOTION_RULE = "a run's winner goes live when its validation log loss is below the constant baseline's, else the slot keeps its model"
BELOW_BASELINE = "BELOW_BASELINE"
# What a model library raises when it cannot fit, convert or run one candidate: a missing or broken package or DLL
# (ImportError, OSError), data it refuses (ValueError, ArithmeticError), a converter or ONNX Runtime failure
# (RuntimeError, which ONNX Runtime's own errors derive from). TypeError, KeyError, AttributeError and the like are
# this code's errors and are raised.
CANDIDATE_ERRORS = (ImportError, OSError, ValueError, ArithmeticError, RuntimeError)

_log = logging.getLogger(__name__)

# online-v3 keeps online-v2's columns first, unchanged (user 10-29); 15 of its 194 were removed from the FeatureSpec
# (user 11-08: constant in the samples or the same number as another column), leaving 179.
ONLINE_V2_COLUMNS = 179


@dataclass(frozen=True)
class Recipe:
    """How a slot is trained: which numeric columns (None = all), whether the candidates read their category columns,
    whether each stock gets the same total weight, and whether only each key's last sample of a minute is used."""

    name: str
    numeric_count: int | None
    categories: bool
    weighted: bool
    per_minute: bool

    def numeric(self, columns: list[str]) -> list[str]:
        return list(columns if self.numeric_count is None else columns[:self.numeric_count])

    def categorical(self, columns: list[str]) -> list[str]:
        return list(columns) if self.categories else []

    def samples(self, frame):
        """The minute's last sample of each key (sampling-online-v1) when `per_minute`, else every sample."""
        if not self.per_minute or frame.empty:
            return frame
        minute = (frame["cutoff_ns"] // MINUTE_NS).rename("minute")
        last = frame["durable_sequence"].groupby([frame["code"], frame["trading_date"], frame["session"], minute]).transform("max")
        return frame[frame["durable_sequence"] == last]


RECIPE = Recipe("online-v3", None, True, True, False)
ONLINE_V2_RECIPE = Recipe("online-v2", ONLINE_V2_COLUMNS, False, False, True)
# The daily run's recipe. Rust B computes online-v3 (a superset) from the start so its data accumulates while the raw
# history is pruned (3 trading days); the models stay the online-v2 way until spec_comparison.py says SWITCH on
# about 10 trading dates, and then this becomes RECIPE for every slot at once (user 10-29, docs/decisions.md).
ACTIVE_RECIPE = ONLINE_V2_RECIPE


def stock_weights(frame) -> np.ndarray:
    """Each sample's weight so that every stock's samples sum to the same total, the mean weight 1."""
    counts = frame["code"].map(frame["code"].value_counts()).to_numpy(dtype=float)
    stocks = frame["code"].nunique()
    return len(frame) / (stocks * counts) if len(frame) else np.zeros(0)


def _by_time(frame, cuts: tuple[float, ...]):
    """`frame` ordered by exchange time and cut at the `cuts` fractions: the parts and each later part's first cutoff."""
    ordered = frame.sort_values("cutoff_ns", kind="stable")
    n = len(ordered)
    edges = [int(n * c) for c in cuts]
    parts = [ordered.iloc[a:b] for a, b in zip([0, *edges], [*edges, n])]
    return parts, [int(ordered["cutoff_ns"].iloc[e]) if e < n else None for e in edges]


def _split(frame, test_only_dates: Iterable[str] = ()):
    dates = sorted(frame["trading_date"].unique())
    test_only = sorted(set(test_only_dates) & set(dates))
    if test_only:
        trained = [d for d in dates if d not in test_only]
        test = frame[frame["trading_date"].isin(test_only)]
        if not trained:
            raise ContractError("the dataset has no complete trading date to train on")
        if len(trained) >= 2:
            return (frame[frame["trading_date"].isin(trained[:-1])], frame[frame["trading_date"] == trained[-1]], test,
                    {"kind": "by_date", "train": trained[:-1], "validation": [trained[-1]], "test": test_only})
        (train, val), boundaries = _by_time(frame[frame["trading_date"] == trained[0]], (0.80,))
        return train, val, test, {"kind": "by_time_80_20", "dates": trained, "test": test_only,
                                  "boundaries_ns": [boundaries[0], None]}
    if len(dates) >= 3:
        return (frame[frame["trading_date"].isin(dates[:-2])], frame[frame["trading_date"] == dates[-2]],
                frame[frame["trading_date"] == dates[-1]], {"kind": "by_date", "train": dates[:-2],
                                                            "validation": [dates[-2]], "test": [dates[-1]]})
    (train, val, test), boundaries = _by_time(frame, (0.70, 0.85))
    return train, val, test, {"kind": "by_time_70_15_15", "dates": dates, "boundaries_ns": boundaries}


def _purge(train, val, split: dict[str, Any], minutes: int):
    """Drop samples whose label window ends inside the next part (time split only; by date it cannot)."""
    if "boundaries_ns" not in split:
        return train, val, {"train": 0, "validation": 0}
    horizon = int(minutes) * MINUTE_NS
    val_start, test_start = split["boundaries_ns"]
    kept_train = train if val_start is None else train[train["cutoff_ns"] + horizon < val_start]
    kept_val = val if test_start is None else val[val["cutoff_ns"] + horizon < test_start]
    return kept_train, kept_val, {"train": int(len(train) - len(kept_train)), "validation": int(len(val) - len(kept_val))}


def _metrics(y: np.ndarray, p: np.ndarray, codes: np.ndarray | None = None) -> dict[str, Any]:
    """Unweighted log loss, Brier and AUC over the rows, and with `codes` the mean of each stock's own log loss."""
    if len(y) == 0:
        return {"samples": 0}
    out: dict[str, Any] = {"samples": int(len(y)), "positive_ratio": float(np.mean(y)),
                           "log_loss": float(log_loss(y, p, labels=[0, 1])),
                           "brier": float(brier_score_loss(y, p))}
    out["auc"] = float(roc_auc_score(y, p)) if len(set(y.tolist())) == 2 else None
    if codes is not None:
        losses = [log_loss(y[codes == code], p[codes == code], labels=[0, 1]) for code in np.unique(codes)]
        out["per_stock_log_loss"] = float(np.mean(losses))
        out["stocks"] = len(losses)
    return out


def _baseline(y: dict[str, np.ndarray], winner_log_loss: float) -> dict[str, Any]:
    """The constant baseline: the training part's positive ratio predicted for every row of each part, unweighted
    like the winner's selection. ``beaten`` when the winner's validation log loss is strictly lower."""
    ratio = float(np.mean(y["train"]))
    losses = {name: float(log_loss(v, np.full(len(v), ratio), labels=[0, 1])) if len(v) else None for name, v in y.items()}
    return {"positive_ratio": ratio, "log_loss": losses, "winner_validation_log_loss": float(winner_log_loss),
            "beaten": float(winner_log_loss) < losses["validation"]}


class OnlineModelTrainer:
    def __init__(self, registry: OnlineModelRegistry | None, *, random_state: int = 0) -> None:
        """`registry` None: fit_slot only (spec_comparison.py), nothing is registered."""
        self.registry = registry
        self.random_state = int(random_state)

    def train(self, dataset_dir: Path, *, horizons_minutes: Iterable[int] | None = None,
              directions: Iterable[str] = ("up", "down"), promote: bool = True, test_only_dates: Iterable[str] = (),
              progress: Callable[[int, int, str], None] | None = None, recipe: Recipe = ACTIVE_RECIPE) -> dict[str, Any]:
        frame, dataset = load_dataset(dataset_dir)
        authority = load_horizon_authority()
        horizons = authority.validate_enabled(horizons_minutes if horizons_minutes is not None
                                              else authority.default_enabled_minutes)
        missing = [m for m in horizons if m not in dataset.get("horizons_minutes", [])]
        if missing:
            raise ContractError(f"dataset {dataset['dataset_id']} has no labels for {missing} minutes; rebuild it")
        directions = list(directions)
        for direction in directions:
            if direction not in authority.directions:
                raise ContractError(f"direction {direction!r} is not allowed")
        run_id = f"run-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:6]}"
        total = len(horizons) * len(directions)
        if progress:
            progress(0, total, "split")
        train, val, test, split = _split(frame, test_only_dates)
        train, val = recipe.samples(train), recipe.samples(val)
        if progress:
            progress(0, total, "split", {"kind": split["kind"]})
        report: dict[str, Any] = {"run_id": run_id, "dataset_id": dataset["dataset_id"], "split": split,
                                  "horizons_minutes": list(horizons), "slots": {}, "code_commit": _git_commit(),
                                  "random_state": self.random_state, "candidates": list(CANDIDATES),
                                  "feature_spec": dataset["feature_spec"], "recipe": recipe.__dict__}
        numeric, categorical = recipe.numeric(dataset["numeric_columns"]), recipe.categorical(dataset["category_columns"])
        for minutes in horizons:
            up_col, down_col = label_columns(minutes)
            for direction in directions:
                slot = prediction_key(minutes, direction)
                done = len(report["slots"])
                step = (lambda name, done=done: progress(done, total, name)) if progress else None
                if step:
                    step(f"train {slot}")
                label = up_col if direction == "up" else down_col
                slot_train, slot_val, purged = _purge(train, val, split, minutes)
                result = self._train_slot(
                    slot, minutes, direction, label, slot_train, slot_val, test, numeric, categorical, dataset, run_id,
                    recipe, report_step=step)
                result["purged"] = purged
                report["slots"][slot] = result
        trained = [(slot, r) for slot, r in report["slots"].items() if r.get("status") == "TRAINED"]
        if promote and trained:
            if progress:
                progress(total, total, "promote")
            live = [r for _slot, r in trained if r["baseline"]["beaten"]]
            down = [r for _slot, r in trained if not r["baseline"]["beaten"]]
            promotions = self.registry.promote(
                run_id, [(r["horizon_minutes"], r["direction"], r["model_id"]) for r in live],
                held=[(r["horizon_minutes"], r["direction"], r["model_id"],
                            {"reason": BELOW_BASELINE, "baseline": r["baseline"]}) for r in down],
                rule=PROMOTION_RULE, decided_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
            for slot, result in trained:
                result["promotion"] = promotions[slot]
                result["promoted"] = promotions[slot]["promoted"]
        return report

    def fit_slot(self, slot: str, label: str, parts: dict[str, Any], numeric: list[str], categorical: list[str],
                 recipe: Recipe, *, report_step: Callable[[str], None] | None = None) -> dict[str, Any]:
        """Every candidate fitted on ``parts["train"]``, exported and checked, with each part's metrics; the winner is
        the lowest unweighted validation log loss. Nothing is registered. ``status`` is TRAINED or why not."""
        parts = {name: part[part[label].notna()] for name, part in parts.items()}
        y = {name: part[label].astype(int).to_numpy() for name, part in parts.items()}
        codes = {name: part["code"].astype(str).to_numpy() for name, part in parts.items()}
        counts = {name: int(len(v)) for name, v in y.items()}
        if len(set(y["train"].tolist())) < 2 or counts["validation"] == 0:
            return {"status": "INSUFFICIENT_LABELS", "counts": counts,
                    "reason": "training needs both classes and a non-empty validation set"}
        weights = stock_weights(parts["train"]) if recipe.weighted else None
        folds = models.logistic_folds(parts["train"]["trading_date"].to_numpy(), parts["train"]["cutoff_ns"].to_numpy())
        candidates, rejected = [], []
        for kind in CANDIDATES:
            if report_step:
                report_step(f"train {slot} {kind}")
            matrix = models.FeatureMatrix.for_candidate(kind, numeric, categorical).fit(parts["train"])
            x = {name: matrix.matrix(part) for name, part in parts.items()}
            step = "fit"
            try:
                fitted = models.fit(kind, x["train"], y["train"], sample_weight=weights, categorical=matrix.code_columns(),
                                    folds=folds, random_state=self.random_state)
                step = "export"
                onnx_bytes = models.to_onnx(kind, fitted, matrix.width)
                step = "runtime"
                check = models.export_check(onnx_bytes, fitted, x["train"])
                if not check["ok"]:
                    rejected.append({"kind": kind, "slot": slot, "reason": "EXPORT_DEVIATES", **check})
                    continue
                metrics = {name: _metrics(y[name], models.predict_onnx(onnx_bytes, x[name]), codes[name]) if len(x[name])
                           else {"samples": 0} for name in parts}
            except CANDIDATE_ERRORS as exc:
                _log.warning("training candidate %s of %s failed at %s: %s: %s", kind, slot, step, type(exc).__name__, exc,
                             exc_info=True)
                rejected.append({"kind": kind, "slot": slot, "reason": f"{step.upper()}_FAILED",
                                 "error": f"{type(exc).__name__}: {exc}"[:500]})
                continue
            candidates.append({"kind": kind, "fitted": fitted, "onnx": onnx_bytes, "metrics": metrics, "matrix": matrix,
                               "export_max_abs_diff": check["max_abs_diff"], "params": models.params(kind, fitted)})
        if not candidates:
            if all(r["reason"] == "EXPORT_DEVIATES" for r in rejected):
                return {"status": "EXPORT_REJECTED", "counts": counts, "rejected_candidates": rejected,
                        "reason": "no candidate's ONNX export reproduced the fitted model within the tolerance"}
            return {"status": "CANDIDATES_FAILED", "counts": counts, "rejected_candidates": rejected,
                    "reason": "no candidate could be fitted, exported and checked"}
        winner = min(candidates, key=lambda c: c["metrics"]["validation"]["log_loss"])
        return {"status": "TRAINED", "counts": counts, "candidates": candidates, "rejected_candidates": rejected,
                "winner": winner, "baseline": _baseline(y, winner["metrics"]["validation"]["log_loss"])}

    def _train_slot(self, slot, minutes, direction, label, train, val, test, numeric, categorical, dataset,
                    run_id, recipe: Recipe, *, report_step: Callable[[str], None] | None = None) -> dict[str, Any]:
        fitted = self.fit_slot(slot, label, {"train": train, "validation": val, "test": test}, numeric, categorical, recipe,
                               report_step=report_step)
        if fitted["status"] != "TRAINED":
            return fitted
        counts, candidates, rejected, winner, baseline = (
            fitted[k] for k in ("counts", "candidates", "rejected_candidates", "winner", "baseline"))
        matrix = winner["matrix"]
        model_id = f"{slot}-{winner['kind']}-{run_id}"
        importance = models.importance(winner["kind"], winner["fitted"], matrix.columns())
        manifest = {
            "schema": MODEL_MANIFEST_SCHEMA, "model_id": model_id, "model_version": run_id,
            "artifact": {"path": "model.onnx", "sha256": "", "format": models.MODEL_FORMAT, "kind": winner["kind"],
                         "opset": models.ONNX_OPSET},
            "runtime": {"engine": "onnxruntime", "execution_provider": "cpu", "trained_with": self._versions()},
            "feature_spec": dict(dataset["feature_spec"]),
            "io": matrix.io(),
            # What it was trained on, and so the only instruments Rust B applies it to.
            "scope": {"sources": list(dataset.get("sources") or []), "markets": list(dataset.get("markets") or [])},
            "horizon_minutes": int(minutes), "direction": direction,
            "label_version": LABEL_POLICY["version"], "label_column": label,
            "dataset_version": dataset["dataset_id"], "training_run_id": run_id,
            "horizon_authority_version": dataset["horizon_authority_version"],
            "validation": {"status": "OFFLINE_METRICS_ONLY", "metrics": winner["metrics"],
                           "export_max_abs_diff": winner["export_max_abs_diff"]},
            "test_only": False,
            # What the model center shows as 特徵權重; Rust B does not read it.
            "feature_importance": importance,
        }
        run = {"run_id": run_id, "slot": slot, "dataset_id": dataset["dataset_id"],
               "candidates": [{k: c[k] for k in ("kind", "metrics", "export_max_abs_diff", "params")} for c in candidates],
               "rejected_candidates": rejected,
               "winner": winner["kind"], "selection": "lowest unweighted validation log_loss (ONNX Runtime probabilities)",
               "baseline": baseline, "recipe": recipe.__dict__, "label_policy": LABEL_POLICY, "counts": counts}
        self.registry.register(model_id, artifact=winner["onnx"], manifest=manifest, run=run)
        # Not live yet: train() decides every trained slot of the run in one operation. A winner below the baseline is
        # still registered so its run stays inspectable; it is never put live.
        return {"status": "TRAINED", "model_id": model_id, "horizon_minutes": int(minutes), "direction": direction,
                "winner": winner["kind"], "counts": counts, "rejected_candidates": rejected,
                "metrics": winner["metrics"], "baseline": baseline, "promoted": False, "promotion": None,
                "feature_importance": importance,
                "artifact_sha256": hashlib.sha256(winner["onnx"]).hexdigest()}

    @staticmethod
    def _versions() -> dict[str, str]:
        import importlib

        out = {}
        for name in ("sklearn", "lightgbm", "skl2onnx", "onnxmltools", "onnx", "onnxruntime"):
            try:
                out[name] = str(importlib.import_module(name).__version__)
            except Exception:  # noqa: BLE001 -- provenance only  # not an error: provenance only: a library that cannot be imported is listed as unavailable
                out[name] = "unavailable"
        return out


def summarize(report: dict[str, Any]) -> str:
    return json.dumps({slot: {k: v for k, v in r.items() if k in ("status", "winner", "counts", "reason")}
                       for slot, r in report["slots"].items()}, indent=1)
