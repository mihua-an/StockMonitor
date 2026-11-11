"""No two service packages import each other.

Edges are counted at package level (service/<pkg>, service/market/<pkg>), function-level imports included -- a
cycle hidden inside a function is still a cycle."""
from __future__ import annotations

import ast
import collections
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _package(module: str) -> str | None:
    parts = module.split(".")
    if parts[:2] == ["service", "market"] and len(parts) >= 3:
        return "market." + parts[2]
    if parts[0] == "service" and len(parts) >= 2:
        return parts[1]
    return None


def test_service_packages_have_no_import_cycle():
    edges: dict[tuple[str, str], list[str]] = collections.defaultdict(list)
    for path in (ROOT / "service").rglob("*.py"):
        rel = path.relative_to(ROOT).with_suffix("")
        source_pkg = _package(".".join(rel.parts))
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith("service."):
                target = _package(node.module)
                if target and source_pkg and target != source_pkg:
                    edges[(source_pkg, target)].append(f"{rel}:{node.lineno}")
    cycles = [f"{a} <-> {b}: {edges[(a, b)][:2]} / {edges[(b, a)][:2]}" for (a, b) in edges if (b, a) in edges and a < b]
    assert not cycles, "\n".join(cycles)
