"""install_provider_sdk.ps1: one install per provider at a time across processes, and a version folder and active
pointer temporary file of each install's own. Two installs started in the same second used to share v-<time> and
active.txt.tmp, and one's failure cleanup could delete the other's stage.

The script's helper region is run as it is, in real PowerShell processes."""
from __future__ import annotations

import os
import shutil
import subprocess
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


def _run(body: str, cwd: Path) -> subprocess.CompletedProcess:
    script = cwd / "probe.ps1"
    script.write_text("﻿$ErrorActionPreference = 'Stop'\n" + _helpers() + "\n" + body, encoding="utf-8")
    return subprocess.run([POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(script)],
                          capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)


def test_the_script_parses():
    command = ("$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile("
               f"'{SCRIPT}', [ref]$null, [ref]$errors) | Out-Null; $errors.Count")
    result = subprocess.run([POWERSHELL, "-NoProfile", "-Command", command], capture_output=True, text=True, timeout=60)
    assert result.stdout.strip() == "0", result.stdout + result.stderr


def test_a_second_install_of_the_same_provider_is_refused_while_one_holds_the_lock(tmp_path):
    root = tmp_path / "shioaji"
    root.mkdir()
    holder = subprocess.Popen(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-Command",
         f"$s = [System.IO.File]::Open('{root / 'install.lock'}', 'OpenOrCreate', 'ReadWrite', 'None'); "
         "[Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep -Seconds 20; $s.Dispose()"],
        stdout=subprocess.PIPE, text=True)
    try:
        assert holder.stdout.readline().strip() == "held"
        refused = _run(f"Open-ProviderInstallLock '{root}'", tmp_path)
        assert refused.returncode != 0
        assert "install.lock" in refused.stderr
    finally:
        holder.kill()
        holder.wait()
    # Released with the process that held it: the next install takes it.
    taken = _run(f"$l = Open-ProviderInstallLock '{root}'; $l.Dispose(); 'ok'", tmp_path)
    assert taken.returncode == 0 and taken.stdout.strip() == "ok", taken.stderr


def test_every_install_gets_a_version_folder_of_its_own(tmp_path):
    root = tmp_path / "futu"
    root.mkdir()
    result = _run(f"(1..5 | ForEach-Object {{ Split-Path -Leaf (New-ProviderStage '{root}') }}) -join ','", tmp_path)
    assert result.returncode == 0, result.stderr
    names = result.stdout.strip().split(",")
    assert len(set(names)) == 5 and all(name.startswith("v-") for name in names)
    assert sorted(p.name for p in root.iterdir()) == sorted(names)
