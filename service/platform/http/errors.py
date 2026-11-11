"""Shared HTTP-facing exception hierarchy for the three FastAPI apps.

Route handlers can raise one of the `AppError` subclasses below instead of
hand-rolling a `SafeJSONResponse(status_code=..., ...)` or silently
swallowing an exception to an implicit HTTP 200 (`except Exception as exc:
return {"ok": False, "error": str(exc)}`). Each app calls
`register_error_handlers(app)` (see below) to translate these into the
project's established `{"ok": false, "error": ...}` body shape, now with a
real HTTP status code and a `classification` field for programmatic
handling.

This module intentionally does NOT touch:

- The existing ad hoc `status_code=` / `SafeJSONResponse(status_code=...)`
  call sites in `backend/shioaji/server.py` and its route modules, `backend/futu/server.py`,
  `api/routes/history_routes.py`.
  Those already return correct, deliberate status codes; they are candidates
  to migrate onto this hierarchy later but are left as-is for now.
A failure is never an implicit HTTP 200: routes let the domain's stated errors (ActualAccountError,
TradeInfoError, CredentialError) propagate to the handlers below, which answer with the status the error names, and
an exception nobody raised on purpose is a 500 through `internal_error_response`.
"""
from __future__ import annotations

import logging
import secrets

from fastapi import FastAPI, Request

from service.platform.http.safe_json_response import SafeJSONResponse

logger = logging.getLogger(__name__)


class AppError(Exception):
    """Base class for deliberate, classified HTTP-facing errors.

    Subclasses set class-level `status_code`/`classification` defaults;
    both can be overridden per-instance via the constructor when a call
    site needs something more specific than the subclass default.
    """

    status_code = 500
    classification = "INTERNAL_ERROR"

    def __init__(self, message, *, classification: str | None = None, status_code: int | None = None):
        super().__init__(message)
        if classification is not None:
            self.classification = classification
        if status_code is not None:
            self.status_code = status_code


class ValidationError(AppError):
    """400 — bad client input (malformed/invalid request payload or params)."""

    status_code = 400
    classification = "VALIDATION_ERROR"


class NotFoundError(AppError):
    """404 — the requested resource does not exist."""

    status_code = 404
    classification = "NOT_FOUND"


class ConflictError(AppError):
    """409 — state conflict (e.g. already exists, wrong mode/lifecycle state)."""

    status_code = 409
    classification = "CONFLICT"


class ForbiddenError(AppError):
    """403 — not permitted given the current state/authorization."""

    status_code = 403
    classification = "FORBIDDEN"


class ServiceUnavailableError(AppError):
    """503 — daemon/runtime not ready yet, or shutting down."""

    status_code = 503
    classification = "SERVICE_UNAVAILABLE"


async def _handle_app_error(request: Request, exc: AppError) -> SafeJSONResponse:
    return SafeJSONResponse(
        status_code=exc.status_code,
        content={"ok": False, "error": str(exc), "classification": exc.classification},
    )


def internal_error(context: str, exc: BaseException | None = None, *, log: logging.Logger | None = None) -> dict:
    """The body for an exception this code did not raise on purpose.

    Its text can carry file paths, SQL, a URL, a host and port, an SDK's internals: it goes to the log under a fresh
    error_id, and the caller gets a fixed message with that id. A message this code writes for the user on purpose
    (an AppError, ActualAccountError, CredentialError, a validation ValueError) is not routed through here.
    """
    error_id = secrets.token_hex(6)
    (log or logger).error("%s failed (error_id=%s)", context, error_id, exc_info=exc)
    return {"ok": False, "error": f"內部錯誤（error_id={error_id}），詳細原因已寫入 log",
            "error_id": error_id, "classification": "INTERNAL_ERROR"}


def internal_error_response(context: str, exc: BaseException | None = None, *, log: logging.Logger | None = None,
                            status_code: int = 500, **extra) -> SafeJSONResponse:
    """internal_error() as the HTTP 500 answer it is, with any extra body fields the route keeps."""
    return SafeJSONResponse(status_code=status_code, content={**internal_error(context, exc, log=log), **extra})


CREDENTIAL_STATUS = {"invalid_input": 422, "missing_credential": 404, "write_conflict": 409}


def credential_error_response(exc, **extra) -> SafeJSONResponse:
    """A CredentialError's answer: bad input 422, nothing stored 404, a concurrent writer 409, the OS store failing 500 (logged with an
    error_id, which the answer carries). Never the secret."""
    status = CREDENTIAL_STATUS.get(getattr(exc, "code", ""), 500)
    if status == 500:
        error_id = secrets.token_hex(6)
        logger.error("credential store operation failed (error_id=%s, code=%s)", error_id,
                     getattr(exc, "code", "credential_error"), exc_info=exc)
        extra = {"error_id": error_id, **extra}
    return SafeJSONResponse(status_code=status, content={"ok": False, "error_code": getattr(exc, "code", "credential_error"),
                                                         "error": str(exc), "classification": "CREDENTIAL_ERROR", **extra})


def logged_error(context: str, exc: BaseException | None = None, *, log: logging.Logger | None = None) -> str:
    """internal_error()'s fixed message alone, for a status field (last_error, a shutdown phase) rather than a body."""
    return internal_error(context, exc, log=log)["error"]


async def _handle_unexpected_error(request: Request, exc: Exception) -> SafeJSONResponse:
    return SafeJSONResponse(status_code=500, content=internal_error(f"{request.method} {request.url.path}", exc))


def register_error_handlers(app: FastAPI) -> None:
    """Wire the AppError hierarchy + a logged catch-all onto a FastAPI app instance.

    Call once per app (`api/service_host.py` for every API part, `backend/shioaji/server.py`,
    `backend/futu/server.py`) right after the `FastAPI(...)` construction.
    """
    app.add_exception_handler(AppError, _handle_app_error)
    from service.platform.credential_service import CredentialError
    from service.platform.stated_error import StatedError

    async def _stated_error(request: Request, exc: StatedError) -> SafeJSONResponse:
        # Any domain's own message with the status it names (account ledger, trade input, ...).
        return SafeJSONResponse(status_code=int(exc.status_code),
                                content={"ok": False, "error": str(exc), "classification": exc.classification})

    async def _credential_error(request: Request, exc: CredentialError) -> SafeJSONResponse:
        return credential_error_response(exc)

    app.add_exception_handler(StatedError, _stated_error)
    app.add_exception_handler(CredentialError, _credential_error)
    app.add_exception_handler(Exception, _handle_unexpected_error)
