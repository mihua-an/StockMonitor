"""The installer's build configuration (package.json "build").

- No choice of installation directory: a directory outside Program Files / the user's profile (D:\\ and the like)
  inherits "Authenticated Users: Modify", so another local account could replace the App's code; the install
  directory holds no data, so there is nothing to choose.
- Electron fuses on the shipped exe: no NODE_OPTIONS and no --inspect arguments (another program could otherwise run
  its code inside the App), app.asar integrity checked at start. RunAsNode stays: Health is the App's own exe run with
  ELECTRON_RUN_AS_NODE=1 (ui/main/health_bootstrap.js)."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
BUILD = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["build"]


def test_the_installer_offers_no_installation_directory():
    nsis = BUILD["nsis"]
    assert "allowToChangeInstallationDirectory" not in nsis
    assert nsis["oneClick"] is False  # the assisted installer: just me (profile) or all users (Program Files)


def test_the_shipped_exe_takes_no_node_options_or_inspector_and_checks_its_asar():
    assert BUILD["electronFuses"] == {
        "runAsNode": True,
        "enableNodeOptionsEnvironmentVariable": False,
        "enableNodeCliInspectArguments": False,
        "enableEmbeddedAsarIntegrityValidation": True,
    }
    # Health is started as Node from the App's own exe; turning RunAsNode off would leave the App without Health.
    bootstrap = (ROOT / "ui" / "main" / "health_bootstrap.js").read_text(encoding="utf-8")
    assert 'ELECTRON_RUN_AS_NODE: "1"' in bootstrap
    assert "app.asar.unpacked" in bootstrap and "health/**/*" in BUILD["asarUnpack"]


@pytest.mark.skipif(shutil.which("node") is None or not (ROOT / "node_modules" / "app-builder-lib").is_dir(),
                    reason="needs node and the installed electron-builder")
def test_electron_builder_accepts_the_build_configuration():
    script = (
        "const {validateConfiguration} = require('app-builder-lib/out/util/config/config.js');"
        "const {DebugLogger} = require('builder-util');"
        "validateConfiguration(require('./package.json').build, new DebugLogger(false))"
        ".then(() => console.log('ok'), (e) => { console.error(e.message); process.exit(1); });"
    )
    result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=60)
    assert result.returncode == 0 and result.stdout.strip() == "ok", result.stderr
