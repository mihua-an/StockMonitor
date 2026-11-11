"""A provider's market-data generation, reserved on disk before it is used (one implementation for Shioaji and Futu).

Rust's event.ingest fence rejects a lower generation or a non-increasing sequence in the same generation, and resets
sequence watermarks when the generation advances (native/market_runtime/src/state.rs apply/validate). A generation
that restarted at 0/1 with every process would let a restarted daemon report a generation Rust had already seen, and
its low in-memory sequences would be rejected as regressions forever (no trend at all after a restart). So each
process reserves a generation strictly greater than anything an earlier process used, floored at wall-clock seconds,
and every later advance is persisted before it is used.

A generation is published only after its reservation is durable (written, fsynced, renamed into place, the rename's
directory entry synced) -- one that could not be recorded raises GenerationPersistError and the caller fails closed
instead of running on a value a restart could hand out again. Read-advance-write runs under an exclusive lock on a sibling lock file,
so two processes sharing a seed can never reserve the same value.
"""
from __future__ import annotations

import contextlib
import errno
import os
import time
from pathlib import Path
from typing import Iterator

from service.platform.atomic_files import write_bytes_atomic



class GenerationPersistError(RuntimeError):
    """The generation could not be recorded durably; it must not be used."""


@contextlib.contextmanager
def _seed_lock(seed_path: Path) -> Iterator[None]:
    """Exclusive, blocking lock on `<seed>.lock` for one read-advance-write."""
    lock_path = seed_path.with_name(f"{seed_path.name}.lock")
    with open(lock_path, "a+b") as fh:
        fh.seek(0)
        if os.name == "nt":
            import msvcrt
            while True:
                try:
                    msvcrt.locking(fh.fileno(), msvcrt.LK_LOCK, 1)
                    break
                except OSError as exc:
                    # not an error: LK_LOCK gives up after ~10 s of contention (EDEADLOCK); keep waiting for the owner
                    if exc.errno != errno.EDEADLOCK:
                        raise
        else:
            import fcntl
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fh.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def _read_seed(seed_path: Path) -> int:
    try:
        text = seed_path.read_text(encoding="ascii").strip()
    except FileNotFoundError:  # not an error: the first reservation creates the seed
        return 0
    except OSError as exc:
        raise GenerationPersistError(f"cannot read {seed_path.name}: {exc}") from exc
    try:
        return int(text or "0")
    except ValueError as exc:
        raise GenerationPersistError(f"{seed_path.name} is corrupt ({text[:32]!r})") from exc


def _write_seed(seed_path: Path, value: int) -> None:
    try:
        write_bytes_atomic(seed_path, str(int(value)).encode("ascii"), durable=True)
    except OSError as exc:
        raise GenerationPersistError(f"cannot record generation {value} in {seed_path.name}: {exc}") from exc


def advance_generation(seed_path: Path, at_least: int) -> int:
    """The next generation, at least `at_least` and above every one on disk (an attempt that failed after reserving
    still used its value), durable before it is returned."""
    return _reserve(seed_path, lambda recorded: max(recorded + 1, int(at_least)))


def _reserve(seed_path: Path, choose) -> int:
    try:
        seed_path.parent.mkdir(parents=True, exist_ok=True)
        with _seed_lock(seed_path):
            generation = choose(_read_seed(seed_path))
            _write_seed(seed_path, generation)
    except OSError as exc:
        raise GenerationPersistError(f"cannot lock {seed_path.name}: {exc}") from exc
    return generation


def reserve_generation(seed_path: Path) -> int:
    """A new generation for this process: above every one on disk and above the clock, durable before it is returned."""
    return _reserve(seed_path, lambda recorded: max(recorded, int(time.time())) + 1)
