"""Removing a training directory (a staging copy, an old shard or dataset) and saying whether it is gone.

`shutil.rmtree(..., ignore_errors=True)` hid every failure, and prune() listed a directory as removed while it was
still on disk. Here a failure is recorded with its path, and the answer is whether the directory no longer exists.
"""
from __future__ import annotations

import logging
import shutil
from pathlib import Path

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
