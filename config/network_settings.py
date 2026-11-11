"""Effective network addresses for Python processes, from the one resolver (config/network_config.py).

Every value here is derived from the ACTIVE saved network revision layered over config/network_manifest.json and the
allowed start overrides -- never a literal. Clients should prefer `endpoint(service_id)` / `base_url(service_id)`.
Resolved once per process: a port change takes effect through Health's controlled restart (06 section 4-5).
"""
from __future__ import annotations

from typing import Any

from config.network_config import base_url as _base_url, effective_from_disk, endpoint as _endpoint, connect_sources

EFFECTIVE: dict[str, Any] = effective_from_disk()
NETWORK_REVISION = EFFECTIVE.get("revision")


def endpoint(service_id: str) -> tuple[str, int]:
    return _endpoint(EFFECTIVE, service_id)


def base_url(service_id: str) -> str:
    return _base_url(EFFECTIVE, service_id)


def _host(sid: str) -> str:
    return endpoint(sid)[0]


def _port(sid: str) -> int:
    return endpoint(sid)[1]


# The quote and model parts are served by realtime_api, settings by app_api (two API processes).
QUOTE_API_URL = base_url("realtime_api")
SETTINGS_API_URL = base_url("app_api")
MODEL_API_URL = base_url("realtime_api")

# Provider processes (SDK owners).
SHIOAJI_DAEMON_HOST = _host("provider_shioaji")
SHIOAJI_DAEMON_PORT = _port("provider_shioaji")
SHIOAJI_DAEMON_URL = f"http://{SHIOAJI_DAEMON_HOST}:{SHIOAJI_DAEMON_PORT}"
FUTU_DAEMON_HOST = _host("provider_futu")
FUTU_DAEMON_PORT = _port("provider_futu")
FUTU_DAEMON_URL = f"http://{FUTU_DAEMON_HOST}:{FUTU_DAEMON_PORT}"

# Rust A (market_runtime).
LIVE_ENGINE_HOST = _host("market_runtime")
LIVE_ENGINE_PORT = _port("market_runtime")
LIVE_ENGINE_BASE_URL = f"http://{LIVE_ENGINE_HOST}:{LIVE_ENGINE_PORT}"
LIVE_ENGINE_WS_URL = f"ws://{LIVE_ENGINE_HOST}:{LIVE_ENGINE_PORT}/live"

# Health (service_controller).
CONTROLLER_HOST = _host("service_controller")
CONTROLLER_PORT = _port("service_controller")
CONTROLLER_BASE_URL = f"http://{CONTROLLER_HOST}:{CONTROLLER_PORT}"

# Renderer windows load from file:// (origin "null"); no dev-server origin is allowed in the formal table.
CORS_ALLOWED_ORIGINS = ["null"]
RENDERER_CONNECT_SOURCES = connect_sources(EFFECTIVE)
