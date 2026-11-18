"""Run what GitHub CI runs, on this machine, before pushing.

The steps are read from .github/workflows/ci.yml each time, so this follows the workflow as it changes: every
`run:` step runs in order with its own `env:` and `working-directory:`, under Git's bash with the same
`-eo pipefail` GitHub uses. What it changes on purpose:

  - the setup steps (`uses:` actions and the dependency installs named in SETUP_STEPS) are skipped: this checkout
    already has its Python packages and node_modules, and reinstalling them would change the machine. Instead the
    installed Python packages are checked against the locks CI installs (scripts/tooling/lock_dependencies.py
    --check-profile), so the tests and the lint (ruff is in requirements/test.lock) run with CI's exact versions;
  - every step runs even after one fails (CI stops at the first), so one local run lists every failure at once;
  - every Electron process gets the CI machine (scripts/tooling/ci_machine.cjs through NODE_OPTIONS): reduced motion
    and a 1024x768 screen, as GitHub's runner has. Without it a UI test that depends on this machine's large screen or
    animation setting passes here and fails only on CI.

It refuses to run in the checkout the App runs from (a folder named StockMonitor beside stock_monitor.bat): CI
builds into native/*/target, which there holds the running App's exes (AGENTS.md 0.5). Run it in the public
checkout or a worktree.

Usage:
  python scripts/tooling/run_ci_locally.py              all steps
  python scripts/tooling/run_ci_locally.py --list       the steps it would run
  python scripts/tooling/run_ci_locally.py --only pytest --only "Node contract"   steps whose name contains these
  python scripts/tooling/run_ci_locally.py --fail-fast  stop at the first failing step, like CI

Exit 0 only when every step that ran passed.
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"
CI_MACHINE = ROOT / "scripts" / "tooling" / "ci_machine.cjs"
LOCK_TOOL = ROOT / "scripts" / "tooling" / "lock_dependencies.py"
PYTHON_SETUP_STEP = "Python dependencies (hash-checked locks)"
SETUP_STEPS = (PYTHON_SETUP_STEP, "Node dependencies")
LOCK_FILE = re.compile(r"-r\s+requirements/([a-z_]+)\.lock\b")


@dataclass
class Step:
    name: str
    script: str
    env: dict[str, str] = field(default_factory=dict)
    working_directory: str | None = None


def load_steps(workflow: Path = WORKFLOW) -> tuple[list[Step], list[str]]:
    """The runnable steps of the workflow's jobs, and the names of the steps skipped as setup."""
    data = yaml.safe_load(workflow.read_text(encoding="utf-8"))
    steps: list[Step] = []
    skipped: list[str] = []
    for job in data["jobs"].values():
        for raw in job["steps"]:
            name = raw.get("name") or raw.get("uses") or raw.get("run", "").splitlines()[0]
            if "run" not in raw or name in SETUP_STEPS:
                skipped.append(name)
                continue
            env = {key: str(value) for key, value in (raw.get("env") or {}).items()}
            steps.append(Step(name, raw["run"], env, raw.get("working-directory")))
    return steps, skipped


def installed_lock_profiles(workflow: Path = WORKFLOW) -> list[str]:
    """The requirements/<profile>.lock files the workflow's Python setup step installs."""
    data = yaml.safe_load(workflow.read_text(encoding="utf-8"))
    for job in data["jobs"].values():
        for raw in job["steps"]:
            if raw.get("name") == PYTHON_SETUP_STEP:
                return LOCK_FILE.findall(raw["run"])
    raise SystemExit(f"{workflow} has no step named {PYTHON_SETUP_STEP!r}")


def check_installed_locks(profiles: list[str]) -> bool:
    """This Python has exactly the pins of the locks CI installs (offline: lock_dependencies.py --check-profile)."""
    ok = True
    for profile in profiles:
        result = subprocess.run([sys.executable, str(LOCK_TOOL), "--check-profile", profile])
        ok = ok and result.returncode == 0
    return ok


