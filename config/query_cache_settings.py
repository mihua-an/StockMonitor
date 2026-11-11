"""Query cache retention (設定 → 資料儲存 → 查詢快取): how many calendar days a closed session fetched for a view stays
on disk (service/market/history/query_cache.py).

One config domain, ``query_cache`` (config/config_revisions.py), active on save; each session's materialization reads
the active revision and removes what is older.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

DEFAULTS: dict[str, Any] = {"retention_days": 7}
MAX_DAYS = 3650


def validate(values: dict[str, Any]) -> list[dict[str, Any]]:
    values = values if isinstance(values, dict) else {}
    problems = [{"code": "UNKNOWN_FIELD", "message": f"unknown field {name!r}"} for name in sorted(set(values) - {"retention_days"})]
    days = values.get("retention_days")
    # bool is an int in Python: True is not "1 day".
    if isinstance(days, bool) or not isinstance(days, int) or not 1 <= days <= MAX_DAYS:
        problems.append({"code": "RETENTION_DAYS", "message": f"retention_days must be 1..{MAX_DAYS}"})
    return problems


def retention_days(config_root: Path | None = None) -> int:
    """The active value, or the default before any revision is saved."""
    from config.config_revisions import ConfigRevisionStore, config_root as default_config_root

    document = ConfigRevisionStore(config_root or default_config_root(), "query_cache").active()
    days = ((document or {}).get("values") or {}).get("retention_days")
    return days if isinstance(days, int) and not isinstance(days, bool) else DEFAULTS["retention_days"]
