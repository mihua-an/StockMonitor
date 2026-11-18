"""Opening a local Windows named pipe as a client that the pipe's server cannot act as.

A pipe name is first come, first served: while the real server is not running, a process of another Windows user can
create the same name and wait. Two things keep that from mattering here:

- the pipe is opened with ``SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION``, so whoever serves it can learn who
  connected but can never impersonate this process (the default level lets a server holding SeImpersonatePrivilege
  act as the client);
- before anything is written, the server process must run as this process's own Windows user
  (``GetNamedPipeServerProcessId`` -> its token's user SID); any other owner, or a process whose owner cannot be read,
  is refused and the handle closed.

Same-user processes are trusted by the threat model (docs/development/threat_model.md section 1), so the user check is
the whole boundary.
"""
from __future__ import annotations

import ctypes
import msvcrt
import os
from ctypes import wintypes
from typing import BinaryIO

GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
OPEN_EXISTING = 3
SECURITY_SQOS_PRESENT = 0x00100000
SECURITY_IDENTIFICATION = 0x00010000
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
TOKEN_QUERY = 0x0008
TOKEN_USER_CLASS = 1
INVALID_HANDLE_VALUE = wintypes.HANDLE(-1).value

_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
_advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)

_kernel32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD,
                                  wintypes.DWORD, wintypes.HANDLE]
_kernel32.CreateFileW.restype = wintypes.HANDLE
_kernel32.GetNamedPipeServerProcessId.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.ULONG)]
_kernel32.GetNamedPipeServerProcessId.restype = wintypes.BOOL
_kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
_kernel32.OpenProcess.restype = wintypes.HANDLE
_kernel32.GetCurrentProcess.argtypes = []
_kernel32.GetCurrentProcess.restype = wintypes.HANDLE
_kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
_kernel32.CloseHandle.restype = wintypes.BOOL
_advapi32.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
_advapi32.OpenProcessToken.restype = wintypes.BOOL
_advapi32.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD,
                                          ctypes.POINTER(wintypes.DWORD)]
_advapi32.GetTokenInformation.restype = wintypes.BOOL
_advapi32.EqualSid.argtypes = [wintypes.LPVOID, wintypes.LPVOID]
_advapi32.EqualSid.restype = wintypes.BOOL


class PipeServerNotTrusted(PermissionError):
    """The pipe's server process does not run as this Windows user (or its owner could not be read)."""


def _check(ok: object, what: str) -> None:
    if not ok:
        raise ctypes.WinError(ctypes.get_last_error(), what)


def _token_user(process: int) -> ctypes.Array:
    """The TOKEN_USER buffer of `process`'s token. It begins with the PSID of the user, pointing into the same
    buffer, so the buffer must stay alive while that SID is used."""
    token = wintypes.HANDLE()
    _check(_advapi32.OpenProcessToken(process, TOKEN_QUERY, ctypes.byref(token)), "OpenProcessToken")
    try:
        size = wintypes.DWORD(0)
        _advapi32.GetTokenInformation(token, TOKEN_USER_CLASS, None, 0, ctypes.byref(size))
        buffer = ctypes.create_string_buffer(size.value)
        _check(_advapi32.GetTokenInformation(token, TOKEN_USER_CLASS, buffer, size, ctypes.byref(size)),
               "GetTokenInformation")
        return buffer
    finally:
        _kernel32.CloseHandle(token)


def _same_user(user_a: ctypes.Array, user_b: ctypes.Array) -> bool:
    sid_a = ctypes.cast(user_a, ctypes.POINTER(ctypes.c_void_p))[0]
    sid_b = ctypes.cast(user_b, ctypes.POINTER(ctypes.c_void_p))[0]
    return bool(_advapi32.EqualSid(sid_a, sid_b))


def server_user_matches(handle: int) -> bool:
    """Whether the server end of the connected pipe `handle` runs as this process's Windows user."""
    pid = wintypes.ULONG(0)
    _check(_kernel32.GetNamedPipeServerProcessId(handle, ctypes.byref(pid)), "GetNamedPipeServerProcessId")
    server = _kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
    if not server:
        # Another user's process (or one that already exited): its owner cannot be confirmed.
        return False
    try:
        try:
            server_user = _token_user(server)
        except OSError as exc:
            raise PipeServerNotTrusted(f"the pipe server's owner cannot be read (pid {pid.value})") from exc
        return _same_user(_token_user(_kernel32.GetCurrentProcess()), server_user)
    finally:
        _kernel32.CloseHandle(server)


def open_pipe(path: str) -> BinaryIO:
    """`path` opened read/write and unbuffered, once its server is confirmed to be this Windows user."""
    handle = _kernel32.CreateFileW(path, GENERIC_READ | GENERIC_WRITE, 0, None, OPEN_EXISTING,
                                   SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, None)
    if handle in (None, INVALID_HANDLE_VALUE):
        raise ctypes.WinError(ctypes.get_last_error(), f"opening {path}")
    try:
        trusted = server_user_matches(handle)
    except BaseException:
        _kernel32.CloseHandle(handle)
        raise
    if not trusted:
        _kernel32.CloseHandle(handle)
        raise PipeServerNotTrusted(f"{path} is served by a process of another Windows user")
    fd = msvcrt.open_osfhandle(handle, os.O_RDWR | os.O_BINARY)
    return os.fdopen(fd, "r+b", buffering=0)
