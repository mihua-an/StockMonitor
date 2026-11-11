"""The closing-data source (設定 → 資料儲存 → 收盤資料來源): the address a closed session's five levels, reference price
and limits are read from, or none.

One config domain, ``closing_data`` (config/config_revisions.py), active on save. Empty by default: with no address
nothing connects anywhere. The user supplies the address and is responsible for that provider's terms.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

DEFAULTS: dict[str, Any] = {"url": ""}
MAX_LENGTH = 500


def validate(values: dict[str, Any]) -> list[dict[str, Any]]:
    values = values if isinstance(values, dict) else {}
    problems = [{"code": "UNKNOWN_FIELD", "message": f"unknown field {name!r}"} for name in sorted(set(values) - {"url"})]
    url = values.get("url")
    if not isinstance(url, str) or len(url) > MAX_LENGTH:
        return [*problems, {"code": "URL", "message": f"url must be text of at most {MAX_LENGTH} characters"}]
    if url and (not url.startswith(("https://", "http://")) or "{code}" not in url):
        problems.append({"code": "URL", "message": "url must start with https:// or http:// and contain {code}"})
    return problems


def url(config_root: Path | None = None) -> str:
    """The active address, or "" when none is set."""
    from config.config_revisions import ConfigRevisionStore, config_root as default_config_root

    document = ConfigRevisionStore(config_root or default_config_root(), "closing_data").active()
    value = ((document or {}).get("values") or {}).get("url")
    return value if isinstance(value, str) else DEFAULTS["url"]
