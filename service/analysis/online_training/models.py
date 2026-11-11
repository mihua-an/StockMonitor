"""Model candidates and their ONNX export for the inference worker (Rust B runs ONNX through ONNX Runtime).

The model input is one float32 row (``FeatureMatrix``): the online-v3 numeric columns in spec order, missing = NaN,
then the category columns the candidate reads (CATEGORY_INPUTS) over the TRAINING vocabulary, which always holds
OTHER_TOKEN: a value seen on fewer than the column's minimum trading days in the training rows (a stock with less
than STOCK_MIN_DAYS days, user 10-29) and any value never seen -- a new listing online -- encode as OTHER_TOKEN.
Rust builds exactly this row from its own features (native/analysis_runtime/src/model.rs). Imputation and scaling
live inside the exported graph, so the row carries no fitted preprocessing state but the vocabulary, which the
manifest records.

Candidates:
* ``logistic``: median imputation, standardisation, each standardised value clipped to its training range, logistic
  regression (scikit-learn pipeline); the industry one-hot. A linear model learns one fixed offset per category value,
  which for a stock code is only the period's drift, so it is given the industry and not the stock (user 10-29).
  With a few training days a weakly regularised fit learns those days' market (the day-level index columns take
  only one path per day): scikit-learn's default C=1 ranked the next day backwards (validation AUC 0.21 on 30m_up,
  11-08). So C is chosen from LOGISTIC_C_GRID by the held-out log loss of each training day left out in turn (or, with
  one training day, of each of LOGISTIC_TIME_FOLDS contiguous time blocks), and a value outside the training range --
  a day unlike any trained on -- moves the logit no further than the most extreme training row did;
* ``lightgbm``: LightGBM gradient-boosted trees, NaN routed by each split's learned missing direction; the industry
  and the stock as native categorical columns (the value's vocabulary index), so a split can learn how one stock or
  one industry behaves in a pattern.
Both take a per-sample weight (the trainer gives every stock the same total weight).
scikit-learn's HistGradientBoosting is not a candidate: its ONNX converter (skl2onnx 1.20 on scikit-learn 1.9)
produced probabilities off by up to 0.13 on rows with missing values.

A candidate whose ONNX export does not reproduce the fitted model's own probabilities on every training row (cast to
float32, the deployed input type) within EXPORT_TOLERANCE is eliminated from its slot (trainer.py, export_check).
The fitted LightGBM model's split thresholds are float32 values (float32_thresholds), so its export is the same model
and a deviation over the tolerance is a converter or runtime error, never rounding.
"""
from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
from sklearn.base import BaseEstimator, TransformerMixin

from service.analysis.inference.contract import MISSING_TOKEN, ContractError, normalize_category

MODEL_FORMAT = "onnx"
CANDIDATES = ("logistic", "lightgbm")
OTHER_TOKEN = "__OTHER__"
STOCK_MIN_DAYS = 10
# The category columns each candidate reads, and their encoding.
CATEGORY_INPUTS = {"logistic": (("industry",), "one_hot"), "lightgbm": (("industry", "stock"), "code")}
# A value needs this many distinct trading dates in the training rows to get its own vocabulary entry.
CATEGORY_MIN_DAYS = {"stock": STOCK_MIN_DAYS}
INPUT_NAME = "features"
OUTPUT_NAME = "probabilities"
POSITIVE_CLASS_INDEX = 1
EXPORT_TOLERANCE = 1e-5
ONNX_OPSET = {"": 17, "ai.onnx.ml": 3}
LOGISTIC_C_GRID = (1.0, 0.1, 0.01, 0.001, 0.0001, 0.00001)
LOGISTIC_TIME_FOLDS = 5


class ClipToTrainingRange(TransformerMixin, BaseEstimator):
    """Each column clipped to the [min, max] it had in the rows it was fitted on (after imputation, so no NaN)."""

    def fit(self, x, y=None):
        x = np.asarray(x, dtype=np.float64)
        self.low_, self.high_ = x.min(axis=0), x.max(axis=0)
        return self

    def transform(self, x):
        return np.maximum(np.minimum(np.asarray(x, dtype=np.float64), self.high_), self.low_)


