"""Authentication shared by the persistent market daemons and their clients.

Roles. Each is a token file under AUTH_ROOT that Health mints:
  daemon      a client of the provider daemons (the business APIs, Health): every daemon route but /v1/control/stop
  management  Health only: the business APIs' /api/service/* routes and a daemon's /v1/control/stop
A process started by Health (STOCK_MONITOR_MANAGED_BY_HEALTH=1) receives through its environment exactly what its role
needs -- the raw token if it CALLS with that credential, only the SHA-256 if it VERIFIES it -- and never falls back to
reading a token file it was not granted. A process started by hand (a developer run, a test) falls back to the files.
"""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import os
import secrets
from collections.abc import Mapping
from pathlib import Path

from starlette.responses import JSONResponse

from service.platform import project_root
import logging
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)

TOKEN_ENV = "STOCK_MONITOR_DAEMON_TOKEN"
TOKEN_FILE_ENV = "STOCK_MONITOR_DAEMON_TOKEN_FILE"
TOKEN_SHA256_ENV = "STOCK_MONITOR_DAEMON_TOKEN_SHA256"
MANAGEMENT_TOKEN_FILE_ENV = "STOCK_MONITOR_MANAGEMENT_TOKEN_FILE"
MANAGEMENT_SHA256_ENV = "STOCK_MONITOR_MANAGEMENT_TOKEN_SHA256"
MANAGED_ENV = "STOCK_MONITOR_MANAGED_BY_HEALTH"
PUBLIC_PATHS = frozenset({"/health"})
# Daemon routes only Health may call: stopping a provider is a management act, not something a market-data client does.
MANAGEMENT_PATHS = frozenset({"/v1/control/stop"})


class CredentialNotGranted(RuntimeError):
    """This process was started by Health without the credential it tried to use."""


def managed_by_health(env: Mapping[str, str] | None = None) -> bool:
    source = os.environ if env is None else env
    return str(source.get(MANAGED_ENV) or "").strip() == "1"


def token_digest(token: str) -> str:
    return hashlib.sha256(str(token).encode("utf-8")).hexdigest()


def _token_path(file_env: str, name: str) -> Path:
    explicit = str(os.environ.get(file_env) or "").strip()
    if explicit:
        return Path(explicit)
    # Read through the module, not a from-import: AUTH_ROOT is resolved on first access so
    # importing this module never fails on an environment without %LOCALAPPDATA%/home.
    return project_root.AUTH_ROOT / name


def _load_or_create_file_token(path: Path) -> str:
    try:
        value = path.read_text(encoding="ascii").strip()
        if len(value) >= 32:
            return value
    except FileNotFoundError:  # not an error: no token file yet: one is created below
        pass
    # One location only (AUTH_ROOT, or the explicit token-file override): a silent fallback to another directory
    # would fork the token every client reads from.
    path.parent.mkdir(parents=True, exist_ok=True)
    candidate = secrets.token_hex(32)
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="ascii") as handle:
            handle.write(candidate)
    except FileExistsError:  # not an error: another process created the token first: its token is read
        candidate = path.read_text(encoding="ascii").strip()
    try:
        path.chmod(0o600)
    except OSError as exc:
        record_failure(_failure_log, "restricting the daemon token file permissions", exc)
    if len(candidate) < 32:
        raise RuntimeError(f"authentication token at {path} is invalid")
    return candidate


def load_or_create_daemon_token() -> str:
    """The daemon-client credential, for a process that CALLS a provider daemon.

    Never written back into os.environ: an exported token reached every subprocess this one started.
    """
    configured = str(os.environ.get(TOKEN_ENV) or "").strip()
    if configured:
        return configured
    if managed_by_health():
        raise CredentialNotGranted("this process was not granted the daemon credential")
    return _load_or_create_file_token(_token_path(TOKEN_FILE_ENV, "daemon_auth_token"))


def load_or_create_management_token() -> str:
    """Health's credential. Only a process started by hand (a test, a developer tool) reads it from the file here;
    Health itself is Node (service/platform/js/daemon_auth.js) and no process it starts is given the token."""
    if managed_by_health():
        raise CredentialNotGranted("only Health holds the management credential")
    return _load_or_create_file_token(_token_path(MANAGEMENT_TOKEN_FILE_ENV, "management_auth_token"))


