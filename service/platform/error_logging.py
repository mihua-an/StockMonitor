from __future__ import annotations

import atexit
import io
import os
import re
import threading
from datetime import datetime
from pathlib import Path
from typing import TextIO

from service.platform.log_session import log_session_path
from service.platform.atomic_files import append_line, rotate_if_larger


# A log record's LEVEL decides, not the words in its message. Every record starts with a header
# that names its level, in one of the two formats this process family emits:
#   service/platform/logging_setup.py  "<asctime> <LEVEL> <logger>: <message>"
#   uvicorn                  "LEVEL:    <message>"
# Lines without a header are the continuation of the record above them (a traceback, a multi-line
# message), so an error record is mirrored whole and ends at the next header, whatever its level.
_RECORD_HEADER = re.compile(
    r"^(?:\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,\d{3} (?P<level>[A-Z]+) \S+:|(?P<uvicorn>DEBUG|INFO|WARNING|ERROR|CRITICAL):\s)")
_ERROR_LEVELS = frozenset({"ERROR", "CRITICAL", "FATAL"})

# Output with no record header at all: a bare traceback, or a native/stderr line from a non-logging
# writer. Deliberately narrow.
#
# A broad word match (\berror\b, \bfailed\b, \btimeout\b, unavailable, disconnected, ...) on every line
# regardless of level would make the "error log" a copy of ordinary DEBUG/INFO traffic: one measured run mirrored
# 18013 identical `websockets.client: < TEXT '{"error":"unknown command"...}'` DEBUG frames and reached 8.3 MB
# with a 29 MB rotated sibling while containing no actual error.
_BARE_TRACEBACK = re.compile(r"^traceback \(most recent call last\)", re.IGNORECASE)
_BARE_ERROR = re.compile(r"\[shutdown\]\[timeout\]")
_lock = threading.RLock()


def error_log_name(source: str) -> str:
    """The error log file of one process: ``error-<source>.log`` (``SHIOAJI_DAEMON`` -> ``error-shioaji_daemon.log``)."""
    tag = re.sub(r"[^a-z0-9_]+", "_", str(source).strip().lower()).strip("_")
    if not tag:
        raise ValueError(f"an error log needs its process's source name, got {source!r}")
    return f"error-{tag}.log"


def runtime_error_path(source: str, output_root: str | Path | None = None) -> Path:
    """This run's error log of one process: ``var/logs/<startup_timestamp>/error-<source>.log``.

    A single shared log that every run appended to would mix weeks of sessions, bounded only by a size-based
    rotation. Each App run gets its own directory (service/platform/log_session.py), which is what makes "no run
    overwrites or buries the previous one" true rather than a matter of rotation timing. Within a run each process
    has its own file (Electron main writes ``error-electron.log``): one writer appends to and rotates a file, so no
    process's rotation moves a file another is appending to, and each file's size bound is its writer's own.

    ``output_root`` forces an explicit directory for callers that own their own location
    (tests, a synthetic project tree).
    """
    name = error_log_name(source)
    if output_root is not None:
        return Path(output_root) / name
    return log_session_path(name)


ROTATE_BYTES_ENV = "STOCK_MONITOR_ERROR_LOG_ROTATE_BYTES"
DEFAULT_ROTATE_BYTES = 16 * 1024 * 1024
MIN_ROTATE_BYTES = 1024 * 1024


def rotate_bytes_from_env(env=os.environ) -> int:
    """The error log's rotation size: STOCK_MONITOR_ERROR_LOG_ROTATE_BYTES when set (an integer of at least 1 MiB),
    else 16 MiB. A value that is not one is refused, not replaced by the default."""
    raw = str(env.get(ROTATE_BYTES_ENV) or "").strip()
    if not raw:
        return DEFAULT_ROTATE_BYTES
    try:
        value = int(raw)
    except ValueError:
        raise ValueError(f"{ROTATE_BYTES_ENV}={raw!r} is not an integer byte count") from None
    if value < MIN_ROTATE_BYTES:
        raise ValueError(f"{ROTATE_BYTES_ENV}={value} is below the minimum {MIN_ROTATE_BYTES}")
    return value


def append_runtime_error(path: Path, source: str, line: str, *, rotate_bytes: int = DEFAULT_ROTATE_BYTES) -> None:
    text = str(line or "").rstrip("\r\n")
    if not text:
        return
    with _lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        rotate_if_larger(path, rotate_bytes)
        stamp = datetime.now().astimezone().isoformat(timespec="milliseconds")
        append_line(path, f"[{stamp}] [{source}] {text}")


class ErrorOnlyMirror(io.TextIOBase):
    """Keep the daemon's normal local log while mirroring only errors to output."""

    def __init__(self, primary: TextIO, *, error_path: Path, source: str, rotate_bytes: int = DEFAULT_ROTATE_BYTES) -> None:
        self._primary = primary
        self._error_path = error_path
        self._source = source
        self._rotate_bytes = int(rotate_bytes)
        self._pending = ""
        # "record": inside an error record (until the next header); "traceback": inside a bare
        # traceback (until its first unindented line after the frames, the exception line); None.
        self._continuing: str | None = None

    @property
    def encoding(self) -> str:
        return str(getattr(self._primary, "encoding", None) or "utf-8")

    def writable(self) -> bool:
        return True

    def isatty(self) -> bool:
        return bool(getattr(self._primary, "isatty", lambda: False)())

    def fileno(self) -> int:
        return int(self._primary.fileno())

    def write(self, value: str) -> int:
        text = str(value)
        written = self._primary.write(text)
        self._pending += text
        while "\n" in self._pending:
            line, self._pending = self._pending.split("\n", 1)
            self._consume(line)
        return len(text) if written is None else int(written)

    def _consume(self, line: str) -> None:
        if self._is_error_line(line):
            append_runtime_error(self._error_path, self._source, line, rotate_bytes=self._rotate_bytes)

    def _is_error_line(self, line: str) -> bool:
        header = _RECORD_HEADER.match(line)
        if header:
            is_error = (header.group("level") or header.group("uvicorn")) in _ERROR_LEVELS
            self._continuing = "record" if is_error else None
            return is_error
        if self._continuing == "record":
            return True
        if self._continuing == "traceback":
            if not line[:1].isspace():
                # The exception line closes a bare traceback.
                self._continuing = None
            return True
        if _BARE_TRACEBACK.match(line):
            self._continuing = "traceback"
            return True
        return bool(_BARE_ERROR.search(line))

    def flush(self) -> None:
        self._primary.flush()

    def finalize(self) -> None:
        """Consume a last line that ended without a newline (a flush never does: more of that line may follow)."""
        pending, self._pending = self._pending, ""
        if pending:
            self._consume(pending)
        self._primary.flush()


def mirror_process_output(primary: TextIO, *, source: str, output_root: str | Path | None = None) -> ErrorOnlyMirror:
    rotate_bytes = rotate_bytes_from_env()
    path = runtime_error_path(source, output_root)
    rotate_if_larger(path, rotate_bytes)
    mirror = ErrorOnlyMirror(primary, error_path=path, source=source, rotate_bytes=rotate_bytes)
    # At process exit the last output may lack its newline; it is still an error line when it is one.
    atexit.register(mirror.finalize)
    return mirror
