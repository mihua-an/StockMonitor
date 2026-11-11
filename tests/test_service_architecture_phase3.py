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


def test_account_command_read_and_analytics_ownership_is_explicit() -> None:
    account = ROOT / "service" / "account"
    ledger_source = (account / "account_ledger_service.py").read_text(encoding="utf-8")
    assert (account / "account_read_service.py").is_file()
    assert (account / "account_analytics_service.py").is_file()
    assert "class AccountLedgerService(AccountReadService, AccountAnalyticsService):" in ledger_source
    assert "def rebuild(" in ledger_source
    assert "def get_positions(" not in ledger_source
    assert "def get_analytics(" not in ledger_source


def test_account_ledger_service_has_no_dead_accounting_core_wrappers() -> None:
    """AccountLedgerService.rebuild() used to call ~14 thin self.X(...) aliases
    that did nothing but forward to self.accounting_core.X(...), with zero
    other caller anywhere in the repo. Only the handful AccountReadService/
    AccountAnalyticsService actually depend on via the multiple-inheritance
    MRO (_build_orders/_split_orders_to_legs/_match_normal_trades/
    parse_trade_info/_decimal/_number) are allowed to remain."""
    account = ROOT / "service" / "account"
    ledger_source = (account / "account_ledger_service.py").read_text(encoding="utf-8")
    removed_wrapper_names = (
        "_ceil_decimal", "_floor_decimal", "_is_etf", "_fee_for_order", "_tax_for_leg",
        "_sort_key", "_allocate_order_part", "_allocate_lot", "_make_match",
        "_match_day_trades", "_minute_diff", "_day_diff", "_fmt", "_read_status_counts_from_conn",
    )
    for name in removed_wrapper_names:
        assert f"def {name}(" not in ledger_source, f"{name} should be inlined, not kept as a dead wrapper"
        assert f"{name} = staticmethod(" not in ledger_source, f"{name} should be inlined, not kept as a dead alias"
    for name in ("_build_orders", "_split_orders_to_legs", "_match_normal_trades", "parse_trade_info"):
        assert f"def {name}(" in ledger_source or f"{name} = staticmethod(" in ledger_source, (
            f"{name} must stay: AccountReadService/AccountAnalyticsService call self.{name}(...) via MRO"
        )


def test_provider_independent_history_and_replay_use_repository_contract() -> None:
    roots = [
        ROOT / "service" / "market" / "history",
        ROOT / "service" / "market" / "query",
        ROOT / "service" / "replay",
    ]
    violations = []
    for root in roots:
        for path in root.rglob("*.py"):
            for module in _imports(path):
                if module.startswith("service.market.shioaji"):
                    violations.append((path.relative_to(ROOT).as_posix(), module))
    assert violations == []
    assert (ROOT / "service" / "market" / "history" / "repository_contract.py").is_file()


def test_history_replay_is_cross_domain_composition_not_analysis_owned() -> None:
    # The 2026-09 service-layer review: `service/replay/` held a single
    # non-__init__ file, too little to be a top-level domain, so it merged into
    # `service/market/history/`. It must still not be owned by `service/analysis/`.
    assert (ROOT / "service" / "market" / "history" / "history_replay_service.py").is_file()
    assert not (ROOT / "service" / "replay").exists()
    assert not (ROOT / "service" / "analysis" / "history_replay_service.py").exists()


def test_market_domain_modules_never_import_api_routes() -> None:
    """R13-26: the background list's validator is a config contract both the route and the owners depend on."""
    import ast

    for path in (ROOT / "service" / "market").rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.ImportFrom) and (node.module or "").startswith("api."):
                raise AssertionError(f"{path.relative_to(ROOT)} imports {node.module}")
