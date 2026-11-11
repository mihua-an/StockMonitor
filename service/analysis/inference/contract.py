"""The training side's half of the inference contract: horizon authority, model manifest, categorical missing token.

The FeatureSpec is NOT defined here. Rust B is the only implementation of the features and the
only holder of the spec (native/analysis_runtime/spec/feature_spec_online_v3.json, embedded in the binary). Python
learns the spec identity from B -- the dataset manifest B writes, ``analysis_runtime --feature-spec``, or B's status
file -- and only ever copies it: dataset -> model manifest -> B, which refuses a model bound to any other digest.

* the prediction horizon is not the feature lookback window. Predicting 5 minutes ahead may look
  at any window the FeatureSpec defines.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Iterable, Mapping

from service.platform import project_root as process_paths

#: The config protocol Rust B reads (native/analysis_runtime/src/contract.rs PROTOCOL).
PROTOCOL = "analysis-worker-v1"

MODEL_MANIFEST_SCHEMA = "model-manifest-v1"


#: Model artifact formats Rust B understands: ONNX models and its builtin TEST_ONLY predictor.
KNOWN_MODEL_FORMATS = ("onnx", "builtin-test")


class ContractError(ValueError):
    """A contract object that must be refused rather than repaired."""


# --------------------------------------------------------------------------- horizon authority
@dataclass(frozen=True)
class HorizonAuthority:
    version: int
    allowed_minutes: tuple[int, ...]
    default_enabled_minutes: tuple[int, ...]
    directions: tuple[str, ...]

    def validate_enabled(self, minutes: Iterable[Any]) -> tuple[int, ...]:
        """The enabled horizons, or ContractError naming the first one that is not allowed.

        Never falls back to another horizon: an unsupported request is refused outright.
        """
        chosen: list[int] = []
        for raw in minutes:
            try:
                value = int(raw)
            except (TypeError, ValueError):
                raise ContractError(f"horizon {raw!r} is not an integer number of minutes") from None
            if value not in self.allowed_minutes:
                raise ContractError(
                    f"horizon {value}m is not allowed (allowed: {list(self.allowed_minutes)})")
            if value not in chosen:
                chosen.append(value)
        if not chosen:
            raise ContractError("no prediction horizon enabled")
        return tuple(sorted(chosen))


def _parse_horizon_authority(data: Mapping[str, Any]) -> HorizonAuthority:
    if data.get("schema") != "prediction-horizons-v1":
        raise ContractError(f"unknown horizon authority schema {data.get('schema')!r}")
    allowed = tuple(int(x) for x in data.get("allowed_minutes") or ())
    directions = tuple(str(x) for x in data.get("directions") or ())
    if not allowed or any(x <= 1 for x in allowed):
        raise ContractError("allowed_minutes must be non-empty and exclude 1-minute prediction")
    if directions != ("up", "down"):
        raise ContractError(f"directions must be ['up', 'down'], got {list(directions)}")
    authority = HorizonAuthority(
        version=int(data.get("version") or 0),
        allowed_minutes=allowed,
        default_enabled_minutes=(),
        directions=directions,
    )
    if authority.version <= 0:
        raise ContractError("horizon authority version must be positive")
    enabled = authority.validate_enabled(data.get("default_enabled_minutes") or ())
    return HorizonAuthority(authority.version, allowed, enabled, directions)


@lru_cache(maxsize=1)
def load_horizon_authority() -> HorizonAuthority:
    with open(process_paths.PROJECT_ROOT / "config" / "prediction_horizons.json", "r", encoding="utf-8") as handle:
        return _parse_horizon_authority(json.load(handle))


def prediction_key(horizon_minutes: int, direction: str) -> str:
    """Wire key of one prediction entry, e.g. ``"3m_up"``. The renderer reads exactly this."""
    return f"{int(horizon_minutes)}m_{direction}"


# --------------------------------------------------------------------------- categorical missing token
#: Rust B normalises a missing category to this token (features.rs normalize_category); the trainer's one-hot uses
#: the same rule so a training row and an online row of the same state encode the same way.
MISSING_TOKEN = "__MISSING__"


def normalize_category(value: Any) -> str:
    """None / NaN / empty-after-strip become MISSING_TOKEN; other text is kept after strip (no case folding)."""
    if value is None:
        return MISSING_TOKEN
    if isinstance(value, float):
        if math.isnan(value):
            return MISSING_TOKEN
        value = repr(value)
    text = str(value).strip()
    return text if text else MISSING_TOKEN


# --------------------------------------------------------------------------- ModelManifest
_MANIFEST_FIELDS = ("schema", "model_id", "model_version", "artifact", "runtime", "feature_spec",
                    "io", "horizon_minutes", "direction", "label_version", "dataset_version",
                    "training_run_id", "horizon_authority_version", "validation", "test_only")


def validate_model_manifest(manifest: Mapping[str, Any], authority: HorizonAuthority) -> list[str]:
    """Problems that make a manifest unusable for ANY worker, independent of this build."""
    problems: list[str] = []
    for name in _MANIFEST_FIELDS:
        if name not in manifest:
            problems.append(f"missing field {name}")
    if manifest.get("schema") != MODEL_MANIFEST_SCHEMA:
        problems.append(f"schema {manifest.get('schema')!r} is not {MODEL_MANIFEST_SCHEMA}")
    try:
        horizon = int(manifest.get("horizon_minutes"))
    except (TypeError, ValueError):  # not an error: a horizon that is not a number is reported as a manifest problem below
        horizon = None
    if horizon not in authority.allowed_minutes:
        problems.append(f"horizon {manifest.get('horizon_minutes')!r} is not an allowed prediction horizon")
    if manifest.get("direction") not in authority.directions:
        problems.append(f"direction {manifest.get('direction')!r} is not one of {list(authority.directions)}")
    artifact = manifest.get("artifact") if isinstance(manifest.get("artifact"), Mapping) else {}
    if artifact.get("format") not in KNOWN_MODEL_FORMATS:
        problems.append(f"artifact format {artifact.get('format')!r} is not recognised")
    if artifact.get("format") != "builtin-test" and not artifact.get("sha256"):
        problems.append("artifact sha256 is required")
    feature = manifest.get("feature_spec") if isinstance(manifest.get("feature_spec"), Mapping) else {}
    for name in ("spec_id", "schema_digest", "feature_version", "preprocessing_version"):
        if not feature.get(name):
            problems.append(f"feature_spec.{name} is required")
    io = manifest.get("io") if isinstance(manifest.get("io"), Mapping) else {}
    if artifact.get("format") == "onnx":
        for name in ("input", "output", "class_index", "numeric", "categorical", "category_vocab"):
            if name not in io:
                problems.append(f"io.{name} is required for an onnx model")
        scope = manifest.get("scope") if isinstance(manifest.get("scope"), Mapping) else {}
        if not scope.get("sources") or not scope.get("markets"):
            problems.append("scope.sources and scope.markets (what the model was trained on) are required")
    if artifact.get("format") == "builtin-test" and manifest.get("test_only") is not True:
        problems.append("a builtin-test artifact must be marked test_only")
    return problems
