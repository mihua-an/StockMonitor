"""Process-start source selection (AGENTS.md section 3). No SDK, I/O service or worker imports.

Edit source_settings.json, or override enabled_sources with STOCK_MONITOR_SOURCES (comma separated canonical names).
Restart the application after changing it. This module only answers "which sources are selected"; which API path
belongs to which source and what an offline UI may still read is API admission policy (api/source_gate.py), and the
disabled-source status body is part of the source status contract (service/market/shared/source_runtime.py).
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from config.flags import parse_flag

SUPPORTED_CONTRACT_VERSIONS = (1,)


def source_settings_problems(doc) -> list[str]:
    """Every way `doc` is not a supported source_settings.json; the same strings as config/js/source_settings.js
    sourceSettingsProblems (tests/fixtures/source_settings_cases.json)."""
    if not isinstance(doc, dict):
        return ["settings must be an object"]
    problems = []
    version = doc.get("contract_version")
    if isinstance(version, bool) or version not in SUPPORTED_CONTRACT_VERSIONS:
        problems.append(f"contract_version must be one of {list(SUPPORTED_CONTRACT_VERSIONS)}")
    sources = doc.get("sources")
    if not isinstance(sources, dict) or not sources:
        return [*problems, "sources must be a non-empty object"]
    for name, spec in sources.items():
        if not isinstance(spec, dict):
            problems.append(f"sources.{name} must be an object")
            continue
        prefixes = spec.get("api_prefixes")
        if not isinstance(prefixes, list) or not prefixes or not all(isinstance(p, str) and p.startswith("/api/") for p in prefixes):
            problems.append(f"sources.{name}.api_prefixes must be a non-empty list of /api/ paths")
    enabled = doc.get("enabled_sources")
    if not isinstance(enabled, list) or not all(isinstance(s, str) and s in sources for s in enabled):
        problems.append("enabled_sources must list sources")
    return problems


def load_source_settings(env=None) -> dict:
    env = os.environ if env is None else env
    path = Path(__file__).with_suffix(".json")
    settings = json.loads(path.read_text(encoding="utf-8"))
    problems = source_settings_problems(settings)
    if problems:
        raise ValueError(f"{path} is invalid: {'; '.join(problems)}")
    raw = env.get("STOCK_MONITOR_SOURCES")
    enabled = settings["enabled_sources"] if raw is None else [s.strip() for s in raw.split(",") if s.strip()]
    offline_ui = parse_flag(env.get("STOCK_MONITOR_OFFLINE_UI"), name="STOCK_MONITOR_OFFLINE_UI", fallback=False)
    if not isinstance(enabled, list) or (not enabled and not offline_ui) or any(s not in settings["sources"] for s in enabled):
        raise ValueError("STOCK_MONITOR_SOURCES must select shioaji, futu, or shioaji,futu")
    if offline_ui:
        enabled = []
    settings["enabled_sources"] = list(dict.fromkeys(enabled))
    settings["offline_ui"] = offline_ui
    return settings


SOURCE_SETTINGS = load_source_settings()
ENABLED_SOURCES = frozenset(SOURCE_SETTINGS["enabled_sources"])


def offline_ui_enabled() -> bool:
    """Whether the process is running the broker-free desktop acceptance mode."""
    return bool(SOURCE_SETTINGS["offline_ui"])


def source_enabled(source: str) -> bool:
    return source in ENABLED_SOURCES
