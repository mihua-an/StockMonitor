from __future__ import annotations

import json
from typing import Any

from starlette.responses import JSONResponse

from service.platform.json_safety import to_json_safe


class SafeJSONResponse(JSONResponse):
    """Strict JSON response boundary shared by FastAPI and Market Daemon APIs."""

    def render(self, content: Any) -> bytes:
        return json.dumps(
            to_json_safe(content),
            ensure_ascii=False,
            allow_nan=False,
            indent=None,
            separators=(",", ":"),
        ).encode("utf-8")
