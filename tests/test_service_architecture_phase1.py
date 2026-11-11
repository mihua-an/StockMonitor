from __future__ import annotations

import ast
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _imports(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    result: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            result.append(node.module or "")
        elif isinstance(node, ast.Import):
            result.extend(alias.name for alias in node.names)
    return result


def test_service_layer_never_imports_app_layer() -> None:
    violations = []
    for path in (ROOT / "service").rglob("*.py"):
        for module in _imports(path):
            if module == "app" or module.startswith("app."):
                violations.append((path.relative_to(ROOT).as_posix(), module))
    assert violations == []


# service/market imports nothing from service/analysis, and service/analysis nothing from service/market.
# The retired Python model chain made the only such edges: the replay's recorded
# model-inference overlay and the Shioaji optional analysis workers. Models live in Rust B and the training job.
_ALLOWED_MARKET_TO_ANALYSIS: set[tuple[str, str]] = set()


def test_market_layer_imports_analysis_only_where_architecture_allows() -> None:
    edges = set()
    for path in (ROOT / "service" / "market").rglob("*.py"):
        for module in _imports(path):
            if module == "service.analysis" or module.startswith("service.analysis."):
                edges.add((path.relative_to(ROOT).as_posix(), module))
    assert edges - _ALLOWED_MARKET_TO_ANALYSIS == set(), "new market -> analysis dependency"
    reverse = set()
    for path in (ROOT / "service" / "analysis").rglob("*.py"):
        for module in _imports(path):
            if module == "service.market" or module.startswith("service.market."):
                reverse.add((path.relative_to(ROOT).as_posix(), module))
    assert reverse == set(), "service.analysis must not depend on service.market"


def test_market_authority_layers_never_depend_on_query_package() -> None:
    violations = []
    market_root = ROOT / "service" / "market"
    for path in market_root.rglob("*.py"):
        if (market_root / "query") in path.parents:
            continue
        for module in _imports(path):
            if module == "service.market.query" or module.startswith("service.market.query."):
                violations.append((path.relative_to(ROOT).as_posix(), module))
    assert violations == []


def test_query_package_contains_no_materialized_store_authority() -> None:
    query = ROOT / "service" / "market" / "query"
    assert {path.name for path in query.glob("*.py")} == {
        "__init__.py",
        "data_center_service.py",
        # 資料中心's catalog over the Rust historical store: reads materialized partitions, owns nothing.
        "historical_catalog.py",
    }
    for removed in (
        "trade_detail_store.py",
        "minute_trend_store.py",
        "session_projection_store.py",
        "product_catalog_service.py",
        "volume_baseline_service.py",
        "market_index_service.py",
        "product_market_summary_service.py",
        "security_master_service.py",
        "watch_page_service.py",
        "monitor_market_context_service.py",
    ):
        assert not (query / removed).exists()


def test_projection_and_semantics_authorities_use_new_paths() -> None:
    projection = ROOT / "service" / "market" / "projection"
    semantics = ROOT / "service" / "market" / "semantics"
    # Python holds no materialized-store writers: only compute-only projectors here,
    # and the historical read boundary lives under history/.
    # session_projectors.py (a third price-volume aggregation) is gone too: Rust B computes 價量.
    # volume_baseline_service.py (a Python re-read of whole sessions in the provider) is gone: the close-of-day
    # materialization publishes 量變's baseline (native/analysis_runtime/src/baseline_publish.rs).
    for gone in ("trade_detail_store.py", "minute_trend_store.py", "session_projection_store.py", "session_projectors.py",
                 "volume_baseline_service.py"):
        assert not (projection / gone).exists()
    assert (ROOT / "service" / "market" / "history" / "historical_store.py").is_file()
    # Large-order classification and signals are Rust B's alone: no Python definition remains.
    for gone in ("large_order.py", "trade_flow.py", "signal_detector.py"):
        assert not (semantics / gone).exists()
    for gone in ("monitor_event_store.py", "alert_service.py", "latest_signal_store.py", "sector_context_service.py"):
        assert not (projection / gone).exists()
