from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from service.platform.http.safe_json_response import SafeJSONResponse

# A refusal is answered with its status, the body unchanged: an unsupported target is bad input, training
# switched off is a state conflict.
REFUSAL_STATUS = {"UNSUPPORTED_TARGET": 422, "MODEL_TRAINING_DISABLED": 409}


def _answer(result: Any):
    if isinstance(result, dict) and result.get("ok") is False:
        error = str(result.get("error") or "")
        return SafeJSONResponse(status_code=REFUSAL_STATUS.get(error, 500), content={"classification": error or "OPERATION_FAILED", **result})
    return result


def create_training_router(app: Any) -> APIRouter:
    """Model center reads and the manual request; the training itself is Health's job process."""
    router = APIRouter()

    @router.get("/api/training/runtime")
    def training_runtime():
        return app.runtime()

    @router.get("/api/training/models")
    def training_models():
        return app.models()

    @router.get("/api/training/today")
    def training_today():
        return app.today()

    @router.get("/api/training/console")
    def training_console(horizon_minutes: int | None = None, direction: str = "up"):
        return _answer(app.console(horizon_minutes=horizon_minutes, direction=direction))

    @router.post("/api/training/run")
    def training_run():
        return _answer(app.run())

    return router
