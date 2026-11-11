"""Feature switches: what the user WANTS enabled (AGENTS.md sections 3-4).

`feature_settings.json` (install default) <- STOCK_MONITOR_SHIOAJI_MODEL_* env overrides. Both are parsed strictly
(config/flags.py): a JSON value must be a real boolean -- the string "false" is an error, never "on" because it is
non-empty -- and an env value must be one of the recognised spellings.

A switch is the user's intent only. Whether the feature can actually run (a model is loaded, the worker is up) is
a capability the owning service reports (model_api); `status()` keeps the two apart and derives the effective
value from both, so an enabled switch never reads as a working feature.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from config.flags import parse_flag

FEATURES = ("model_inference", "model_training")
ENV = {"model_inference": "STOCK_MONITOR_SHIOAJI_MODEL_INFERENCE", "model_training": "STOCK_MONITOR_SHIOAJI_MODEL_TRAINING"}


@dataclass(frozen=True)
class ShioajiFeatureSettings:
    model_inference: bool = True
    model_training: bool = True
    sources: tuple[tuple[str, str], ...] = ()

    def source_of(self, feature: str) -> str:
        return dict(self.sources).get(feature, "default")

    def status(self, capabilities: Mapping[str, Any] | None = None) -> dict[str, dict[str, object]]:
        """desired (this switch) / capability (reported by the owning service, None = not reported) / effective."""
        capabilities = capabilities or {}
        out: dict[str, dict[str, object]] = {}
        for feature in FEATURES:
            desired = bool(getattr(self, feature))
            capable = capabilities.get(feature)
            capable = None if capable is None else bool(capable)
            out[feature] = {"desired": desired, "source": self.source_of(feature), "capability": capable,
                            "effective": desired and capable is True,
                            "reason": None if desired and capable else ("disabled by setting" if not desired
                                                                         else "capability not reported" if capable is None
                                                                         else "not available")}
        return out


def load_feature_settings(env: Mapping[str, str] | None = None, path: Path | None = None) -> ShioajiFeatureSettings:
    env = os.environ if env is None else env
    raw = json.loads((path or Path(__file__).with_suffix(".json")).read_text(encoding="utf-8"))
    shioaji = raw.get("shioaji") or {}
    if not isinstance(shioaji, dict):
        raise ValueError("feature_settings.json: 'shioaji' must be an object")
    values: dict[str, bool] = {}
    sources: list[tuple[str, str]] = []
    for feature in FEATURES:
        default, source = True, "default"
        if feature in shioaji:
            if not isinstance(shioaji[feature], bool):
                raise ValueError(f"feature_settings.json shioaji.{feature} must be a JSON boolean, got {shioaji[feature]!r}")
            default, source = shioaji[feature], "file"
        if str(env.get(ENV[feature]) or "").strip():
            source = "env"
        values[feature] = parse_flag(env.get(ENV[feature]), name=ENV[feature], fallback=default)
        sources.append((feature, source))
    return ShioajiFeatureSettings(**values, sources=tuple(sources))


SHIOAJI_FEATURES = load_feature_settings()
