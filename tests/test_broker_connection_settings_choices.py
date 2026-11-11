"""設定 → 券商帳號 → 永豐行情連線: the page builds its choices from the domain (GET /api/config/broker_connections),
never from a copy of the defaults, ranges and listed limits of its own."""
from __future__ import annotations

from config import broker_connection_settings as bcs


def test_choices_are_the_domains_own():
    choices = bcs.choices()
    assert choices["defaults"] == bcs.DEFAULTS and choices["defaults"] is not bcs.DEFAULTS
    shioaji = choices["shioaji"]
    assert shioaji["connections"] == {"min": 1, "max": bcs.MAX_CONNECTIONS}
    limit = shioaji["per_connection_limit"]
    assert limit["min"] == 1 and limit["max"] == bcs.MAX_PER_CONNECTION
    assert bcs.DEFAULTS["shioaji"]["per_connection_limit"] in limit["options"]
    # Every value offered is one the domain accepts.
    for connections in range(1, shioaji["connections"]["max"] + 1):
        for per in limit["options"]:
            assert bcs.validate({"shioaji": {"connections": connections, "per_connection_limit": per}}) == []
    assert bcs.validate({"shioaji": {"connections": shioaji["connections"]["max"] + 1, "per_connection_limit": 200}})


def test_settings_api_serves_the_choices(tmp_path):
    from api.routes.config_routes import create_config_router, seed_defaults

    seed_defaults(tmp_path)
    router = create_config_router(config_root=lambda: tmp_path)
    endpoint = {(route.path, method): route.endpoint for route in router.routes for method in route.methods}
    described = endpoint[("/api/config/{domain}", "GET")]("broker_connections")
    assert described["ok"] and described["choices"] == bcs.choices()
