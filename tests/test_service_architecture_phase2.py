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


def test_market_shared_never_imports_provider_implementation() -> None:
    violations = []
    shared = ROOT / "service" / "market" / "shared"
    for path in shared.rglob("*.py"):
        for module in _imports(path):
            if module.startswith("service.market.shioaji") or module.startswith("service.market.futu"):
                violations.append((path.relative_to(ROOT).as_posix(), module))
    assert violations == []


def test_provider_specific_maintenance_is_not_shared() -> None:
    shared = ROOT / "service" / "market" / "shared"
    assert not (shared / "market_maintenance_coordinator.py").exists()
    assert not (shared / "stock_session_repair_coordinator.py").exists()
    assert (ROOT / "service" / "market" / "shioaji" / "maintenance.py").is_file()
    assert not (ROOT / "service" / "market" / "shioaji" / "stock_session_repair.py").exists()  # Rust materializer job replaces it


def test_process_recovery_execution_is_health_owned() -> None:
    recovery = ROOT / "service" / "platform" / "recovery_executor.py"
    assert not recovery.exists()
    assert (ROOT / "health" / "supervisor.js").is_file()
    assert not (ROOT / "service" / "market" / "shared" / "recovery_executor.py").exists()


def test_futu_service_composes_control_plane_components() -> None:
    source = (ROOT / "service" / "market" / "futu" / "service.py").read_text(encoding="utf-8")
    assert "FutuOpenDLifecycle(self," in source
    assert "FutuSessionLifecycleCoordinator(" in source  # explicit per-source session lifecycle owner (06)
    assert "FutuSecurityMasterLifecycle(" in source
    assert "self.opend_lifecycle.run()" in source
    assert "def _sync_context" not in source
