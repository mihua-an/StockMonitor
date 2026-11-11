"""config/api_routes.json against the routes each business API really serves (00 section 2).

Every /api path a service mounts must route to that same service (longest prefix), and Node resolves exactly like
Python -- otherwise the renderer would address a service that 404s the request.
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
from pathlib import Path

import pytest

from config.api_routes import routes, service_for_path

ROOT = Path(__file__).resolve().parents[1]
SERVICES = ("realtime_api", "app_api")
SHARED = ("/api/service/", "/api/diagnostics/client-auth")


def _walk(items, prefix=""):
    """path -> the HTTP methods served on it."""
    found: dict[str, set[str]] = {}
    for route in items:
        inner = getattr(route, "original_router", None)
        if inner is not None:
            for path, methods in _walk(inner.routes, prefix + (getattr(getattr(route, "include_context", None), "prefix", "") or "")).items():
                found.setdefault(path, set()).update(methods)
            continue
        path = prefix + (getattr(route, "path", "") or "")
        if path.startswith("/api/") and not path.startswith(SHARED):
            found.setdefault(path, set()).update(getattr(route, "methods", None) or ())
    return found


def _served(service_id: str) -> dict[str, set[str]]:
    import importlib

    app = importlib.import_module(f"api.services.{service_id}").build_app(client_token="x")

    async def run():
        async with app.router.lifespan_context(app):
            return _walk(app.router.routes)

    return asyncio.run(run())


@pytest.fixture(scope="module")
def served_methods(isolated_roots_module):
    return {sid: _served(sid) for sid in SERVICES}


@pytest.fixture(scope="module")
def served(served_methods):
    return {sid: set(paths) for sid, paths in served_methods.items()}


@pytest.fixture(scope="module")
def isolated_roots_module(tmp_path_factory):
    root = tmp_path_factory.mktemp("routes")
    old = {k: os.environ.get(k) for k in ("STOCK_MONITOR_AUTH_ROOT",)}
    os.environ["STOCK_MONITOR_AUTH_ROOT"] = str(root / "auth")
    yield root
    for key, value in old.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def test_every_served_path_routes_to_its_own_service(served):
    wrong = []
    for sid, paths in served.items():
        for path in sorted(paths):
            concrete = path.replace("{", "").replace("}", "")
            if service_for_path(concrete) != sid:
                wrong.append((path, sid, service_for_path(concrete)))
    assert wrong == []


def test_every_route_prefix_is_backed_by_a_served_path(served):
    unused = [(prefix, sid) for prefix, sid in routes()
              if not any(p == prefix.rstrip("/") or p.startswith(prefix) for p in served[sid])]
    assert unused == []


def test_no_service_writes_watch_pages(served_methods):
    # Electron's watch_page_store.js is the only writer of watch_pages.csv (06 section 2): a second, uncoordinated
    # HTTP writer would silently lose one side's concurrent edit.
    writes = {(sid, path, method) for sid, routes_ in served_methods.items() for path, methods in routes_.items()
              if path.startswith("/api/watch-pages") for method in methods if method not in ("GET", "HEAD")}
    assert writes == set()
    assert "/api/watch-pages" in served_methods["app_api"]


def test_unknown_paths_are_not_guessed():
    assert service_for_path("/api/no-such-thing") is None
    assert service_for_path("/api/market-daemon/status?x=1") == "realtime_api"


def test_node_resolves_like_python():
    probes = ["/api/config/network", "/api/watch-pages", "/api/history/dates", "/api/model/options", "/api/market/taiex",
              "/api/diagnostics/account-sqlite", "/api/diagnostics/readiness", "/api/paper-wallet/status", "/api/nope"]
    out = subprocess.run(["node", "-e", "const r=require('./config/js/api_routes.js');"
                          f"process.stdout.write(JSON.stringify({json.dumps(probes)}.map(r.serviceForPath)))"],
                         cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=30)
    assert out.returncode == 0, out.stderr
    assert json.loads(out.stdout) == [service_for_path(p) for p in probes]


def test_a_prefix_matches_whole_path_segments_in_both_languages():
    # /api/settingsx is not /api/settings: a sibling route is never sent to the wrong service.
    cases = json.loads((ROOT / "tests" / "fixtures" / "api_route_cases.json").read_text(encoding="utf-8"))
    assert [service_for_path(path) for path, _ in cases] == [expected for _, expected in cases]
    out = subprocess.run(["node", "-e", "const r=require('./config/js/api_routes.js');"
                          f"process.stdout.write(JSON.stringify({json.dumps([p for p, _ in cases])}.map(r.serviceForPath)))"],
                         cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=30)
    assert out.returncode == 0, out.stderr
    assert json.loads(out.stdout) == [expected for _, expected in cases]
