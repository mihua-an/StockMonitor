"""The installed flavor's directory names reach the uninstaller, the SDK installer and the bundled Python only from
config/var_layout.json (scripts/tooling/installed_flavor.py), never from a hand-written copy.

A drifted name in the uninstaller would leave the data behind or delete another flavor's directory.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from scripts.tooling import installed_flavor
from scripts.tooling.stage_python_runtime import SITECUSTOMIZE

ROOT = Path(__file__).resolve().parents[1]


def test_the_generated_files_equal_var_layout():
    assert installed_flavor.stale() == [], "run python scripts/tooling/installed_flavor.py --write"
    layout = json.loads((ROOT / "config" / "var_layout.json").read_text(encoding="utf-8"))["flavors"]["installed"]
    generated = json.loads((ROOT / "packaging" / "installed_flavor.json").read_text(encoding="utf-8"))
    assert generated["user_data_dir"] == layout["user_data_dir"]
    assert generated["auth_root_dir"] == layout["auth_dir"][0]


def test_no_place_writes_the_name_by_hand():
    name = installed_flavor.flavor()["user_data_dir"]
    nsh = (ROOT / "packaging" / "installer.nsh").read_text(encoding="utf-8-sig")
    assert 'installed_flavor.nsh"' in nsh
    assert not [line for line in nsh.splitlines() if "RMDir" in line and name in line], "RMDir names come from the defines"
    assert "${STOCKMONITOR_USER_DATA_DIR}" in nsh and "${STOCKMONITOR_AUTH_ROOT_DIR}" in nsh
    ps1 = (ROOT / "packaging" / "install_provider_sdk.ps1").read_text(encoding="utf-8-sig")
    assert "installed_flavor.json" in ps1 and not re.search(rf'Join-Path \$env:APPDATA "{name}', ps1)
    assert repr(tuple(installed_flavor.provider_sdk_dir())) in SITECUSTOMIZE
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    assert {"from": "packaging/installed_flavor.json", "to": "installed_flavor.json"} in package["build"]["extraResources"]


def test_an_unsafe_name_is_refused(tmp_path, monkeypatch):
    layout = tmp_path / "var_layout.json"
    layout.write_text(json.dumps({"flavors": {"installed": {"user_data_dir": "../x", "auth_dir": ["A", "auth"]}}}),
                      encoding="utf-8")
    monkeypatch.setattr(installed_flavor, "VAR_LAYOUT", layout)
    try:
        installed_flavor.flavor()
    except ValueError as exc:
        assert "unsafe" in str(exc)
    else:
        raise AssertionError("an unsafe directory name was accepted")
