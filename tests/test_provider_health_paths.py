"""Each provider client asks its daemon's own health route.

The shared client always asked /v1/health; the Futu daemon defines only /health.
"""
from __future__ import annotations

import re
from pathlib import Path

from api.provider_http_client import HEALTH_PATHS

ROOT = Path(__file__).resolve().parents[1]
DAEMONS = {"provider_futu": ROOT / "backend" / "futu", "provider_shioaji": ROOT / "backend" / "shioaji"}


def _routes(directory: Path) -> set[str]:
    # Decorated (@api.get("/health")) or tabled (("/v1/health", "get_health_v1", ("GET",))) routes.
    text = "\n".join(p.read_text(encoding="utf-8") for p in directory.rglob("*.py"))
    return set(re.findall(r"(?:\.get\(\s*|\(\s*)['\"](/[^'\"]+)['\"]", text))


def test_every_provider_health_path_is_a_route_of_its_daemon():
    for service_id, directory in DAEMONS.items():
        assert HEALTH_PATHS[service_id] in _routes(directory), f"{service_id} asks {HEALTH_PATHS[service_id]}"
