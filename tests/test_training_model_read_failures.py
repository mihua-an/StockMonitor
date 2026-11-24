"""模型中心 tells "no model" from a record it could not read: a run file that is missing, damaged or unreadable was
read as "no candidates", and the registry's champion state reaches each slot of /api/training/models."""
import json

from api import training_application
from tests.support.training_registry import FakeRegistry


class _Dirs(FakeRegistry):
    def __init__(self, slots, root):
        super().__init__(slots)
        self.root = root

    def status(self):
        return {"slots": self.slots, "worker_feature_spec": None,
                "champions_error": {"kind": "CHAMPIONS_DAMAGED", "detail": "not JSON"}}

    def model_dir(self, model_id):
        return self.root / model_id


def test_a_run_file_that_cannot_be_read_says_why(tmp_path, monkeypatch):
    registry = _Dirs({}, tmp_path)
    (tmp_path / "ok").mkdir()
    (tmp_path / "ok" / "run.json").write_text(json.dumps({"winner": "logistic", "candidates": [{"kind": "logistic"}]}),
                                              encoding="utf-8")
    run, candidates, error = training_application._slot_candidates({"model_id": "ok"}, registry)
    assert error is None and candidates == [{"kind": "logistic", "winner": True}]
    assert training_application._slot_candidates({}, registry) == ({}, [], None), "no model named: nothing to read"

    assert training_application._slot_candidates({"model_id": "gone"}, registry)[2]["kind"] == "RUN_MISSING"
    (tmp_path / "bad").mkdir()
    (tmp_path / "bad" / "run.json").write_text("{broken", encoding="utf-8")
    assert training_application._slot_candidates({"model_id": "bad"}, registry)[2]["kind"] == "RUN_DAMAGED"
    (tmp_path / "list").mkdir()
    (tmp_path / "list" / "run.json").write_text("[]", encoding="utf-8")
    assert training_application._slot_candidates({"model_id": "list"}, registry)[2]["kind"] == "RUN_DAMAGED"
    (tmp_path / "dir").mkdir()
    (tmp_path / "dir" / "run.json").mkdir()   # opening a directory as a file is an I/O error, not a missing file
    assert training_application._slot_candidates({"model_id": "dir"}, registry)[2]["kind"] == "RUN_IO_ERROR"


def test_models_passes_each_slot_s_champion_state_and_run_error(tmp_path, monkeypatch):
    monkeypatch.setattr(training_application.training_job, "latest_run_report",
                        lambda: {"slots": {"3m_up": {"model_id": "gone"}}})
    monkeypatch.setattr(training_application, "job_view", lambda: {"job": None, "running": False, "pending_request": None})
    monkeypatch.setattr(training_application, "_training_state", lambda: ({}, None))
    monkeypatch.setattr(training_application.TrainingApplication, "today", lambda self: None)
    slots = {"3m_up": {"champion": None, "champion_state": "CHAMPIONS_DAMAGED", "reason": "champions file unreadable"},
             "3m_down": {"champion": None, "champion_state": "NONE", "reason": "no champion"}}
    app = training_application.TrainingApplication(training_application.TrainingDependencies(
        registry=lambda: _Dirs(slots, tmp_path), worker_status=lambda: None, enabled_minutes=lambda: (3,)))
    payload = app.models()
    served = {slot["key"]: slot for slot in payload["slots"]}
    assert payload["champions_error"]["kind"] == "CHAMPIONS_DAMAGED"
    assert (served["3m_up"]["champion_state"], served["3m_up"]["champion_reason"]) == ("CHAMPIONS_DAMAGED", "champions file unreadable")
    assert served["3m_up"]["candidates_error"]["kind"] == "RUN_MISSING"
    assert (served["3m_down"]["champion_state"], served["3m_down"]["candidates_error"]) == ("NONE", None)
    assert served["3m_up"]["baseline_log_loss"] is None and served["3m_down"]["baseline_log_loss"] is None


