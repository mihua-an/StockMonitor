"""Each service mounts its own named domain routers with include_router(); no router of another domain is built
and sliced by path prefix (the removed include_paths + NotHere wiring), so a renamed path cannot be dropped silently
and a wrong dependency cannot hide until a request reaches it."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_no_prefix_slicing_or_wrong_service_stand_ins():
    for path in [*(ROOT / "api" / "services").glob("*.py"), ROOT / "api" / "service_host.py", ROOT / "api" / "components.py"]:
        source = path.read_text(encoding="utf-8")
        assert "include_paths" not in source and "NotHere" not in source, path.name
        assert "app.router.routes.append" not in source, path.name
