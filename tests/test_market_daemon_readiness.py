from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_passive_health_reports_live_ingress_state_not_retired_canonical_hydration() -> None:
    """M8/M9: service/market/canonical/ (a confirmed duplicate live authority)
    is retired and physically removed. /health's "canonical" readiness block
    (still read by ui/main/startup_lifecycle.js's startup gate) must report
    the live-ingress sink's own operational health instead -- not the
    now-nonexistent CanonicalMarketViewService hydration coordinator this
    test used to lock in reading from."""
    source = (ROOT / "backend" / "shioaji" / "daemon_health.py").read_text(encoding="utf-8")

    assert 'getattr(canonical, "_accept_new_hydration"' not in source
    assert 'getattr(hydration, "_accept_new_work", False)' not in source
    assert "import CanonicalMarketViewService" not in source
    assert 'ingress_health.get("running")' in source


def _route(router, path):
    return next(route.endpoint for route in router.routes if route.path == path)


class _Coordinator:
    """The provider's security-master owner: records which write each route asked for."""

    def __init__(self):
        self.calls = []

    def ensure_current(self, api):
        self.calls.append("ensure")
        return {"ok": True, "current": True}

    def refresh_connected(self, api):
        self.calls.append("refresh")
        return {"ok": True}


def _router(app):
    import backend.shioaji.routes.maintenance_routes as routes

    return routes.create_maintenance_router(routes.MaintenanceRouteDependencies(app_provider=lambda: app))


def _app(status, coordinator, api=object()):
    from types import SimpleNamespace

    rollover = None if status is None else SimpleNamespace(status=status)
    fields = {"broker_service": SimpleNamespace(get_api=lambda: api), "market_maintenance_coordinator": coordinator}
    return SimpleNamespace(**fields, **({} if rollover is None else {"market_session_rollover": rollover}))


def test_live_session_defers_provider_contract_enumeration() -> None:
    """Enumerating contracts monopolizes the provider's API lane: during PREOPEN / LIVE neither route writes."""
    coordinator = _Coordinator()
    live = lambda: {"session_policy": {"decisions": {"STK": {"phase": "LIVE"}}}}
    router = _router(_app(live, coordinator))
    result = _route(router, "/v1/security-master/refresh")()
    assert result["deferred"] is True and result["reason"] == "LIVE_MARKET_DATA_PRIORITY"
    assert coordinator.calls == []


def test_unavailable_session_status_defers_instead_of_enumerating() -> None:
    # An exception reading lifecycle state was swallowed and the full contract enumeration ran.
    def broken_status():
        raise RuntimeError("rollover state unavailable")

    coordinator = _Coordinator()
    result = _route(_router(_app(broken_status, coordinator)), "/v1/security-master/refresh")()
    assert result["deferred"] is True and result["reason"] == "SESSION_STATUS_UNAVAILABLE"
    assert coordinator.calls == []


def test_every_master_write_goes_through_the_providers_owner() -> None:
    """An explicit refresh writes now through the one owner, never a second writer. Today's master is the login's
    (ShioajiService._on_shioaji_connected): the daemon offers no route for the desktop's start to ask for it, which
    before the login found no contracts and failed (503 / "contracts are not ready" on every restart)."""
    coordinator = _Coordinator()
    router = _router(_app(None, coordinator))
    assert _route(router, "/v1/security-master/refresh")() == {"ok": True}
    closed = _router(_app(lambda: {"session_policy": {"decisions": {"STK": {"phase": "CLOSED"}}}}, coordinator))
    _route(closed, "/v1/security-master/refresh")()
    assert coordinator.calls == ["refresh", "refresh"]
    assert "/v1/security-master/ensure" not in {route.path for route in router.routes}


def test_a_refresh_before_the_login_is_refused_not_written_from_no_contracts() -> None:
    import pytest
    from service.platform.http.errors import ServiceUnavailableError

    coordinator = _Coordinator()
    with pytest.raises(ServiceUnavailableError) as refused:
        _route(_router(_app(None, coordinator, api=None)), "/v1/security-master/refresh")()
    assert refused.value.classification == "BROKER_NOT_LOGGED_IN"
    assert coordinator.calls == []