def logistic_folds(dates: np.ndarray, times: np.ndarray) -> list[np.ndarray]:
    """Held-out masks over the training rows: one per training day, or with one day LOGISTIC_TIME_FOLDS contiguous
    blocks of the rows ordered by `times` (exchange time)."""
    dates = np.asarray(dates).astype(str)
    days = np.unique(dates)
    if len(days) >= 2:
        return [dates == day for day in days]
    order = np.argsort(np.asarray(times), kind="stable")
    masks = []
    for block in np.array_split(order, LOGISTIC_TIME_FOLDS):
        mask = np.zeros(len(dates), dtype=bool)
        mask[block] = True
        masks.append(mask)
    return masks


def _choose_c(z: np.ndarray, y: np.ndarray, sample_weight: np.ndarray | None, folds: list[np.ndarray],
              random_state: int) -> tuple[float, dict[str, float]]:
    """The grid C with the lowest mean unweighted held-out log loss (the measure the candidates are picked by); a
    fold whose training rows have one class is left out."""
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import log_loss

    losses: dict[str, float] = {}
    for c in LOGISTIC_C_GRID:
        held = []
        for mask in folds:
            if len(set(y[~mask].tolist())) < 2 or not mask.any():
                continue
            weight = None if sample_weight is None else sample_weight[~mask]
            model = LogisticRegression(C=c, max_iter=2000, random_state=random_state).fit(z[~mask], y[~mask], sample_weight=weight)
            held.append(log_loss(y[mask], model.predict_proba(z[mask])[:, 1], labels=[0, 1]))
        if held:
            losses[repr(c)] = float(np.mean(held))
    if not losses:
        raise ValueError("no held-out fold has both classes to train on: C cannot be chosen")
    best = min(losses, key=losses.get)
    return float(best), losses


class FeatureMatrix:
    """Numeric columns then the categories, one-hot (``one_hot``) or as their vocabulary index (``code``); the
    vocabulary is fitted on the training rows only."""

    def __init__(self, numeric: list[str], categorical: list[str], encoding: str = "one_hot") -> None:
        if encoding not in ("one_hot", "code"):
            raise ContractError(f"unknown category encoding {encoding!r}")
        self.numeric = list(numeric)
        self.categorical = list(categorical)
        self.encoding = encoding
        self.vocab: dict[str, list[str]] = {}

    @classmethod
    def for_candidate(cls, kind: str, numeric: list[str], available: list[str]) -> "FeatureMatrix":
        """The matrix candidate `kind` reads: its CATEGORY_INPUTS that the dataset has."""
        names, encoding = CATEGORY_INPUTS[kind]
        return cls(numeric, [name for name in names if name in available], encoding)

    def fit(self, frame) -> "FeatureMatrix":
        self.vocab = {}
        for name in self.categorical:
            tokens = frame[name].map(normalize_category)
            minimum = CATEGORY_MIN_DAYS.get(name)
            if minimum is None:
                kept = set(tokens)
            else:
                days = pd.DataFrame({"token": tokens.to_numpy(), "date": frame["trading_date"].to_numpy()}).groupby("token")["date"].nunique()
                kept = {token for token, n in days.items() if n >= minimum}
            self.vocab[name] = sorted({*kept, OTHER_TOKEN})
        return self

    @property
    def width(self) -> int:
        if self.encoding == "code":
            return len(self.numeric) + len(self.categorical)
        return len(self.numeric) + sum(len(v) for v in self.vocab.values())

    def _indices(self, frame, name: str) -> np.ndarray:
        index = {token: i for i, token in enumerate(self.vocab[name])}
        other = index[OTHER_TOKEN]
        return np.array([index.get(normalize_category(v), other) for v in frame[name]], dtype=np.int64)

    def matrix(self, frame) -> np.ndarray:
        numeric = np.column_stack([np.asarray(frame[n], dtype=float) for n in self.numeric]) if len(frame) else np.zeros((0, len(self.numeric)))
        numeric = np.where(np.isfinite(numeric), numeric, np.nan)
        blocks = [numeric]
        for name in self.categorical:
            indices = self._indices(frame, name) if len(frame) else np.zeros(0, dtype=np.int64)
            if self.encoding == "code":
                blocks.append(indices.astype(float).reshape(-1, 1))
            else:
                block = np.zeros((len(indices), len(self.vocab[name])))
                block[np.arange(len(indices)), indices] = 1.0
                blocks.append(block)
        return np.hstack(blocks).astype(np.float32)

    def code_columns(self) -> list[int]:
        """The matrix columns that are categorical codes (LightGBM's categorical_feature)."""
        if self.encoding != "code":
            return []
        return list(range(len(self.numeric), len(self.numeric) + len(self.categorical)))

    def columns(self) -> list[str]:
        """The name of every matrix column, in order: the numeric feature, the category (``code``), or
        ``category=token`` (``one_hot``)."""
        if self.encoding == "code":
            return [*self.numeric, *self.categorical]
        return [*self.numeric, *(f"{name}={token}" for name in self.categorical for token in self.vocab[name])]

    def io(self) -> dict[str, Any]:
        return {"input": INPUT_NAME, "output": OUTPUT_NAME, "class_index": POSITIVE_CLASS_INDEX, "dtype": "float32",
                "numeric": self.numeric, "categorical": self.categorical, "category_vocab": self.vocab,
                "category_encoding": self.encoding, "missing_token": MISSING_TOKEN, "other_token": OTHER_TOKEN,
                "layout": ("numeric (NaN = missing) then each categorical column's vocabulary index" if self.encoding == "code"
                           else "numeric (NaN = missing) then one-hot per categorical column")}


