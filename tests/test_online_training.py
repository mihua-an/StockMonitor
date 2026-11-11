"""The one model chain: Rust B features -> dataset -> per-slot training -> ONNX -> registry.

Synthetic historical store (tests/online_training_fixtures.py): the metrics here are plumbing evidence only, never
model quality. The dataset tests run the real Rust B binary (``analysis_runtime --export-features``): the features are
B's, not a Python copy. They are skipped when no binary with the export mode is built; the Rust side
(native/analysis_runtime/src/dataset.rs tests) covers the export itself either way.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from service.analysis.inference.contract import ContractError, load_horizon_authority, validate_model_manifest
from service.analysis.online_training import models
from service.analysis.online_training.dataset import (
    OnlineDatasetBuilder, RustFeatureExporter, available_dates, load_dataset, partition_fingerprint,
)
from service.analysis.online_training.labels import MINUTE_NS, label
from service.analysis.online_training.registry import OnlineModelRegistry
from service.analysis.online_training.trainer import CANDIDATES, ONLINE_V2_COLUMNS, RECIPE, OnlineModelTrainer
from service.analysis.producer.inference_config import InferenceConfigAuthority
from tests.online_training_fixtures import DATES
from tests.support.online_training_store import store  # noqa: F401  -- the module-scoped dataset fixture

FIXTURES = Path(__file__).parent / "fixtures" / "inference_contract"


@pytest.fixture
def beatable_baseline(monkeypatch):
    """The synthetic store has no signal, so no winner beats the constant baseline and nothing would go live: tests of
    the plumbing after the decision raise the baseline's validation log loss out of reach."""
    from service.analysis.online_training import trainer as trainer_module

    real = trainer_module._baseline

    def beatable(y, winner_log_loss):
        baseline = real(y, winner_log_loss)
        return {**baseline, "log_loss": {**baseline["log_loss"], "validation": 99.0}, "beaten": True}

    monkeypatch.setattr(trainer_module, "_baseline", beatable)
    return real


def test_the_dataset_is_written_in_chunks_with_the_same_samples_and_stats(store, tmp_path, monkeypatch):
    # The builder no longer holds every sample as a dict before one DataFrame (R14-26): rows go to parquet in chunks
    # and the label statistics are counted as they pass. A tiny chunk gives the same dataset.
    from service.analysis.online_training import dataset as dataset_module

    root, directory, manifest, exporter = store
    monkeypatch.setattr(dataset_module, "SAMPLE_CHUNK_ROWS", 7)
    chunked = OnlineDatasetBuilder(root / "hist", tmp_path / "datasets", exporter).build(DATES)
    assert chunked["samples"] > 7 and chunked["dataset_id"] == manifest["dataset_id"]
    for key in ("samples", "codes", "label_stats", "label_states"):
        assert chunked[key] == manifest[key], key
    whole, _ = load_dataset(directory)
    parts, _ = load_dataset(tmp_path / "datasets" / chunked["dataset_id"])
    pd.testing.assert_frame_equal(whole, parts)
    assert not list((tmp_path / "datasets").glob(".samples-*")), "no building file left behind"

def test_labels_apply_the_barriers_and_are_never_zero_when_unknown():
    assert label({"state": "OK", "max": 0.015, "min": -0.001}) == (1.0, 0.0, "OK")
    assert label({"state": "OK", "max": 0.0, "min": -0.006}) == (0.0, 1.0, "OK")
    for state in ("TAIL_INSUFFICIENT", "NO_FUTURE_PRICE", "NO_PRICE"):
        up, down, got = label({"state": state})
        assert math.isnan(up) and math.isnan(down) and got == state, "unknown is not 'did not move'"
    assert label(None)[2] == "NO_PATH"


def test_the_dataset_is_rust_b_output_and_records_its_feature_spec(store):
    root, directory, manifest, exporter = store
    frame, loaded = load_dataset(directory)
    assert loaded == manifest
    assert manifest["feature_spec"]["schema_digest"] == exporter.spec()["schema_digest"]
    assert manifest["feature_source"]["builder"] == "analysis_runtime --export-features"
    # The build is named by file name and hash, never by this machine's absolute path.
    assert manifest["feature_source"]["binary"] == exporter.binary.name and len(manifest["feature_source"]["binary_sha256"]) == 64
    assert str(exporter.binary.parent) not in json.dumps(manifest)
    assert manifest["horizons_minutes"] == [3, 5, 10, 15, 30] and manifest["horizon_authority_version"] == 1
    assert manifest["label_policy"]["version"] == "label-online-v2"
    assert manifest["trading_dates"] == list(DATES) and not manifest["degraded"]
    assert set(frame["market"]) == {"STK"}, "the reference index is an input, not a training sample"
    assert frame["index_fresh"].max() == 1.0, "the index was folded with the stocks"
    assert manifest["label_states"]["30m"]["TAIL_INSUFFICIENT"] > manifest["label_states"]["3m"]["TAIL_INSUFFICIENT"]
    assert not any(c.endswith("_1m") and c.startswith("label_") for c in frame.columns)
    assert available_dates(root / "hist", root / "datasets" / "shards") == list(DATES)
    (directory / "samples.parquet").write_bytes((directory / "samples.parquet").read_bytes() + b"x")
    with pytest.raises(ContractError):
        load_dataset(directory)
    (directory / "samples.parquet").write_bytes((directory / "samples.parquet").read_bytes()[:-1])


def test_a_shard_is_reused_until_its_partitions_change(store, tmp_path):
    root, _directory, _manifest, exporter = store
    calls = []

    class Counting:
        binary = exporter.binary

        def spec(self):
            return exporter.spec()

        def export(self, **kwargs):
            calls.append(kwargs["date"])
            return exporter.export(**kwargs)

        def context_fingerprint(self, date):
            return exporter.context_fingerprint(date)

    builder = OnlineDatasetBuilder(root / "hist", tmp_path, Counting())
    first = builder.build(DATES[:2], horizons_minutes=[3])
    again = builder.build(DATES[:2], horizons_minutes=[3])
    assert sorted(calls) == list(DATES[:2]), "the second build reused both shards"
    assert again["dataset_id"] == first["dataset_id"], "same shards, same labels: the same dataset"
    # A partition whose committed content changes (re-materialized) gets a new shard.
    before = partition_fingerprint(root / "hist", DATES[0])
    manifest_path = next((root / "hist").glob(f"source=shioaji/market=STK/trading_date={DATES[0]}/session=*/*/manifest.json"))
    original = manifest_path.read_text(encoding="utf-8")
    try:
        body = json.loads(original)
        body["content_hash_fnv1a64"] = "0" * 16
        manifest_path.write_text(json.dumps(body), encoding="utf-8")
        assert partition_fingerprint(root / "hist", DATES[0]) != before
        rebuilt = builder.build(DATES[:2], horizons_minutes=[3])
        assert calls[-1] == DATES[0] and len(calls) == 3
        assert rebuilt["degraded"], "B refused the partition whose bytes no longer match its manifest"
    finally:
        manifest_path.write_text(original, encoding="utf-8")
    # The run that used the re-exported shard drops the one computed from contents no longer on disk.
    final = builder.build(DATES[:2], horizons_minutes=[3])
    removed = builder.prune(used=final, retention_days=None, keep_datasets=1)
    assert [name.split("/")[1] for name in removed["shards"]] == [DATES[0]] and len(removed["datasets"]) >= 1
    assert removed["dates"] == [], "the training data is kept forever by default"


