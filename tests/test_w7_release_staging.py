"""The staged Python runtime and the clean-checkout release pipeline."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _load(name: str):
    spec = importlib.util.spec_from_file_location(f"w7_{name}", ROOT / "scripts" / "tooling" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_bundled_locks_carry_no_broker_sdk_and_include_the_model_chain():
    stage = _load("stage_python_runtime")
    bundled = stage._locked_entries()
    assert not {"shioaji", "moomoo-api"} & set(bundled)
    for package in ("fastapi", "lightgbm", "onnx", "onnxruntime", "scikit-learn", "skl2onnx", "onnxmltools"):
        assert package in bundled, package


def test_provider_sdk_lists_hold_only_what_the_bundle_lacks():
    stage = _load("stage_python_runtime")
    sdk = stage.provider_sdk_requirements()
    names = {provider: set(lines) for provider, lines in sdk.items()}
    assert names["shioaji"] == {"shioaji"}
    assert "moomoo-api" in names["futu"] and "protobuf" not in names["futu"]  # protobuf is bundled (onnx)
    # Bare package names, not pinned lines: the broker SDK is installed latest from PyPI, unpinned (decisions.md
    # 券商 SDK 裝最新不綁版本). `pip install --no-deps` of these names finds every other dependency in the bundle.
    assert all("==" not in name and "--hash" not in name for lines in sdk.values() for name in lines)


def test_a_bundled_lock_that_pins_a_broker_sdk_is_refused(monkeypatch, tmp_path):
    stage = _load("stage_python_runtime")
    (tmp_path / "requirements").mkdir()
    for name in stage.RUNTIME_LOCKS:
        (tmp_path / "requirements" / name).write_text("shioaji==1.7.2 --hash=sha256:00\n", encoding="utf-8")
    monkeypatch.setattr(stage, "ROOT", tmp_path)
    with pytest.raises(RuntimeError, match="broker SDK"):
        stage._locked_entries()


def test_bootstrap_downloads_are_pinned_and_checked(monkeypatch, tmp_path):
    stage = _load("stage_python_runtime")
    pins = json.loads((ROOT / "requirements" / "python-bootstrap.json").read_text(encoding="utf-8"))
    evidence = json.loads((ROOT / "requirements" / "environment-evidence.json").read_text(encoding="utf-8"))
    assert pins["python_embed"]["version"] == evidence["python"]
    for artifact in ("python_embed", "pip_wheel"):
        assert pins[artifact]["url"].startswith("https://") and len(pins[artifact]["sha256"]) == 64
    assert "bootstrap.pypa.io" not in (ROOT / "scripts" / "tooling" / "stage_python_runtime.py").read_text(encoding="utf-8")

    class Response:
        def __init__(self, data): self.data = data
        def __enter__(self): return self
        def __exit__(self, *exc): return False
        def read(self, size=-1):
            chunk, self.data = self.data, b""
            return chunk

    monkeypatch.setattr(stage.urllib.request, "urlopen", lambda url, timeout: Response(b"tampered"))
    with pytest.raises(RuntimeError, match="sha256 mismatch"):
        stage._download_verified("https://example.invalid/x.zip", "0" * 64, tmp_path / "x.zip")
    assert not (tmp_path / "x.zip").exists()


def test_only_allowlisted_executables_may_be_staged():
    stage = _load("stage_python_runtime")
    assert stage.unexpected_executables(
        ["python.exe", "pythonw.exe", "Lib/site-packages/pip/_vendor/distlib/t64.exe"]) == []
    assert stage.unexpected_executables(
        ["Lib/site-packages/moomoo/tools/protoc.exe", "Scripts/pip.exe"]) == [
        "Lib/site-packages/moomoo/tools/protoc.exe", "Scripts/pip.exe"]


def test_sitecustomize_appends_only_the_active_provider_sdk_version(tmp_path, monkeypatch):
    stage = _load("stage_python_runtime")
    sdk = tmp_path / "sdk"
    (sdk / "futu" / "v-1").mkdir(parents=True)
    (sdk / "futu" / "active.txt").write_text("v-1", encoding="ascii")
    monkeypatch.setenv("STOCK_MONITOR_PROVIDER_SDK_DIR", str(sdk))
    import sys
    before = list(sys.path)
    try:
        exec(compile(stage.SITECUSTOMIZE, "sitecustomize.py", "exec"), {})
        assert sys.path[-1] == str(sdk / "futu" / "v-1") and sys.path[:-1] == before, "appended; the flat root never"
    finally:
        sys.path[:] = before


def test_release_pipeline_runs_every_step_in_order(monkeypatch, tmp_path):
    release = _load("build_release")
    cargo_build = release.cargo_build
    calls = []
    for step in ("check_toolchain", "npm_ci", "cargo_build", "stage_python_runtime", "stage_vc_runtime", "check_notices",
                 "electron_builder", "report"):
        monkeypatch.setattr(release, step, lambda *args, _step=step: calls.append(_step) or {})
    monkeypatch.setattr(release.os, "chdir", lambda path: calls.append(("chdir", Path(path))))
    monkeypatch.setattr(release.sys, "argv", ["build_release.py"])
    assert release.main() == 0
    assert calls == [("chdir", ROOT), "check_toolchain", "npm_ci", "cargo_build", "stage_python_runtime", "stage_vc_runtime",
                     "check_notices", "electron_builder", "report"]
    # Rust builds from the committed lock files (in a stand-in root where each build "produced" its executable).
    builds = []
    for crate, exes in release.CRATES.items():
        for exe in exes:
            (tmp_path / crate / "target" / "release").mkdir(parents=True, exist_ok=True)
            (tmp_path / crate / "target" / "release" / exe).write_bytes(b"")
    monkeypatch.setattr(release, "ROOT", tmp_path)
    monkeypatch.setattr(release, "_tool", lambda name: name)
    monkeypatch.setattr(release, "_run", lambda args, **kwargs: builds.append((args, kwargs.get("cwd"))))
    cargo_build()
    assert {cwd.name for _args, cwd in builds} == {"market_runtime", "analysis_runtime"}
    assert all(args[:3] == ["cargo", "build", "--release"] and "--locked" in args for args, _cwd in builds), builds
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    assert package["scripts"]["release"].endswith("build_release.py")
    shipped = {entry["from"] for entry in package["build"]["extraResources"]}
    assert {"packaging/install_provider_sdk.ps1", "packaging/licenses"} <= shipped


def test_onnxruntime_license_ships_with_the_installer():
    directory = ROOT / "packaging" / "licenses" / "onnxruntime-1.28.0"
    assert (directory / "LICENSE").read_text(encoding="utf-8").startswith("MIT License")
    assert (directory / "ThirdPartyNotices.txt").stat().st_size > 100_000
    lock = (ROOT / "native" / "analysis_runtime" / "Cargo.lock").read_text(encoding="utf-8")
    assert 'name = "ort-sys"\nversion = "2.0.0-rc.13"' in lock  # rc.13 pins ONNX Runtime 1.28.0


def test_shipped_powershell_scripts_parse_under_windows_powershell_5():
    # Windows PowerShell 5.1 reads a BOM-less script in the ANSI code page: a UTF-8 script with Chinese text then
    # fails to parse (install_provider_sdk.ps1 did, found by running the installed build). ASCII or a UTF-8 BOM.
    for script in sorted((ROOT / "packaging").glob("*.ps1")):
        data = script.read_bytes()
        assert data.startswith(b"\xef\xbb\xbf") or data.isascii(), f"{script.name}: non-ASCII without a UTF-8 BOM"
