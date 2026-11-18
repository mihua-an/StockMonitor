"""Every child process a Python service starts is created without a console window.

The provider daemons run detached (no console); a console child they started without CREATE_NO_WINDOW got a window of
its own, so every K-bar import flashed one (the analysis_runtime --import-kbars job). Each subprocess call under api/,
backend/ and service/ passes creationflags=NO_CONSOLE (service/platform/child_process.py).
"""
from __future__ import annotations

import ast
import subprocess
from pathlib import Path

from service.platform.child_process import NO_CONSOLE

ROOT = Path(__file__).resolve().parents[1]
SPAWNS = {"run", "Popen", "call", "check_call", "check_output"}


def _spawn_calls():
    for folder in ("api", "backend", "service"):
        for path in sorted((ROOT / folder).rglob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
                    continue
                owner = node.func.value
                if isinstance(owner, ast.Name) and owner.id == "subprocess" and node.func.attr in SPAWNS:
                    yield path.relative_to(ROOT).as_posix(), node


def test_every_service_child_is_created_without_a_console() -> None:
    calls = list(_spawn_calls())
    assert calls, "the scan found the services' subprocess calls"
    missing = [f"{path}:{node.lineno}" for path, node in calls
               if not any(k.arg == "creationflags" and isinstance(k.value, ast.Name) and k.value.id == "NO_CONSOLE"
                          for k in node.keywords)]
    assert missing == [], f"subprocess calls without creationflags=NO_CONSOLE: {missing}"


def test_the_flag_is_create_no_window_on_windows() -> None:
    assert NO_CONSOLE == int(getattr(subprocess, "CREATE_NO_WINDOW", 0))


def test_a_one_shot_job_is_started_without_a_console(monkeypatch, tmp_path) -> None:
    from service.platform import native_binaries

    seen: dict = {}

    def fake_run(command, **kwargs):
        seen.update(kwargs)
        return subprocess.CompletedProcess(command, 0, stdout='{"ok": true}\n', stderr="")

    monkeypatch.setattr(native_binaries.subprocess, "run", fake_run)
    assert native_binaries.run_job(["--import-kbars"], 5, binary=tmp_path / "analysis_runtime.exe") == {"ok": True}
    assert seen["creationflags"] == NO_CONSOLE
