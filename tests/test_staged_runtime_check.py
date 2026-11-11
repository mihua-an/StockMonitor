"""stage_python_runtime.py --check decides whether a staged runtime is the one the current pins and locks describe:
the bootstrap pins, every bundled lock's digest, each bundled package's version, the provider requirement lists and
the executables. A directory that merely exists (what --reuse-python-runtime and beforePack used to accept) is not."""
from __future__ import annotations

import json
from pathlib import Path

import scripts.tooling.stage_python_runtime as stage


def _staged(tmp_path: Path) -> Path:
    """A synthetic staged runtime built from the current pins and locks."""
    root = tmp_path / "python"
    site = root / "Lib" / "site-packages"
    site.mkdir(parents=True)
    (root / "python.exe").write_bytes(b"")
    for line in stage._locked_requirements():
        name, _, version = line.split()[0].partition("==")
        (site / f"{name.replace('-', '_')}-{version}.dist-info").mkdir()
    provider_sdk = stage.provider_sdk_requirements()
    (root / "provider_sdk").mkdir()
    for provider, lines in provider_sdk.items():
        (root / "provider_sdk" / f"{provider}.txt").write_text(stage._provider_sdk_file_text(provider, lines), encoding="utf-8")
    manifest = {**stage._inputs(stage._target_python_version(), provider_sdk), "executables": stage._executables(root)}
    (root / "STAGED_RUNTIME.json").write_text(json.dumps(manifest), encoding="utf-8")
    return root


def test_a_runtime_staged_from_the_current_inputs_is_current(tmp_path):
    assert stage.check_staged(_staged(tmp_path)) == []


def test_a_missing_manifest_is_not_a_staged_runtime(tmp_path):
    root = _staged(tmp_path)
    (root / "STAGED_RUNTIME.json").unlink()
    assert "missing" in stage.check_staged(root)[0]


def test_a_changed_lock_digest_or_pin_is_stale(tmp_path):
    root = _staged(tmp_path)
    manifest = json.loads((root / "STAGED_RUNTIME.json").read_text(encoding="utf-8"))
    manifest["bundled_locks"]["core.lock"] = "0" * 64
    manifest["pip"]["version"] = "0.0"
    (root / "STAGED_RUNTIME.json").write_text(json.dumps(manifest), encoding="utf-8")
    problems = stage.check_staged(root)
    assert any("bundled_locks" in p for p in problems) and any(p.startswith("STAGED_RUNTIME.json pip") for p in problems)


def test_a_package_of_another_version_is_stale(tmp_path):
    root = _staged(tmp_path)
    site = root / "Lib" / "site-packages"
    first = sorted(site.glob("*.dist-info"))[0]
    first.rename(site / (first.name.rsplit("-", 1)[0] + "-0.0.0.dist-info"))
    assert any("is not what is staged" in p for p in stage.check_staged(root))


def test_a_changed_provider_list_or_an_extra_executable_is_reported(tmp_path):
    root = _staged(tmp_path)
    (root / "provider_sdk" / "futu.txt").write_text("moomoo-api==0.0\n", encoding="utf-8")
    (root / "Scripts").mkdir()
    (root / "Scripts" / "pip.exe").write_bytes(b"")
    problems = stage.check_staged(root)
    assert any("futu.txt" in p for p in problems)
    assert any("executables on disk" in p for p in problems)
    assert any("outside the allowlist" in p for p in problems)
