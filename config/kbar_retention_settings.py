"""K-bar retention (設定 → 資料儲存 → K 棒保存): how many months a date keeps each intraday timeframe.

One config domain, ``kbar_retention`` (config/config_revisions.py), active on save; the close-of-day materialization
reads the active revision when it ages the K-bar store (native/analysis_runtime/src/kbar_store.rs).

``months`` names every stored timeframe of the chain in config/system_contract.json. 3 minutes is read from the 1-minute
rows and has no value of its own. A coarser timeframe is never kept for less time than a finer one: a date is folded
along the chain. Daily bars are kept forever and are no field here.
"""
from __future__ import annotations

from datetime import date
from calendar import monthrange
from pathlib import Path
from typing import Any

from config.system_contract import contract

MAX_MONTHS = 120
DOMAIN = "kbar_retention"


def defaults() -> dict[str, Any]:
    return {"months": dict(contract()["kbar_retention_months"])}


def _problem(code: str, message: str) -> dict[str, Any]:
    return {"code": code, "message": message}


def validate(values: dict[str, Any]) -> list[dict[str, Any]]:
    values = values if isinstance(values, dict) else {}
    problems = [_problem("UNKNOWN_FIELD", f"unknown field {name!r}") for name in sorted(set(values) - {"months"})]
    months = values.get("months")
    tiers = sorted(contract()["kbar_retention_months"], key=int)
    if not isinstance(months, dict) or set(months) != set(tiers):
        return [*problems, _problem("MONTHS", f"months must name exactly the timeframes {', '.join(tiers)}")]
    # bool is an int in Python: True is not "1 month".
    bad = [tier for tier in tiers if not isinstance(months[tier], int) or isinstance(months[tier], bool) or not 1 <= months[tier] <= MAX_MONTHS]
    if bad:
        return [*problems, _problem("MONTHS", f"months must be 1..{MAX_MONTHS}: {', '.join(bad)}")]
    for finer, coarser in zip(tiers, tiers[1:]):
        if months[finer] > months[coarser]:
            problems.append(_problem("MONTHS_ORDER", f"{coarser} 分 K 的保存月數不能少於 {finer} 分 K"))
    return problems


def months_before(day: date, months: int) -> date:
    """`day` minus `months` calendar months; a day the earlier month lacks becomes its last. Rust B's aging has the same
    rule (kbar_store.rs months_before); tests/test_technical_history.py holds the two to the same cases."""
    index = day.year * 12 + day.month - 1 - months
    year, month = index // 12, index % 12 + 1
    return date(year, month, min(day.day, monthrange(year, month)[1]))


def active_months(config_root: Path | None = None) -> dict[str, int]:
    """The active revision's months, or the contract's before any revision is saved."""
    from config.config_revisions import ConfigRevisionStore, config_root as default_config_root

    document = ConfigRevisionStore(config_root or default_config_root(), DOMAIN).active()
    return dict(((document or {}).get("values") or defaults()).get("months") or defaults()["months"])


def horizons(today: date, config_root: Path | None = None) -> dict[str, str]:
    """The oldest date each intraday timeframe a chart shows can reach: its own retention. 3 minutes is read from the
    1-minute rows, so it lasts as long as they do."""
    months = active_months(config_root)
    reach = {timeframe: months_before(today, count).isoformat() for timeframe, count in months.items()}
    return {**reach, "3": reach["1"]}