def test_models_serves_the_constant_baseline_a_slot_s_winner_had_to_beat(tmp_path, monkeypatch):
    (tmp_path / "m1").mkdir()
    (tmp_path / "m1" / "run.json").write_text(json.dumps({
        "winner": "lightgbm", "candidates": [{"kind": "lightgbm"}],
        "baseline": {"positive_ratio": 0.43, "log_loss": {"train": 0.68, "validation": 0.698, "test": 0.724},
                     "winner_validation_log_loss": 0.754, "beaten": False}}), encoding="utf-8")
    monkeypatch.setattr(training_application.training_job, "latest_run_report", lambda: {"slots": {"30m_down": {"model_id": "m1"}}})
    monkeypatch.setattr(training_application, "job_view", lambda: {"job": None, "running": False, "pending_request": None})
    monkeypatch.setattr(training_application, "_training_state", lambda: ({}, None))
    monkeypatch.setattr(training_application.TrainingApplication, "today", lambda self: None)
    slots = {"30m_down": {"champion": None, "champion_state": "BELOW_BASELINE", "reason": "not below the constant baseline"}}
    app = training_application.TrainingApplication(training_application.TrainingDependencies(
        registry=lambda: _Dirs(slots, tmp_path), worker_status=lambda: None, enabled_minutes=lambda: (30,)))
    served = {slot["key"]: slot for slot in app.models()["slots"]}["30m_down"]
    assert served["baseline_log_loss"] == 0.698 and served["champion_state"] == "BELOW_BASELINE"


def test_each_days_part_in_the_models(tmp_path, monkeypatch):
    report = {"run_id": "run-1", "split": {"kind": "by_date", "train": ["2026-11-19"], "validation": ["2026-11-20"], "test": ["2026-11-18"]},
              "dataset": {"dataset_id": "ods-1"}}
    monkeypatch.setattr(training_application.training_job, "latest_run_report", lambda: report)
    monkeypatch.setattr(training_application.TrainingApplication, "today",
                        lambda self: {"window": {"trained_dates": ["2026-11-20", "2026-11-23"], "test_only_dates": ["2026-11-18"]}})
    monkeypatch.setattr(training_application.TrainingApplication, "_dataset", staticmethod(
        lambda report, minutes: {"shards": [{"trading_date": "2026-11-19", "samples": 93412}]}))
    by_date = {"2026-11-19": {"samples": 10, "positives": 3, "called": 2, "hits": 1}}
    slots = {"3m_up": {"champion": "m", "validation": {"by_date": by_date}},
             "3m_down": {"champion": "older", "validation": {}}, "5m_up": {"champion": None, "validation": None}}
    app = training_application.TrainingApplication(training_application.TrainingDependencies(
        registry=lambda: _Dirs(slots, tmp_path), worker_status=lambda: None, enabled_minutes=lambda: (3,)))
    days = app.days()["days"]
    assert days["2026-11-19"] == {"use": "train", "next": None, "samples": 93412, "models": [{"key": "3m_up", **by_date["2026-11-19"]}]}
    assert (days["2026-11-18"]["use"], days["2026-11-18"]["next"]) == ("test", "test")
    assert (days["2026-11-20"]["use"], days["2026-11-20"]["next"]) == ("validation", "train")
    assert (days["2026-11-23"]["use"], days["2026-11-23"]["next"], days["2026-11-23"]["models"]) == (None, "train", [])


def test_a_run_s_winner_is_counted_per_date():
    import numpy as np
    import pandas as pd

    from service.analysis.online_training.trainer import _by_date

    parts = {"train": pd.DataFrame({"trading_date": ["a", "a", "b"]}), "test": pd.DataFrame({"trading_date": ["c"]})}
    y = {"train": np.array([1, 0, 1]), "test": np.array([0])}
    p = {"train": np.array([0.9, 0.6, 0.2]), "test": np.array([0.1])}
    assert _by_date(parts, y, p) == {"a": {"samples": 2, "positives": 1, "called": 2, "hits": 1},
                                     "b": {"samples": 1, "positives": 1, "called": 0, "hits": 0},
                                     "c": {"samples": 1, "positives": 0, "called": 0, "hits": 0}}
