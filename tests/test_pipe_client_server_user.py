"""service/platform/pipe_client.py: the remediation pipe client opens at identification level only, and refuses a
server that is not this Windows user (S-1116-06)."""
from __future__ import annotations

import os
import threading
import uuid

import pytest

pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows named pipes")

if os.name == "nt":
    import ctypes
    from ctypes import wintypes

    from service.platform import pipe_client

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    adv = ctypes.WinDLL("advapi32", use_last_error=True)
    k32.CreateNamedPipeW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD,
                                     wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID]
    k32.CreateNamedPipeW.restype = wintypes.HANDLE
    k32.ConnectNamedPipe.argtypes = [wintypes.HANDLE, wintypes.LPVOID]
    k32.ReadFile.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
    k32.WriteFile.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    k32.GetCurrentThread.restype = wintypes.HANDLE
    adv.ImpersonateNamedPipeClient.argtypes = [wintypes.HANDLE]
    adv.OpenThreadToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.BOOL, ctypes.POINTER(wintypes.HANDLE)]
    adv.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD,
                                        ctypes.POINTER(wintypes.DWORD)]

PIPE_ACCESS_DUPLEX = 3
TOKEN_QUERY = 8
TOKEN_IMPERSONATION_LEVEL = 9
SECURITY_IDENTIFICATION = 1


def serve_once(name: str, seen: dict, ready: threading.Event) -> None:
    """One pipe instance: wait for a client, read 4 bytes, note the impersonation level the client allowed, echo back."""
    handle = k32.CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX, 0, 1, 4096, 4096, 0, None)
    ready.set()
    try:
        k32.ConnectNamedPipe(handle, None)
        buffer = ctypes.create_string_buffer(4)
        got = wintypes.DWORD(0)
        k32.ReadFile(handle, buffer, 4, ctypes.byref(got), None)
        seen["read"] = got.value
        if adv.ImpersonateNamedPipeClient(handle):
            token = wintypes.HANDLE()
            if adv.OpenThreadToken(k32.GetCurrentThread(), TOKEN_QUERY, True, ctypes.byref(token)):
                level = ctypes.c_int(-1)
                size = wintypes.DWORD(0)
                adv.GetTokenInformation(token, TOKEN_IMPERSONATION_LEVEL, ctypes.byref(level), ctypes.sizeof(level), ctypes.byref(size))
                seen["level"] = level.value
                k32.CloseHandle(token)
            adv.RevertToSelf()
        wrote = wintypes.DWORD(0)
        k32.WriteFile(handle, buffer, got.value, ctypes.byref(wrote), None)
    finally:
        k32.CloseHandle(handle)


def start_server(seen: dict) -> tuple[str, threading.Thread]:
    name = rf"\\.\pipe\stock-monitor-test-{uuid.uuid4().hex}"
    ready = threading.Event()
    thread = threading.Thread(target=serve_once, args=(name, seen, ready), daemon=True)
    thread.start()
    ready.wait(5)
    return name, thread


def test_a_server_of_this_user_is_reached_and_can_only_identify_the_client():
    seen: dict = {}
    name, thread = start_server(seen)
    with pipe_client.open_pipe(name) as pipe:
        pipe.write(b"ping")
        assert pipe.read(4) == b"ping"
    thread.join(5)
    # Plain open() would allow SecurityImpersonation (2): the server could act as this process.
    assert seen.get("level") == SECURITY_IDENTIFICATION


def test_a_server_of_another_user_is_refused_before_anything_is_written(monkeypatch):
    seen: dict = {}
    name, thread = start_server(seen)
    monkeypatch.setattr(pipe_client, "server_user_matches", lambda handle: False)
    with pytest.raises(pipe_client.PipeServerNotTrusted):
        pipe_client.open_pipe(name)
    thread.join(5)
    assert seen.get("read") == 0


def test_the_remediation_client_opens_health_pipe_through_the_checked_client():
    source = open(os.path.join(os.path.dirname(__file__), "..", "service", "platform", "remediation.py"), encoding="utf-8").read()
    assert "open_pipe(path)" in source and 'open(path, "r+b"' not in source
