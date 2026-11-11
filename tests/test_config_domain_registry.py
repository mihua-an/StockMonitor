"""settings_api's config domains come from one ConfigDomainSpec registry: effect, validator, activation, defaults and
routes are all derived from it, so a domain cannot be half-registered."""
from __future__ import annotations

import json

from api.routes.config_routes import DOMAINS, create_config_router, effect_of, seed_defaults
from config.system_contract import contract


def test_every_domain_is_complete():
    modes = contract()["effect_modes"]
    for name, spec in DOMAINS.items():
        assert spec.name == name
        assert spec.effect_contract in modes, name
        assert callable(spec.validator), name
        assert effect_of(name)["activated_on_save"] is spec.activate_on_save
        if spec.default is not None:
            assert spec.validator(spec.default()) == [], f"{name}'s default passes its own validator"


def test_routes_and_seed_follow_the_registry(tmp_path):
    seeded = seed_defaults(tmp_path)
    assert set(seeded) == {name for name, spec in DOMAINS.items() if spec.default is not None}
    router = create_config_router(config_root=lambda: tmp_path)
    endpoint = {(route.path, method): route.endpoint for route in router.routes for method in route.methods}
    get = endpoint[("/api/config/{domain}", "GET")]
    for name, spec in DOMAINS.items():
        if not spec.generic_routes:
            continue
        assert get(name)["activate_on_save"] is spec.activate_on_save, name
    unknown = get("network")
    assert unknown.status_code == 404, "network has routes of its own"
    assert json.loads(unknown.body)["domains"] == sorted(DOMAINS)
    assert "apply_operation" in get("storage_location")
