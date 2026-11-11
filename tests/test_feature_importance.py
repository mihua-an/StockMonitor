"""特徵權重: each candidate's importance keyed by matrix column, and the model center's top list (old models have none)."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from api import training_application
from service.analysis.inference.contract import ContractError
from service.analysis.online_training import models
from tests.support.training_registry import FakeRegistry


def _data(rows: int = 600):
    rng = np.random.default_rng(0)
    frame = pd.DataFrame({"strong": rng.normal(size=rows), "weak": rng.normal(size=rows), "noise": rng.normal(size=rows)})
    y = (frame["strong"] * 2.0 - frame["weak"] * 0.5 + rng.normal(scale=0.5, size=rows) > 0).astype(int).to_numpy()
    matrix = models.FeatureMatrix(["strong", "weak", "noise"], []).fit(frame)
    return matrix, matrix.matrix(frame), y


def _folds(rows: int):
    return models.logistic_folds(np.array(["2026-09-21"] * rows), np.arange(rows))


def test_logistic_importance_is_the_signed_standardised_coefficient_per_column():
    matrix, x, y = _data()
    fitted = models.fit("logistic", x, y, folds=_folds(len(y)))
    importance = models.importance("logistic", fitted, matrix.columns())
    assert importance["method"] == "standardized_coefficient" and importance["signed"] is True
    values = importance["values"]
    assert list(values) == ["strong", "weak", "noise"]
    assert values["strong"] > 0 > values["weak"], "the sign says which way the feature moves the probability"
    assert abs(values["strong"]) > abs(values["weak"]) > abs(values["noise"])


def test_lightgbm_importance_is_gain_normalised_to_one():
    pytest.importorskip("lightgbm")
    matrix, x, y = _data()
    fitted = models.fit("lightgbm", x, y)
    importance = models.importance("lightgbm", fitted, matrix.columns())
    assert importance["method"] == "gain" and importance["signed"] is False
    values = importance["values"]
    assert list(values) == ["strong", "weak", "noise"]
    assert sum(values.values()) == pytest.approx(1.0)
    assert values["strong"] == max(values.values())


def test_importance_names_one_hot_columns_and_refuses_a_width_mismatch():
    frame = pd.DataFrame({"a": [1.0, 2.0], "c": ["x", "y"]})
    matrix = models.FeatureMatrix(["a"], ["c"]).fit(frame)
    assert matrix.columns() == ["a", "c=__OTHER__", "c=x", "c=y"] and len(matrix.columns()) == matrix.width
    _m, x, y = _data()
    fitted = models.fit("logistic", x, y, folds=_folds(len(y)))
    with pytest.raises(ContractError):
        models.importance("logistic", fitted, ["only_one"])


def test_the_model_center_gets_the_top_features_by_magnitude_with_their_share():
    importance = {"kind": "logistic", "method": "standardized_coefficient", "signed": True,
                  "values": {"a": 0.1, "b": -0.6, "c": 0.3}}
    top = training_application.top_importance(importance, top=2)
    assert top["features"] == 3 and top["signed"] is True
    assert [f["name"] for f in top["top"]] == ["b", "c"], "ranked by |weight|, the sign kept"
    assert top["top"][0]["value"] == -0.6 and top["top"][0]["share"] == pytest.approx(0.6)
    assert training_application.top_importance(None) is None, "a model trained before 特徵權重 has none"
    assert training_application.top_importance({"kind": "logistic"}) is None


def test_models_serves_each_slot_s_importance_and_none_for_an_old_manifest(monkeypatch):
    monkeypatch.setattr(training_application.training_job, "latest_run_report", lambda: {})
    monkeypatch.setattr(training_application, "job_view", lambda: {"job": None, "running": False, "pending_request": None})
    monkeypatch.setattr(training_application, "_training_state", lambda: ({}, None))
    monkeypatch.setattr(training_application.TrainingApplication, "today", lambda self: None)
    gain = {"kind": "lightgbm", "method": "gain", "signed": False, "values": {"a": 0.75, "b": 0.25}}
    slots = {"3m_up": {"champion": "m-new", "kind": "lightgbm", "feature_importance": gain},
             "3m_down": {"champion": "m-old", "kind": "logistic"}}   # an older manifest: no feature_importance
    app = training_application.TrainingApplication(training_application.TrainingDependencies(
        registry=lambda: FakeRegistry(slots), worker_status=lambda: None, enabled_minutes=lambda: (3,)))
    served = {slot["key"]: slot for slot in app.models()["slots"]}
    assert served["3m_up"]["feature_importance"]["top"][0] == {"name": "a", "value": 0.75, "share": 0.75}
    assert served["3m_down"]["feature_importance"] is None
    assert served["5m_up"]["feature_importance"] is None
