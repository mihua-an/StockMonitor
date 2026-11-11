"""Missing declarations cannot silently pass the reproducibility check."""
import importlib.util
from pathlib import Path
import sys

import pytest


@pytest.fixture
def locks(monkeypatch, tmp_path):
    script = Path(__file__).resolve().parents[1] / "scripts/tooling/lock_dependencies.py"
    spec = importlib.util.spec_from_file_location("isolated_dependency_locks", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "DIRECTORY", tmp_path)
    return module


@pytest.mark.parametrize("profile", ["core", "shioaji", "futu", "models", "test"])
def test_missing_requested_profile_fails(locks, monkeypatch, tmp_path, profile):
    # An unrelated declaration must not make the requested missing one optional.
    (tmp_path / "unrelated.in").write_text("", encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["lock_dependencies.py", "--check-profile", profile])
    with pytest.raises(SystemExit, match=f"Missing dependency declaration: {profile}.in"):
        locks.main()


def test_full_lock_refresh_rejects_incomplete_inventory_before_writing(locks, monkeypatch, tmp_path):
    for profile in ("core", "shioaji", "futu", "models"):
        (tmp_path / f"{profile}.in").write_text("", encoding="utf-8")
    original = "existing lock must remain intact\n"
    (tmp_path / "core.lock").write_text(original, encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["lock_dependencies.py", "--write"])
    with pytest.raises(SystemExit, match="Missing dependency declaration: test.in"):
        locks.main()
    assert (tmp_path / "core.lock").read_text(encoding="utf-8") == original
    assert not (tmp_path / "environment-evidence.json").exists()


# -- wheel hashes ------------------------------------------------------------------


def _fake_closure(locks, monkeypatch, versions):
    monkeypatch.setattr(locks, "inputs", lambda path: [])
    monkeypatch.setattr(locks, "closure", lambda requirements: (dict(versions), {}))
    for profile in locks.PROFILES:
        (locks.DIRECTORY / f"{profile}.in").write_text("", encoding="utf-8")


def test_check_rejects_a_lock_whose_pins_have_no_hashes(locks, monkeypatch, tmp_path):
    _fake_closure(locks, monkeypatch, {"fastapi": "1.0"})
    (tmp_path / "core.lock").write_text(locks.HEADER + "fastapi==1.0\n", encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["lock_dependencies.py", "--check-profile", "core"])
    with pytest.raises(SystemExit, match="pins without wheel hashes: fastapi"):
        locks.main()


def test_write_records_hashes_and_check_accepts_them_offline(locks, monkeypatch, tmp_path):
    _fake_closure(locks, monkeypatch, {"fastapi": "1.0"})
    fetched = []
    monkeypatch.setattr(locks, "wheel_hashes", lambda name, version: fetched.append(name) or ["a" * 64])
    monkeypatch.setattr(sys, "argv", ["lock_dependencies.py", "--write"])
    locks.main()
    assert locks.parse_lock((tmp_path / "core.lock").read_text(encoding="utf-8")) == {"fastapi": ("1.0", ["a" * 64])}
    assert fetched == ["fastapi"], "one lookup per pin, shared across profiles"
    monkeypatch.setattr(locks, "wheel_hashes", lambda *a: pytest.fail("--check must not go to the network"))
    monkeypatch.setattr(sys, "argv", ["lock_dependencies.py", "--check"])
    locks.main()


def test_wheel_hashes_keep_only_wheels_this_target_can_install(locks):
    from packaging.tags import sys_tags
    tag = next(iter(sys_tags()))
    release = {"urls": [
        {"packagetype": "bdist_wheel", "filename": f"pkg-1.0-{tag.interpreter}-{tag.abi}-{tag.platform}.whl", "digests": {"sha256": "fit"}},
        {"packagetype": "bdist_wheel", "filename": "pkg-1.0-cp314-cp314-manylinux_2_28_x86_64.whl", "digests": {"sha256": "linux"}},
        {"packagetype": "bdist_wheel", "filename": "pkg-1.0-py3-none-any.whl", "digests": {"sha256": "pure"}, "yanked": True},
        {"packagetype": "sdist", "filename": "pkg-1.0.tar.gz", "digests": {"sha256": "source"}},
    ]}
    assert locks.wheel_hashes("pkg", "1.0", fetch=lambda url: release) == ["fit"]
    sdist_only = {"urls": [release["urls"][3]]}
    with pytest.raises(SystemExit, match="No PyPI wheel of pkg==1.0"):
        locks.wheel_hashes("pkg", "1.0", fetch=lambda url: sdist_only)
    assert locks.wheel_hashes("moomoo-api", "1.0", fetch=lambda url: sdist_only) == ["source"]


def test_every_committed_pin_carries_a_hash(locks):
    directory = Path(__file__).resolve().parents[1] / "requirements"
    for profile in locks.PROFILES:
        entries = locks.parse_lock((directory / f"{profile}.lock").read_text(encoding="utf-8"))
        assert entries and all(hashes for _, hashes in entries.values()), profile


def test_staging_installs_with_require_hashes(monkeypatch, tmp_path):
    script = Path(__file__).resolve().parents[1] / "scripts/tooling/stage_python_runtime.py"
    spec = importlib.util.spec_from_file_location("isolated_stage_runtime", script)
    stage = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(stage)
    monkeypatch.setattr(stage, "STAGE_DIR", tmp_path)
    calls = []
    monkeypatch.setattr(stage, "_run", lambda args, **kwargs: calls.append(args))
    stage._pip_install_locked(tmp_path / "python.exe")
    assert all("--require-hashes" in args for args in calls) and len(calls) == 1
    # No broker SDK is bundled; the user installs them from provider_sdk/<provider>.txt.
    assert not any(line.startswith(("moomoo-api==", "shioaji==")) for line in stage._locked_requirements())

    (tmp_path / "requirements").mkdir()
    for name in stage.RUNTIME_LOCKS:
        (tmp_path / "requirements" / name).write_text("fastapi==1.0\n", encoding="utf-8")
    monkeypatch.setattr(stage, "ROOT", tmp_path)
    with pytest.raises(RuntimeError, match="has no hash"):
        stage._locked_requirements()
