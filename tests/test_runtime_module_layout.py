"""Location/import contracts only; no market process is started."""
from __future__ import annotations

import ast
import importlib
import os
from pathlib import Path
import re

import pytest

ROOT = Path(__file__).resolve().parents[1]
SKIP = {"node_modules", "__pycache__", "target", "var", "data", "output", "IsolatedData"}

# electron-builder's beforePack hook points straight at scripts/tooling now that the
# npm workspace root is the project root, so there is no production-tree bridge file.
TOOLS_BRIDGE_ALLOWLIST: set[str] = set()


def source_files(directory):
    for base, dirs, names in os.walk(directory):
        dirs[:] = [d for d in dirs if d not in SKIP and not (Path(base) / d).is_symlink()]
        for name in names:
            file = Path(base) / name
            if file.suffix in {".py", ".js", ".cjs", ".mjs"}:
                yield file


def is_scripts_reference(value):
    return bool(re.search(r"(?:^|[./\\])scripts(?:[./\\]|$)", value))


@pytest.mark.parametrize("layer", ["api", "service", "backend", "health", "ui"])
def test_formal_layers_do_not_import_tools(layer):
    violations = []
    for file in source_files(ROOT / layer):
        if file.relative_to(ROOT).as_posix() in TOOLS_BRIDGE_ALLOWLIST:
            continue
        text = file.read_text(encoding="utf-8-sig")
        if file.suffix == ".py":
            tree = ast.parse(text, filename=str(file))
            for node in ast.walk(tree):
                names = []
                if isinstance(node, ast.Import):
                    names = [a.name for a in node.names]
                elif isinstance(node, ast.ImportFrom):
                    names = [node.module or ""]
                elif isinstance(node, ast.Call) and node.args:
                    call = node.func.id if isinstance(node.func, ast.Name) else node.func.attr if isinstance(node.func, ast.Attribute) else ""
                    if call in {"__import__", "import_module", "spec_from_file_location"}:
                        names = [arg.value for arg in node.args if isinstance(arg, ast.Constant) and isinstance(arg.value, str)]
                violations.extend(f"{file.relative_to(ROOT)}:{node.lineno}: {name}" for name in names if is_scripts_reference(name))
        else:
            # Includes require, dynamic import and static import/export-from paths.
            imports = re.findall(r"(?:\b(?:require|import)\s*\(\s*|\bfrom\s+|\bimport\s+)[\"']([^\"']+)[\"']", text)
            violations.extend(f"{file.relative_to(ROOT)}: {name}" for name in imports if is_scripts_reference(name))
    assert not violations, "\n".join(violations)


@pytest.mark.parametrize("module", ["scripts.diagnostics.check_offline", "scripts.tooling.lock_dependencies"])
def test_safe_module_imports(module):
    assert importlib.import_module(module).__file__
