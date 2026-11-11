"""The bundled Python imports a broker SDK only from the version folder its active.txt names."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _sitecustomize() -> str:
    spec = importlib.util.spec_from_file_location("stage_python_runtime", ROOT / "scripts" / "tooling" / "stage_python_runtime.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.SITECUSTOMIZE


def test_only_the_active_version_folder_is_imported(tmp_path, monkeypatch):
    root = tmp_path / "provider-sdk"
    (root / "shioaji" / "v-1").mkdir(parents=True)
    (root / "shioaji" / "v-2").mkdir()          # an interrupted install: never named active
    (root / "shioaji" / "active.txt").write_text("v-1", encoding="ascii")
    monkeypatch.setenv("STOCK_MONITOR_PROVIDER_SDK_DIR", str(root))
    monkeypatch.setattr(sys, "path", list(sys.path))
    exec(compile(_sitecustomize(), "sitecustomize", "exec"), {})
    assert str(root / "shioaji" / "v-1") in sys.path
    assert str(root / "shioaji" / "v-2") not in sys.path
    assert str(root) not in sys.path, "a flat SDK root is never put on the path"


def _run(root, monkeypatch, capsys):
    monkeypatch.setenv("STOCK_MONITOR_PROVIDER_SDK_DIR", str(root))
    monkeypatch.setattr(sys, "path", list(sys.path))
    namespace = {}
    exec(compile(_sitecustomize(), "sitecustomize", "exec"), namespace)
    return namespace["PROVIDER_SDK_ERRORS"], capsys.readouterr().err


def test_not_installed_is_only_a_missing_active_txt_and_every_other_fault_is_recorded(tmp_path, monkeypatch, capsys):
    root = tmp_path / "provider-sdk"
    (root / "futu").mkdir(parents=True)
    errors, stderr = _run(root, monkeypatch, capsys)
    assert errors == {} and stderr == "", "no active.txt: not installed, nothing to say"
    (root / "shioaji").mkdir()
    for name, expected in (("..", "names no version folder"), ("v-1/../../x", "names no version folder"),
                           ("v-9", "does not exist")):
        (root / "shioaji" / "active.txt").write_text(name, encoding="ascii")
        errors, stderr = _run(root, monkeypatch, capsys)
        assert expected in errors["shioaji"] and "[PROVIDER SDK] shioaji" in stderr, name
    (root / "shioaji" / "active.txt").unlink()
    (root / "shioaji" / "active.txt").mkdir()          # unreadable: a directory where the file should be
    errors, _ = _run(root, monkeypatch, capsys)
    assert "failed" in errors["shioaji"], "a read failure is not 'not installed'"