def test_the_stored_shards_outlive_the_raw_partitions(store, tmp_path):
    # User 10-22: the training data stays after the raw history is pruned; a date with its raw data gone (or only the
    # traded codes' partitions left) trains on the shard exported while it was all there, never on what is left.
    import shutil

    root, _directory, _manifest, exporter = store
    hist = tmp_path / "hist"
    shutil.copytree(root / "hist", hist)
    calls = []

    class Counting:
        binary = exporter.binary

        def spec(self):
            return exporter.spec()

        def export(self, **kwargs):
            calls.append(kwargs["date"])
            return exporter.export(**kwargs)

        def context_fingerprint(self, date):
            return exporter.context_fingerprint(date)

    builder = OnlineDatasetBuilder(hist, tmp_path / "out", Counting())
    first = builder.build(DATES, horizons_minutes=[3])
    assert sorted(calls) == list(DATES)   # exported at the same time: in any order
    spec = exporter.spec()["schema_digest"]
    # The oldest date loses every raw partition, the next all but one code's.
    shutil.rmtree(hist / "source=shioaji" / "market=STK" / f"trading_date={DATES[0]}")
    shutil.rmtree(hist / "source=shioaji" / "market=IDX" / f"trading_date={DATES[0]}")
    second_day = sorted((hist / "source=shioaji" / "market=STK" / f"trading_date={DATES[1]}").glob("session=*/*"))
    for partition in second_day[1:]:
        shutil.rmtree(partition)
    assert available_dates(hist, builder.shard_root, spec_digest=spec, horizons=[3]) == list(DATES)
    assert available_dates(hist, builder.shard_root, spec_digest="another spec", horizons=[3]) == list(DATES[1:])
    again = builder.build(DATES, horizons_minutes=[3])
    assert sorted(calls) == list(DATES), "no date was exported again from what is left on disk"
    assert again["dataset_id"] == first["dataset_id"], "the same shards: the same dataset"
    # The training data retention removes the oldest dates (and their daily summaries) only when set.
    summaries = tmp_path / "summary"
    (summaries / "source=shioaji" / "market=STK" / f"trading_date={DATES[0]}").mkdir(parents=True)
    kept = builder.prune(used=again, retention_days=None, summary_root=summaries)
    assert kept["dates"] == [] and kept["summaries"] == []
    trimmed = builder.prune(used=again, retention_days=len(DATES) - 1, summary_root=summaries)
    assert trimmed["dates"] == [DATES[0]] and trimmed["summaries"] == [f"source=shioaji/market=STK/trading_date={DATES[0]}"]
    assert available_dates(hist, builder.shard_root, spec_digest=spec, horizons=[3]) == list(DATES[1:])


def test_a_new_fold_version_exports_again_even_with_the_same_columns_and_context(store, tmp_path):
    root, _directory, _manifest, exporter = store
    calls, fold = [], {"version": "fold-a"}

    class Versioned:
        binary = exporter.binary

        def spec(self):
            return {**exporter.spec(), "fold_version": fold["version"]}

        def export(self, **kwargs):
            calls.append(kwargs["date"])
            return exporter.export(**kwargs)

        def context_fingerprint(self, date):
            return exporter.context_fingerprint(date)

    builder = OnlineDatasetBuilder(root / "hist", tmp_path / "out", Versioned())
    builder.build(DATES, horizons_minutes=[3])
    assert sorted(calls) == list(DATES)
    builder.build(DATES, horizons_minutes=[3])
    assert sorted(calls) == list(DATES), "same fold: the stored shards are reused"
    fold["version"] = "fold-b"
    spec, entries = Versioned().spec(), partition_fingerprint(root / "hist", DATES[0])
    assert builder.stored_shard(DATES[0], builder.shard_id(DATES[0], (3,), spec, entries), (3,), spec, entries) is None
    builder.build(DATES, horizons_minutes=[3])
    assert sorted(calls) == sorted(list(DATES) * 2), "a new fold exports every date again"


def test_a_one_minute_or_unknown_horizon_is_refused_everywhere(store, tmp_path):
    root, directory, _manifest, exporter = store
    with pytest.raises(ContractError):
        OnlineDatasetBuilder(root / "hist", tmp_path, exporter).build(DATES, horizons_minutes=[1])
    small = OnlineDatasetBuilder(root / "hist", tmp_path, exporter).build(DATES, horizons_minutes=[3])
    trainer = OnlineModelTrainer(OnlineModelRegistry(tmp_path / "reg"))
    with pytest.raises(ContractError, match="no labels for"):
        trainer.train(tmp_path / small["dataset_id"], horizons_minutes=[5])
    with pytest.raises(ContractError):
        trainer.train(directory, horizons_minutes=[2])


