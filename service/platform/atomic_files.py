"""The one atomic JSON write and the one size rotation for Python services.

Five modules each had their own temp-file + os.replace JSON writer (one fsynced, one retried Windows sharing
violations, the others neither) and three logs each had their own rotation. They differ only in options now.
`config/config_revisions.py` keeps its own writer: config/ does not import from service/ (AGENTS.md section 2).
"""
from __future__ import annotations

import itertools
import json
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any
import logging
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)


def write_json_atomic(path: Path, payload: Any, *, durable: bool = False, indent: int | None = None,
                      sort_keys: bool = False, compact: bool = False, ensure_ascii: bool = False) -> None:
    """Replace `path` with `payload` as JSON in one step: readers see the old file or the new one, never a part
    (``write_bytes_atomic``)."""
    separators = (",", ":") if compact else None
    data = json.dumps(payload, ensure_ascii=ensure_ascii, indent=indent, sort_keys=sort_keys,
                      separators=separators).encode("utf-8")
    write_bytes_atomic(path, data, durable=durable)


def write_bytes_atomic(path: Path, data: bytes, *, durable: bool = False) -> None:
    """Replace `path` with `data` in one step: readers see the old file or the new one, never a part.

    `durable` fsyncs the data before the replace and the directory after it (state that must survive a power loss).
    The replace never waits for readers (`replace_file`) as long as every reader opens with delete sharing
    (`read_bytes_shared`); a sharing violation means a reader that does not, so it is raised at once for the caller
    to record, not retried. The temporary file is removed whatever happens."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        with open(temporary, "wb") as handle:
            handle.write(data)
            if durable:
                handle.flush()
                os.fsync(handle.fileno())
        replace_file(temporary, path)
        if durable:
            fsync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


_FILE_RENAME_INFO_EX = 22             # FILE_INFO_BY_HANDLE_CLASS.FileRenameInfoEx
_RENAME_REPLACE_POSIX = 0x1 | 0x2      # FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS
# FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE: a reader or a log rotation may rename the file while it is open
_SHARE_ALL = 0x1 | 0x2 | 0x4


def _open_handle(path: Path, access: int):
    import ctypes

    kernel32 = _kernel32
    handle = kernel32.CreateFileW(str(Path(path).absolute()), access, _SHARE_ALL, None, 3, 0, None)  # OPEN_EXISTING
    if handle is None or handle == ctypes.c_void_p(-1).value:
        error = ctypes.get_last_error()
        raise OSError(None, ctypes.FormatError(error), str(path), error)
    return kernel32, handle


def replace_file(source: Path, destination: Path) -> None:
    """`os.replace` that does not fail while someone reads the destination. Windows' MoveFileEx refuses to replace a
    file any process has open (WinError 5), and the daemon owner record is polled by the API and Health while the
    daemon rewrites it; a POSIX-semantics rename swaps the name and leaves open readers on the old file. Readers must
    open with delete sharing for that: Node's fs does, Python's open() does not (`read_bytes_shared`)."""
    if os.name != "nt":
        os.replace(source, destination)
        return
    import ctypes
    from ctypes import wintypes

    name = str(Path(destination).absolute()).encode("utf-16-le")

    class _RenameInfo(ctypes.Structure):
        _fields_ = [("Flags", wintypes.DWORD), ("RootDirectory", wintypes.HANDLE), ("FileNameLength", wintypes.DWORD),
                    ("FileName", ctypes.c_byte * (len(name) + 2))]

    kernel32, handle = _open_handle(source, 0x00010000)   # DELETE access is what a rename needs
    try:
        info = _RenameInfo(Flags=_RENAME_REPLACE_POSIX, RootDirectory=None, FileNameLength=len(name))
        ctypes.memmove(info.FileName, name, len(name))
        if not kernel32.SetFileInformationByHandle(handle, _FILE_RENAME_INFO_EX, ctypes.byref(info),
                                                   ctypes.sizeof(info)):
            error = ctypes.get_last_error()
            raise OSError(None, ctypes.FormatError(error), str(destination), error)
    finally:
        kernel32.CloseHandle(handle)


def read_bytes_shared(path: Path) -> bytes:
    """The file's bytes, opened so a concurrent `replace_file` of it goes through (delete sharing on Windows)."""
    if os.name != "nt":
        return Path(path).read_bytes()
    import msvcrt

    kernel32, handle = _open_handle(path, 0x80000000)    # GENERIC_READ
    try:
        descriptor = msvcrt.open_osfhandle(handle, os.O_RDONLY)
    except BaseException:
        kernel32.CloseHandle(handle)
        raise
    with os.fdopen(descriptor, "rb") as stream:
        return stream.read()


def read_text_shared(path: Path, encoding: str = "utf-8") -> str:
    """`read_bytes_shared` decoded; line endings kept as written (what csv's newline="" reading expects)."""
    return read_bytes_shared(path).decode(encoding)


