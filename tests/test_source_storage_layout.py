import os
from pathlib import Path

from service.market.storage.market_storage_layout import MarketStorageLayout, process_market_layout
from service.platform.project_root import PROJECT_ROOT


def test_source_layouts_are_isolated_and_lazy(tmp_path):
    layout = MarketStorageLayout(tmp_path)
    assert layout.source_root("shioaji") == tmp_path / "market" / "shioaji"
    assert layout.futu_canonical_root == tmp_path / "market" / "futu" / "canonical"
    assert layout.evidence_root == tmp_path / "market" / "shioaji" / "evidence"
    assert layout.volume_baseline_root == tmp_path / "market" / "shioaji" / "volume_baseline"
    assert layout.actual_accounts_root == tmp_path / "accounts" / "actual"
    assert layout.paper_accounts_root == tmp_path / "accounts" / "paper"
    assert layout.shioaji_reference_root == tmp_path / "reference" / "shioaji"
    assert layout.futu_reference_root == tmp_path / "reference" / "futu"
    assert layout.watch_pages_file == tmp_path / "preferences" / "watch_pages.csv"
    assert layout.source_path("futu", "evidence", "ticker") == tmp_path / "market" / "futu" / "evidence" / "ticker"
    assert not layout.futu_canonical_root.exists()


def test_default_project_root_is_the_application_root():
    expected_root = Path(__file__).resolve().parents[1]
    assert PROJECT_ROOT == expected_root
    # tests/conftest.py points STOCK_MONITOR_VAR_ROOT at a disposable directory; the DEFAULT (<project>/var) is proven in
    # tests/test_var_layout.py by a subprocess with the variable removed.
    assert process_market_layout().data_root == Path(os.environ["STOCK_MONITOR_VAR_ROOT"]) / "data"
