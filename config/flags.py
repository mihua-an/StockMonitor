"""Strict boolean parsing for configuration flags (AGENTS.md section 4).

One contract for Python and Node (config/js/flags.js), pinned by tests/fixtures/config/flag_cases.json: true for
1/true/yes/on, false for 0/false/no/off, the fallback for an absent or empty value, and an error for anything else --
a non-empty string such as "false" is never truthy just because it is non-empty, and a typo never silently means
"off". JSON booleans are accepted as themselves; any other JSON type is an error.
"""
from __future__ import annotations

from typing import Any

TRUE = frozenset({"1", "true", "yes", "on"})
FALSE = frozenset({"0", "false", "no", "off"})


class FlagError(ValueError):
    pass


def parse_flag(value: Any, *, name: str, fallback: bool) -> bool:
    if value is None:
        return fallback
    if isinstance(value, bool):
        return value
    if not isinstance(value, str):
        raise FlagError(f"{name} must be a boolean, got {type(value).__name__}")
    text = value.strip().lower()
    if text == "":
        return fallback
    if text in TRUE:
        return True
    if text in FALSE:
        return False
    raise FlagError(f"{name} must be one of 1/true/yes/on or 0/false/no/off, got {value!r}")
