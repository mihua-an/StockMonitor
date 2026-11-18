"""Training directories written whole or not at all, and removed with a record when they cannot be.

A shard, a dataset and a registered model are each written into a staging directory beside their place
(``<name>.tmp-<pid>``) and renamed into it when complete (``published_dir``); the samples file of a dataset being
built is ``.samples-<pid>-<hex>.parquet.tmp``. The pid in both names is how the next job tells the staging of a job
that ended mid-write from a live one (``discard_dead_staging``).

`shutil.rmtree(..., ignore_errors=True)` hid every failure, and prune() listed a directory as removed while it was
still on disk. Here a failure is recorded with its path, and the answer is whether the directory no longer exists.
"""
from __future__ import annotations

import logging
import os
import shutil
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Iterable, Iterator

from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)


def remove_tree(path: Path, what: str) -> bool:
    """Remove `path` (absent is fine). True when it is gone; a failure is recorded and answered False."""
    path = Path(path)
    try:
        shutil.rmtree(path)
    except FileNotFoundError:
        return True                     # absent is not an error: nothing to remove
    except OSError as exc:
        record_failure(_failure_log, f"removing {what} {path}", exc)
    if path.exists():
        return False
    return True


STAGING_MARK = ".tmp-"


def staging_dir(target: Path) -> Path:
    """Where `target` is written by this process before it is published."""
    target = Path(target)
    return target.with_name(f"{target.name}{STAGING_MARK}{os.getpid()}")


def samples_staging_file(directory: Path) -> Path:
    """A dataset's samples file while this process writes it."""
    return Path(directory) / f".samples-{os.getpid()}-{uuid.uuid4().hex[:8]}.parquet.tmp"


def is_staging(path: Path) -> bool:
    return staging_owner(path) is not None


def staging_owner(path: Path) -> int | None:
    """The pid of the process writing a staging name (``staging_dir`` or ``samples_staging_file``); None for any
    other name."""
    name = Path(path).name
    if name.startswith(".samples-") and name.endswith(".parquet.tmp"):
        owner = name.split("-")[1]
    elif STAGING_MARK in name:
        owner = name.rsplit(STAGING_MARK, 1)[-1]
    else:
        return None
    return int(owner) if owner.isdigit() else None


@contextmanager
def published_dir(target: Path, what: str) -> Iterator[Path]:
    """A fresh staging directory for `target`, renamed to `target` once the block completes; removed either way (a
    failed block leaves nothing). `what` names it in failure records."""
    staging = staging_dir(target)
    remove_tree(staging, f"a leftover {what} staging directory")   # one that stays makes mkdir below fail
    staging.mkdir(parents=True)
    try:
        yield staging
        os.replace(staging, target)
    finally:
        remove_tree(staging, f"a {what} staging directory")


def discard_dead_staging(paths: Iterable[Path]) -> list[str]:
    """Remove the staging among `paths` left by a job that ended mid-write (stopped by force, crashed): a staging name
    whose process is gone. This process's own and a live writer's (another job still running) are kept. Returns what
    was removed."""
    from service.platform.process_observer import ProcessTableUnavailable, process_exists

    removed = []
    for path in paths:
        owner = staging_owner(path)
        if owner is None or owner == os.getpid():
            continue   # not an error: not a staging name, or this job's own
        try:
            if process_exists(owner):
                continue   # not an error: its writer is still running
        except ProcessTableUnavailable as exc:
            record_failure(_failure_log, "listing processes before removing training staging", exc)
            return removed
        if path.is_dir():
            gone = remove_tree(path, "the staging of an ended training job")
        else:
            try:
                path.unlink()
                gone = True
            except FileNotFoundError:   # not an error: already gone
                gone = True
            except OSError as exc:
                record_failure(_failure_log, f"removing the staging of an ended training job {path}", exc)
                gone = False
        if gone:
            removed.append(str(path))
    return removed
