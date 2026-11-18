"""install_provider_sdk.ps1's pip step reads no pip configuration file and installs from PyPI only. pip always loads
the machine-wide %ProgramData%\\pip\\pip.ini (which any local account can create), even with --isolated, unless
PIP_CONFIG_FILE is exactly os.devnull; another account could otherwise point the broker SDK install at its own index.

The script's helper region is run as it is, in real PowerShell processes."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "packaging" / "install_provider_sdk.ps1"
POWERSHELL = shutil.which("powershell") or shutil.which("pwsh")

pytestmark = pytest.mark.skipif(os.name != "nt" or POWERSHELL is None, reason="the installer is a Windows PowerShell script")


def _helpers() -> str:
    text = SCRIPT.read_text(encoding="utf-8-sig")
    start = text.index("# region install helpers")
    return text[start:text.index("# endregion", start)]


def _install(python: str, work: Path, env: dict[str, str]) -> subprocess.CompletedProcess:
    target = work / "target"
    target.mkdir()
    requirements = work / "req.txt"
    requirements.write_text("--no-index\nstockmonitor-no-such-package\n", encoding="utf-8")
    script = work / "probe.ps1"
    script.write_text("﻿$ErrorActionPreference = 'Stop'\n" + _helpers() + "\n"
                      f"Install-ProviderPackages '{python}' '{target}' '{requirements}'\nexit $LASTEXITCODE\n",
                      encoding="utf-8")
    return subprocess.run([POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(script)],
                          capture_output=True, text=True, encoding="utf-8", errors="replace", env=env, timeout=180)


def test_pip_reads_no_configuration_file(tmp_path):
    # A configuration file pip would honour: it names a log file, so loading it leaves that file behind. Handed in
    # through PIP_CONFIG_FILE because the machine-wide file cannot be redirected in a test; pip skips both, and every
    # other file, by the same os.devnull check.
    log = tmp_path / "pip-config-was-read.log"
    config = tmp_path / "pip.ini"
    config.write_text(f"[global]\nlog = {log}\n", encoding="utf-8")
    env = {**os.environ, "PIP_CONFIG_FILE": str(config), "PYTHONNOUSERSITE": "0"}
    result = _install(sys.executable, tmp_path, env)
    assert "stockmonitor-no-such-package" in result.stdout + result.stderr, result.stdout + result.stderr
    assert not log.exists(), "pip loaded a configuration file"


def test_pip_is_given_pypi_and_no_environment_settings(tmp_path):
    # A stand-in python that prints what pip would be started with.
    fake = tmp_path / "python.cmd"
    fake.write_text("@echo off\r\necho PIP_CONFIG_FILE=%PIP_CONFIG_FILE%\r\necho ARGS=%*\r\n", encoding="ascii")
    env = {**os.environ, "PIP_CONFIG_FILE": str(tmp_path / "elsewhere.ini")}
    result = _install(str(fake), tmp_path, env)
    assert result.returncode == 0, result.stderr
    lines = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    assert lines["PIP_CONFIG_FILE"] == os.devnull
    args = lines["ARGS"].split()
    assert args[:3] == ["-m", "pip", "install"]
    assert "--isolated" in args
    assert args[args.index("--index-url") + 1] == "https://pypi.org/simple"
    assert "--extra-index-url" not in args
