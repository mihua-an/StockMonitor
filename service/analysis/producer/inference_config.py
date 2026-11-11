"""The one versioned inference configuration (docs/system-architecture/05 section 2).

model_api owns the enabled prediction horizons (3/5/10/15/30, default 3 and 5; never 1 minute) as its own config
domain ``model_options``; Settings only delegates edits to it. Slots carry only registry-checked manifests, or the
registry's reason a slot has none (``no_model``). Every change is a new config_version: the producer learns it first
and refuses results computed under the old one.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
from typing import Any, Callable

from service.analysis.inference.contract import PROTOCOL, load_horizon_authority

TEST_ONLY_ENV = "STOCKMONITOR_INFERENCE_TEST_ONLY"


def test_only_requested() -> bool:
    return str(os.environ.get(TEST_ONLY_ENV) or "").strip() == "1"


class InferenceConfigAuthority:
    DOMAIN = "model_options"

    def __init__(self, *, slots_provider: Callable[[int, str], dict[str, Any]] | None = None,
                 store: Any = None, test_only: bool | None = None, limits: dict[str, int] | None = None) -> None:
        self._authority = load_horizon_authority()
        self._slot_models = slots_provider
        self._store = store
        self._test_only = test_only_requested() if test_only is None else bool(test_only)
        # queue_capacity and task_ttl_ms follow every config. workers and feature_capture are startup-only in Rust B:
        # a change is reported as restart_required in B's status, not applied.
        self._limits = {"queue_capacity": 4096, "workers": 1, "task_ttl_ms": 5000, **(limits or {})}
        self._lock = threading.Lock()
        self._version = 0
        self._fingerprint: str | None = None

    def snapshot(self) -> tuple[tuple[int, ...], int | None]:
        """The enabled horizons and the revision they came from, both from ONE read of the active document.

        Only a missing ``enabled_minutes`` (no saved document, or one that never set it) means the default; a saved
        value -- an empty list included -- is validated like any other and refused when invalid."""
        active = self._store.active() if self._store is not None else None
        values = (active or {}).get("values") or {}
        minutes = values["enabled_minutes"] if "enabled_minutes" in values else self._authority.default_enabled_minutes
        return self._authority.validate_enabled(minutes), (active or {}).get("revision")

    def enabled_minutes(self) -> tuple[int, ...]:
        return self.snapshot()[0]

    def revision(self) -> int | None:
        return self.snapshot()[1]

    def _slots(self, minutes: tuple[int, ...]) -> list[dict[str, Any]]:
        slots = []
        for m in minutes:
            for direction in self._authority.directions:
                model = self._slot_models(m, direction) if self._slot_models else {}
                slots.append({"horizon_minutes": m, "direction": direction, **model})
        return slots

    def current(self) -> dict[str, Any]:
        minutes, revision = self.snapshot()
        body = {"protocol": PROTOCOL, "horizon_authority_version": self._authority.version,
                "allowed_minutes": list(self._authority.allowed_minutes), "slots": self._slots(minutes),
                "test_only_predictor": self._test_only, "test_faults": {}, "model_options_revision": revision, **self._limits}
        fingerprint = hashlib.sha256(json.dumps(body, sort_keys=True, allow_nan=False).encode()).hexdigest()
        with self._lock:
            # Derived from the content, not counted per process: Rust B keeps running the config file across a
            # model_api restart, and the same config must keep the same version there (a counter restarting at 1
            # would have read as a change and disabled every published signal).
            self._fingerprint = fingerprint
            self._version = int(fingerprint[:13], 16) or 1
            return {"config_version": self._version, **body}
