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


def test_the_steps_run_in_an_environment_of_only_the_locks_ci_installs(monkeypatch, tmp_path):
    """A test importing a package this machine has but CI does not (starlette's TestClient needs httpx) passed here
    and failed on CI: the steps now run in a virtual environment made from the locks alone, as CI makes its own."""
    assert runner.installed_lock_profiles() == ["test", "models"]
    calls = []

    class Done:
        returncode = 0

    def run(argv, **kw):
        calls.append(argv)
        if argv[1:3] == ["-m", "venv"]:
            python = runner.venv_python(tmp_path / "venv")
            python.parent.mkdir(parents=True)
            python.write_text("", encoding="utf-8")
        return Done()

    monkeypatch.setattr(runner.subprocess, "run", run)
    venv = tmp_path / "venv"
    python_bin = runner.prepare_ci_python(["test", "models"], venv)
    assert python_bin == runner.venv_python(venv).parent
    assert calls[0][1:] == ["-m", "venv", str(venv)], "no --system-site-packages: nothing of this machine's"
    assert calls[1][:2] == [str(runner.venv_python(venv)), "-m"]
    assert calls[1][-5:] == ["--require-hashes", "-r", "requirements/test.lock", "-r", "requirements/models.lock"]

    calls.clear()
    assert runner.prepare_ci_python(["test", "models"], venv) == python_bin
    assert calls == [], "the same locks reuse the environment"

    steps, _ = runner.load_steps()
    env = runner.step_env(next(step for step in steps if step.name == "pytest"), python_bin)
    assert env["PATH"].split(runner.os.pathsep)[0] == str(python_bin), "the steps' python is the environment's"
    assert "PYTHONPATH" not in env


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
