"""Inference contract, training side. The Rust half (contract.rs, model.rs) runs the same fixtures."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from service.analysis.inference import contract as c

FIXTURES = Path(__file__).parent / "fixtures" / "inference_contract"


def test_python_holds_no_feature_spec_of_its_own():
    """Rust B is the only feature implementation and the only holder of the spec."""
    assert not hasattr(c, "online_v1_feature_spec") and not hasattr(c, "ONLINE_V1_FEATURE_SPEC_BODY")
    root = Path(__file__).resolve().parents[1]
    assert not (root / "service" / "analysis" / "online_features.py").exists()
    assert not (root / "service" / "analysis" / "inference" / "parity.py").exists()


def test_missing_policy_cases_are_shared_with_the_rust_half():
    import math
    for case in json.loads((FIXTURES / "missing_policy_cases.json").read_text(encoding="utf-8")):
        value = math.nan if case["input"] == {"nan": True} else case["input"]
        assert c.normalize_category(value) == case["expected"], case
    assert c.normalize_category(float("nan")) == c.MISSING_TOKEN


def test_horizon_authority():
    authority = c.load_horizon_authority()
    assert authority.allowed_minutes == (3, 5, 10, 15, 30)
    assert authority.default_enabled_minutes == (3, 5)
    assert authority.validate_enabled([5, 3, 5]) == (3, 5)
    for bad in ([1], [2], [60], [], ["x"]):
        with pytest.raises(c.ContractError):
            authority.validate_enabled(bad)


def test_the_authority_file_itself_refuses_one_minute():
    with pytest.raises(c.ContractError):
        c._parse_horizon_authority({"schema": "prediction-horizons-v1", "version": 1,
                                    "allowed_minutes": [1, 3], "default_enabled_minutes": [3],
                                    "directions": ["up", "down"]})


def test_manifest_validation():
    authority = c.load_horizon_authority()
    manifest = json.loads((FIXTURES / "model_manifest_onnx_example.json").read_text(encoding="utf-8"))
    assert c.validate_model_manifest(manifest, authority) == []
    root = Path(__file__).resolve().parents[1]
    spec = json.loads((root / "native" / "analysis_runtime" / "spec" / "feature_spec_online_v3.json").read_text(encoding="utf-8"))
    assert manifest["feature_spec"]["schema_digest"] == spec["schema_digest"]
    assert manifest["io"]["numeric"] == [col["name"] for col in spec["columns"] if col["dtype"] == "f64"]
    no_io = {**manifest, "io": {}}
    assert any("io.input" in p for p in c.validate_model_manifest(no_io, authority))
    unscoped = {k: v for k, v in manifest.items() if k != "scope"}
    assert any("scope" in p for p in c.validate_model_manifest(unscoped, authority))
    legacy = {**manifest, "artifact": {**manifest["artifact"], "format": "model-json-v1"}}
    assert any("not recognised" in p for p in c.validate_model_manifest(legacy, authority))
    for field, value in (("horizon_minutes", 1), ("direction", "sideways")):
        bad = {**manifest, field: value}
        assert c.validate_model_manifest(bad, authority)
    bad = {**manifest, "artifact": {**manifest["artifact"], "sha256": ""}}
    assert c.validate_model_manifest(bad, authority)
    test_model = {**manifest, "artifact": {"format": "builtin-test", "path": ""}, "test_only": False}
    assert any("test_only" in p for p in c.validate_model_manifest(test_model, authority))


def test_the_analysis_graph_takes_market_runtime_from_the_manifest_only():
    """A port change is a resolver change (00/06): every client derives market_runtime from the effective config."""
    import re

    from config.network_settings import LIVE_ENGINE_WS_URL, endpoint
    from service.market.shared.rust_live import RustDaemonEventSink
    from service.market.shared.rust_view_client import RustViewClient

    host, port = endpoint("market_runtime")
    assert LIVE_ENGINE_WS_URL == f"ws://{host}:{port}/live"
    # The credential is a header, never part of the URL.
    sink = RustDaemonEventSink(token="t" * 32, source="shioaji")
    assert sink._url() == LIVE_ENGINE_WS_URL and sink._auth_headers() == {"Authorization": "Bearer " + "t" * 32}
    view = RustViewClient(token="t" * 32)
    assert view._url == LIVE_ENGINE_WS_URL and "t" * 32 not in view._url
    root = Path(__file__).resolve().parents[1]
    for rel in ("service/market/shared/rust_live.py",
                "service/market/shared/rust_view_client.py", "api/services/model_api.py", "api/services/quote_api.py"):
        code = "\n".join(line for line in (root / rel).read_text(encoding="utf-8").splitlines()
                         if not line.lstrip().startswith("#"))
        assert not re.search(r"ws://127\.0\.0\.1:\d+", code), f"{rel} carries a literal Market Runtime address"