def fit(kind: str, x: np.ndarray, y: np.ndarray, *, sample_weight: np.ndarray | None = None,
        categorical: list[int] | None = None, folds: list[np.ndarray] | None = None, random_state: int = 0):
    """`categorical`: the matrix columns holding category codes (LightGBM only; FeatureMatrix.code_columns).
    `folds`: the held-out row masks the logistic candidate chooses its C over (logistic_folds)."""
    if kind == "logistic":
        from sklearn.impute import SimpleImputer
        from sklearn.linear_model import LogisticRegression
        from sklearn.pipeline import Pipeline
        from sklearn.preprocessing import StandardScaler

        if categorical:
            raise ContractError("the logistic candidate reads categories one-hot, never as codes")
        if not folds or any(len(mask) != len(y) for mask in folds):
            raise ContractError("the logistic candidate needs held-out folds over its training rows to choose its C")
        prepare = Pipeline([("impute", SimpleImputer(strategy="median", keep_empty_features=True)),
                            ("scale", StandardScaler()), ("clip", ClipToTrainingRange())])
        z = prepare.fit_transform(x.astype(np.float64))
        c, losses = _choose_c(z, y, sample_weight, folds, random_state)
        model = Pipeline([*prepare.steps, ("model", LogisticRegression(C=c, max_iter=2000, random_state=random_state))])
        model.steps[-1][1].fit(z, y, sample_weight=sample_weight)
        model.chosen_params_ = {"C": c, "held_out_log_loss": losses}
        return model
    elif kind == "lightgbm":
        import lightgbm
        from lightgbm import LGBMClassifier

        model = LGBMClassifier(n_estimators=200, learning_rate=0.05, num_leaves=15, min_child_samples=50,
                               subsample=1.0, colsample_bytree=1.0, random_state=random_state, deterministic=True,
                               n_jobs=1, verbose=-1)
        model.fit(x.astype(np.float64), y, sample_weight=sample_weight, categorical_feature=list(categorical or []) or "auto")
        model._Booster = lightgbm.Booster(model_str=float32_thresholds(model.booster_.model_to_string()))
        return model
    raise ContractError(f"unknown model kind {kind}")


