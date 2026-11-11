"""Tunable parameters, grouped by domain (AGENTS.md section 3).

Install defaults only. The trade-flow rule values that the
user can edit are versioned by settings_api (the `flow_rules` domain -- LARGE_ORDER_FALLBACK_VOLUME below is only the
seed of its first revision); process lifecycle timeouts belong to Health; market-data capacity belongs to
market_runtime. Nothing here is read on the per-event market path.
"""
from __future__ import annotations


# --- Trade-flow classification (install defaults; see module docstring) ---------------------------------------
# A print is large when it alone reaches LARGE_ORDER_FALLBACK_VOLUME, or when the same-side attack it belongs to
# (prints <= LARGE_ORDER_EPISODE_GAP_MS apart, best price not retreating) has consumed LARGE_ORDER_IMPACT_RATIO of
# the opposite best-level liquidity it met. These seed the first flow_rules revision; Rust B applies the active one
# (it is the only large-order classifier).
# User 10-14: 50 lots for a single print and for an attack's total. The impact rule keeps its 50-lot floor (fraction
# 1.0 of the threshold) and an attack's member stays a print of at least 10 lots (fraction 0.2).
LARGE_ORDER_FALLBACK_VOLUME = 50.0
LARGE_ORDER_IMPACT_MIN_FRACTION = 1.0
LARGE_ORDER_MEMBER_MIN_FRACTION = 0.2
LARGE_ORDER_IMPACT_RATIO = 0.30
LARGE_ORDER_EPISODE_GAP_MS = 1500
LARGE_ORDER_EPISODE_MAX_MS = 3000

# --- Model training labels (label-online-v2; when and what to train is config/model_training.json) --------------
LABEL_BARRIER_UP = 0.010
LABEL_BARRIER_DOWN = -0.005

