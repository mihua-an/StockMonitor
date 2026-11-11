"""The installer carries the MSVC runtime its binaries import (scripts/tooling/stage_vc_runtime.py)."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _module():
    spec = importlib.util.spec_from_file_location("stage_vc_runtime", ROOT / "scripts" / "tooling" / "stage_vc_runtime.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_pe_import_table_is_read():
    imports = _module().pe_imports(Path(sys.executable))
    assert any(name.startswith("python3") or name == "kernel32.dll" for name in imports), imports


def test_check_names_an_import_that_is_not_staged(tmp_path, monkeypatch):
    module = _module()
    binary = tmp_path / "app.exe"
    binary.write_bytes(b"")
    monkeypatch.setattr(module, "ROOT", tmp_path)
    monkeypatch.setattr(module, "BINARIES", ("app.exe",))
    monkeypatch.setattr(module, "OUT", tmp_path / "vc")
    monkeypatch.setattr(module, "PYTHON_DIR", tmp_path / "python")
    monkeypatch.setattr(module, "MANIFEST", tmp_path / "vc" / "VC_RUNTIME.json")
    monkeypatch.setattr(module, "vc_runtime_imports", lambda path: {"msvcp140.dll", "vcruntime140.dll"})
    (tmp_path / "vc").mkdir()
    (tmp_path / "python").mkdir()
    (tmp_path / "vc" / "vcruntime140.dll").write_bytes(b"v")
    problems = module.check()
    assert any("msvcp140.dll" in p and "not staged" in p for p in problems), problems
    assert any("VC_RUNTIME.json missing" in p for p in problems), problems

    (tmp_path / "vc" / "msvcp140.dll").write_bytes(b"m")
    files = {name: {"sha256": hashlib.sha256(data).hexdigest()} for name, data in (("vcruntime140.dll", b"v"), ("msvcp140.dll", b"m"))}
    (tmp_path / "vc" / "VC_RUNTIME.json").write_text(json.dumps({"files": files}), encoding="utf-8")
    (tmp_path / "python" / "vcruntime140.dll").write_bytes(b"old")      # python.org's older copy left in place
    (tmp_path / "python" / "msvcp140.dll").write_bytes(b"m")
    problems = module.check()
    assert problems and all("vcruntime140.dll" in p for p in problems), problems
    (tmp_path / "python" / "vcruntime140.dll").write_bytes(b"v")
    assert module.check() == []


def test_release_build_stages_it_and_the_installer_copies_it():
    build = (ROOT / "scripts" / "tooling" / "build_release.py").read_text(encoding="utf-8")
    assert "stage_vc_runtime()" in build.split("def main()")[1]
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    assert {"from": "packaging/vc_runtime", "to": "native", "filter": ["*.dll"]} in package["build"]["extraResources"]
