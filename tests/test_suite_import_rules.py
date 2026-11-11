"""A test module is never another test's library: shared fakes and builders live in tests/support/ (R18-19).

Importing from a test_*.py module ties unrelated cases to that file's name and makes pytest collect its tests twice
under two module names when the import path differs.
"""
from __future__ import annotations

import ast
from pathlib import Path

TESTS = Path(__file__).resolve().parent


def _imported_modules(tree: ast.AST):
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            yield node.lineno, node.module, [alias.name for alias in node.names]
        elif isinstance(node, ast.Import):
            for alias in node.names:
                yield node.lineno, alias.name, []


def _offenders(text: str) -> list[str]:
    found = []
    for line, module, names in _imported_modules(ast.parse(text)):
        parts = module.split(".")
        if any(part.startswith("test_") for part in parts):
            found.append(f"{line}: {module}")
        elif parts[-1] == "tests" and any(name.startswith("test_") for name in names):
            found.append(f"{line}: {module} import {', '.join(names)}")
    return found


def test_no_test_module_imports_another_test_module():
    problems = []
    for path in sorted(TESTS.rglob("*.py")):
        problems += [f"{path.relative_to(TESTS.parent)}:{entry}" for entry in _offenders(path.read_text(encoding="utf-8"))]
    assert not problems, "move the shared helper to tests/support/:\n" + "\n".join(problems)


def test_the_rule_sees_each_import_form():
    assert _offenders("from tests.test_paper_orders import make_desk\n") == ["1: tests.test_paper_orders"]
    assert _offenders("import tests.test_paper_orders as t\n") == ["1: tests.test_paper_orders"]
    assert _offenders("from tests import test_paper_orders\n") == ["1: tests import test_paper_orders"]
    assert _offenders("def f():\n    from test_paper_orders import x\n") == ["2: test_paper_orders"]
    assert _offenders("from tests.support.paper_desk import make_desk\nfrom tests import synthetic_runtime\n") == []
