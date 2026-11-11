"""The background list's schema: what a saved revision of the ``background`` config domain may hold.

One validator for both writers -- the 設定 API route (api/routes/config_routes.py) and the owners that replace their
part of the list (service/market/reference/background_demand.py) -- so neither depends on the other.
"""
from __future__ import annotations

from typing import Any

# The lanes an instrument of the list can be subscribed with.
KINDS = {"quote", "trade", "orderbook"}
MAX_ITEMS = 4000


def _problem(code: str, message: str, **extra: Any) -> dict[str, Any]:
    return {"code": code, "message": message, **extra}


def validate_background(values: dict[str, Any]) -> list[dict[str, Any]]:
    from config.source_settings import source_enabled

    items = values.get("items")
    if not isinstance(items, list):
        return [_problem("ITEMS_REQUIRED", "items must be a list")]
    if len(items) > MAX_ITEMS:
        return [_problem("TOO_MANY_ITEMS", f"at most {MAX_ITEMS} background instruments")]
    problems, seen = [], set()
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            problems.append(_problem("INVALID_ITEM", "item must be an object", index=i))
            continue
        source = str(item.get("source") or "").strip().lower()
        market = str(item.get("market") or "").strip().upper()
        code = str(item.get("code") or "").strip().upper()
        if not (source and market and code):
            problems.append(_problem("INCOMPLETE_ITEM", "source, market and code are required", index=i))
            continue
        if not source_enabled(source):
            problems.append(_problem("SOURCE_DISABLED", f"source {source} is disabled", index=i))
        # Absent means every kind; a given list names at least one kind, none twice (market_runtime demand.rs).
        kinds = item["kinds"] if "kinds" in item else sorted(KINDS)
        if not isinstance(kinds, list) or not kinds:
            problems.append(_problem("EMPTY_KINDS", "kinds must be a list naming at least one kind", index=i))
        elif not set(kinds) <= KINDS:
            problems.append(_problem("UNKNOWN_KIND", f"kinds must be within {sorted(KINDS)}", index=i))
        elif len(set(kinds)) != len(kinds):
            problems.append(_problem("REPEATED_KIND", "kinds names a kind twice", index=i))
        # Each owner's claim (background_demand.merge): owner -> the kinds it wants.
        claims = item.get("claims", {})
        if not isinstance(claims, dict) or any(not isinstance(k, list) or not set(k) <= KINDS for k in claims.values()):
            problems.append(_problem("INVALID_CLAIMS", "claims must map each owner to a list of kinds", index=i))
        if (source, market, code) in seen:
            problems.append(_problem("DUPLICATE_ITEM", f"{source}:{market}:{code} listed twice", index=i))
        seen.add((source, market, code))
    return problems
