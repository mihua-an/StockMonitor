"""Training data settings (設定 → 資料儲存 → 模型訓練資料): how long the derived training data is kept, and how many
trading dates one training run uses.

One config domain, ``training_data`` (config/config_revisions.py), active on save; the training job reads the
active revision at every run (service/analysis/online_training/job.py):

* ``retention_days`` -- how many trading dates of training data (the per-date feature shards and the daily summaries
  under the storage location, config/var_layout.json "storage") are kept; ``null`` = forever, the default (user
  10-22). The raw history has its own retention (``storage_retention``): the training data is derived from it, kept
  after the raw data is gone, and cannot be derived again once both are gone.
* ``window_trading_days`` -- how many of the newest 完整 trading dates (every stock's ticks reconcile) one run trains
  on; the incomplete dates the window reaches (since the first of them, or within the newest that many trading dates)
  are test data only (service/analysis/online_training/job.training_window).
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

MAX_RETENTION_DAYS = 3650
MAX_WINDOW_TRADING_DAYS = 250
DEFAULTS: dict[str, Any] = {"retention_days": None, "window_trading_days": 20}


def _problem(code: str, message: str) -> dict[str, Any]:
    return {"code": code, "message": message}


def _whole(value: Any) -> bool:
    # bool is an int in Python: True is not "1 day".
    return isinstance(value, int) and not isinstance(value, bool)


def validate(values: dict[str, Any]) -> list[dict[str, Any]]:
    values = values if isinstance(values, dict) else {}
    problems: list[dict[str, Any]] = []
    for name in sorted(set(values) - set(DEFAULTS)):
        problems.append(_problem("UNKNOWN_FIELD", f"unknown field {name!r}"))
    days = values.get("retention_days")
    if "retention_days" not in values or (days is not None and not (_whole(days) and 1 <= days <= MAX_RETENTION_DAYS)):
        problems.append(_problem("RETENTION_DAYS", f"retention_days must be null (forever) or 1..{MAX_RETENTION_DAYS}"))
    window = values.get("window_trading_days")
    if not (_whole(window) and 1 <= window <= MAX_WINDOW_TRADING_DAYS):
        problems.append(_problem("WINDOW_TRADING_DAYS", f"window_trading_days must be 1..{MAX_WINDOW_TRADING_DAYS}"))
    return problems


def training_data(config_root: Path | None = None) -> dict[str, Any]:
    """The active revision; the defaults while none exists. A revision that does not validate is an error, never
    quietly replaced by the defaults (the training job reports it)."""
    from config.config_revisions import ConfigRevisionStore, config_root as default_config_root

    document = ConfigRevisionStore(config_root or default_config_root(), "training_data").active()
    if not document:
        return dict(DEFAULTS)
    values = document.get("values")
    problems = validate(values)
    if problems:
        raise ValueError(f"training_data revision {document.get('revision')}: " + "; ".join(p["message"] for p in problems))
    return {name: values[name] for name in DEFAULTS}
