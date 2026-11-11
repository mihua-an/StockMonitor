"""One-shot B runs from Python (the gap report of the close fill, the partition verifier, training's feature exports
outside Health) use a copy of B named by its content, never the release file a deploy replaces; the copy is named
exactly as Health's (service/platform/js/native_job_binary.js) so both find the same file."""
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from service.platform import native_binaries
from service.platform.native_binaries import analysis_runtime_job_binary, job_binary

REPO = Path(__file__).resolve().parents[1]


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


def test_a_copy_named_by_content_is_made_once_and_a_new_build_gets_its_own(tmp_path):
    release = tmp_path / "release" / "analysis_runtime.exe"
    release.parent.mkdir()
    release.write_bytes(b"build one")
    jobs = tmp_path / "state" / "native_jobs"
    first = job_binary(release, jobs)
    assert first == jobs / f"analysis_runtime-{_digest(b'build one')}.exe"
    assert first.read_bytes() == b"build one"
    assert job_binary(release, jobs) == first
    # The deploy replaces the release file while a job runs the first copy: the next run gets the new build.
    with first.open("rb"):
        release.write_bytes(b"build two, longer")
        second = job_binary(release, jobs)
    assert second != first and second.read_bytes() == b"build two, longer"
    assert first.exists()
    assert not list(jobs.glob("*.tmp"))


def test_a_missing_release_build_is_an_error(tmp_path):
    with pytest.raises(OSError):
        job_binary(tmp_path / "missing.exe", tmp_path / "jobs")


def test_a_job_health_started_uses_the_copy_it_was_handed(tmp_path, monkeypatch):
    handed = tmp_path / "analysis_runtime-0011223344556677.exe"
    monkeypatch.setenv(native_binaries.ANALYSIS_RUNTIME_ENV, str(handed))
    assert analysis_runtime_job_binary() == handed


def test_without_one_it_copies_the_release_build_into_state(tmp_path, monkeypatch):
    release = tmp_path / "rel"
    release.mkdir()
    (release / f"analysis_runtime{native_binaries._EXE}").write_bytes(b"B")
    monkeypatch.delenv(native_binaries.ANALYSIS_RUNTIME_ENV, raising=False)
    monkeypatch.setenv(native_binaries.ANALYSIS_RUNTIME_RELEASE_ENV, str(release))
    monkeypatch.setattr(native_binaries.process_paths, "STATE_ROOT", tmp_path / "state", raising=False)
    copy = analysis_runtime_job_binary()
    assert copy.parent == tmp_path / "state" / native_binaries.JOB_BINARY_DIR
    assert copy.read_bytes() == b"B"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_health_names_the_copy_the_same_way(tmp_path):
    release = tmp_path / "analysis_runtime.exe"
    release.write_bytes(b"same build")
    script = ("const fs=require('fs'),path=require('path');"
              "const {jobBinary}=require(process.argv[1]);"
              "process.stdout.write(JSON.stringify(jobBinary({fs,path,source:process.argv[2],dir:process.argv[3]})));")
    node = subprocess.run(["node", "-e", script, str(REPO / "service" / "platform" / "js" / "native_job_binary.js"),
                           str(release), str(tmp_path / "node_jobs")], capture_output=True, text=True, check=True)
    assert Path(json.loads(node.stdout)).name == job_binary(release, tmp_path / "py_jobs").name


def test_the_partition_verifier_resolves_its_copy_at_each_check(tmp_path, monkeypatch):
    from service.market.history import historical_store

    seen = []

    def resolve():
        seen.append(1)
        return tmp_path / "absent.exe"

    monkeypatch.setattr(historical_store, "analysis_runtime_job_binary", resolve)
    store = historical_store.HistoricalStore(tmp_path / "hist")
    assert store._verify(["a"]) == {} and store._verify(["b"]) == {}
    assert len(seen) == 2, "a deploy between two checks is picked up by the second"
