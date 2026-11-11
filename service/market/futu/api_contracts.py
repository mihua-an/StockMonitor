"""HTTP request contracts shared by FastAPI's ``/api/futu/*`` proxy routes
and the Futu daemon's own native ``/v1/futu/*`` routes.

Both process-wiring layers (``api/`` and ``backend/futu/``) want the exact
same request shape -- the proxy route just forwards the same JSON body to the
daemon's own handler. Living here (the Futu domain layer, which both
``api/`` and ``backend/futu/`` are allowed to depend on) instead of in either
process's own module avoids the ``api/ <-> backend/futu`` cross-process-wiring
import cycle docs/development/directory_recommendations.md forbids -- neither
process owns this shape.
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel


class WatchlistRequest(BaseModel):
    items: list[dict[str, Any]] = []

