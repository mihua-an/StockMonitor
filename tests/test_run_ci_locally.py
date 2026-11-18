"""The local CI runner runs the workflow's own steps: every `run:` step of ci.yml except the declared setup."""
from __future__ import annotations

from scripts.tooling import run_ci_locally as runner


def test_every_test_and_lint_step_of_the_workflow_is_run():
    steps, skipped = runner.load_steps()
    names = [step.name for step in steps]
    for expected in ("Lint (Python)", "Lint (JavaScript syntax)", "Rust release executables", "pytest",
                     "Node contract tests", "Rust Market Runtime (A)", "Rust Analysis Runtime (B)"):
        assert expected in names
    assert set(runner.SETUP_STEPS) <= set(skipped), "a renamed setup step would be run (and reinstall packages)"
    by_name = {step.name: step for step in steps}
    assert by_name["pytest"].env == {"STOCK_MONITOR_REQUIRE_RELEASE_EXES": "1"}
    assert by_name["Rust Market Runtime (A)"].working_directory == "native/market_runtime"


def test_the_installed_packages_are_checked_against_the_locks_ci_installs(monkeypatch):
    # The skipped setup step installs these locks (ruff included, in test.lock); locally they are checked instead.
    assert runner.installed_lock_profiles() == ["test", "models"]
    calls = []

    class Done:
        def __init__(self, code):
            self.returncode = code

    monkeypatch.setattr(runner.subprocess, "run", lambda argv, **kw: calls.append(argv) or Done(0 if argv[-1] == "test" else 1))
    assert runner.check_installed_locks(["test"]) is True
    assert runner.check_installed_locks(["test", "models"]) is False
    assert calls[0][1:] == [str(runner.LOCK_TOOL), "--check-profile", "test"]


def test_every_step_gets_the_ci_machine():
    steps, _ = runner.load_steps()
    env = runner.step_env(next(step for step in steps if step.name == "Node contract tests"))
    assert f'--require "{runner.CI_MACHINE.as_posix()}"' in env["NODE_OPTIONS"]
    assert runner.CI_MACHINE.is_file()


def test_the_app_checkout_is_refused(tmp_path):
    app = tmp_path / "StockMonitor"
    app.mkdir()
    assert not runner.is_app_checkout(app)
    (tmp_path / "stock_monitor.bat").write_text("", encoding="utf-8")
    assert runner.is_app_checkout(app)
    public = tmp_path / "StockMonitor-public"
    public.mkdir()
    assert not runner.is_app_checkout(public)
