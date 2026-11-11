"""Per-desktop-launch client authentication; no credentials in URLs or logs."""
import os

from starlette.responses import JSONResponse

from service.platform.daemon_auth import bearer_matches, token_digest

# Health gives a business API only the SHA-256 of the client token: the API verifies Electron's requests
# but cannot itself present the credential. A process started by hand may still be given the raw token.
CLIENT_TOKEN_SHA256_ENV = "STOCK_MONITOR_CLIENT_TOKEN_SHA256"
CLIENT_TOKEN_ENV = "STOCK_MONITOR_CLIENT_TOKEN"


def client_token_digest() -> str | None:
    granted = str(os.environ.get(CLIENT_TOKEN_SHA256_ENV) or "").strip().lower()
    if granted:
        return granted
    raw = str(os.environ.get(CLIENT_TOKEN_ENV) or "").strip()
    return token_digest(raw) if raw else None

PUBLIC_HTTP_PATHS = frozenset({
    "/api/diagnostics/readiness",
    "/api/diagnostics/heartbeat",
})


class ClientAuthenticationMiddleware:
    def __init__(self, app, token=None):
        self.app = app
        self.digest = client_token_digest() if token is None else (token_digest(token) if token else None)

    async def __call__(self, scope, receive, send):
        kind = scope.get("type")
        path = scope.get("path", "")
        method = scope.get("method", "GET")
        if path.startswith("/api/service/"):
            # Service-management endpoints: authorized by api/service_host.py with Health's credential, never the
            # renderer's client token.
            await self.app(scope, receive, send)
            return
        # Only the two process-liveness probes stay public so Electron can
        # identify a listener before attaching. Every application API route,
        # including ordinary market-data GETs, requires the per-launch token.
        # CORS still permits Origin:null because trusted file:// renderers need
        # it, but null origin is never treated as client identity.
        application_api = path == "/api" or path.startswith("/api/")
        required = kind == "websocket" or (
            kind == "http"
            and method != "OPTIONS"
            and (method not in {"GET", "HEAD"} or (application_api and path not in PUBLIC_HTTP_PATHS))
        )
        if required:
            if not bearer_matches(scope, self.digest):
                if kind == "websocket":
                    await send({"type": "websocket.close", "code": 4401})
                else:
                    await JSONResponse({"ok": False, "error": "APP_AUTH_REQUIRED"}, status_code=401)(scope, receive, send)
                return
        await self.app(scope, receive, send)
