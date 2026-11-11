"""Bounded process exit for the provider daemons.

A normal interpreter exit waits for every non-daemon thread without limit. A broker SDK thread that never ends
kept a daemon process alive after its server had stopped -- or after uvicorn failed to bind and returned -- with
no port to stop it by (an orphan Futu daemon that never served). The daemons leave through here:
non-daemon threads get a grace period, the atexit handlers run, and then the process ends regardless.
"""
from __future__ import annotations

import atexit
import logging
import os
import sys
import threading
import time
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)


def exit_bounded(code: int, *, grace_seconds: float = 5.0) -> None:
    deadline = time.monotonic() + max(0.0, grace_seconds)
    current = threading.current_thread()
    for thread in threading.enumerate():
        if thread is current or thread.daemon:
            continue
        thread.join(max(0.0, deadline - time.monotonic()))
    lingering = [t.name for t in threading.enumerate() if t is not current and not t.daemon and t.is_alive()]
    if lingering:
        print(f"[EXIT] leaving with non-daemon threads still running: {lingering}", file=sys.stderr, flush=True)
    try:
        atexit._run_exitfuncs()
    except Exception as exc:
        record_failure(_failure_log, "running the exit handlers", exc)
    try:
        logging.shutdown()
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:  # not an error: the process is exiting: logging is already shut down and stdio may be gone
        pass
    os._exit(int(code or 0))