def _float32_floor(t: float) -> float:
    """The largest float32 <= t: for every float32 v, ``v <= t`` exactly when ``v <= _float32_floor(t)``."""
    top = float(np.finfo(np.float32).max)
    if t >= top:
        return top
    if t < -top:
        return float("-inf")
    f = np.float32(t)
    if float(f) > t:
        f = np.nextafter(f, np.float32(-np.inf))
    return float(f)


def float32_thresholds(model_text: str) -> str:
    """A LightGBM model (its text form) with every numeric split threshold replaced by the largest float32 <= it.

    The model only ever sees float32 rows (FeatureMatrix, Rust B), so on its whole input domain this is the same model:
    no row changes leaf. LightGBM places a threshold between two training values in double, and the ONNX tree
    ensemble stores thresholds as float32; rounded to nearest, a threshold that rounds up equals the upper training
    value, and every row holding exactly that value went to the other leaf in ONNX (up to 0.05 in probability on a few
    training rows per slot). A float32 threshold rounds to itself, so the export decides every split as LightGBM does.
    Categorical splits (decision_type bit 0) hold an index into the category sets, not a value, and are left alone.
    ``tree_sizes`` (each tree's byte length) is dropped: the text changes length and LightGBM parses without it."""
    lines = [line for line in model_text.splitlines() if not line.startswith("tree_sizes=")]
    trees: list[dict[str, int]] = []
    for at, line in enumerate(lines):
        if line.startswith("Tree="):
            trees.append({})
        elif trees and line.startswith(("threshold=", "decision_type=")):
            trees[-1][line.split("=", 1)[0]] = at
    for tree in trees:
        if "threshold" not in tree:
            continue  # a single-leaf tree has no split
        if "decision_type" not in tree:
            raise ContractError("LightGBM model text: a tree with threshold= has no decision_type= line")
        values = lines[tree["threshold"]].split("=", 1)[1].split()
        decision_types = [int(v) for v in lines[tree["decision_type"]].split("=", 1)[1].split()]
        if len(decision_types) != len(values):
            raise ContractError("LightGBM model text: threshold= and decision_type= differ in length")
        lines[tree["threshold"]] = "threshold=" + " ".join(
            v if decision_types[i] & 1 else repr(_float32_floor(float(v))) for i, v in enumerate(values))
    return "\n".join(lines) + "\n"


def importance(kind: str, model, columns: list[str]) -> dict[str, Any]:
    """How much each feature moves the fitted model, keyed by matrix column (FeatureMatrix.columns).

    * ``logistic``: the coefficient on the standardised feature (the pipeline scales before the regression, so the
      coefficient is already per standard deviation); signed: positive raises the probability.
    * ``lightgbm``: total split gain, normalised to sum to 1; unsigned (a tree has no direction per feature).
    """
    if kind == "logistic":
        values = np.asarray(model.named_steps["model"].coef_, dtype=float)[0]
        method, signed = "standardized_coefficient", True
    elif kind == "lightgbm":
        values = np.asarray(model.booster_.feature_importance(importance_type="gain"), dtype=float)
        total = float(values.sum())
        values = values / total if total > 0 else values
        method, signed = "gain", False
    else:
        raise ContractError(f"unknown model kind {kind}")
    if len(values) != len(columns):
        raise ContractError(f"{kind} importance has {len(values)} values for {len(columns)} columns")
    return {"kind": kind, "method": method, "signed": signed,
            "values": {name: float(v) for name, v in zip(columns, values)}}


def _register_lightgbm() -> None:
    from lightgbm import LGBMClassifier
    from onnxmltools.convert.lightgbm.operator_converters.LightGbm import convert_lightgbm
    from skl2onnx import update_registered_converter
    from skl2onnx.common.shape_calculator import calculate_linear_classifier_output_shapes

    update_registered_converter(LGBMClassifier, "LightGbmLGBMClassifier", calculate_linear_classifier_output_shapes,
                                convert_lightgbm, options={"nocl": [True, False], "zipmap": [True, False, "columns"]})


