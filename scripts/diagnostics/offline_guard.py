"""Loaded only in the disposable offline check workspace, including child Python."""
import os
import sys
import socket
from pathlib import Path

if os.environ.get("STOCK_MONITOR_OFFLINE_CHECK") == "1":
    original = Path(os.environ["STOCK_MONITOR_CHECK_ORIGINAL"]).resolve()

    def audit(event, args):
        if event in {"socket.connect", "socket.bind", "socket.getaddrinfo"}:
            # Windows asyncio uses CPython's private TCP socketpair for its wakeup
            # pipe. Permit only that exact stdlib frame and its own ephemeral pair.
            frame = sys._getframe(1)
            fallback = getattr(socket, "_fallback_socketpair", None)
            if fallback and frame.f_code is fallback.__code__:
                values = frame.f_locals
                expected = (values.get("host"), 0) if event == "socket.bind" else (values.get("addr"), values.get("port"))
                if event in {"socket.bind", "socket.connect"} and args[1] == expected:
                    return
            raise RuntimeError(f"Offline check forbids network: {event}")
        path_events = {"open", "sqlite3.connect", "os.mkdir", "os.remove", "os.rmdir", "os.scandir", "os.rename", "shutil.copyfile"}
        if event in path_events:
            for value in args[:2] if event in {"os.rename", "shutil.copyfile"} else args[:1]:
                if isinstance(value, (str, bytes, os.PathLike)):
                    path = Path(os.fsdecode(value)).resolve()
                    if path.is_relative_to(original):
                        raise RuntimeError(f"Offline check forbids original project access: {path}")

    class NoLiveSDK:
        def find_spec(self, fullname, path=None, target=None):
            if fullname.split(".")[0] in {"shioaji", "moomoo", "futu", "keyring"}:
                raise ModuleNotFoundError(f"Offline check forbids live SDK/native/credential backend: {fullname}")

    sys.addaudithook(audit)
    sys.meta_path.insert(0, NoLiveSDK())
