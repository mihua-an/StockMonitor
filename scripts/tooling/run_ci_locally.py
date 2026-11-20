"""Run what GitHub CI runs, on this machine, before pushing.

The steps are read from .github/workflows/ci.yml each time, so this follows the workflow as it changes: every
`run:` step runs in order with its own `env:` and `working-directory:`, under Git's bash with the same
`-eo pipefail` GitHub uses. What it changes on purpose:

  - the setup steps (`uses:` actions and the dependency installs named in SETUP_STEPS) are not run as written. The
    Python one is run into a virtual environment of its own (CI_VENV, made from this Python with no site-packages
    of the machine, reused while the locks and this Python are the same), and every step runs with that
    environment's python first on PATH: the tests and the lint (ruff is in requirements/test.lock) see exactly the
    packages CI installs. A package this machine has but the locks do not (httpx, the broker SDKs) is missing
    there as on CI -- checking only the locks' own versions let a test that imported starlette's TestClient (it
    needs httpx) pass here and fail on CI. node_modules is this checkout's own (`npm ci` is what made it);
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
import hashlib
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"
CI_MACHINE = ROOT / "scripts" / "tooling" / "ci_machine.cjs"
PYTHON_SETUP_STEP = "Python dependencies (hash-checked locks)"
SETUP_STEPS = (PYTHON_SETUP_STEP, "Node dependencies")
LOCK_FILE = re.compile(r"-r\s+requirements/([a-z_]+)\.lock\b")
# The Python environment the steps run in: only what the workflow's Python setup step installs (var/ is not in git).
CI_VENV = ROOT / "var" / "ci" / "python"
CI_VENV_KEY = CI_VENV / "ci-locks.sha256"


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


def venv_python(venv: Path = CI_VENV) -> Path:
    return venv / ("Scripts" if os.name == "nt" else "bin") / ("python.exe" if os.name == "nt" else "python")


def locks_key(profiles: list[str]) -> str:
    """What the environment was made from: this Python's version and every lock file's bytes."""
    digest = hashlib.sha256(sys.version.encode("utf-8"))
    for profile in profiles:
        digest.update(profile.encode("utf-8"))
        digest.update((ROOT / "requirements" / f"{profile}.lock").read_bytes())
    return digest.hexdigest()


def prepare_ci_python(profiles: list[str], venv: Path = CI_VENV) -> Path | None:
    """The bin folder of a virtual environment holding exactly the locks CI installs, made the way CI makes it
    (`pip install --require-hashes -r <lock> ...`); None when it could not be made (the output says why)."""
    key = locks_key(profiles)
    marker = venv / CI_VENV_KEY.name
    if venv_python(venv).is_file() and marker.is_file() and marker.read_text(encoding="utf-8").strip() == key:
        print(f"reusing {venv} (same locks)", flush=True)
        return venv_python(venv).parent
    if venv.exists():
        shutil.rmtree(venv)
    if subprocess.run([sys.executable, "-m", "venv", str(venv)]).returncode != 0:
        return None
    install = [str(venv_python(venv)), "-m", "pip", "install", "--disable-pip-version-check", "--require-hashes"]
    for profile in profiles:
        install += ["-r", f"requirements/{profile}.lock"]
    if subprocess.run(install, cwd=ROOT).returncode != 0:
        return None
    marker.write_text(key + "\n", encoding="utf-8")
    return venv_python(venv).parent


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


def step_env(step: Step, python_bin: Path | None = None) -> dict[str, str]:
    """The environment a step runs in: the workflow's, the CI Python environment's python first on PATH, and every
    Electron process given the CI machine."""
    env = {**os.environ, **step.env, "GITHUB_WORKSPACE": ROOT.as_posix(), "CI": "true"}
    if python_bin is not None:
        env["PATH"] = str(python_bin) + os.pathsep + env.get("PATH", "")
        env["VIRTUAL_ENV"] = str(python_bin.parent)
        env.pop("PYTHONHOME", None)
        env.pop("PYTHONPATH", None)
    env["NODE_OPTIONS"] = (env.get("NODE_OPTIONS", "") + f' --require "{CI_MACHINE.as_posix()}"').strip()
    return env


def run_step(step: Step, bash: str, python_bin: Path) -> bool:
    cwd = ROOT / step.working_directory if step.working_directory else ROOT
    return subprocess.run([bash, "--noprofile", "--norc", "-eo", "pipefail", "-c", step.script], cwd=cwd,
                          env=step_env(step, python_bin)).returncode == 0


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
    check_name = f"CI Python environment ({', '.join(f'{p}.lock' for p in profiles)} only)"
    print(f"\n===== {check_name} =====", flush=True)
    started = time.monotonic()
    python_bin = prepare_ci_python(profiles)
    results.append((check_name, python_bin is not None, time.monotonic() - started))
    print(f"----- {check_name}: {'PASS' if results[-1][1] else 'FAIL'}", flush=True)
    planned = len(steps)
    if python_bin is None:
        # The steps would run with this machine's packages, not CI's: their results would say nothing.
        steps = []
    for step in steps:
        print(f"\n===== {step.name} =====", flush=True)
        started = time.monotonic()
        ok = run_step(step, bash, python_bin)
        results.append((step.name, ok, time.monotonic() - started))
        print(f"----- {step.name}: {'PASS' if ok else 'FAIL'} ({results[-1][2]:.0f}s)", flush=True)
        if not ok and args.fail_fast:
            break

    print("\n===== summary =====")
    for name, ok, seconds in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}  ({seconds:.0f}s)")
    not_run = planned + 1 - len(results)
    if not_run:
        print(f"  ({not_run} step(s) not run after --fail-fast)")
    failed = [name for name, ok, _ in results if not ok]
    print(f"{len(results) - len(failed)} passed, {len(failed)} failed" + (" -- same as CI would report" if not failed else ""))
    return 1 if failed or not_run else 0


if __name__ == "__main__":
    sys.exit(main())
