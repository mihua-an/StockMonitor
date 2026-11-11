"""Source API admission (AGENTS.md section 3: API path policy lives with the API, not in config).

Which path belongs to which source comes from each source's `api_prefixes` in config/source_settings.json; a disabled
source's routes are refused here, before any handler can allocate that source's services -- except the broker-free
reads an offline acceptance UI is allowed to make.
"""
from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

from starlette.responses import JSONResponse

from config.source_settings import SOURCE_SETTINGS, offline_ui_enabled, source_enabled
from service.market.shared.source_runtime import disabled_source


def request_source(path: str, source: str | None = None) -> str | None:
    parsed = urlsplit(path)
    for name, descriptor in SOURCE_SETTINGS["sources"].items():
        if any(parsed.path.startswith(prefix) for prefix in descriptor["api_prefixes"]):
            return name
    if parsed.path.startswith("/api/product-catalog/"):
        return source or parse_qs(parsed.query).get("source", [None])[0]
    return None



def offline_local_read_allowed(path: str, method: str) -> bool:
    """Allow only broker-free persisted-data reads during UI acceptance."""
    if not offline_ui_enabled():
        return False
    parsed = urlsplit(path)
    verb = str(method or "GET").upper()
    if parsed.path.startswith("/api/history/") and verb == "GET":
        return True
    if parsed.path in {
        "/api/data-center/dates",
        "/api/data-center/date",
        "/api/data-center/closing",
    } and verb == "GET":
        return True
    return False



class SourceAdmissionMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") == "http" and scope.get("method") != "OPTIONS":
            path = scope.get("path", "") + "?" + scope.get("query_string", b"").decode("utf-8")
            source = request_source(path)
            if source and not source_enabled(source) and not offline_local_read_allowed(path, scope.get("method", "GET")):
                return await JSONResponse(disabled_source(source), status_code=409)(scope, receive, send)
        return await self.app(scope, receive, send)
