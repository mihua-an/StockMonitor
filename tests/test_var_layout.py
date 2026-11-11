"""The var/ runtime layout: one contract (config/var_layout.json), every runtime writer lands under var/, and the repository
root never gets data/, output/, IsolatedData/, StockMonitorTwse/, shioaji.log or .tmp_health. Synthetic project roots only."""
from __future__ import annotations

import json
import os
import re

from service.platform.log_session import SESSION_PATTERN as LOG_SESSION_PATTERN
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
LAYOUT = json.loads((REPO / "config" / "var_layout.json").read_text(encoding="utf-8"))
CHILD_DIRS = {name: spec["dir"] for name, spec in LAYOUT["children"].items()}
PRE_VAR_NAMES = ("data", "output", "IsolatedData", "StockMonitorTwse", "shioaji.log", ".tmp_health", ".tmp_health.txt")


def _clean_env(project: Path) -> dict[str, str]:
    """A process environment with NO layout override (conftest points the whole session at a disposable var/)."""
    # Other tests legitimately leave STOCK_MONITOR_* variables in the pytest process (e.g. STOCK_MONITOR_DAEMON_TOKEN after a token
    # was loaded): a first-start simulation must not inherit any of them.
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("STOCK_MONITOR_", "SJ_"))}
    env.update(STOCK_MONITOR_PROJECT_ROOT=str(project), PYTHONPATH=str(REPO), PYTHONUTF8="1",
               LOCALAPPDATA=str(project.parent / "LocalAppData"))     # AUTH_ROOT default resolves from here, never the real one
    return env


@pytest.fixture()
def project(tmp_path):
    """Stands in for the repository root: only the markers project_root.py needs, plus the real contracts the writers
    read at import (the layout; the session evidence writer's market clocks and trading minutes)."""
    root = tmp_path / "checkout"
    (root / "service").mkdir(parents=True)
    (root / "config").mkdir()
    (root / "main.py").write_text("", encoding="utf-8")
    for name in ("var_layout.json", "market_timezones.json", "trading_sessions.json"):
        shutil.copyfile(REPO / "config" / name, root / "config" / name)
    return root


PRODUCTION_WRITERS = r'''
import json, os
from pathlib import Path
from service.platform import project_root as pr
from service.market.shared import materialization_jobs
from service.market.shared.partition_evidence import default_evidence_root
from service.market.shared.daemon_state import daemon_state_dir
from service.market.shared.dataflow_health import runtime_health_dir
from service.platform.daemon_auth import load_or_create_daemon_token
from service.platform.error_logging import runtime_error_path
from service.platform.log_session import log_session_dir
from service.market.shioaji.log_rotation import configure_shioaji_log_path
from service.market.storage.market_storage_layout import process_market_layout

var = pr.VAR_ROOT
existed_before = var.exists()
token = load_or_create_daemon_token()                                   # <LOCALAPPDATA>/StockMonitorTwse/auth/daemon_auth_token
state = daemon_state_dir()                                              # var/state
health = runtime_health_dir()                                           # var/state/health
job = materialization_jobs.request_materialization(source="shioaji", market="STK", code="2330", trading_date="2026-09-25",
                                                   session="DAY", completeness="complete")
log = configure_shioaji_log_path()                                       # var/logs/shioaji.log (SDK reads SJ_LOG_PATH)
log.write_text("x", encoding="utf-8")
process_market_layout().market_root.mkdir(parents=True, exist_ok=True)
print(json.dumps({
  "existed_before": existed_before,
  "roots": {n: str(getattr(pr, n)) for n in ("VAR_ROOT", "DATA_ROOT", "OUTPUT_ROOT", "STATE_ROOT", "LOG_ROOT", "TEMP_ROOT", "AUTH_ROOT")},
  "token_file": str(pr.AUTH_ROOT / "daemon_auth_token"), "state": str(state), "health": str(health),
  "job": str(materialization_jobs.default_jobs_root() / "pending" / f"{job}.json"),
  "evidence": str(default_evidence_root()), "errors": str(runtime_error_path("SHIOAJI_DAEMON")), "shioaji_log": str(log),
  "log_session_dir": str(log_session_dir()),
  "market_root": str(process_market_layout().market_root),
  "sj_log_path_env": os.environ.get("SJ_LOG_PATH"), "cwd": os.getcwd(),
}))
'''


