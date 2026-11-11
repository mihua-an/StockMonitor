from __future__ import annotations

import json
from service.platform import project_root as process_paths
from typing import Any


_CONTRACT_PATH = process_paths.PROJECT_ROOT / "config" / "runtime_contract.json"

# Every field a consumer reads, with its type: the same table as config/js/runtime_contract.js REQUIRED_FIELDS, so a
# damaged file is refused at load by both languages with the same problems (tests/fixtures/runtime_contract_cases.json).
REQUIRED_FIELDS: tuple[tuple[str, str], ...] = (
    ("backend.architecture", "string"),
    ("backend.runtime_version", "string"),
    ("backend.renderer_protocol_version", "integer"),
    ("backend.canonical_frame_protocol_version", "integer"),
    ("market_daemon.identity", "string"),
    ("market_daemon.protocol_version", "integer"),
    ("market_daemon.runtime_version", "string"),
    ("moomoo_daemon.identity", "string"),
    ("moomoo_daemon.protocol_version", "integer"),
    ("moomoo_daemon.runtime_version", "string"),
)


class RuntimeContractError(RuntimeError):
    code = "RUNTIME_CONFIGURATION_INVALID"


def contract_problems(payload: Any) -> list[str]:
    if not isinstance(payload, dict):
        return ["contract must be a JSON object"]
    problems = []
    for field, kind in REQUIRED_FIELDS:
        section, key = field.split(".")
        value = payload.get(section, {}).get(key) if isinstance(payload.get(section), dict) else None
        if kind == "string" and not (isinstance(value, str) and value):
            problems.append(f"{field} must be a non-empty string")
        elif kind == "integer" and not (isinstance(value, int) and not isinstance(value, bool) and value >= 1):
            problems.append(f"{field} must be a positive integer")
    return problems


def _load_contract() -> dict[str, Any]:
    try:
        with _CONTRACT_PATH.open("r", encoding="utf-8") as fp:
            payload = json.load(fp)
    except (OSError, ValueError) as exc:
        raise RuntimeContractError(f"runtime contract {_CONTRACT_PATH} is unreadable: {exc}") from exc
    problems = contract_problems(payload)
    if problems:
        raise RuntimeContractError(f"runtime contract {_CONTRACT_PATH} is invalid: {'; '.join(problems)}")
    return payload


RUNTIME_CONTRACT = _load_contract()
BACKEND_CONTRACT = RUNTIME_CONTRACT["backend"]
MARKET_DAEMON_CONTRACT = RUNTIME_CONTRACT["market_daemon"]
MOOMOO_DAEMON_CONTRACT = RUNTIME_CONTRACT["moomoo_daemon"]