def test_each_slot_trains_on_its_own_label_exports_onnx_and_registers(store, tmp_path, beatable_baseline):
    _root, directory, dataset, exporter = store
    registry = OnlineModelRegistry(tmp_path / "reg", spec_provider=lambda: exporter.spec()["schema_digest"])
    report = OnlineModelTrainer(registry).train(directory, horizons_minutes=[3, 10], recipe=RECIPE)
    assert set(report["slots"]) == {"3m_up", "3m_down", "10m_up", "10m_down"}
    assert report["split"]["kind"] == "by_date" and report["split"]["test"] == [DATES[-1]]
    authority = load_horizon_authority()
    for slot, result in report["slots"].items():
        assert result["status"] == "TRAINED", (slot, result)
        model_dir = registry.model_dir(result["model_id"])
        manifest = json.loads((model_dir / "manifest.json").read_text())
        run = json.loads((model_dir / "run.json").read_text())
        assert validate_model_manifest(manifest, authority) == []
        minutes, direction = int(slot.split("m_")[0]), slot.split("_")[1]
        assert (manifest["horizon_minutes"], manifest["direction"]) == (minutes, direction)
        assert manifest["label_column"] == f"label_{direction}_{minutes}m", "never another slot's label"
        assert manifest["dataset_version"] == dataset["dataset_id"] and manifest["training_run_id"] == report["run_id"]
        assert manifest["feature_spec"] == dataset["feature_spec"], "the model carries the dataset's (B's) FeatureSpec"
        assert manifest["artifact"]["format"] == "onnx" and (model_dir / "model.onnx").is_file()
        assert manifest["io"]["numeric"] == dataset["numeric_columns"]
        assert manifest["scope"] == {"sources": ["shioaji"], "markets": ["STK"]}, "applied only to what it was trained on"
        assert manifest["validation"]["export_max_abs_diff"] <= models.EXPORT_TOLERANCE
        assert {c["kind"] for c in run["candidates"]} == {"logistic", "lightgbm"}
        importance = manifest["feature_importance"]
        assert importance["kind"] == result["winner"]
        # The numeric columns, then the categories the winner read: LightGBM's as codes, the logistic one-hot industry.
        numeric = dataset["numeric_columns"]
        assert dataset["category_columns"] == ["industry", "stock"]
        assert list(importance["values"])[:len(numeric)] == numeric
        if result["winner"] == "lightgbm":
            assert list(importance["values"])[len(numeric):] == ["industry", "stock"]
            assert manifest["io"]["category_encoding"] == "code" and manifest["io"]["categorical"] == ["industry", "stock"]
        else:
            assert all(name.startswith("industry=") for name in list(importance["values"])[len(numeric):])
            assert manifest["io"]["category_encoding"] == "one_hot" and manifest["io"]["categorical"] == ["industry"]
        assert all(models.OTHER_TOKEN in vocab for vocab in manifest["io"]["category_vocab"].values())
        assert importance["method"] == {"logistic": "standardized_coefficient", "lightgbm": "gain"}[result["winner"]]
        assert result["feature_importance"] == importance, "the slot's report carries the same weights"
        assert registry.status()["slots"][slot]["feature_importance"] == importance
        assert registry.slot_model(minutes, direction)["manifest"]["model_id"] == result["model_id"]
    assert registry.slot_model(5, "up") == {"no_model": {"state": "NONE", "reason": "no champion"}}, \
        "an untrained slot is never filled from another"
    status = registry.status()["slots"]
    assert status["3m_up"]["deployable"] and status["3m_up"]["feature_spec"] == "MATCH"
    assert not status["5m_up"]["deployable"]
    other = OnlineModelRegistry(tmp_path / "reg", spec_provider=lambda: "f" * 64).status()["slots"]["3m_up"]
    assert not other["deployable"] and other["feature_spec"] == "MISMATCH"


def test_the_daily_run_trains_the_online_v2_way_until_the_switch(store, tmp_path):
    # Rust B computes online-v3; until spec_comparison says SWITCH the models read online-v2's 194 columns of the
    # minute's last samples, unweighted, with no category (trainer.ACTIVE_RECIPE).
    _root, directory, dataset, exporter = store
    registry = OnlineModelRegistry(tmp_path / "reg", spec_provider=lambda: exporter.spec()["schema_digest"])
    report = OnlineModelTrainer(registry).train(directory, horizons_minutes=[3], directions=["up"])
    assert report["recipe"]["name"] == "online-v2"
    manifest = json.loads((registry.model_dir(report["slots"]["3m_up"]["model_id"]) / "manifest.json").read_text())
    assert manifest["io"]["numeric"] == dataset["numeric_columns"][:ONLINE_V2_COLUMNS] and manifest["io"]["categorical"] == []
    assert manifest["feature_spec"] == dataset["feature_spec"], "bound to the online-v3 B that computes its columns"
    full = OnlineModelTrainer(registry).train(directory, horizons_minutes=[3], directions=["up"], recipe=RECIPE, promote=False)
    assert full["slots"]["3m_up"]["counts"]["train"] > report["slots"]["3m_up"]["counts"]["train"], "every 15 seconds"


def test_the_registry_refuses_a_tampered_or_misplaced_model(store, tmp_path, beatable_baseline):
    _root, directory, _dataset, _exporter = store
    registry = OnlineModelRegistry(tmp_path / "reg")
    report = OnlineModelTrainer(registry).train(directory, horizons_minutes=[3], directions=["up"])
    model_id = report["slots"]["3m_up"]["model_id"]
    with pytest.raises(ContractError, match="manifest is for 3m_up"):
        registry.promote("run-x", [(5, "up", model_id)], rule="test", decided_at="now")
    artifact = registry.model_dir(model_id) / "model.onnx"
    artifact.write_bytes(artifact.read_bytes() + b"\0")
    assert registry.slot_model(3, "up")["no_model"]["state"] == "MODEL_UNUSABLE"
    assert registry.status()["slots"]["3m_up"]["reason"] == "artifact does not match the manifest hash"


