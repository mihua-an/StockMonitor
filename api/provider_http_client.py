"""Light HTTP client for a provider process (provider_shioaji / provider_futu), resolved by service_id.

For API services that only need a provider's data-fetching capabilities (history misses, data-center jobs,
catalog refresh): request/response JSON, the service-management credential, and nothing else -- no stream, no
client lease, no second live view. The one full stream client stays in quote_api only.
"""
from __future__ import annotations

import threading
import time
from typing import Any

from service.market.shared.daemon_transport import DaemonHttpTransport, DaemonTransportError
from service.market.shioaji.daemon_errors import MarketDaemonError


HEALTH_PATHS = {"provider_futu": "/health", "provider_shioaji": "/v1/health"}


class ProviderHttpClient:
    HEALTH_TTL_S = 2.0

    def __init__(self, service_id: str) -> None:
        from config.network_settings import endpoint

        host, port = endpoint(service_id)
        self.service_id = service_id
        self._transport = DaemonHttpTransport(host, port)
        self._health: dict[str, Any] = {}
        self._health_at = 0.0
        self._lock = threading.Lock()
        self._app = None

    def get_json(self, path: str, *, params: dict[str, Any] | None = None, timeout: float = 3.0) -> dict[str, Any]:
        try:
            return self._transport.get(path, params=params, timeout=timeout)
        except DaemonTransportError as exc:
            raise MarketDaemonError(str(exc)) from exc

    def post_json(self, path: str, body: dict[str, Any] | None = None, *, params: dict[str, Any] | None = None,
                  timeout: float = 8.0) -> dict[str, Any]:
        try:
            return self._transport.post(path, json_body=body, params=params, timeout=timeout)
        except DaemonTransportError as exc:
            raise MarketDaemonError(str(exc)) from exc

    def request(self, method: str, path: str, *, params: dict[str, Any] | None = None, body: dict[str, Any] | None = None,
                timeout: float = 5.0) -> dict[str, Any]:
        try:
            return self._transport.request(method.upper(), path, params=params, json_body=body, timeout=timeout)
        except DaemonTransportError as exc:
            raise MarketDaemonError(str(exc)) from exc

    def cached_health(self) -> dict[str, Any]:
        with self._lock:
            if time.monotonic() - self._health_at < self.HEALTH_TTL_S:
                return dict(self._health)
        try:
            # Each daemon's own health route: Futu serves /health, Shioaji /v1/health.
            health = self.get_json(HEALTH_PATHS.get(self.service_id, "/v1/health"), timeout=1.5)
        except MarketDaemonError as exc:
            # not an error: an unanswered health read is the cached health's answer (ok False, error), shown as the
            # provider's state; the client's attach recovery records the daemon being away
            health = {"ok": False, "error": str(exc)}
        with self._lock:
            self._health, self._health_at = dict(health), time.monotonic()
        return dict(health)

    @property
    def app(self):
        """The Shioaji historical/data-center view over this client (local cache first, misses to the provider)."""
        if self._app is None and self.service_id == "provider_shioaji":
            from service.market.shioaji.daemon_client import ShioajiDaemonClientView

            self._app = ShioajiDaemonClientView(self)
        return self._app