def _run_writers(project: Path) -> dict:
    result = subprocess.run([sys.executable, "-c", PRODUCTION_WRITERS], cwd=project, env=_clean_env(project),
                            capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout.strip().splitlines()[-1])


# ---- 1-6: the repository root stays clean -------------------------------------------------------------------------
@pytest.mark.parametrize("name", PRE_VAR_NAMES)
def test_running_production_writers_never_creates_pre_var_entries_at_the_root(project, name):
    _run_writers(project)
    assert not (project / name).exists()


# ---- 7-11 + 17: writers land under var/, and a missing var/ is created on first use ------------------------------
def test_first_start_creates_var_and_every_runtime_writer_lands_under_it(project):
    assert not (project / "var").exists()
    out = _run_writers(project)
    assert out["existed_before"] is False                                             # 17: var/ is absent at first start...
    var = project / "var"
    auth = project.parent / "LocalAppData" / "StockMonitorTwse" / "auth"
    assert (auth / "daemon_auth_token").is_file()                                      # ...and created by the first write
    assert not (var / "local_auth").exists() and not list(var.rglob("*auth_token*"))    # no secret ever lands in var/ or the repo
    assert Path(out["roots"]["AUTH_ROOT"]) == auth
    for key, child in (("DATA_ROOT", "data"), ("OUTPUT_ROOT", "output"), ("STATE_ROOT", "state"), ("LOG_ROOT", "logs"), ("TEMP_ROOT", "temp")):
        assert Path(out["roots"][key]) == var / CHILD_DIRS[child]
    assert Path(out["market_root"]) == var / "data" / "market" and (var / "data" / "market").is_dir()      # 7 runtime data
    assert Path(out["job"]).is_file() and Path(out["job"]).is_relative_to(var / "output")                  # 8 output
    assert Path(out["evidence"]) == var / "output" / "session_evidence"
    # Per App run and process, not one shared file every run appends to: var/logs/<startup_timestamp>/error-<source>.log
    errors = Path(out["errors"])
    assert errors.name == "error-shioaji_daemon.log" and errors.parent.parent == var / "logs"
    assert LOG_SESSION_PATTERN.match(errors.parent.name), errors
    assert Path(out["token_file"]) == auth / "daemon_auth_token"                                           # 10 local IPC auth: AUTH_ROOT only
    assert Path(out["state"]) == var / "state" and Path(out["health"]) == var / "state" / "health"       # lock/owner/health: var/state
    # 11 logs: the SDK's own file lands in THIS run's directory, beside error-*.log/api-*.log,
    # not in one shared var/logs/shioaji.log that every run appended to.
    sdk_log = Path(out["shioaji_log"])
    assert sdk_log.name == "shioaji.log" and sdk_log.is_file()
    assert sdk_log.parent == errors.parent, "the SDK log shares this run's directory"
    assert Path(out["sj_log_path_env"]) == sdk_log                                      # SDK writes there, not to cwd


