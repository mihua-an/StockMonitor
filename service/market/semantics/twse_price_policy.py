"""台股 升降單位: config/twse_price_policy.json applied to a price and an instrument kind (the security master's).

漲停／跌停 are not derived here or anywhere: only the official limits the provider publishes are used."""
from __future__ import annotations

import json
from decimal import Decimal
from typing import Any

from service.platform import project_root as process_paths


def _load_policy() -> dict[str, Any]:
    with open(process_paths.PROJECT_ROOT / "config" / "twse_price_policy.json", "r", encoding="utf-8") as handle:
        policy = json.load(handle)
    tables = policy["tick_tables"]
    for kind, table in policy["tick_table_of_kind"].items():
        if table not in tables:
            raise ValueError(f"twse_price_policy.json: kind {kind!r} names no tick table {table!r}")
    return policy


PRICE_POLICY = _load_policy()


def _decimal(value: Any) -> Decimal | None:
    try:
        number = Decimal(str(value))
    except Exception:  # not an error: price coercion: a non-numeric value is None (missing) by contract
        return None
    return number if number.is_finite() and number > 0 else None


def tick_table(instrument_kind: str) -> list[list[Any]]:
    """The 升降單位 table of an instrument kind; KeyError for a kind the policy does not know."""
    return PRICE_POLICY["tick_tables"][PRICE_POLICY["tick_table_of_kind"][str(instrument_kind)]]


def twse_tick_size(price: Any, instrument_kind: str) -> Decimal | None:
    """The regular-board 升降單位 at `price` for an instrument kind (stock / etf / etn / reit); None without a price."""
    value = _decimal(price)
    if value is None:
        return None
    for below, tick in tick_table(instrument_kind):
        if below is None or value < Decimal(below):
            return Decimal(tick)
    raise ValueError("twse_price_policy.json: a tick table without its open-ended last row")


def price_policy_projection() -> dict[str, Any]:
    """What a screen stepping prices needs (the paper funds carry it): the tables and which kind uses which."""
    return {"tick_tables": PRICE_POLICY["tick_tables"], "tick_table_of_kind": PRICE_POLICY["tick_table_of_kind"]}
