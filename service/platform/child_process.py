"""The flag every child process a Python service starts is created with.

Health starts the provider daemons detached, so they have no console; a console program they start (a one-shot
analysis_runtime job, PowerShell, git) would get a console window of its own on Windows, shown for as long as it runs
-- every K-bar import flashed one. CREATE_NO_WINDOW runs the child without a console window; elsewhere it is 0.
tests/test_child_process_no_console.py checks every subprocess call under api/, backend/ and service/ passes it.
"""
from __future__ import annotations

import subprocess

NO_CONSOLE: int = int(getattr(subprocess, "CREATE_NO_WINDOW", 0))
