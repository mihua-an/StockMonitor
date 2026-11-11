"""設定 → 券商帳號 → 永豐行情連線 (user 10-19): how many broker logins the App may use for market data and how many
subscriptions each takes.

Shioaji counts subscriptions per connection (one ``api.login()`` session); one person ID may hold 5 connections. An
ordinary account takes 200 per connection (a stock's Tick and BidAsk are two, an index one) and the broker can raise
it for an account. The App opens its first connection at login and the next one only when the subscriptions no
longer fit (service/market/shioaji/session.py), up to ``connections``. The default leaves two of the five for the
phone and for development; at most four, so one is always left for logging in elsewhere.

One settings_api domain, ``broker_connections``, active on save; the Shioaji provider reads the active revision on
its subscription loop and applies it (more capacity at once; less than what is in use by logging in again).
"""
from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

DOMAIN = "broker_connections"
MAX_CONNECTIONS = 4
MAX_PER_CONNECTION = 1000
DEFAULTS: dict[str, Any] = {"shioaji": {"connections": 3, "per_connection_limit": 200}}
# The per-connection limits the settings page offers (an account's own limit, if the broker raised it, is one of them
# or is kept as the saved value).
PER_CONNECTION_OPTIONS = (100, 150, 200, 250, 300, 400, 500, 600, 800, 1000)


def choices() -> dict[str, Any]:
    """What the settings page offers, from this domain: the defaults, each field's range and the limits listed."""
    return {"defaults": copy.deepcopy(DEFAULTS), "shioaji": {
        "connections": {"min": 1, "max": MAX_CONNECTIONS},
        "per_connection_limit": {"min": 1, "max": MAX_PER_CONNECTION, "options": list(PER_CONNECTION_OPTIONS)},
    }}


def _problem(code: str, message: str, **detail: Any) -> dict[str, Any]:
    return {"code": code, "message": message, **detail}


def _whole(value: Any) -> bool:
    # bool is an int in Python: True is not "1".
    return isinstance(value, int) and not isinstance(value, bool)


def validate(values: dict[str, Any]) -> list[dict[str, Any]]:
    entry = (values or {}).get("shioaji")
    if not isinstance(entry, dict):
        return [_problem("SHIOAJI", "shioaji must be an object")]
    problems = []
    unknown = sorted(set(values) - {"shioaji"})
    if unknown:
        problems.append(_problem("UNKNOWN_SOURCE", f"unknown source {unknown[0]!r}"))
    connections = entry.get("connections")
    if not _whole(connections) or not 1 <= connections <= MAX_CONNECTIONS:
        problems.append(_problem("CONNECTIONS", f"connections must be a whole number 1..{MAX_CONNECTIONS}"))
    limit = entry.get("per_connection_limit")
    if not _whole(limit) or not 1 <= limit <= MAX_PER_CONNECTION:
        problems.append(_problem("PER_CONNECTION_LIMIT", f"per_connection_limit must be a whole number 1..{MAX_PER_CONNECTION}"))
    return problems


def shioaji(config_root: Path | None = None) -> dict[str, Any]:
    """The active Shioaji connection settings and their revision: ``{"connections", "per_connection_limit", "revision"}``.
    No active revision: the defaults (revision None). A revision that does not validate raises ValueError (the caller
    records it and keeps what it runs with)."""
    from config.config_revisions import ConfigRevisionStore, config_root as default_config_root

    document = ConfigRevisionStore(config_root or default_config_root(), DOMAIN).active()
    if document is None:
        return {**DEFAULTS["shioaji"], "revision": None}
    values = document.get("values")
    problems = validate(values if isinstance(values, dict) else {})
    if problems:
        raise ValueError(f"{DOMAIN} revision {document.get('revision')}: {problems[0]['message']}")
    entry = values["shioaji"]
    return {"connections": entry["connections"], "per_connection_limit": entry["per_connection_limit"],
            "revision": document.get("revision")}
