"""A shard, a dataset and a registered model are written the same way (online_training/cleanup.py published_dir): a
staging directory named with its writer's pid beside the target, renamed into place when complete. The pid is what
lets the next job remove what an ended job left (discard_dead_staging), the model registry's included."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

from service.analysis.online_training import cleanup
from service.analysis.online_training.cleanup import published_dir, staging_dir, staging_owner


def _dead_pid() -> int:
    process = subprocess.Popen([sys.executable, "-c", "pass"])
    process.wait()
    return process.pid


def test_a_block_that_completes_is_published_and_one_that_fails_leaves_nothing(tmp_path: Path):
    target = tmp_path / "ods-1"
    with published_dir(target, "dataset") as staging:
        assert staging == staging_dir(target) and staging_owner(staging) == os.getpid()
        (staging / "manifest.json").write_text("{}", encoding="utf-8")
    assert (target / "manifest.json").is_file()
    with pytest.raises(RuntimeError):
        with published_dir(tmp_path / "ods-2", "dataset") as staging:
            raise RuntimeError("export failed")
    assert sorted(path.name for path in tmp_path.iterdir()) == ["ods-1"]


def test_every_staging_name_carries_its_writer():
    assert staging_owner(Path("abc.tmp-123")) == 123
    assert staging_owner(Path(".samples-456-1234abcd.parquet.tmp")) == 456
    assert staging_owner(cleanup.samples_staging_file(Path("."))) == os.getpid()
    assert staging_owner(Path("abc")) is None and staging_owner(Path("abc.tmp-x")) is None


def test_registering_a_model_removes_what_an_ended_registration_left(tmp_path: Path, monkeypatch):
    from service.analysis.online_training import registry as registry_module

    dead = _dead_pid()
    left = tmp_path / "models" / f"m1{cleanup.STAGING_MARK}{dead}"
    left.mkdir(parents=True)
    (left / "model.onnx").write_bytes(b"half")
    registry = registry_module.OnlineModelRegistry(tmp_path)
    monkeypatch.setattr(registry_module, "validate_model_manifest", lambda manifest, authority: [])
    monkeypatch.setattr(registry_module, "load_horizon_authority", lambda: None)
    directory = registry.register("m1", artifact=b"onnx", manifest={"artifact": {}}, run={})
    assert (directory / registry_module.MODEL_FILE).read_bytes() == b"onnx"
    assert not left.exists()
