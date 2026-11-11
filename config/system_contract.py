"""Loader for config/system_contract.json -- the cross-language system contract (roles, states, units, windows).

Python, Node (config/js/system_contract.js) and Rust (include_str! in native crates) read the same file; parity tests
prove the three agree. Read-only; cached for the process lifetime.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

SCHEMA = "stock-monitor-system-contract-v1"
_PATH = Path(__file__).resolve().parent / "system_contract.json"


@lru_cache(maxsize=1)
def _load() -> dict[str, Any]:
    contract = json.loads(_PATH.read_text(encoding="utf-8"))
    if contract.get("schema") != SCHEMA:
        raise RuntimeError(f"{_PATH} is not {SCHEMA}")
    return contract


def contract() -> dict[str, Any]:
    return json.loads(json.dumps(_load()))


def role_permissions(role: str) -> frozenset[str]:
    return frozenset(_load()["market_runtime_roles"].get(role, ()))


def data_child(owner: str) -> str:
    """Name of the DATA_ROOT child a native runtime owns ("market_runtime" -> "live-engine")."""
    name = _load()["data_children"].get(owner)
    if not name:
        raise KeyError(f"system contract names no data directory for {owner}")
    return name