def expected_digest(role: str) -> str | None:
    """The SHA-256 a VERIFIER compares against, or None when this process was not granted it (then nothing passes)."""
    env_name, loader = {
        "daemon": (TOKEN_SHA256_ENV, load_or_create_daemon_token),
        "management": (MANAGEMENT_SHA256_ENV, load_or_create_management_token),
    }[role]
    granted = str(os.environ.get(env_name) or "").strip().lower()
    if granted:
        return granted
    # A process granted the token itself (a caller) can verify it too.
    raw = str(os.environ.get(TOKEN_ENV) or "").strip() if role == "daemon" else ""
    if raw:
        return token_digest(raw)
    if managed_by_health():
        return None
    return token_digest(loader())


def bearer_matches(scope, digest: str | None) -> bool:
    """Exactly one Authorization header, "Bearer <token>", whose SHA-256 equals ``digest``."""
    if not digest:
        return False
    credentials = [value for key, value in scope.get("headers", []) if key.lower() == b"authorization"]
    if len(credentials) != 1 or not credentials[0].startswith(b"Bearer "):
        return False
    presented = hashlib.sha256(credentials[0][len(b"Bearer "):]).hexdigest()
    return hmac.compare_digest(presented, digest)


def authorization_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {load_or_create_daemon_token()}"}


def _host_is_direct(scope) -> bool:
    """True when the request's Host is an IP literal or localhost (or absent, as with HTTP/1.0 tools)."""
    raw = next((value for key, value in scope.get("headers", []) if key.lower() == b"host"), b"")
    host = raw.decode("latin-1").strip().lower()
    if not host:
        return True
    if host.startswith("["):
        host = host[1:host.find("]")] if "]" in host else host[1:]
    elif host.count(":") == 1:
        host = host.rsplit(":", 1)[0]
    if host == "localhost":
        return True
    try:
        ipaddress.ip_address(host)
    except ValueError:  # not an error: validator: a host that is not an IP address is answered False
        return False
    return True


class DaemonAuthenticationMiddleware:
    """Require the daemon-client credential on every data route, and Health's management credential on the
    management routes; each route accepts exactly one role."""

    def __init__(self, app, token: str | None = None, management_token: str | None = None):
        self.app = app
        self._digests: dict[str, str | None] = {}
        if token is not None:
            self._digests["daemon"] = token_digest(str(token)) if token else None
        if management_token is not None:
            self._digests["management"] = token_digest(str(management_token)) if management_token else None

    def _digest(self, role: str) -> str | None:
        # Resolved on first use: a daemon that is never asked to stop never reads the management grant.
        if role not in self._digests:
            try:
                self._digests[role] = expected_digest(role)
            except CredentialNotGranted:  # not an error: the role has no management grant: its requests are refused
                self._digests[role] = None
        return self._digests[role]

    async def __call__(self, scope, receive, send):
        kind = scope.get("type")
        if kind in {"http", "websocket"} and not _host_is_direct(scope):
            # DNS rebinding: a web page that re-points its own hostname at 127.0.0.1 reaches the daemon with that
            # hostname in Host. Every legitimate client addresses the daemon by IP literal or "localhost", so any
            # other name is refused -- on /health too, which needs no token and names the watched codes, the
            # connection state and local paths.
            if kind == "websocket":
                await send({"type": "websocket.close", "code": 4403})
            else:
                await JSONResponse({"ok": False, "error": "DAEMON_HOST_REJECTED"}, status_code=421)(scope, receive, send)
            return
        path = str(scope.get("path") or "")
        method = str(scope.get("method") or "GET").upper()
        required = kind == "websocket" or (
            kind == "http" and method != "OPTIONS" and path not in PUBLIC_PATHS
        )
        if required:
            role = "management" if path in MANAGEMENT_PATHS else "daemon"
            if not bearer_matches(scope, self._digest(role)):
                if kind == "websocket":
                    await send({"type": "websocket.close", "code": 4401})
                else:
                    error = "DAEMON_MANAGEMENT_AUTH_REQUIRED" if role == "management" else "DAEMON_AUTH_REQUIRED"
                    await JSONResponse({"ok": False, "error": error}, status_code=401)(scope, receive, send)
                return
        await self.app(scope, receive, send)
