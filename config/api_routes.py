"""Path -> business API service_id (config/api_routes.json; Node twin config/js/api_routes.js).

The longest matching prefix wins, matched by whole path segments (/api/status serves /api/status and /api/status/x,
not /api/statusx); a path no service serves is None, never a guessed default.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

SCHEMA = "stock-monitor-api-routes-v1"
_PATH = Path(__file__).resolve().parent / "api_routes.json"


@lru_cache(maxsize=1)
def routes() -> tuple[tuple[str, str], ...]:
    doc = json.loads(_PATH.read_text(encoding="utf-8"))
    if doc.get("schema") != SCHEMA:
        raise RuntimeError(f"{_PATH} is not {SCHEMA}")
    return tuple(sorted(((r["prefix"], r["service_id"]) for r in doc["routes"]), key=lambda r: -len(r[0])))


def service_for_path(path: str) -> str | None:
    clean = str(path or "").split("?", 1)[0]
    for prefix, service_id in routes():
        base = prefix.rstrip("/")
        if clean == base or clean.startswith(base + "/"):
            return service_id
    return None
