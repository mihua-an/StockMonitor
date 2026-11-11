"""Labels for online-v2 samples, per prediction horizon from the authority.

The price path after each sample is Rust B's (future-path-v1, computed in the same pass as the features, see
native/analysis_runtime/src/dataset.rs): per horizon h, either state OK with ``max`` / ``min`` = the extreme of the
key's own prints in (t, t+h] relative to the sample's last_price, or a state saying why there is no path. This module
only applies the barriers (label-online-v2):

* label_up_{h}m   = 1 when max >= barrier_up,   else 0;
* label_down_{h}m = 1 when min <= barrier_down, else 0;
* NOT AVAILABLE (NaN) -- never a 0 -- when the state is not OK (TAIL_INSUFFICIENT, NO_FUTURE_PRICE, NO_PRICE).

Each horizon is labelled from its own window: changing the horizon never reuses another's label.
"""
from __future__ import annotations

import math
from typing import Any, Mapping

from config.settings import LABEL_BARRIER_DOWN, LABEL_BARRIER_UP

LABEL_POLICY: dict[str, Any] = {
    "version": "label-online-v2",
    "barrier_up": LABEL_BARRIER_UP,
    "barrier_down": LABEL_BARRIER_DOWN,
    "path": "future-path-v1 (Rust B): the key's own prints in (t, t+h], non-simtrade trade.price, quote.current > 0",
    "unavailable": ["TAIL_INSUFFICIENT", "NO_FUTURE_PRICE", "NO_PRICE"],
}

MINUTE_NS = 60_000_000_000


def label_columns(minutes: int) -> tuple[str, str]:
    return f"label_up_{int(minutes)}m", f"label_down_{int(minutes)}m"


def label(future: Mapping[str, Any] | None) -> tuple[float, float, str]:
    """(up, down, state) for one sample's future path at one horizon."""
    if not isinstance(future, Mapping):
        return math.nan, math.nan, "NO_PATH"
    state = str(future.get("state") or "NO_PATH")
    if state != "OK":
        return math.nan, math.nan, state
    high, low = future.get("max"), future.get("min")
    if not (isinstance(high, (int, float)) and isinstance(low, (int, float))):
        return math.nan, math.nan, "NO_PATH"
    up = 1.0 if float(high) >= LABEL_POLICY["barrier_up"] else 0.0
    down = 1.0 if float(low) <= LABEL_POLICY["barrier_down"] else 0.0
    return up, down, "OK"
