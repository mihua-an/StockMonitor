"""The project's license is declared once and consistently, and the installer ships its notices (O1)."""
import importlib.util
import json
from pathlib import Path
import tomllib

ROOT = Path(__file__).resolve().parents[1]


def test_every_manifest_declares_the_same_license():
    assert "Apache License" in (ROOT / "LICENSE").read_text(encoding="utf-8").splitlines()[1]
    assert "Version 2.0" in (ROOT / "LICENSE").read_text(encoding="utf-8")
    assert json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["license"] == "Apache-2.0"
    for crate in ("market_runtime", "analysis_runtime"):
        manifest = tomllib.loads((ROOT / "native" / crate / "Cargo.toml").read_text(encoding="utf-8"))
        assert manifest["package"]["license"] == "Apache-2.0", crate


def test_installer_ships_the_license_and_notices():
    resources = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["build"]["extraResources"]
    shipped = {entry["from"] for entry in resources}
    assert {"LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"} <= shipped


def test_notices_list_every_bundled_python_package():
    spec = importlib.util.spec_from_file_location("stage_runtime_for_notices", ROOT / "scripts/tooling/stage_python_runtime.py")
    stage = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(stage)
    notices = (ROOT / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")
    for name, line in stage._locked_entries().items():
        version = line.split()[0].partition("==")[2]
        assert f"| {name} | {version} |" in notices, f"{name}=={version} missing; run third_party_notices.py --write"