def test_a_failed_registration_leaves_nothing_behind(tmp_path, monkeypatch):
    # A half-written model directory blocked every retry ("already registered").
    registry = OnlineModelRegistry(tmp_path / "reg")
    manifest = json.loads((FIXTURES / "onnx_model_manifest.json").read_text(encoding="utf-8"))
    monkeypatch.setattr("service.analysis.online_training.registry.write_json_atomic", lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(OSError):
        registry.register("m1", artifact=b"onnx", manifest=manifest, run={})
    assert not registry.model_dir("m1").exists() and not list((tmp_path / "reg" / "models").glob("*"))
    monkeypatch.undo()
    assert registry.register("m1", artifact=b"onnx", manifest=manifest, run={}).is_dir(), "a retry is not blocked"


def test_the_fixture_model_rust_runs_gives_these_probabilities_in_onnx_runtime():
    """The Python half of model.rs's parity test: both runtimes reproduce onnx_model_cases.json."""
    manifest = json.loads((FIXTURES / "onnx_model_manifest.json").read_text(encoding="utf-8"))
    io = manifest["io"]
    matrix = models.FeatureMatrix(io["numeric"], io["categorical"], io["category_encoding"])
    matrix.vocab = io["category_vocab"]
    cases = json.loads((FIXTURES / "onnx_model_cases.json").read_text(encoding="utf-8"))
    frame = pd.DataFrame([{**dict(zip(io["numeric"], [np.nan if v is None else v for v in case["values"]])),
                           **dict(zip(["industry", "stock"], case["categories"]))} for case in cases])
    got = models.predict_onnx((FIXTURES / "onnx_model.onnx").read_bytes(), matrix.matrix(frame))
    assert np.allclose(got, [case["probability"] for case in cases], atol=1e-7, rtol=0)


def test_a_time_split_purges_samples_whose_label_reaches_into_the_next_part():
    # With fewer than three dates the 70/15/15 cut kept training samples labelled with
    # validation-period prices (and validation samples labelled with test-period prices).
    from service.analysis.online_training.trainer import _purge, _split

    minute = MINUTE_NS
    frame = pd.DataFrame({"trading_date": ["2026-09-29"] * 100, "cutoff_ns": [i * minute for i in range(100)]})
    train, val, test, split = _split(frame)
    assert split["kind"] == "by_time_70_15_15" and split["boundaries_ns"] == [70 * minute, 85 * minute]
    kept_train, kept_val, purged = _purge(train, val, split, 5)
    assert purged == {"train": 5, "validation": 5}
    assert int((kept_train["cutoff_ns"] + 5 * minute).max()) < 70 * minute
    assert int((kept_val["cutoff_ns"] + 5 * minute).max()) < 85 * minute
    by_date = pd.DataFrame({"trading_date": ["d1", "d2", "d3"], "cutoff_ns": [1, 2, 3]})
    tr, va, _te, split = _split(by_date)
    assert _purge(tr, va, split, 30)[2] == {"train": 0, "validation": 0}, "a session-scoped label never crosses dates"


def test_a_winner_goes_live_only_below_the_constant_baseline_else_the_slot_keeps_its_model(store, tmp_path, monkeypatch):
    # User decisions: the run's winner becomes the slot's model -- a worse score than yesterday's model is not a reason
    # to keep it -- but only when its validation log loss beats predicting the training positive ratio for every row.
    # 10-29: 8 of 10 live models were worse than that constant, and all of them were live. A winner that does not beat
    # it leaves the slot on the model it already has (user 11-08); 10-29 to 11-08 it took the slot down to no model.
    from service.analysis.online_training import trainer as trainer_module

    real_baseline = trainer_module._baseline
    y = {"train": np.array([0, 0, 0, 1]), "validation": np.array([0, 1]), "test": np.array([], dtype=int)}
    constant = real_baseline(y, 0.5)
    assert constant["positive_ratio"] == 0.25 and constant["log_loss"]["test"] is None
    assert math.isclose(constant["log_loss"]["validation"], -(math.log(0.75) + math.log(0.25)) / 2)
    assert constant["beaten"] is True and real_baseline(y, constant["log_loss"]["validation"])["beaten"] is False

    _root, directory, _dataset, exporter = store
    registry = OnlineModelRegistry(tmp_path / "reg", spec_provider=lambda: exporter.spec()["schema_digest"])
    beatable = lambda y, w: {**real_baseline(y, w), "beaten": True}  # noqa: E731
    train = lambda: OnlineModelTrainer(registry).train(directory, horizons_minutes=[3], directions=["up"])["slots"]["3m_up"]  # noqa: E731

    # The synthetic store has no signal: with the real baseline its winner is worse than the constant. Registered (its
    # run stays inspectable) but not live; a slot with no model to keep has none, with why.
    first = train()
    baseline = first["baseline"]
    assert first["status"] == "TRAINED" and not baseline["beaten"] and not first["promoted"]
    assert baseline["winner_validation_log_loss"] == first["metrics"]["validation"]["log_loss"] >= baseline["log_loss"]["validation"]
    assert registry.model_dir(first["model_id"]).is_dir()
    entry = registry.champions()["3m_up"]
    assert entry["model_id"] is None and entry["promotion"] == first["promotion"]
    assert first["promotion"]["reason"] == trainer_module.BELOW_BASELINE and first["promotion"]["champion"] is None
    status = registry.status()["slots"]["3m_up"]
    assert status["champion_state"] == "BELOW_BASELINE" and not status["deployable"] and status["champion"] is None
    # Rust B gets no model for the slot, and the registry's reason for it -- not a config change, not the old champion.
    assert registry.slot_model(3, "up") == {"no_model": {"state": "BELOW_BASELINE", "reason": status["reason"]}}
    config = InferenceConfigAuthority(slots_provider=registry.slot_model, test_only=False).current()
    slot = next(s for s in config["slots"] if (s["horizon_minutes"], s["direction"]) == (3, "up"))
    assert slot == {"horizon_minutes": 3, "direction": "up", "no_model": {"state": "BELOW_BASELINE", "reason": status["reason"]}}
    assert "not below the constant baseline" in status["reason"] and status["last_promotion"]["promoted"] is False

    # A winner that beats it goes live.
    monkeypatch.setattr(trainer_module, "_baseline", beatable)
    second = train()
    assert second["promoted"] and second["promotion"]["champion"] is None
    assert registry.champions()["3m_up"]["model_id"] == second["model_id"]
    assert json.loads((registry.model_dir(second["model_id"]) / "run.json").read_text())["baseline"] == second["baseline"]
    assert registry.status()["slots"]["3m_up"]["kept"] is None

    # The next winner does not beat it: the slot keeps the live model, recording which candidate stayed out and why.
    monkeypatch.setattr(trainer_module, "_baseline", real_baseline)
    third = train()
    assert not third["promoted"] and third["promotion"]["reason"] == trainer_module.BELOW_BASELINE
    assert third["promotion"]["champion"] == second["model_id"] and third["promotion"]["candidate"] == third["model_id"]
    entry = registry.champions()["3m_up"]
    assert entry["model_id"] == second["model_id"] and entry["promotion"] == third["promotion"]
    assert registry.slot_model(3, "up")["manifest"]["model_id"] == second["model_id"], "Rust B keeps the model it has"
    status = registry.status()["slots"]["3m_up"]
    assert status["champion"] == second["model_id"] and status["champion_state"] == "OK" and status["deployable"]
    assert status["kept"] == trainer_module.BELOW_BASELINE and "not below the constant baseline" in status["kept_reason"]
    config = InferenceConfigAuthority(slots_provider=registry.slot_model, test_only=False).current()
    slot = next(s for s in config["slots"] if (s["horizon_minutes"], s["direction"]) == (3, "up"))
    assert slot["manifest"]["model_id"] == second["model_id"] and "no_model" not in slot


def test_a_slot_does_not_keep_a_model_of_another_feature_spec(store, tmp_path, monkeypatch):
    # 11-08: after the switch to online-v3.1 the retrain left 10m_up and 15m_up on their online-v3.0 models (the run's
    # winners were below the baseline), which the registry called live and Rust B refuses. The run was trained on the
    # FeatureSpec B computes now, so a kept model of another spec can never be served: the slot has none, with why.
    from service.analysis.online_training import trainer as trainer_module

    real_baseline = trainer_module._baseline
    _root, directory, _dataset, exporter = store
    registry = OnlineModelRegistry(tmp_path / "reg", spec_provider=lambda: exporter.spec()["schema_digest"])
    train = lambda: OnlineModelTrainer(registry).train(directory, horizons_minutes=[3], directions=["up"])["slots"]["3m_up"]  # noqa: E731

    monkeypatch.setattr(trainer_module, "_baseline", lambda y, w: {**real_baseline(y, w), "beaten": True})
    live = train()
    assert registry.champions()["3m_up"]["model_id"] == live["model_id"]
    # The live model was trained under an earlier FeatureSpec.
    manifest_path = registry.model_dir(live["model_id"]) / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    old_digest = "0" * 64
    assert manifest["feature_spec"]["schema_digest"] != old_digest
    manifest["feature_spec"] = {**manifest["feature_spec"], "schema_digest": old_digest, "feature_version": "online-old"}
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    monkeypatch.setattr(trainer_module, "_baseline", real_baseline)
    held = train()
    assert not held["promoted"] and held["promotion"]["reason"] == trainer_module.BELOW_BASELINE
    assert held["promotion"]["champion"] == live["model_id"]
    assert held["promotion"]["retired"]["model_id"] == live["model_id"]
    assert held["promotion"]["retired"]["feature_spec"] == old_digest
    entry = registry.champions()["3m_up"]
    assert entry["model_id"] is None and entry["promotion"] == held["promotion"]
    status = registry.status()["slots"]["3m_up"]
    assert status["champion"] is None and status["champion_state"] == "BELOW_BASELINE" and not status["deployable"]
    assert f"{live['model_id']} was not kept" in status["reason"] and "online-old" in status["reason"]
    assert registry.slot_model(3, "up") == {"no_model": {"state": "BELOW_BASELINE", "reason": status["reason"]}}

    # A model of the run's own spec is still kept (the rule the test above covers), and the next held run on a slot
    # with no model stays at none.
    again = train()
    assert not again["promoted"] and "retired" not in again["promotion"]
    assert registry.champions()["3m_up"]["model_id"] is None


def test_a_champions_entry_without_a_model_needs_the_decision_that_took_it_down(tmp_path):
    from service.analysis.online_training.registry import ChampionsUnreadable

    registry = OnlineModelRegistry(tmp_path / "reg")
    registry.root.mkdir(parents=True)
    for bare in ('{"3m_up": {"model_id": null}}', '{"3m_up": {"model_id": null, "promotion": {"promoted": true}}}',
                 '{"3m_up": {"model_id": null, "promotion": {"promoted": false}}}'):
        registry.champions_path.write_text(bare, encoding="utf-8")
        with pytest.raises(ChampionsUnreadable):
            registry.champions()


def test_a_run_s_slots_go_live_together_or_not_at_all(store, tmp_path, monkeypatch, beatable_baseline):
    # champions.json was rewritten slot by slot as each trained and promotions.jsonl appended after: a run that stopped
    # midway left some slots live, and a failure between the two writes left a champion with no promotion record.
    from service.analysis.online_training import registry as registry_module

    _root, directory, _dataset, exporter = store
    registry = OnlineModelRegistry(tmp_path / "reg", spec_provider=lambda: exporter.spec()["schema_digest"])
    first = OnlineModelTrainer(registry).train(directory, horizons_minutes=[3], directions=["up", "down"])["slots"]
    before = registry.champions_path.read_bytes()
    assert {slot: e["model_id"] for slot, e in registry.champions().items()} == {s: r["model_id"] for s, r in first.items()}
    assert {e["promotion"]["run_id"] for e in registry.champions().values()} == {first["3m_up"]["promotion"]["run_id"]}

    real_write = registry_module.write_json_atomic
    monkeypatch.setattr(registry_module, "write_json_atomic",
                        lambda *a, **k: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(OSError):
        OnlineModelTrainer(registry).train(directory, horizons_minutes=[3], directions=["up", "down"])
    assert registry.champions_path.read_bytes() == before, "a failed promotion changes no slot"
    monkeypatch.setattr(registry_module, "write_json_atomic", real_write)

    # One model of the run that cannot go live stops the whole operation before anything is written.
    real_checked = registry._checked
    monkeypatch.setattr(registry, "_checked", lambda model_id, m, d: (None, "artifact missing") if d == "down"
                        else real_checked(model_id, m, d))
    with pytest.raises(ContractError, match="artifact missing"):
        OnlineModelTrainer(registry).train(directory, horizons_minutes=[3], directions=["up", "down"])
    assert registry.champions_path.read_bytes() == before


def test_a_damaged_or_unreadable_champions_file_is_not_no_model_and_is_never_overwritten(store, tmp_path, monkeypatch):
    # A damaged champions.json read as {}: every slot showed "no champion", and the next promotion replaced it.
    from service.analysis.online_training.registry import ChampionsUnreadable

    _root, directory, _dataset, exporter = store
    registry = OnlineModelRegistry(tmp_path / "reg", spec_provider=lambda: exporter.spec()["schema_digest"])
    assert registry.status()["slots"]["3m_up"]["champion_state"] == "NONE"
    assert registry.status()["slots"]["3m_up"]["reason"] == "no champion"
    assert registry.status()["champions_error"] is None
    registry.root.mkdir(parents=True, exist_ok=True)
    for damaged in ("{broken", '{"3m_up": {"kind": "x"}}', "[]"):
        registry.champions_path.write_text(damaged, encoding="utf-8")
        with pytest.raises(ChampionsUnreadable) as caught:
            registry.champions()
        assert caught.value.kind == "CHAMPIONS_DAMAGED"
        status = registry.status()
        assert status["champions_error"]["kind"] == "CHAMPIONS_DAMAGED"
        assert {s["champion_state"] for s in status["slots"].values()} == {"CHAMPIONS_DAMAGED"}
        assert registry.slot_model(3, "up")["no_model"]["state"] == "CHAMPIONS_DAMAGED"
        with pytest.raises(ChampionsUnreadable):
            OnlineModelTrainer(registry).train(directory, horizons_minutes=[3], directions=["up"])
        assert registry.champions_path.read_text(encoding="utf-8") == damaged, "never replaced by a promotion"

    registry.champions_path.unlink()
    real_read = type(registry.champions_path).read_text

    def denied(path, *a, **k):
        if path.name == "champions.json":
            raise PermissionError(13, "Access is denied")
        return real_read(path, *a, **k)

    monkeypatch.setattr(type(registry.champions_path), "read_text", denied)
    status = registry.status()
    assert status["champions_error"] == {"kind": "CHAMPIONS_IO_ERROR", "detail": "Access is denied"}
    assert status["slots"]["3m_up"]["champion_state"] == "CHAMPIONS_IO_ERROR"


def test_a_candidate_failing_the_export_check_is_eliminated_and_recorded_not_the_whole_run(store, tmp_path, monkeypatch):
    # One candidate whose export deviates must not fail the whole automatic run; the other candidate is used.
    _root, directory, _dataset, exporter = store
    real = models.export_check

    def lightgbm_off(onnx_bytes, model, x):
        check = real(onnx_bytes, model, x)
        if type(model).__name__ == "LGBMClassifier":
            return {**check, "ok": False, "max_abs_diff": 2.095e-4, "rows_over": 1, "ratio_over": 1 / max(1, check["rows"]),
                    "worst_row": {"index": 7, "fitted_probability": 0.006122, "onnx_probability": 0.005912}}
        return check

    monkeypatch.setattr(models, "export_check", lightgbm_off)
    registry = OnlineModelRegistry(tmp_path / "reg", spec_provider=lambda: exporter.spec()["schema_digest"])
    report = OnlineModelTrainer(registry).train(directory, horizons_minutes=[3])
    for slot in ("3m_up", "3m_down"):
        result = report["slots"][slot]
        assert result["status"] == "TRAINED" and result["winner"] == "logistic", "the passing candidate is used"
        rejected = result["rejected_candidates"][0]
        assert (rejected["kind"], rejected["slot"], rejected["rows_over"]) == ("lightgbm", slot, 1)
        assert rejected["worst_row"]["fitted_probability"] == 0.006122 and rejected["tolerance"] == models.EXPORT_TOLERANCE
        run = json.loads((registry.model_dir(result["model_id"]) / "run.json").read_text())
        assert [c["kind"] for c in run["candidates"]] == ["logistic"] and run["rejected_candidates"][0]["kind"] == "lightgbm"

    monkeypatch.setattr(models, "export_check", lambda o, m, x: {**real(o, m, x), "ok": False, "rows_over": 3})
    report = OnlineModelTrainer(registry).train(directory, horizons_minutes=[3], directions=["up"])
    assert report["slots"]["3m_up"]["status"] == "EXPORT_REJECTED", "the slot fails alone; the run still returns"
    assert len(report["slots"]["3m_up"]["rejected_candidates"]) == 2


def test_a_lightgbm_split_between_two_float32_values_exports_the_same_decision(monkeypatch):
    # LightGBM splits between 1+2^-23 and 1+2^-22 at their double midpoint, which rounds UP to 1+2^-22 as a float32
    # (ties to even): stored to nearest, ONNX sent every 1+2^-22 row to the other leaf (production: up to 0.05 off on a
    # few training rows per slot, eliminating the candidate).
    low, high = 1 + 2.0 ** -23, 1 + 2.0 ** -22
    assert float(np.float32((low + high) / 2)) == high
    x = np.array([[low]] * 300 + [[high]] * 300, dtype=np.float32)
    y = np.array([0] * 270 + [1] * 30 + [1] * 270 + [0] * 30)

    fitted = models.fit("lightgbm", x, y)
    check = models.export_check(models.to_onnx("lightgbm", fitted, 1), fitted, x)
    assert check["ok"] and check["max_abs_diff"] < 1e-6, check
    split = fitted.booster_.dump_model()["tree_info"][0]["tree_structure"]
    assert split["threshold"] == float(np.float32(split["threshold"])) and low <= split["threshold"] < high

    # Control: the thresholds LightGBM chose, exported as they are.
    monkeypatch.setattr(models, "float32_thresholds", lambda text: text)
    raw = models.fit("lightgbm", x, y)
    raw_check = models.export_check(models.to_onnx("lightgbm", raw, 1), raw, x)
    assert not raw_check["ok"] and raw_check["rows_over"] == 300
    np.testing.assert_allclose(fitted.predict_proba(x.astype(np.float64)), raw.predict_proba(x.astype(np.float64)),
                               rtol=0, atol=0)


def test_float32_thresholds_rounds_numeric_splits_down_and_leaves_category_splits_alone():
    text = ("tree_sizes=99 99\n\nTree=0\nnum_leaves=3\ndecision_type=2 1\nthreshold=1.0000000894069672 1\n"
            "Tree=1\ndecision_type=2\nthreshold=1e+300\nTree=2\ndecision_type=2\nthreshold=-1e+300\n")
    rounded = models.float32_thresholds(text)
    assert "tree_sizes" not in rounded
    lines = [line for line in rounded.splitlines() if line.startswith("threshold=")]
    assert lines[0] == "threshold=1.0 1", "numeric: largest float32 <= it; categorical: the category-set index as is"
    assert float(lines[1].split("=")[1]) == float(np.finfo(np.float32).max)
    assert lines[2] == "threshold=-inf"
    with pytest.raises(ContractError):
        models.float32_thresholds("Tree=0\nthreshold=1.5\n")


def test_a_candidate_its_library_cannot_fit_is_eliminated_and_a_program_error_stops_the_run(store, tmp_path, monkeypatch):
    # A broken LightGBM install stopped the whole slot, so the logistic model that could be trained was not (R14-16).
    _root, directory, _dataset, exporter = store
    real_fit = models.fit

    def broken_lightgbm(kind, x, y, **kwargs):
        if kind == "lightgbm":
            raise OSError("lib_lightgbm.dll: the specified module could not be found")
        return real_fit(kind, x, y, **kwargs)

    monkeypatch.setattr(models, "fit", broken_lightgbm)
    registry = OnlineModelRegistry(tmp_path / "reg", spec_provider=lambda: exporter.spec()["schema_digest"])
    result = OnlineModelTrainer(registry).train(directory, horizons_minutes=[3], directions=["up"])["slots"]["3m_up"]
    assert result["status"] == "TRAINED" and result["winner"] == "logistic"
    rejected = result["rejected_candidates"][0]
    assert (rejected["kind"], rejected["reason"]) == ("lightgbm", "FIT_FAILED") and "lib_lightgbm" in rejected["error"]

    monkeypatch.setattr(models, "fit", lambda kind, x, y, **kwargs: (_ for _ in ()).throw(ImportError("no sklearn")))
    result = OnlineModelTrainer(registry).train(directory, horizons_minutes=[3], directions=["up"])["slots"]["3m_up"]
    assert result["status"] == "CANDIDATES_FAILED" and len(result["rejected_candidates"]) == 2

    def program_error(kind, x, y, **kwargs):
        raise KeyError("n_estimators")
    monkeypatch.setattr(models, "fit", program_error)
    with pytest.raises(KeyError):
        OnlineModelTrainer(registry).train(directory, horizons_minutes=[3], directions=["up"])


def test_dates_are_exported_at_the_same_time_and_read_in_order(store, tmp_path, monkeypatch):
    # 11-08: the 12-day retrain exported one date at a time, one B process on one of 12 cores. The builder now runs
    # up to export_workers() exports at once; the dataset is the same as one export at a time.
    import threading
    import time

    from service.analysis.online_training import dataset as dataset_module

    root, _directory, _manifest, exporter = store
    lock = threading.Lock()
    active, peak, seen = [0], [0], []

    class Overlapping:
        binary = exporter.binary

        def spec(self):
            return exporter.spec()

        def context_fingerprint(self, date):
            return exporter.context_fingerprint(date)

        def export(self, **kwargs):
            with lock:
                assert kwargs["date"] not in seen, "a date is exported once"
                seen.append(kwargs["date"])
                active[0] += 1
                peak[0] = max(peak[0], active[0])
            try:
                time.sleep(0.3)   # long enough for the other workers to start theirs
                return exporter.export(**kwargs)
            finally:
                with lock:
                    active[0] -= 1

    monkeypatch.setattr(dataset_module, "export_workers", lambda dates: min(3, dates))
    calls = []
    parallel = OnlineDatasetBuilder(root / "hist", tmp_path / "parallel", Overlapping()).build(
        DATES, horizons_minutes=[3], progress=lambda i, n, step, detail=None: calls.append(step))
    assert peak[0] == min(3, len(DATES)) > 1, f"exports overlapped: at most {peak[0]} at once"
    assert sorted(seen) == sorted(DATES)
    assert list(dict.fromkeys(calls)) == [f"features {d}" for d in DATES] + ["dataset"], "dates are read in order"

    monkeypatch.setattr(dataset_module, "export_workers", lambda dates: 1)
    one = OnlineDatasetBuilder(root / "hist", tmp_path / "one", exporter).build(DATES, horizons_minutes=[3])
    assert parallel["dataset_id"] == one["dataset_id"] and parallel["samples"] == one["samples"]
    assert parallel["label_stats"] == one["label_stats"] and parallel["label_states"] == one["label_states"]
    a = pd.read_parquet(tmp_path / "parallel" / parallel["dataset_id"] / "samples.parquet")
    b = pd.read_parquet(tmp_path / "one" / one["dataset_id"] / "samples.parquet")
    pd.testing.assert_frame_equal(a, b)


def test_a_failed_export_stops_the_build_and_the_dates_not_started(store, tmp_path, monkeypatch):
    from service.analysis.online_training import dataset as dataset_module

    root, _directory, _manifest, exporter = store
    started = []

    class Failing:
        binary = exporter.binary

        def spec(self):
            return exporter.spec()

        def context_fingerprint(self, date):
            return exporter.context_fingerprint(date)

        def export(self, **kwargs):
            started.append(kwargs["date"])
            raise ContractError(f"export of {kwargs['date']} failed")

    monkeypatch.setattr(dataset_module, "export_workers", lambda dates: 1)
    with pytest.raises(ContractError, match=f"export of {DATES[0]} failed"):
        OnlineDatasetBuilder(root / "hist", tmp_path / "out", Failing()).build(DATES, horizons_minutes=[3])
    # The one worker may have taken the next date before the build cancelled the rest; none after it starts.
    assert started[0] == DATES[0] and len(started) <= 2, started
    assert not list((tmp_path / "out").glob("shards/*/*.tmp-*")), "no staging left behind"


def test_the_job_describes_the_promotion_rule_the_trainer_applies():
    # One promotion rule: the job's description names it instead of restating an older one.
    from service.analysis.online_training import job, trainer

    assert "PROMOTION_RULE" in job.__doc__ and "not worse" not in job.__doc__
    assert trainer.PROMOTION_RULE == ("a run's winner goes live when its validation log loss is below the constant "
                                      "baseline's, else the slot keeps its model")


def test_the_builder_and_trainer_report_each_step_they_are_on(store, tmp_path):
    # The model center's 執行紀錄 shows what the job is doing now: each date (its shard reused or exported), the
    # merge, the split, every candidate of every slot and the winner going live.
    root, directory, _manifest, exporter = store
    calls = []
    record = lambda i, n, step, detail=None: calls.append((step, detail))
    OnlineDatasetBuilder(root / "hist", tmp_path / "datasets", exporter).build(DATES, progress=record)
    assert list(dict.fromkeys(step for step, _ in calls)) == [f"features {d}" for d in DATES] + ["dataset"]
    assert [detail for _, detail in calls if detail and "reused" in detail] == [{"reused": False}] * len(DATES)
    # Each exported date reports B's four phases (as they come while it is the date being read; one exported before its
    # turn shows them all at once when it comes), then its shard read into the dataset (load), every phase ending at
    # done = total; the samples B wrote are the ones loaded.
    for date in DATES:
        updates = [detail["export"] for step, detail in calls if step == f"features {date}" and detail and "export" in detail]
        assert updates[-1]["phase"] == "load"
        last = updates[-1]["phases"]
        assert list(last) == ["verify", "replay", "labels", "write", "load"]
        assert all(p["done"] == p["total"] and isinstance(p["elapsed_ms"], int) for p in last.values()), last
        assert last["replay"]["total"] > last["write"]["total"] == last["load"]["total"] > 0
    calls.clear()
    registry = OnlineModelRegistry(tmp_path / "reg", spec_provider=lambda: exporter.spec()["schema_digest"])
    OnlineModelTrainer(registry).train(directory, horizons_minutes=[3], directions=["up"], progress=record)
    steps = list(dict.fromkeys(step for step, _ in calls))
    assert steps[:2] == ["split", "train 3m_up"]
    assert steps[2:-1] == [f"train 3m_up {kind}" for kind in CANDIDATES]
    assert steps[-1] == "promote", "every slot goes live in one step after the last one trained"
    assert {"kind": "by_date"} in [detail for _, detail in calls]


def test_the_job_status_keeps_every_step_with_its_times(tmp_path, monkeypatch):
    # The model center's 執行紀錄 lists every step the job went through, not only the current one.
    from service.analysis.online_training import job

    monkeypatch.setattr(job, "training_root", lambda: tmp_path)
    run = job.Job(mode="manual", job_id="t")
    run._progress("checking")
    run._progress("features 2026-10-27", 0, 2)
    run._progress("features 2026-10-27", 0, 2)
    run._progress("train 3m_up", 0, 1)
    run._finish("SUCCEEDED")
    status = json.loads((tmp_path / "status.json").read_text(encoding="utf-8"))
    assert [entry["step"] for entry in status["log"]] == ["checking", "features 2026-10-27", "train 3m_up"]
    assert all(entry["started_at"] and entry["ended_at"] for entry in status["log"]), "the last step ends with the job"


def test_a_date_s_progress_is_merged_into_its_log_entry_without_replacing_what_was_known(tmp_path, monkeypatch):
    from service.analysis.online_training import job

    monkeypatch.setattr(job, "training_root", lambda: tmp_path)
    run = job.Job(mode="manual", job_id="t")
    run._progress("features 2026-10-27", 0, 1)
    run._progress("features 2026-10-27", 0, 1, {"export": {"phase": "write", "phases": {}}})
    run._progress("features 2026-10-27", 0, 1, {"reused": False})
    run._progress("features 2026-10-27", 0, 1, {"export": {"phase": "load", "phases": {}}})
    status = json.loads((tmp_path / "status.json").read_text(encoding="utf-8"))
    assert status["log"][-1]["detail"] == {"reused": False, "export": {"phase": "load", "phases": {}}}


def _fake_b(tmp_path, script: str) -> tuple[RustFeatureExporter, list[str]]:
    """The exporter's process runner over a Python stand-in for B: `script` writes what B would."""
    import sys

    path = tmp_path / "fake_b.py"
    path.write_text(script, encoding="utf-8")
    return RustFeatureExporter(binary=Path(sys.executable)), [str(path)]


def test_progress_lines_go_to_the_callback_and_other_stderr_lines_into_the_error(tmp_path):
    exporter, args = _fake_b(tmp_path, "\n".join([
        "import sys",
        "for done in (0, 5, 10):",
        "    print('{\"progress\": {\"date\": \"2026-10-28\", \"phase\": \"replay\", \"done\": %d, \"total\": 10, \"elapsed_ms\": 1}}' % done, file=sys.stderr)",
        "print('[analysis_runtime] something went wrong', file=sys.stderr)",
        "print('{\"progress\": not json', file=sys.stderr)",
        "sys.exit(int(sys.argv[1]))",
    ]))
    seen = []
    assert exporter._run([*args, "0"], 30, seen.append) == ""
    assert [u["done"] for u in seen] == [0, 5, 10]
    with pytest.raises(ContractError) as failed:
        exporter._run([*args, "3"], 30, seen.append)
    assert "something went wrong" in str(failed.value) and '{"progress": not json' in str(failed.value)
    assert '"done": 5' not in str(failed.value), "progress lines are not error text"


def test_a_b_without_progress_lines_and_a_failing_display_still_export(tmp_path, caplog):
    # An older B writes no progress: the run goes on as before. A display that fails is recorded once and stderr keeps
    # being drained, so B never blocks on a full pipe.
    exporter, args = _fake_b(tmp_path, "print('{\"ok\": true}')")
    assert exporter._run(args, 30, lambda update: pytest.fail("no progress line was written")).strip() == '{"ok": true}'
    exporter, args = _fake_b(tmp_path, "\n".join([
        "import sys",
        "for done in range(20000):",
        "    print('{\"progress\": {\"phase\": \"replay\", \"done\": %d, \"total\": 20000, \"elapsed_ms\": 0}}' % done, file=sys.stderr)",
        "print('{\"ok\": true}')",
    ]))
    calls = []

    def broken(update):
        calls.append(update)
        raise OSError("status.json is locked")

    assert exporter._run(args, 60, broken).strip() == '{"ok": true}'
    assert len(calls) == 1
    assert "showing the progress of analysis_runtime" in caplog.text


def test_an_export_that_runs_past_its_timeout_is_stopped(tmp_path):
    exporter, args = _fake_b(tmp_path, "import time\ntime.sleep(30)")
    with pytest.raises(ContractError, match="timed out"):
        exporter._run(args, 1)


def test_only_complete_days_are_trained_and_incomplete_days_are_test_only(tmp_path):
    # User 10-28: a day whose stocks' ticks do not all reconcile (資料中心 完整) is test data only, never trained or
    # validated on. Before, the window was the newest dates whatever their completeness, the last of them test.
    from service.analysis.online_training.job import training_window
    from service.analysis.online_training.trainer import _split

    def summary(day, complete):
        # What Rust B writes: the summary and its verdict file (daily_summary.rs write).
        path = tmp_path / "source=shioaji" / "market=STK" / f"trading_date={day}" / "session=DAY.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"tick_complete": complete, "codes": {}}), encoding="utf-8")
        path.with_name("session=DAY.verdict.json").write_text(json.dumps(
            {"schema": "daily-summary-verdict-v1", "trading_date": day, "session": "DAY", "tick_complete": complete}), encoding="utf-8")

    for day, complete in (("d1", True), ("d2", False), ("d3", True), ("d4", False), ("d5", True)):
        summary(day, complete)
    dates = ["d0", "d1", "d2", "d3", "d4", "d5"]          # d0 has no summary: not known, not complete
    assert training_window(dates, 2, tmp_path) == (["d3", "d5"], ["d4"])
    assert training_window(dates, 20, tmp_path) == (["d1", "d3", "d5"], ["d0", "d2", "d4"])
    assert training_window(["d0", "d2"], 20, tmp_path) == ([], [])
    # User 10-28: incomplete days before the first complete one, within the newest window_days dates, are test too
    # (10-20..10-22 incomplete, 10-27 and 10-28 complete). Before, only the dates since the first complete one were.
    for day in ("e1", "e2", "e3"):
        summary(day, False)
    for day in ("e4", "e5"):
        summary(day, True)
    assert training_window(["e1", "e2", "e3", "e4", "e5"], 20, tmp_path) == (["e4", "e5"], ["e1", "e2", "e3"])
    assert training_window(["e1", "e2", "e3", "e4", "e5"], 3, tmp_path) == (["e4", "e5"], ["e3"])

    frame = pd.DataFrame({"trading_date": ["d1", "d2", "d3", "d4", "d5"] * 2, "cutoff_ns": range(10)})
    train, val, test, split = _split(frame, ["d2", "d4"])
    assert split == {"kind": "by_date", "train": ["d1", "d3"], "validation": ["d5"], "test": ["d2", "d4"]}
    assert set(train["trading_date"]) == {"d1", "d3"} and set(test["trading_date"]) == {"d2", "d4"}
    one = pd.DataFrame({"trading_date": ["d5"] * 10 + ["d4"] * 3, "cutoff_ns": [i * MINUTE_NS for i in range(13)]})
    train, val, test, split = _split(one, ["d4"])
    assert split["kind"] == "by_time_80_20" and (len(train), len(val), len(test)) == (8, 2, 3)
    assert set(test["trading_date"]) == {"d4"}
    with pytest.raises(ContractError):
        _split(one[one["trading_date"] == "d4"], ["d4"])


def test_a_day_s_completeness_is_its_verdict_file_not_a_parse_of_its_summary(tmp_path):
    # The training window asks every available date whether it is 完整 on every model center request: it reads the
    # few-byte verdict file B writes with the summary, never the summary itself (every stock's minutes, ~20 ms a day).
    from service.platform.model_storage_layout import day_tick_complete

    folder = tmp_path / "source=shioaji" / "market=STK" / "trading_date=2026-10-30"
    folder.mkdir(parents=True)
    (folder / "session=DAY.json").write_text(json.dumps({"tick_complete": True, "codes": {}}), encoding="utf-8")
    assert day_tick_complete("2026-10-30", tmp_path) is None, "a summary without its verdict file is not parsed"
    verdict = {"schema": "daily-summary-verdict-v1", "trading_date": "2026-10-30", "session": "DAY", "tick_complete": True}
    (folder / "session=DAY.verdict.json").write_text(json.dumps(verdict), encoding="utf-8")
    (folder / "session=DAY.json").write_text("{not read", encoding="utf-8")
    assert day_tick_complete("2026-10-30", tmp_path) is True
    (folder / "session=DAY.verdict.json").write_text(json.dumps({**verdict, "schema": "other"}), encoding="utf-8")
    assert day_tick_complete("2026-10-30", tmp_path) is None, "a verdict of another schema is not trusted"
