from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from backend.futu.runtime import FutuRuntime
from service.market.futu.service import FutuMarketService


ROOT = Path(__file__).resolve().parents[1]


def test_futu_runtime_exposes_one_source_owner_to_catalog(tmp_path: Path):
    source = FutuMarketService(tmp_path / "futu.db")
    assert source.source == "futu"
    runtime = FutuRuntime(service_factory=lambda: source)
    runtime._service = source
    assert source.control_store.db_path == source.db_path
    assert runtime.product_catalog is source.product_catalog
    assert not hasattr(source, "market_store") and not hasattr(runtime, "market_queries")
    assert source._thread is None


def test_inference_and_training_switches_are_independent(tmp_path: Path):
    code = """
from config.feature_settings import SHIOAJI_FEATURES
print(SHIOAJI_FEATURES.model_inference, SHIOAJI_FEATURES.model_training)
"""
    for inference, training in (("1", "0"), ("0", "1")):
        result = subprocess.run(
            [sys.executable, "-c", code], cwd=tmp_path, capture_output=True, text=True,
            env={**os.environ, "PYTHONPATH": str(ROOT),
                 "STOCK_MONITOR_SHIOAJI_MODEL_INFERENCE": inference,
                 "STOCK_MONITOR_SHIOAJI_MODEL_TRAINING": training}, timeout=15,
        )
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == f"{'True' if inference == '1' else 'False'} {'True' if training == '1' else 'False'}"


def test_the_shioaji_daemon_imports_no_model_code(tmp_path: Path):
    """No model, training or analysis worker lives in the Shioaji daemon; models are Rust B's, training is a job
    Health starts. Building the daemon's service graph must not import any of it."""
    code = """
import sys
from service.market.shioaji.service import ShioajiMarketService
ShioajiMarketService()
loaded = sorted(m for m in sys.modules if m.startswith(("service.analysis", "sklearn", "lightgbm", "onnx", "orderbook_model")))
print("LOADED", loaded)
"""
    result = subprocess.run(
        [sys.executable, "-c", code], cwd=tmp_path, capture_output=True, text=True, encoding="utf-8", timeout=60,
        env={**os.environ, "PYTHONPATH": str(ROOT), "STOCK_MONITOR_SOURCES": "shioaji",
             "STOCK_MONITOR_DATA_ROOT": str(tmp_path / "data")},
    )
    assert "LOADED []" in result.stdout, result.stdout + result.stderr
