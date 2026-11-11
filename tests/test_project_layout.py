"""Relocated entry points, tested without starting Electron or broker services."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
OUTER = ROOT.parent
WINDOWS = pytest.mark.skipif(os.name != "nt", reason="Windows launcher contract")


@pytest.mark.distribution_acceptance
def test_outer_directory_has_only_user_launchers_and_project():
    if not (OUTER / "stock_monitor.bat").is_file():
        pytest.skip("not the distributed layout: a repository checkout has no launchers beside it")
    if ROOT.name == "StockMonitor-public":
        pytest.skip("the user's public GitHub checkout, which sits beside the distributed layout, is not it")
    assert ROOT.name == "StockMonitor"
    visible = {
        path.name for path in OUTER.iterdir()
        if not path.name.startswith(".") and path.suffix.lower() != ".log"
    }
    required = {
        "StockMonitor",
        "stock_monitor.bat",
        "stock_monitor_hidden.vbs",
    }
    # Allowed to be there and allowed to be absent: StockMonitor.zip (a hand-made distribution snapshot),
    # StockMonitor-public (the user's checkout of the public GitHub repository, with its own .git) and
    # acceptance-YYYYMMDD report folders. Everything else is an unexpected stray --
    # the point of this test is that no runtime directory (data/, output/, var/, ...) ever appears beside
    # the project, so assert the required set plus nothing unknown.
    optional = {"StockMonitor.zip", "StockMonitor-public"}
    assert required <= visible, f"missing outer entries: {sorted(required - visible)}"
    unexpected = {name for name in visible - required - optional if not name.startswith("acceptance-")}
    assert not unexpected, f"unexpected outer entries: {sorted(unexpected)}"
    assert (ROOT / "main.py").is_file()
    assert (ROOT / "pytest.ini").is_file()
    for name in ("api", "backend", "config", "health", "native", "service", "tests", "ui"):
        assert (ROOT / name).is_dir()
    assert not (ROOT / "runtime").exists()
    assert not (ROOT / "desktop").exists()


def test_python_modules_resolve_inside_relocated_project():
    for name in ("api", "backend", "config", "service", "main"):
        spec = importlib.util.find_spec(name)
        assert spec is not None
        assert Path(spec.origin).resolve().is_relative_to(ROOT)


def test_direct_backend_entry_sets_cwd_before_api_import(tmp_path):
    outer = tmp_path / "folder with spaces"
    project = outer / "StockMonitor"
    project.mkdir(parents=True)
    shutil.copyfile(ROOT / "main.py", project / "main.py")
    # Exercise the real entry file with a fake server. Its API import writes
    # markers just as real services initialise their var/ runtime locations.
    (project / "api").mkdir()
    (project / "api" / "__init__.py").write_text("")
    (project / "api" / "services").mkdir()
    (project / "api" / "services" / "__init__.py").write_text("")
    (project / "api" / "services" / "realtime_api.py").write_text('''
from pathlib import Path
assert Path.cwd() == Path(__file__).resolve().parents[2]
Path("var/output").mkdir(parents=True)
Path("var/output/entry_marker.txt").write_text(str(Path.cwd()))
def build_app(**kwargs): return object()
''', encoding="utf-8")
    (project / "api" / "service_host.py").write_text('''
def run_service(service_id, build_app, argv):
    assert service_id == "realtime_api" and argv == []
    build_app()
''', encoding="utf-8")
    env = dict(os.environ)
    env.pop("STOCK_MONITOR_STARTUP_TRACE_PATH", None)
    env.pop("STARTUP_TEST_FASTAPI_READY_DELAY_MS", None)
    result = subprocess.run([sys.executable, str(project / "main.py"), "realtime_api"], cwd=outer, env=env, capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    assert (project / "var" / "output" / "entry_marker.txt").read_text() == str(project)
    for stray in ("data", "output", "var", "IsolatedData", "StockMonitorTwse"):
        assert not (outer / stray).exists()


def test_current_launchers_use_project_relative_paths_and_expected_ownership():
    if not (OUTER / "stock_monitor.bat").is_file():
        pytest.skip("not the distributed layout: a repository checkout has no launchers beside it")
    batch = (OUTER / "stock_monitor.bat").read_text(encoding="utf-8")
    hidden = (OUTER / "stock_monitor_hidden.vbs").read_text(encoding="utf-8")
    assert 'set "APPDIR=%PROJECT_ROOT%"' in batch
    assert "npm" not in batch.lower()
    assert 'Launcher = FSO.BuildPath(Root, "stock_monitor.bat")' in hidden

def test_electron_resources_and_native_locations():
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    assert (ROOT / package["main"]).is_file()
    for name in ("ui/main/preload.js", "ui/renderer/index.html", "ui/renderer/trade_window.html", "ui/renderer/watch_pages_window.html", "ui/renderer/detached_view.html"):
        assert (ROOT / name).is_file()
    electron = ROOT / "node_modules" / "electron"
    executable = (electron / "path.txt").read_text().strip()
    assert (electron / "dist" / executable).is_file()
    assert (ROOT / "native" / "market_runtime" / "Cargo.toml").is_file()
