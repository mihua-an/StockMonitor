"""python -O is refused, and the pre-deletion integrity checks hold without asserts."""
from __future__ import annotations

import ast
import os
import subprocess
import sys
from pathlib import Path

import pytest

from service.platform.interpreter_guard import EXIT_OPTIMIZED

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("flag", ["-O", "-OO"])
def test_service_entry_points_refuse_an_optimized_interpreter(flag):
    code = "from service.platform.interpreter_guard import refuse_optimized_interpreter as r; r('probe')"
    out = subprocess.run([sys.executable, flag, "-c", code], capture_output=True, text=True, cwd=ROOT, timeout=60)
    assert out.returncode == EXIT_OPTIMIZED and "refusing to run under python -O" in out.stderr
    plain = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=ROOT, timeout=60)
    assert plain.returncode == 0


# Every Python process Health starts, exactly as it starts it (health/services/python_service_host.js,
# futu_daemon_host.js, shioaji_daemon_host.js, health/training_job_runner.js) plus the main.py dispatcher.
def _entry_point_commands() -> list[tuple[str, list[str]]]:
    services = ast.literal_eval(next(
        node.value for node in ast.parse((ROOT / "main.py").read_text(encoding="utf-8")).body
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == "SERVICES" for t in node.targets)))
    # --port 1 is never the effective port: an entry point that skipped the guard stops on the port check instead
    # of serving.
    return ([(f"api.services.{sid}", ["-m", f"api.services.{sid}", "--port", "1"]) for sid in services]
            + [(f"main.py {sid}", ["main.py", sid, "--port", "1"]) for sid in services]
            + [("futu daemon", [str(Path("backend") / "futu" / "run_futu_daemon.py")]),
               ("shioaji daemon", [str(Path("backend") / "shioaji" / "run_shioaji_daemon.py")]),
               ("training job", ["-m", "service.analysis.online_training.job", "--mode", "manual", "--job-id", "probe"])])


@pytest.mark.parametrize("flag", ["-O", "-OO"])
@pytest.mark.parametrize("name,args", _entry_point_commands(), ids=[name for name, _ in _entry_point_commands()])
def test_every_python_entry_point_refuses_an_optimized_interpreter(flag, name, args, tmp_path):
    # A probe environment: writable roots and AUTH_ROOT in tmp_path, so an entry point that failed to refuse finds no
    # token, credential or live data to act on.
    env = {key: value for key, value in os.environ.items() if not key.startswith(("STOCK_MONITOR", "PYTHONOPTIMIZE"))}
    env.update(STOCK_MONITOR_VAR_ROOT=str(tmp_path / "var"), STOCK_MONITOR_AUTH_ROOT=str(tmp_path / "auth"),
               LOCALAPPDATA=str(tmp_path / "localappdata"))
    out = subprocess.run([sys.executable, flag, *args], capture_output=True, text=True, cwd=ROOT, timeout=60, env=env)
    assert out.returncode == EXIT_OPTIMIZED, (name, out.returncode, out.stderr[-2000:])
    assert "refusing to run under python -O" in out.stderr, (name, out.stderr[-2000:])
    assert not (tmp_path / "var").exists(), f"{name} wrote runtime data before refusing"
