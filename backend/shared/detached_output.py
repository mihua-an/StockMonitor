"""A provider daemon started detached by Health writes its stdout/stderr to this run's log directory.

One helper for both daemons (Shioaji, Futu), so both keep the same bound: the log file never grows past
``ROTATE_BYTES``; when a write would take it over, the file becomes a rotated generation (the rule of every log:
``service.platform.atomic_files``) and a new file is started. The daemons are long-running, so a bound checked only at open did not bound a session.
"""
from __future__ import annotations

import io
import os
import sys
import threading
from pathlib import Path

from service.platform.atomic_files import prune_rotated, rotate_log

ROTATE_BYTES = 16 * 1024 * 1024


class BoundedLogFile(io.TextIOBase):
    """A line-buffered UTF-8 text file that rotates itself to a new generation before it would pass ``limit`` bytes."""

    def __init__(self, path: Path, *, limit: int = ROTATE_BYTES) -> None:
        self.path = Path(path)
        self.limit = int(limit)
        self._lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._handle = self._open()
        self._size = self.path.stat().st_size
        self.rotations = 0
        self._rotation_failed = False

    def _open(self):
        return self.path.open("a", encoding="utf-8", buffering=1, errors="backslashreplace")

    @property
    def encoding(self) -> str:
        return "utf-8"

    def writable(self) -> bool:
        return True

    def fileno(self) -> int:
        return self._handle.fileno()

    def write(self, value: str) -> int:
        text = str(value)
        # Bytes as they reach the file: UTF-8, with each newline written as os.linesep (text mode).
        size = len(text.encode("utf-8", errors="backslashreplace")) + text.count("\n") * (len(os.linesep) - 1)
        rotated = False
        with self._lock:
            if self._size and self._size + size > self.limit and not self._rotation_failed:
                rotated = self._rotate()
            self._handle.write(text)
            self._size += size
        # Outside the lock: a generation that cannot be removed is recorded through logging, which writes back here.
        if rotated:
            prune_rotated(self.path)
        return len(text)

    def _rotate(self) -> bool:
        # A rotation that fails is said once, on the file itself (logging would write back into this stream), and not
        # tried again: the bound is lost for this file only, never the daemon's output.
        self._handle.close()
        try:
            rotate_log(self.path)
        except OSError as exc:
            # not an error: recorded on the file itself (the line written below), since logging writes into it
            self._rotation_failed = True
            self._handle = self._open()
            self._handle.write(f"[LOG] rotating {self.path} failed: {type(exc).__name__}: {exc}; "
                               f"this file is no longer bounded\n")
            self._size = self.path.stat().st_size
            return False
        self._handle = self._open()
        self._size = 0
        self.rotations += 1
        return True

    def flush(self) -> None:
        with self._lock:
            if not self._handle.closed:
                self._handle.flush()

    def close(self) -> None:
        with self._lock:
            self._handle.close()
        super().close()


def redirect_detached_output(*, env_flag: str, log_name: str, source: str, label: str,
                             limit: int = ROTATE_BYTES) -> Path | None:
    """When ``env_flag`` is "1" (Health started the daemon detached), stdout and stderr go to this run's
    ``log_name`` (bounded), and their error lines are mirrored to this run's error log. Returns the log path."""
    if str(os.environ.get(env_flag) or "").strip() != "1":
        return None
    from service.platform.error_logging import mirror_process_output
    from service.platform.log_session import log_session_dir

    log_path = log_session_dir() / log_name
    handle = BoundedLogFile(log_path, limit=limit)
    sys.stdout = mirror_process_output(handle, source=source)
    sys.stderr = mirror_process_output(handle, source=source)
    print(f"[{label}] detached log={log_path} (rotates at {limit} bytes)", flush=True)
    return log_path
