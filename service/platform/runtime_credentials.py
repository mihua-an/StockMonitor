"""Per-role credentials for the market_runtime listener (docs/system-architecture/00 section 4).

One token per role under AUTH_ROOT/market_runtime/ (first writer wins, any process may read). Health creates all
of them and writes the credential file market_runtime is started with -- that file holds only SHA-256 digests,
never a token. Python only reads: each client reads exactly its own role's token and fails when it is missing.
The renderer only ever receives the viewer token (through Electron main), never a provider/controller one. Node twin: service/platform/js/runtime_credentials.js.
"""
from __future__ import annotations

import os
from pathlib import Path
import logging
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)

ROLES = ("viewer", "provider:shioaji", "provider:futu", "analysis_runtime", "signal_producer", "controller")


def _root() -> Path:
    explicit = str(os.environ.get("STOCK_MONITOR_RUNTIME_CREDENTIAL_DIR") or "").strip()
    if explicit:
        return Path(explicit)
    from service.platform.project_root import AUTH_ROOT

    return Path(AUTH_ROOT) / "market_runtime"


def token_path(role: str) -> Path:
    if role not in ROLES:
        raise ValueError(f"unknown market_runtime role {role!r}")
    return _root() / f"{role.replace(':', '-')}.token"


def read_token(role: str) -> str | None:
    try:
        token = token_path(role).read_text(encoding="ascii").strip()
    except FileNotFoundError:  # not an error: no token file for that role
        return None
    except OSError as exc:
        record_failure(_failure_log, "reading a runtime token", exc)
        return None
    return token if len(token) >= 32 else None


def require_token(role: str) -> str:
    """This role's token, or a clear error. Python clients never create one: a token written here would be one
    market_runtime was not started with (its credential file holds only the digests Health wrote), so every
    connection would be refused as 401 instead of failing loudly. Only Health creates tokens."""
    token = read_token(role)
    if not token:
        raise RuntimeError(f"market_runtime credential for role {role!r} is missing or invalid at {token_path(role)}; "
                           "Health creates it at start -- restart the app instead of creating one here")
    return token
