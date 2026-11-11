"""The synthetic historical store built into an online dataset by the real Rust B exporter, shared by the online
training tests. Skipped when no analysis_runtime build has the feature-spec/export mode."""
from __future__ import annotations

import pytest

from service.analysis.inference.contract import ContractError
from service.analysis.online_training.dataset import OnlineDatasetBuilder, RustFeatureExporter
from tests.online_training_fixtures import DATES, write_store


def rust_feature_exporter() -> RustFeatureExporter:
    exporter = RustFeatureExporter()
    try:
        exporter.spec()
    except (ContractError, OSError, ValueError, IndexError) as exc:
        pytest.skip(f"no analysis_runtime build with --feature-spec/--export-features: {exc}")
    return exporter


@pytest.fixture(scope="module")
def store(tmp_path_factory):
    """(root, dataset directory, dataset manifest, exporter) over the synthetic store's DATES."""
    exporter = rust_feature_exporter()
    root = tmp_path_factory.mktemp("store")
    write_store(root / "hist")
    manifest = OnlineDatasetBuilder(root / "hist", root / "datasets", exporter).build(DATES)
    return root, root / "datasets" / manifest["dataset_id"], manifest, exporter
