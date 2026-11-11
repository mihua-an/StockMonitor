"""One log directory per application run: ``var/logs/<startup_timestamp>/``.

Every writable runtime location is described by ``config/var_layout.json``; this module owns the
one directory *inside* ``LOG_ROOT`` that all of a single App run's log files share, so a run's
API-call / dataflow / error / daemon logs sit together and a later run can never overwrite an
earlier one.

**Who mints the id.** Electron is the App-run boundary, so it generates ``STOCK_MONITOR_LOG_SESSION``
before it spawns Health (``service/platform/js/log_session.js``), and every service Health spawns inherits it
through the environment. A process started without it -- a standalone daemon, a diagnostic script,
a test -- mints its own and exports it to its own children, so a log file always has a home and two
unrelated runs never share one.

The id is a local-time ``YYYYmmdd_HHMMSS`` stamp plus a short random suffix. The stamp is what makes
a directory listing readable; the suffix is what keeps two runs started in the same second apart.
"""
from __future__ import annotations

import os
import re
import secrets
from datetime import datetime
from pathlib import Path

from service.platform import project_root as process_paths

LOG_SESSION_ENV = "STOCK_MONITOR_LOG_SESSION"

# <timestamp>-<suffix>; Health prunes old run directories by the same pattern (service/platform/js/log_session.js).
SESSION_PATTERN = re.compile(r"^\d{8}_\d{6}-[0-9a-f]{6}$")


def new_log_session_id(now: datetime | None = None) -> str:
    stamp = (now or datetime.now()).strftime("%Y%m%d_%H%M%S")
    return f"{stamp}-{secrets.token_hex(3)}"


def log_session_id() -> str:
    """This process's run id, minting and exporting one if the environment has none. A value that is set but not an
    id is refused: minting a new one would split one App run's logs across directories."""
    configured = str(os.environ.get(LOG_SESSION_ENV) or "").strip()
    if configured:
        if not SESSION_PATTERN.match(configured):
            raise ValueError(f"{LOG_SESSION_ENV}={configured!r} is not a run id (YYYYmmdd_HHMMSS-xxxxxx)")
        return configured
    minted = new_log_session_id()
    os.environ[LOG_SESSION_ENV] = minted
    return minted


def log_root() -> Path:
    """The process's LOG_ROOT, read on use (F1)."""
    return Path(process_paths.LOG_ROOT)


def log_session_dir() -> Path:
    directory = log_root() / log_session_id()
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def log_session_path(name: str) -> Path:
    """Path to one log file inside this run's directory (the directory is created)."""
    safe = str(name or "").strip()
    if not safe or "/" in safe or "\\" in safe or safe.startswith("."):
        raise ValueError(f"invalid log file name: {name!r}")
    return log_session_dir() / safe