def find_bash() -> str:
    """Git's bash, the shell GitHub's windows runner uses -- never WSL's System32\\bash.exe."""
    try:
        exec_path = subprocess.run(["git", "--exec-path"], capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as exc:
        raise SystemExit(f"git not runnable ({exc}); Git for Windows provides the bash CI uses") from exc
    git_root = Path(exec_path).parents[2]       # <git>/mingw64/libexec/git-core
    for candidate in (git_root / "bin" / "bash.exe", git_root / "usr" / "bin" / "bash.exe"):
        if candidate.is_file():
            return str(candidate)
    raise SystemExit(f"no bash.exe under {git_root}")


def is_app_checkout(root: Path) -> bool:
    """The distributed layout: the App's own checkout, named StockMonitor, beside the user's launchers."""
    return root.name == "StockMonitor" and (root.parent / "stock_monitor.bat").is_file()


def step_env(step: Step) -> dict[str, str]:
    """The environment a step runs in: the workflow's, and every Electron process given the CI machine."""
    env = {**os.environ, **step.env, "GITHUB_WORKSPACE": ROOT.as_posix(), "CI": "true"}
    env["NODE_OPTIONS"] = (env.get("NODE_OPTIONS", "") + f' --require "{CI_MACHINE.as_posix()}"').strip()
    return env


def run_step(step: Step, bash: str) -> bool:
    cwd = ROOT / step.working_directory if step.working_directory else ROOT
    return subprocess.run([bash, "--noprofile", "--norc", "-eo", "pipefail", "-c", step.script], cwd=cwd,
                          env=step_env(step)).returncode == 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--only", action="append", default=[], help="run only steps whose name contains this")
    parser.add_argument("--list", action="store_true", help="list the steps and exit")
    parser.add_argument("--fail-fast", action="store_true", help="stop at the first failing step, like CI")
    args = parser.parse_args(argv)

    steps, skipped = load_steps()
    if args.only:
        steps = [s for s in steps if any(part.lower() in s.name.lower() for part in args.only)]
    if args.list:
        print("skipped (setup):", ", ".join(skipped))
        for step in steps:
            print(f"  {step.name}" + (f"  [in {step.working_directory}]" if step.working_directory else ""))
        return 0
    if not steps:
        print("no step matches", args.only)
        return 1

    if is_app_checkout(ROOT):
        print(f"{ROOT} is the checkout the App runs from: CI's cargo build would overwrite the running App's exes "
              "in native/*/target. Run this in StockMonitor-public or a worktree.")
        return 2
    bash = find_bash()
    results: list[tuple[str, bool, float]] = []
    profiles = installed_lock_profiles()
    check_name = f"installed Python packages = {', '.join(f'{p}.lock' for p in profiles)}"
    print(f"\n===== {check_name} =====", flush=True)
    started = time.monotonic()
    results.append((check_name, check_installed_locks(profiles), time.monotonic() - started))
    print(f"----- {check_name}: {'PASS' if results[-1][1] else 'FAIL'}", flush=True)
    for step in steps:
        print(f"\n===== {step.name} =====", flush=True)
        started = time.monotonic()
        ok = run_step(step, bash)
        results.append((step.name, ok, time.monotonic() - started))
        print(f"----- {step.name}: {'PASS' if ok else 'FAIL'} ({results[-1][2]:.0f}s)", flush=True)
        if not ok and args.fail_fast:
            break

    print("\n===== summary =====")
    for name, ok, seconds in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}  ({seconds:.0f}s)")
    not_run = len(steps) + 1 - len(results)
    if not_run:
        print(f"  ({not_run} step(s) not run after --fail-fast)")
    failed = [name for name, ok, _ in results if not ok]
    print(f"{len(results) - len(failed)} passed, {len(failed)} failed" + (" -- same as CI would report" if not failed else ""))
    return 1 if failed or not_run else 0


if __name__ == "__main__":
    sys.exit(main())
