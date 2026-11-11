from __future__ import annotations

import ctypes
import os
from ctypes import wintypes


TH32CS_SNAPPROCESS = 0x00000002
ERROR_NO_MORE_FILES = 18
MAX_PATH = 260


if os.name == "nt":
    class _ProcessEntry32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", wintypes.LONG),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", wintypes.WCHAR * MAX_PATH),
        ]


class ProcessTableUnavailable(OSError):
    """The OS process table could not be read: whether a PID exists is UNKNOWN, never "no" (an empty
    set from a failed enumeration would read as "the owner is gone" and a held singleton could be cleared)."""


def process_ids() -> frozenset[int]:
    """Return one passive OS process-table snapshot.

    Windows uses Toolhelp enumeration instead of opening each target process.
    This avoids ACCESS_DENIED ambiguity for protected or recently exited PIDs
    and never injects work into the observed application.
    """
    if os.name != "nt":
        try:
            return frozenset(int(name) for name in os.listdir("/proc") if name.isdigit())
        except Exception as exc:
            raise ProcessTableUnavailable(f"/proc unreadable: {exc}") from exc

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.argtypes = (wintypes.DWORD, wintypes.DWORD)
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.Process32FirstW.argtypes = (wintypes.HANDLE, ctypes.POINTER(_ProcessEntry32W))
    kernel32.Process32FirstW.restype = wintypes.BOOL
    kernel32.Process32NextW.argtypes = (wintypes.HANDLE, ctypes.POINTER(_ProcessEntry32W))
    kernel32.Process32NextW.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    kernel32.CloseHandle.restype = wintypes.BOOL

    snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    invalid_handle = ctypes.c_void_p(-1).value
    if snapshot in (None, 0, invalid_handle):
        raise ProcessTableUnavailable(f"CreateToolhelp32Snapshot failed ({ctypes.get_last_error()})")
    found: set[int] = set()
    try:
        entry = _ProcessEntry32W()
        entry.dwSize = ctypes.sizeof(_ProcessEntry32W)
        if not kernel32.Process32FirstW(snapshot, ctypes.byref(entry)):
            raise ProcessTableUnavailable(f"Process32FirstW failed ({ctypes.get_last_error()})")
        while True:
            found.add(int(entry.th32ProcessID))
            if not kernel32.Process32NextW(snapshot, ctypes.byref(entry)):
                # The end of the table is ERROR_NO_MORE_FILES; anything else stopped the walk part-way, and a partial
                # table must not be read as "these are all the processes".
                error = ctypes.get_last_error()
                if error != ERROR_NO_MORE_FILES:
                    raise ProcessTableUnavailable(f"Process32NextW failed part-way ({error})")
                break
    finally:
        kernel32.CloseHandle(snapshot)
    return frozenset(found)


def process_exists(pid: int | str | None) -> bool:
    """Whether `pid` is a running process. Raises ProcessTableUnavailable when that cannot be known."""
    try:
        value = int(pid or 0)
    except (TypeError, ValueError):  # not an error: a non-numeric pid is not a running process by contract
        return False
    if value <= 0:
        return False
    if os.name == "nt" or os.path.isdir("/proc"):
        return value in process_ids()
    try:
        os.kill(value, 0)
        return True
    except PermissionError:  # not an error: a process we may not signal exists
        return True
    except OSError:  # not an error: no such process is the answer
        return False


def process_created_epoch_ns(pid: int | str | None) -> int | None:
    """Read-only Windows process generation evidence; unavailable is not death."""
    if os.name != "nt":
        return None
    try:
        value = int(pid or 0)
    except (TypeError, ValueError):  # not an error: a non-numeric pid has no creation time by contract
        return None
    if value <= 0:
        return None
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.GetProcessTimes.argtypes = (wintypes.HANDLE, *([ctypes.POINTER(wintypes.FILETIME)] * 4))
    kernel32.GetProcessTimes.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    handle = kernel32.OpenProcess(0x1000, False, value)  # QUERY_LIMITED_INFORMATION
    if not handle:
        return None
    try:
        times = [wintypes.FILETIME() for _ in range(4)]
        if not kernel32.GetProcessTimes(handle, *(ctypes.byref(t) for t in times)):
            return None
        ticks = (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
        return (ticks - 116444736000000000) * 100
    finally:
        kernel32.CloseHandle(handle)
