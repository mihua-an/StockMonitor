from __future__ import annotations

from collections.abc import Iterable
import json
import os
import subprocess
from typing import Any

from service.platform.process_observer import ProcessTableUnavailable, process_exists
import logging
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)


def normalized_process_text(value: object) -> str:
    return str(value or "").replace("\\", "/").strip().lower()


def matches_process_patterns(owner: dict[str, Any] | None, patterns: Iterable[str]) -> bool:
    payload = owner or {}
    command = normalized_process_text(payload.get("commandLine") or payload.get("command_line"))
    executable = normalized_process_text(payload.get("executablePath") or payload.get("executable_path") or payload.get("executable"))
    return any(normalized_process_text(pattern) in command or normalized_process_text(pattern) in executable for pattern in patterns)


def classify_owner_metadata(owner: dict[str, Any] | None, *, known_patterns: Iterable[str]) -> str:
    payload = owner or {}
    pid = payload.get("owner_pid") or payload.get("pid")
    if not pid:
        return "STALE_SINGLETON_NO_PROCESS"
    try:
        alive = process_exists(pid)
    except ProcessTableUnavailable:  # not an error: an unreadable process table is answered as the explicit OWNER_UNVERIFIABLE state, which the caller reports
        # Unknown is not stale: the singleton is never cleared on a process table that could not be read.
        return "OWNER_UNVERIFIABLE"
    if not alive:
        return "STALE_SINGLETON_NO_PROCESS"
    return "KNOWN_DAEMON_OWNER" if matches_process_patterns(payload, known_patterns) else "UNKNOWN_PROCESS_OWNER"


def inspect_listening_port_owner(port: int) -> dict[str, Any] | None:
    """Return Windows listener identity without leaking PowerShell into clients."""
    if os.name != "nt":
        return None
    script = (
        f"$c = Get-NetTCPConnection -LocalPort {int(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; "
        "if (-not $c) { exit 0 }; "
        "$p = Get-CimInstance Win32_Process -Filter (\"ProcessId = \" + $c.OwningProcess) -ErrorAction SilentlyContinue; "
        "[pscustomobject]@{ pid=[int]$c.OwningProcess; executablePath=$p.ExecutablePath; commandLine=$p.CommandLine; name=$p.Name } | ConvertTo-Json -Compress"
    )
    try:
        completed = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
            capture_output=True,
            text=True,
            timeout=2.5,
            check=False,
        )
        if completed.returncode != 0:
            stderr = str(completed.stderr or "").strip()[:300]
            record_failure(_failure_log, f"reading the owner of port {int(port)} through PowerShell "
                                         f"(exit {completed.returncode}: {stderr})")
            return None
        raw = str(completed.stdout or "").strip()
        payload = json.loads(raw) if raw else None
        return payload if isinstance(payload, dict) else None
    except Exception as exc:
        record_failure(_failure_log, "reading the process identity through PowerShell", exc)
        return None