def _register_clip() -> None:
    """ClipToTrainingRange as ONNX Min then Max against its per-column bounds (float32, the graph's type): a value
    rounds to the same float32 bound either way, so the export clips as the fitted model does."""
    from onnx import TensorProto
    from skl2onnx import update_registered_converter
    from skl2onnx.common.data_types import FloatTensorType

    def shape(operator):
        width = operator.inputs[0].get_second_dimension()
        operator.outputs[0].type = FloatTensorType([None, width])

    def convert(scope, operator, container):
        op = operator.raw_operator
        low = scope.get_unique_variable_name("clip_low")
        high = scope.get_unique_variable_name("clip_high")
        below = scope.get_unique_variable_name("clip_below_high")
        container.add_initializer(low, TensorProto.FLOAT, [len(op.low_)], op.low_.astype(np.float32).tolist())
        container.add_initializer(high, TensorProto.FLOAT, [len(op.high_)], op.high_.astype(np.float32).tolist())
        container.add_node("Min", [operator.inputs[0].full_name, high], below, name=scope.get_unique_operator_name("ClipHigh"))
        container.add_node("Max", [below, low], operator.outputs[0].full_name, name=scope.get_unique_operator_name("ClipLow"))

    update_registered_converter(ClipToTrainingRange, "StockMonitorClipToTrainingRange", shape, convert)


def params(kind: str, model) -> dict[str, Any]:
    """The hyperparameters a candidate was fitted with that were chosen during the fit (logistic: C and each grid
    value's held-out log loss); {} when none were."""
    return dict(getattr(model, "chosen_params_", None) or {}) if kind == "logistic" else {}


def to_onnx(kind: str, model, width: int) -> bytes:
    from skl2onnx import convert_sklearn
    from skl2onnx.common.data_types import FloatTensorType

    if kind == "lightgbm":
        _register_lightgbm()
    elif kind == "logistic":
        _register_clip()
    onx = convert_sklearn(model, initial_types=[(INPUT_NAME, FloatTensorType([None, width]))],
                          options={id(model): {"zipmap": False}}, target_opset=ONNX_OPSET)
    if [o.name for o in onx.graph.output] != ["label", OUTPUT_NAME]:
        raise ContractError(f"unexpected ONNX outputs {[o.name for o in onx.graph.output]}")
    return onx.SerializeToString()


def predict_onnx(onnx_bytes: bytes, x: np.ndarray) -> np.ndarray:
    """The deployed model's probability of the positive class (ONNX Runtime, CPU), as Rust B computes it."""
    import onnxruntime

    options = onnxruntime.SessionOptions()
    options.intra_op_num_threads = 1
    session = onnxruntime.InferenceSession(onnx_bytes, options, providers=["CPUExecutionProvider"])
    if len(x) == 0:
        return np.zeros(0)
    return np.asarray(session.run([OUTPUT_NAME], {INPUT_NAME: x.astype(np.float32)})[0])[:, POSITIVE_CLASS_INDEX].astype(float)


def export_check(onnx_bytes: bytes, model, x: np.ndarray) -> dict[str, Any]:
    """|fitted model - ONNX Runtime| over the rows (float32 input on both sides): the worst row and how many rows exceed
    EXPORT_TOLERANCE. ``ok`` only when none does."""
    x32 = x.astype(np.float32)
    if not len(x32):
        return {"ok": True, "max_abs_diff": 0.0, "rows": 0, "rows_over": 0, "ratio_over": 0.0}
    expected = model.predict_proba(x32.astype(np.float64))[:, 1]
    got = predict_onnx(onnx_bytes, x32)
    diff = np.abs(got - expected)
    worst = int(np.argmax(diff))
    over = int(np.sum(~(diff <= EXPORT_TOLERANCE)))
    return {"ok": over == 0, "max_abs_diff": float(diff[worst]), "tolerance": EXPORT_TOLERANCE, "rows": int(len(diff)),
            "rows_over": over, "ratio_over": over / len(diff),
            "worst_row": {"index": worst, "fitted_probability": float(expected[worst]), "onnx_probability": float(got[worst])}}

