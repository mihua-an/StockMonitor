"""Run contracts in a fresh source-only copy. Never start the trading application."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import sys
# A direct `python <this file>` run: every entry script sits two levels below the project root.
_ROOT = str(Path(__file__).resolve().parents[2])
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
from service.platform.project_root import PROJECT_ROOT
import shutil
import subprocess
import sys
import tempfile

ROOT = PROJECT_ROOT
SOURCE_DIRS = ("api", "backend", "config", "health", "native", "packaging",
               "service", "tests", "scripts", "requirements", "ui")
SKIP_DIRS = {"node_modules", "target", "dist", "__pycache__", ".pytest_cache", "load"}
SUFFIXES = {".py", ".js", ".cjs", ".mjs", ".html", ".css", ".json", ".md", ".toml", ".lock", ".rs", ".txt", ".in",
            ".svg", ".png", ".ico", ".woff", ".woff2", ".ps1", ".nsh"}
# Root files the suites read directly. package.json/package-lock.json are build inputs for the
# packaging contracts,
# and .gitignore is asserted by tests/test_var_layout.py.
ROOT_FILES = ("main.py", "pytest.ini", "package.json", "package-lock.json", ".gitignore",
              "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md")
# Directories main() creates empty instead of copying: production state must never be duplicated.
CREATED_DIRS = ("models", "var")
# Deliberately absent from the snapshot. Contracts must resolve against Node builtins and project
# sources only -- an installed dependency tree would hide a real packaging regression.
INVENTORY_EXEMPT = {"node_modules"}
# Per-contract-file network/process allowances handed to scripts/diagnostics/offline_guard.cjs.
# Nothing is granted globally; every other contract still runs fully denied.
CONTRACT_ALLOWANCES = {
    "controller_full_shutdown_contract.cjs": ("loopback",),   # drives its own loopback control HTTP API via fetch
    "health_hosts_monitoring_contract.cjs": ("loopback",),    # drives Health's own loopback control API via fetch
    "health_supervisor_operations_contract.cjs": ("loopback",),  # port precheck binds a loopback socket
    "network_config_parity_contract.cjs": ("subprocess",),    # resolves the same documents through Python
    "network_topology_contract.cjs": ("subprocess",),         # derives the service graph a second time through Python
    "observability_contract_contract.cjs": ("subprocess",),   # runs the Python mirror of the metric rules
    "var_layout_parity_contract.cjs": ("subprocess",),        # resolves var/ paths a second time through Python
}

_PY_IMPORT = re.compile(r"^[ \t]*(?:from|import)[ \t]+([A-Za-z_][A-Za-z0-9_]*)", re.M)
_PY_ROOT_PATH = re.compile(r"\b(?:REPO|ROOT|PROJECT_ROOT|SOURCE_ROOT)\s*/\s*\"([^\"/]+)\"")
_JS_REQUIRE = re.compile(r"require\(\s*[\"'](?:\.\./)+([A-Za-z_][\w.\-]*)")
_JS_ROOT_PATH = re.compile(r"(?:PROJECT_ROOT|projectRoot|repoRoot|ROOT|root)\s*,\s*[\"']([^\"'/]+)[\"']")
_SCANNED_SUFFIXES = {".py", ".js", ".cjs", ".mjs"}


def snapshot_inventory() -> set[str]:
    """Top-level paths the snapshot is declared to provide (or to withhold on purpose)."""
    return set(SOURCE_DIRS) | set(ROOT_FILES) | set(CREATED_DIRS) | set(INVENTORY_EXEMPT)


def required_top_level_paths(source: Path) -> dict[str, list[str]]:
    """Top-level paths of `source` that anything under its tests/ imports, requires or reads.

    Names are classified by existence in `source`, so stdlib and third-party imports drop out.
    """
    required: dict[str, set[str]] = {}
    for path in sorted((source / "tests").rglob("*")):
        if not path.is_file() or path.suffix not in _SCANNED_SUFFIXES or "__pycache__" in path.parts:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        if path.suffix == ".py":
            names = set(_PY_IMPORT.findall(text)) | set(_PY_ROOT_PATH.findall(text))
        else:
            names = set(_JS_REQUIRE.findall(text)) | set(_JS_ROOT_PATH.findall(text))
        for name in names:
            for candidate in (name, f"{name}.py"):
                if (source / candidate).exists():
                    required.setdefault(candidate, set()).add(path.relative_to(source).as_posix())
                    break
    return {name: sorted(sources) for name, sources in sorted(required.items())}


def snapshot_inventory_problems(source: Path, project: Path) -> list[str]:
    """Explicit inventory errors, so a future missing directory never becomes a ModuleNotFoundError."""
    problems = []
    declared = snapshot_inventory()
    for name, users in required_top_level_paths(source).items():
        if name not in declared:
            problems.append(f"{name}: needed by {', '.join(users[:4])} but not declared in "
                            f"SOURCE_DIRS/ROOT_FILES/CREATED_DIRS/INVENTORY_EXEMPT")
    for name in sorted(declared - INVENTORY_EXEMPT):
        if not (source / name).exists():
            continue                                  # declared but gone from the tree: nothing to copy
        target = project / name
        if not target.exists():
            problems.append(f"{name}: declared in the snapshot inventory but missing from {project}")
        elif name in SOURCE_DIRS and not any(target.iterdir()):
            problems.append(f"{name}: copied empty -- no file under it matches SUFFIXES")
    return problems


def copy_sources(source: Path, destination: Path):
    if not source.exists():
        return
    for directory, dirs, files in os.walk(source, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not (Path(directory) / d).is_symlink())
        for name in sorted(files):
            path = Path(directory) / name
            if path.is_symlink() or path.suffix not in SUFFIXES:
                continue
            target = destination / path.relative_to(source)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", choices=("all", "python", "javascript", "load", "browser"), default="all")
    parser.add_argument("--include-launchers", action="store_true", help="Also run Windows batch/WSH integration contracts (requires host permissions)")
    parser.add_argument("--phase3-baseline", action="store_true", help="Use verified pre-refactor renderer sources with today's load/browser harness, only in the new temp copy")
    args = parser.parse_args()
    if args.phase3_baseline and args.only not in ("load", "browser"):
        parser.error("--phase3-baseline is only for load/browser comparisons")
    if args.only in ("load", "browser"):
        SKIP_DIRS.discard("load")
    # mkdtemp, not an arbitrary --basetemp: pytest may delete that directory.
    run = Path(tempfile.mkdtemp(prefix="stockmonitor-check-"))
    outer = run / "workspace"
    project = outer / "StockMonitor"
    project.mkdir(parents=True)
    for name in SOURCE_DIRS:
        copy_sources(ROOT / name, project / name)
    if args.phase3_baseline:
        baseline = ROOT / "var/output/phase3_before"
        manifest = json.loads((baseline / "sha256.json").read_text(encoding="utf-8"))
        for relative, digest in manifest.items():
            if not relative.startswith("ui/renderer/"):
                continue
            source = baseline / relative
            if hashlib.sha256(source.read_bytes()).hexdigest() != digest:
                raise SystemExit(f"Baseline hash mismatch: {relative}")
            shutil.copyfile(source, project / relative)
    # runtime contains production state/binaries: copy code only, never its data.
    for directory in (ROOT / "runtime", ROOT / "runtime" / "launchers"):
        for path in directory.glob("*.py"):
            target = project / path.relative_to(ROOT)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
    for name in ROOT_FILES:
        shutil.copyfile(ROOT / name, project / name)
    for name in ("start_app.bat", "start_app_hidden.vbs", "stock_monitor.bat", "stock_monitor_hidden.vbs"):
        if (ROOT.parent / name).is_file():
            shutil.copyfile(ROOT.parent / name, outer / name)
    (project / "models").mkdir(exist_ok=True)
    for name in ("data", "output", "state", "logs", "temp"):
        (project / "var" / name).mkdir(parents=True, exist_ok=True)
    # sitecustomize also reaches subprocesses whose tests reset PYTHONPATH to ROOT.
    shutil.copyfile(project / "scripts" / "diagnostics" / "offline_guard.py", project / "sitecustomize.py")
    # Pre-flight: an incomplete snapshot must read as an inventory error here, not as a
    # ModuleNotFoundError buried in a subprocess log half an hour later.
    problems = snapshot_inventory_problems(ROOT, project)
    if problems:
        raise SystemExit("Incomplete offline snapshot:\n  " + "\n  ".join(problems))
    env = {k: v for k, v in os.environ.items() if not k.startswith(("STOCK_MONITOR_", "SHIOAJI_", "MOOMOO_", "FUTU_", "STARTUP_TEST_", "PYTEST_"))}
    env.update(PYTHONPATH=str(project), PYTHONDONTWRITEBYTECODE="1", PYTHONUTF8="1",
               PYTEST_DISABLE_PLUGIN_AUTOLOAD="1", STOCK_MONITOR_OFFLINE_CHECK="1",
               STOCK_MONITOR_CHECK_ORIGINAL=str(ROOT), STOCK_MONITOR_CHECK_RUN=str(run),
               TEMP=str(run), TMP=str(run), TMPDIR=str(run))
    env.pop("ELECTRON_RUN_AS_NODE", None)
    env["STOCK_MONITOR_CHECK_BASELINE"] = "1" if args.phase3_baseline else "0"
    commands = []
    if args.only in ("all", "python"):
        commands.append(("dependency-lock", [sys.executable, "scripts/tooling/lock_dependencies.py", "--check-profile", "test"]))
        commands.append(("python", [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider",
            "--basetemp", str(run / "pytest"), "--junitxml", str(run / "python.xml"),
            "-m", "not localhost_integration and not native_acceptance and not distribution_acceptance",
            "--deselect", "tests/test_project_layout.py::test_electron_resources_and_native_locations"]))
        if not args.include_launchers:
            for name in ("test_batch_handles_spaces_cwd_and_npm_exit_code", "test_batch_missing_project_fails_without_launching",
                         "test_batch_blocks_incomplete_relocation", "test_batch_reports_missing_npm", "test_hidden_launcher_runs_real_vbscript_with_spaces"):
                commands[-1][1].extend(["--deselect", f"tests/test_project_layout.py::{name}"])
    if args.only in ("all", "javascript", "load"):
        node = shutil.which("node")
        if not node:
            raise SystemExit("Node.js is required for JavaScript contracts")
        commands.extend((p.name, [node, "--require", str(project / "scripts" / "diagnostics" / "offline_guard.cjs"), str(p)])
                        for p in sorted((project / "tests").glob("*_contract.*")) if p.suffix in {".cjs", ".mjs"})
        if args.only == "load":
            # M8/M9: "offline-recorder-load" (the retired offline recording load)
            # removed -- it load-tested service/market/canonical/'s durable
            # recording throughput specifically, a confirmed duplicate live
            # authority now retired along with that whole tree.
            commands = [("offline-renderer-load", [node, "--require", str(project / "scripts" / "diagnostics" / "offline_guard.cjs"), "tests/load/offline_flow.mjs"])]
    if args.only == "browser":
        electron = ROOT / "node_modules/electron/dist/electron.exe"
        if not electron.is_file():
            raise SystemExit("Isolated browser checks require the existing Electron executable")
        commands = [("offline-browser", [str(electron), str(project / "tests/load/browser_runner.cjs")])]
    # One flat 300s budget for every command could never pass: the Python contract suite is 728
    # collected tests, many of which spawn a fresh interpreter to prove an import allocates no
    # resources, and a cold `import api.server` alone costs tens of seconds on Windows. The suite
    # takes ~20 minutes here, so the python step was killed at 300s and reported FAIL on every run
    # -- a red light that said nothing about the product. A node contract, by contrast, genuinely
    # should never take minutes, so it keeps a tight budget: the point is a budget per command,
    # not a bigger budget everywhere.
    DEFAULT_COMMAND_TIMEOUT = 300
    COMMAND_TIMEOUTS = {"python": 3600, "offline-renderer-load": 900, "offline-browser": 900}
    results = []
    print(f"Isolated check directory: {run}", flush=True)
    for name, command in commands:
        log = run / f"{name}.log"
        timeout_seconds = COMMAND_TIMEOUTS.get(name, DEFAULT_COMMAND_TIMEOUT)
        command_env = env
        allowances = CONTRACT_ALLOWANCES.get(name)
        if allowances:
            command_env = dict(env, STOCK_MONITOR_OFFLINE_ALLOW=",".join(allowances))
            if "subprocess" in allowances:
                # The only interpreter the guard will let a contract re-enter.
                command_env["STOCK_MONITOR_OFFLINE_PYTHON"] = sys.executable
                command_env["PYTHON"] = sys.executable
        try:
            with log.open("w", encoding="utf-8") as output:
                result = subprocess.run(command, cwd=project, env=command_env, stdout=output, stderr=subprocess.STDOUT, timeout=timeout_seconds)
            code = result.returncode
            if name == "offline-browser":
                report = run / "browser-result.json"
                if not report.is_file() or not json.loads(report.read_text(encoding="utf-8")).get("ok"):
                    code = code or 1
        except subprocess.TimeoutExpired:
            code = 124
            print(f"{name}: timed out after {timeout_seconds}s", flush=True)
        results.append({"check": name, "exit_code": code, "log": str(log)})
        print(f"{name}: {'PASS' if code == 0 else 'FAIL'} ({log})", flush=True)
        if code:
            print(log.read_text(encoding="utf-8", errors="replace")[-12000:], flush=True)
    (run / "results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    return int(any(row["exit_code"] for row in results))


if __name__ == "__main__":
    raise SystemExit(main())
