"""Broker SDKs that PyPI carries as source only (moomoo-api: every release is a .tar.gz) are built by the bundled
runtime itself. Its ._pth file makes Python ignore PYTHONPATH, so pip's isolated build environment never reaches the
build backend (`Cannot import 'setuptools.build_meta'` on every clean machine); the runtime carries setuptools and
install_provider_sdk.ps1 builds with --no-build-isolation. Packages that do publish wheels are installed as wheels
only: the runtime has no compiler."""
from __future__ import annotations

import importlib.util
import os
import shutil
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
STAGED_PYTHON = ROOT / "packaging" / "python" / "python.exe"


def _stage():
    spec = importlib.util.spec_from_file_location("stage_source_build", ROOT / "scripts" / "tooling" / "stage_python_runtime.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_bundle_carries_the_build_backend_for_source_only_sdks():
    stage = _stage()
    assert "setuptools" in stage._locked_entries()
    assert stage.unexpected_executables(["Lib/site-packages/setuptools/cli-64.exe"]) == []


def test_provider_lists_take_wheels_only_except_for_source_only_packages():
    stage = _stage()
    for provider, names in stage.provider_sdk_requirements().items():
        options = [line for line in stage._provider_sdk_file_text(provider, names).splitlines()
                   if line.startswith("--")]
        wheels_only = [name for name in names if name not in stage.SDIST_ONLY]
        assert options == [f"--only-binary={','.join(wheels_only)}"], provider
    futu = stage._provider_sdk_file_text("futu", stage.provider_sdk_requirements()["futu"])
    assert "moomoo-api" not in futu.split("--only-binary=", 1)[1].splitlines()[0].split(",")


@pytest.mark.skipif(os.name != "nt" or shutil.which("powershell") is None, reason="the installer is a Windows PowerShell script")
def test_the_installer_pip_step_builds_a_source_only_package_with_the_staged_runtime(tmp_path):
    stage = _stage()
    if not STAGED_PYTHON.is_file() or stage.check_staged():
        pytest.skip("needs a current runtime staged by stage_python_runtime.py (it runs this same check itself)")
    result = stage.install_source_package(STAGED_PYTHON, tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    assert (tmp_path / "target" / "sdist_only_probe" / "__init__.py").is_file()