def fsync_directory(folder: Path) -> None:
    """Make a rename inside `folder` durable. Windows cannot open a directory for fsync (os.open raises
    PermissionError) and NTFS journals the rename's metadata itself, so there it is nothing to do; elsewhere a
    failure raises for the caller to record."""
    if os.name == "nt":
        return
    fd = os.open(str(folder), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


if os.name == "nt":
    import ctypes
    from ctypes import wintypes

    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _kernel32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD,
                                      wintypes.DWORD, wintypes.HANDLE]
    _kernel32.CreateFileW.restype = wintypes.HANDLE
    _kernel32.WriteFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
                                    ctypes.c_void_p]
    _kernel32.WriteFile.restype = wintypes.BOOL
    _kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    _kernel32.SetFileInformationByHandle.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    _FILE_APPEND_DATA = 0x0004
    _OPEN_ALWAYS = 4
    _INVALID_HANDLE = wintypes.HANDLE(-1).value

    def _append_bytes(path: Path, data: bytes) -> None:
        # FILE_APPEND_DATA without FILE_WRITE_DATA: every WriteFile goes to the end of the file as one step, so lines
        # from several processes never overwrite each other (the CRT's "a" mode is a seek, then a write).
        handle = _kernel32.CreateFileW(str(path), _FILE_APPEND_DATA, _SHARE_ALL, None, _OPEN_ALWAYS, 0x80, None)
        if handle in (None, _INVALID_HANDLE):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            written = wintypes.DWORD(0)
            if not _kernel32.WriteFile(handle, data, len(data), ctypes.byref(written), None):
                raise ctypes.WinError(ctypes.get_last_error())
            if written.value != len(data):
                raise OSError(f"short append to {path}: {written.value} of {len(data)} bytes")
        finally:
            _kernel32.CloseHandle(handle)
else:
    def _append_bytes(path: Path, data: bytes) -> None:
        # O_APPEND: the kernel moves to the end and writes in one step.
        fd = os.open(str(path), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
        try:
            written = os.write(fd, data)
            if written != len(data):
                raise OSError(f"short append to {path}: {written} of {len(data)} bytes")
        finally:
            os.close(fd)


def append_line(path: Path, line: str) -> None:
    """Append one line (`line` without its newline) to a log several processes write, as one atomic append (Electron
    main's appends are too: Node opens "a" files with FILE_APPEND_DATA on Windows).

    A sharing violation (a process that opened the log without sharing it) is retried briefly, then raised for the
    caller to record."""
    data = (line + "\n").encode("utf-8", errors="backslashreplace")
    last_error: OSError | None = None
    for attempt in range(5):
        try:
            _append_bytes(Path(path), data)
            return
        except PermissionError as exc:
            last_error = exc
            time.sleep(0.005 * (attempt + 1))
    raise last_error


# Rotated generations kept next to a log; older ones are removed.
ROTATED_GENERATIONS = 3


_rotation_sequence = itertools.count()


def rotated_name(path: Path) -> Path:
    """`<path>.<UTC time>-<sequence>-<pid>-<random>`: unique, so a rotation never replaces another one, and sortable
    by time. The millisecond stamp alone ties for rotations in the same millisecond, so the process's rotation
    sequence orders those (each log has one writing process). The same rule as service/platform/js/atomic_files.js
    rotatedName."""
    now = time.time()
    stamp = time.strftime("%Y%m%dT%H%M%S", time.gmtime(now)) + f"{int(now * 1000) % 1000:03d}"
    return path.with_name(f"{path.name}.{stamp}-{next(_rotation_sequence):010d}-{os.getpid()}-{uuid.uuid4().hex[:6]}")


def _is_generation(path: Path, candidate: Path) -> bool:
    suffix = candidate.name[len(path.name) + 1:]
    return len(suffix) > 18 and suffix[:8].isdigit() and suffix[8] == "T"


def rotate_log(path: Path) -> None:
    """Rename `path` to a new rotated generation; raises OSError for the caller."""
    Path(path).rename(rotated_name(Path(path)))


def prune_rotated(path: Path, *, keep: int = ROTATED_GENERATIONS) -> None:
    """Remove all but the newest `keep` rotated generations of `path`. Never raises: what cannot be removed is recorded
    and goes at the next rotation."""
    path = Path(path)
    generations = sorted(p for p in path.parent.glob(f"{path.name}.*") if _is_generation(path, p))
    for old in generations[:-keep] if keep > 0 else generations:
        try:
            old.unlink(missing_ok=True)
        except OSError as exc:
            record_failure(_failure_log, f"removing an old rotated log {old.name}", exc)


def rotate_if_larger(path: Path, max_bytes: int, *, keep: int = ROTATED_GENERATIONS) -> None:
    """Move `path` to a new rotated generation once it is larger than `max_bytes`, then keep the newest `keep`.

    Each run's log has one writing process (error-<source>.log, dataflow-<component>.log); a rotation renames to a
    unique name and never deletes or replaces the file it renames, so no generation is ever overwritten. Never
    raises: a rotation that cannot happen now happens at a later append."""
    path = Path(path)
    try:
        if not path.exists() or path.stat().st_size <= max_bytes:
            return
        rotate_log(path)
    except FileNotFoundError:  # not an error: the log went between the check and the rename (its run directory was removed)
        return
    except OSError as exc:
        record_failure(_failure_log, "rotating a log file (retried at the next append)", exc)
        return
    prune_rotated(path, keep=keep)
