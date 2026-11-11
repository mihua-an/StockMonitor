"""Guards that the Shioaji daemon's service graph can actually be built."""
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_shioaji_market_service_graph_constructs_without_broker(tmp_path):
    code = """
from config.feature_settings import SHIOAJI_FEATURES
from service.market.shioaji.service import ShioajiMarketService
service = ShioajiMarketService()
assert service.broker_service is not None and service.live_event_sink is not None
assert not hasattr(service, "analysis_services"), "no model or analysis worker lives in the Shioaji daemon"
assert service.session_evidence_gate is not None
print("SERVICE_GRAPH_OK")
"""
    result = subprocess.run(
        [sys.executable, "-c", code], cwd=tmp_path, capture_output=True, text=True, encoding="utf-8", timeout=60,
        env={**os.environ, "PYTHONPATH": str(ROOT), "STOCK_MONITOR_SOURCES": "shioaji",
             "STOCK_MONITOR_DATA_ROOT": str(tmp_path / "data")},
    )
    assert "SERVICE_GRAPH_OK" in result.stdout, result.stdout + result.stderr