def test_a_single_variable_relocates_every_runtime_location(project, tmp_path):
    elsewhere = tmp_path / "userData" / "var"                                         # what a packaged launch exports
    env = _clean_env(project)
    env[LAYOUT["root_env"]] = str(elsewhere)
    result = subprocess.run([sys.executable, "-c", PRODUCTION_WRITERS], cwd=project, env=env, capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stderr
    out = json.loads(result.stdout.strip().splitlines()[-1])
    auth = str(project.parent / "LocalAppData" / "StockMonitorTwse" / "auth")
    assert all(Path(path).is_relative_to(elsewhere) for key, path in out["roots"].items() if key != "AUTH_ROOT")
    assert out["roots"]["AUTH_ROOT"] == auth                                          # VAR_ROOT relocation never moves the secrets
    assert not (project / "var").exists()                                             # nothing falls back to the install location


def test_the_source_checkout_default_is_project_var_not_the_test_session_directory():
    env = _clean_env(REPO)
    env.pop("STOCK_MONITOR_PROJECT_ROOT")
    code = "from service.platform import project_root as p; print(p.VAR_ROOT); print(p.DATA_ROOT)"
    out = subprocess.run([sys.executable, "-c", code], cwd=REPO, env=env, capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    var, data = out.stdout.split()
    assert Path(var) == REPO / "var" and Path(data) == REPO / "var" / "data"


# ---- 16 (isolation of the test session itself) ----------------------------------------------------------------------
def test_the_test_session_never_points_at_the_real_var_directory():
    assert Path(os.environ[LAYOUT["root_env"]]).resolve() != (REPO / "var").resolve()


# ---- stale-path scan: no production code may still address the pre-var locations -------------------------------------
_SCAN_DIRS = ("api", "backend", "config", "health", "service", "main.py", "scripts", "ui/main", "native/market_runtime/src")
_ALLOWED = {"scripts/diagnostics/check_offline.py"}
_FORBIDDEN = (
    re.compile(r"IsolatedData|StockMonitorTwse|LOCALAPPDATA|\.tmp_health"),
    re.compile(r"""(PROJECT_ROOT|projectRoot|project_root|\bROOT\b)\s*(/|,)\s*['"](data|output)['"]"""),
    re.compile(r"""path\.join\(\s*(runtime\.)?projectRoot\s*,\s*['"](data|output)['"]"""),
)


def _production_files():
    for entry in _SCAN_DIRS:
        base = REPO / entry
        files = [base] if base.is_file() else [p for p in base.rglob("*") if p.is_file()]
        for path in files:
            rel = path.relative_to(REPO).as_posix()
            if path.suffix in {".py", ".js", ".cjs", ".mjs", ".rs"} and "/node_modules/" not in rel and "/target/" not in rel \
                    and "__pycache__" not in rel and rel not in _ALLOWED:
                yield rel, path


def _code_part(line: str, suffix: str) -> str:
    """The line without its comment (a comment may legitimately name the old locations)."""
    marker = "#" if suffix == ".py" else "//"
    if line.lstrip().startswith((marker, "*", "/*")):
        return ""
    return line.split(f" {marker}", 1)[0]


def test_no_production_source_still_addresses_a_pre_var_location():
    offenders = []
    for rel, path in _production_files():
        for number, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            code = _code_part(line, path.suffix)
            for pattern in _FORBIDDEN:
                match = pattern.search(code)
                if match:
                    offenders.append(f"{rel}:{number}: {match.group(0)}")
    assert not offenders, "\n".join(offenders)


def test_the_stale_path_scan_is_not_vacuous():
    samples = ('env.LOCALAPPDATA', 'PROJECT_ROOT / "output" / "x"', "path.join(projectRoot, 'data')")
    assert all(any(p.search(sample) for p in _FORBIDDEN) for sample in samples)
    assert _code_part("x = 1  # StockMonitorTwse", ".py").strip() == "x = 1" and _code_part("// IsolatedData", ".js") == ""


def test_gitignore_ignores_var_as_a_whole_and_no_longer_lists_the_scattered_runtime_names():
    lines = {line.strip() for line in (REPO / ".gitignore").read_text(encoding="utf-8").splitlines()}
    assert "/var/" in lines
    for stale in ("/data/", "/output/", "/IsolatedData/", "StockMonitorTwse/", "/.tmp_health.txt"):
        assert stale not in lines
