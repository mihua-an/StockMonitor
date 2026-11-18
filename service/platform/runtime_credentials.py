"""Per-role credentials for the market_runtime listener (docs/system-architecture/00 section 4).

One token per role under AUTH_ROOT/market_runtime/. Health creates all of them (and renews every one on a full start)
and writes the credential file market_runtime is started with -- that file holds only SHA-256 digests, never a token.
Python never creates one. A service Health starts (STOCK_MONITOR_MANAGED_BY_HEALTH=1) receives exactly the role tokens
it needs in its environment (grant_env(role)) and never reads a token file: a role it was not granted is
CredentialNotGranted. Only a process started by hand (a developer run, a test) reads its role's file.
The renderer only ever receives the viewer token (through Electron main), never a provider/controller one.
Node twin: service/platform/js/runtime_credentials.js.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
import logging
from service.platform.daemon_auth import CredentialNotGranted, managed_by_health
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)

ROLES = ("viewer", "provider:shioaji", "provider:futu", "analysis_runtime", "signal_producer", "controller")
# The environment variable Health grants a role's token in (the Node twin's grantEnv, the same rule).
GRANT_ENV_PREFIX = "STOCK_MONITOR_RUNTIME_TOKEN_"


def _check(role: str) -> None:
    if role not in ROLES:
        raise ValueError(f"unknown market_runtime role {role!r}")


def grant_env(role: str) -> str:
    _check(role)
    return GRANT_ENV_PREFIX + re.sub(r"[^A-Za-z0-9]", "_", role).upper()


def _root() -> Path:
    explicit = str(os.environ.get("STOCK_MONITOR_RUNTIME_CREDENTIAL_DIR") or "").strip()
    if explicit:
        return Path(explicit)
    from service.platform.project_root import AUTH_ROOT

    return Path(AUTH_ROOT) / "market_runtime"


def token_path(role: str) -> Path:
    _check(role)
    return _root() / f"{role.replace(':', '-')}.token"


def read_token(role: str) -> str | None:
    """The token in this role's file (a process started by hand); None when absent, unreadable or too short."""
    try:
        token = token_path(role).read_text(encoding="ascii").strip()
    except FileNotFoundError:  # not an error: no token file for that role
        return None
    except OSError as exc:
        record_failure(_failure_log, "reading a runtime token", exc)
        return None
    return token if len(token) >= 32 else None


def require_token(role: str) -> str:
    """This role's token, or a clear error. Under Health: the granted value only, CredentialNotGranted without one.
    By hand: the role's file, never a new one -- a token written here would be one market_runtime was not started with
    (its credential file holds only the digests Health wrote), so every connection would be refused as 401 instead of
    failing loudly."""
    _check(role)
    granted = str(os.environ.get(grant_env(role)) or "").strip()
    if granted:
        return granted
    if managed_by_health():
        raise CredentialNotGranted(f"this process was not granted the market_runtime {role!r} credential")
    token = read_token(role)
    if not token:
        raise RuntimeError(f"market_runtime credential for role {role!r} is missing or invalid at {token_path(role)}; "
                           "Health creates it at start -- start the app instead of creating one here")
    return token
