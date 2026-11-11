from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from fastapi import APIRouter

from api.models import ShioajiCredentialsRequest
from service.platform.credential_service import CredentialError
from service.platform.http.errors import credential_error_response


@dataclass(frozen=True)
class SettingsRouteDependencies:
    credentials: Any
    shioaji_app: Callable[[], Any | None]


def create_settings_router(deps: SettingsRouteDependencies) -> APIRouter:
    router = APIRouter()

    def reconnect_if_running() -> dict[str, Any]:
        # The credential change is saved either way; a reconnect that failed must say so. It was swallowed, so
        # deleting the credentials looked done while the old broker session kept running.
        app = deps.shioaji_app()
        if app is None:
            return {}
        try:
            result = app.broker_service.reconnect(reason="credentials_changed")
        except Exception as exc:
            # A broker SDK's exception text is logged under an error_id, not returned.
            from service.platform.http.errors import internal_error

            return {"reconnect_ok": False, "reconnect_error": internal_error("[CREDENTIALS] broker reconnect", exc)["error"]}
        # A daemon that is shutting down answers ok False with its own message (no SDK text).
        if not result.get("ok"):
            return {"reconnect_ok": False, "reconnect_error": str(result.get("message") or "Shioaji 拒絕重新連線")}
        return {"reconnect_ok": True}

    @router.get("/api/settings/shioaji/credentials")
    def get_credentials_status():
        return {"ok": True, **deps.credentials.public_status()}

    @router.put("/api/settings/shioaji/credentials")
    def put_credentials(req: ShioajiCredentialsRequest):
        try:
            deps.credentials.save_shioaji_credentials(
                req.api_key.get_secret_value(), req.secret_key.get_secret_value()
            )
        except CredentialError as exc:  # not an error: a credential failure is the API's stated answer (credential_error_response)
            return credential_error_response(exc, configured=False)
        return {"ok": True, "configured": True, **reconnect_if_running()}

    @router.delete("/api/settings/shioaji/credentials")
    def delete_credentials():
        try:
            deps.credentials.delete_shioaji_credentials()
        except CredentialError as exc:  # not an error: a credential failure is the API's stated answer (credential_error_response)
            # A partial delete still took the credentials out of effect: the broker reconnects without them.
            extra = reconnect_if_running() if exc.code == "delete_incomplete" else {}
            return credential_error_response(exc, configured=False, **extra)
        return {"ok": True, "configured": False, **reconnect_if_running()}

    return router

