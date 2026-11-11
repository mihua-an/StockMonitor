"""Where the Rust executables are: the one resolver for the services and the Python tests.

Health passes the B a job runs (STOCK_MONITOR_ANALYSIS_RUNTIME_EXE). A release build elsewhere is named by its release
directory, <CARGO_TARGET_DIR>\\release: STOCK_MONITOR_A_RELEASE (Market Runtime), STOCK_MONITOR_B_RELEASE (analysis
runtime); the running App locks native\\*\\target\\release, so a worktree or test run builds and names its own. Without
either, a dev checkout uses its own release build.

A one-shot B run (``--gap-report``, ``--verify-partitions``, ``--export-features``) goes through
:func:`analysis_runtime_job_binary`: a copy named by its content under <STATE_ROOT>/native_jobs, never the release file
itself, so a deploy can replace the release exe while a job runs (Windows keeps a running .exe locked). The rule and
the names are service/platform/js/native_job_binary.js's (Health's jobs); Health removes copies no job runs at its
start.
"""
from __future__ import annotations

import hashlib
import os
import threading
import uuid
from pathlib import Path

from service.platform import project_root as process_paths

ANALYSIS_RUNTIME_ENV = "STOCK_MONITOR_ANALYSIS_RUNTIME_EXE"
MARKET_RUNTIME_RELEASE_ENV = "STOCK_MONITOR_A_RELEASE"
ANALYSIS_RUNTIME_RELEASE_ENV = "STOCK_MONITOR_B_RELEASE"
JOB_BINARY_DIR = "native_jobs"
DIGEST_CHARS = 16
_EXE = ".exe" if os.name == "nt" else ""

# path -> (size, mtime_ns, digest): the release file is hashed again only when it changed.
_digests: dict[str, tuple[int, int, str]] = {}
_digests_lock = threading.Lock()


def _release_dir(env: str, crate: str) -> Path:
    named = str(os.environ.get(env) or "").strip()
    return Path(named) if named else process_paths.PROJECT_ROOT / "native" / crate / "target" / "release"


def analysis_runtime_binary() -> Path:
    explicit = str(os.environ.get(ANALYSIS_RUNTIME_ENV) or "").strip()
    if explicit:
        return Path(explicit)
    return _release_dir(ANALYSIS_RUNTIME_RELEASE_ENV, "analysis_runtime") / f"analysis_runtime{_EXE}"


def market_runtime_binary() -> Path:
    """Market Runtime (Rust A)'s executable in its release folder (the synthetic end-to-end tests start it)."""
    return _release_dir(MARKET_RUNTIME_RELEASE_ENV, "market_runtime") / f"market_runtime_daemon{_EXE}"


def _content_digest(source: Path) -> str:
    stat = source.stat()
    key = str(source)
    with _digests_lock:
        known = _digests.get(key)
    if known and known[0] == stat.st_size and known[1] == stat.st_mtime_ns:
        return known[2]
    sha = hashlib.sha256()
    with source.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            sha.update(block)
    digest = sha.hexdigest()[:DIGEST_CHARS]
    with _digests_lock:
        _digests[key] = (stat.st_size, stat.st_mtime_ns, digest)
    return digest


def job_binary(source: Path, directory: Path | None = None) -> Path:
    """The job copy of ``source`` (``<stem>-<sha256 16><ext>``), made when absent. Raises when the source is missing or
    the copy cannot be made."""
    source = Path(source)
    directory = Path(directory) if directory else process_paths.STATE_ROOT / JOB_BINARY_DIR
    target = directory / f"{source.stem}-{_content_digest(source)}{source.suffix}"
    if target.is_file():
        return target
    directory.mkdir(parents=True, exist_ok=True)
    staged = target.with_name(f"{target.name}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        with source.open("rb") as src, staged.open("wb") as dst:
            for block in iter(lambda: src.read(1 << 20), b""):
                dst.write(block)
        os.replace(staged, target)
    except OSError:
        # not an error: another process made the same copy first (the content is the same) and that one is used; any
        # other failure is raised to the caller, which records it as its run's failure.
        staged.unlink(missing_ok=True)
        if not target.is_file():
            raise
    return target


def analysis_runtime_job_binary() -> Path:
    """The B a one-shot run uses. A job Health started was handed its copy already (STOCK_MONITOR_ANALYSIS_RUNTIME_EXE
    names it); anything else copies the release build it would otherwise run."""
    explicit = str(os.environ.get(ANALYSIS_RUNTIME_ENV) or "").strip()
    if explicit:
        return Path(explicit)
    return job_binary(analysis_runtime_binary())
