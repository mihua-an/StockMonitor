"""Storage settings (設定 → 資料儲存): how much raw history each source keeps, and where the growing data lives.

Two config domains (config/config_revisions.py), because they take effect differently:

* ``storage_retention`` -- per source, whether its raw history (tick / bidask partitions under the historical root)
  is kept after its session, for how many trading dates (``retention_days``; ``null`` = forever), and for Shioaji
  which kinds of data (``keep``, CATEGORIES below). Active on save;
  Market Runtime (Rust A) reads the active revision on every prune -- each pre-open rollover and once a minute.
  A source that is not kept still has its current session on disk: it is shown live, after the close and across
  restarts until the next session's pre-open, and only then removed (the user's rule: a day's data stays viewable
  until the next session begins). Defaults: Shioaji kept 3 trading dates, Futu not kept.
* ``storage_location`` -- the folder for everything that grows without bound (``historical_root``; ``null`` = the
  data root's default, config/var_layout.json "storage"): the raw history at its root and the children var_layout
  names under it (B's rule events, the model datasets and registry). Saved as the desired revision only; Health
  prepares everything StockMonitor owns there (on another drive, by copying beside the running App) and activates it
  at a full start, before any service starts, so every process reads ONE root.

Readers use :func:`historical_root` (the active location) and :func:`storage_paths` (its children). The same rules
in Node: config/js/storage_settings.js.
"""
from __future__ import annotations

from pathlib import Path, PureWindowsPath
from typing import Any

SOURCES = ("shioaji", "futu")
MAX_RETENTION_DAYS = 3650
# 資料儲存 → Shioaji → 要儲存哪些 (user 11-01): 大盤 (the indexes), 台指 near month and far months, 個股 spot and
# futures. ``keep`` names each with a boolean; absent, everything is kept. A kind not kept is removed like a source not
# kept (at the next session's pre-open); the retention days apply to the kinds kept. Market Runtime prunes by it
# (native/market_runtime/src/storage.rs CATEGORIES, the same names).
CATEGORIES = ("index", "txf_near", "txf_far", "stock", "stock_futures")
DEFAULT_RETENTION: dict[str, Any] = {
    "sources": {
        "shioaji": {"persist": True, "retention_days": 3},
        "futu": {"persist": False, "retention_days": None},
    },
}
DEFAULT_LOCATION: dict[str, Any] = {"historical_root": None}
# Written by Health into a history folder it moved the store to (config/js/storage_settings.js MARKER).
MARKER = ".stock-monitor-historical.json"


def _problem(code: str, message: str, **extra: Any) -> dict[str, Any]:
    return {"code": code, "message": message, **extra}


def validate_retention(values: dict[str, Any]) -> list[dict[str, Any]]:
    sources = (values or {}).get("sources")
    if not isinstance(sources, dict):
        return [_problem("SOURCES", "sources must be an object keyed by source")]
    problems: list[dict[str, Any]] = []
    for source in sorted(set(sources) - set(SOURCES)):
        problems.append(_problem("UNKNOWN_SOURCE", f"unknown source {source!r}", source=source))
    for source in SOURCES:
        entry = sources.get(source)
        if not isinstance(entry, dict):
            problems.append(_problem("SOURCE", f"{source} must be an object", source=source))
            continue
        if not isinstance(entry.get("persist"), bool):
            problems.append(_problem("PERSIST", "persist must be a JSON boolean", source=source))
        days = entry.get("retention_days")
        # bool is an int in Python: True is not "1 day".
        if days is not None and (isinstance(days, bool) or not isinstance(days, int) or not 1 <= days <= MAX_RETENTION_DAYS):
            problems.append(_problem("RETENTION_DAYS", f"retention_days must be null (forever) or 1..{MAX_RETENTION_DAYS}", source=source))
        unknown = sorted(set(entry) - {"persist", "retention_days", "keep"})
        if unknown:
            problems.append(_problem("UNKNOWN_FIELD", f"unknown field {unknown[0]!r}", source=source))
        if "keep" in entry:
            keep = entry["keep"]
            if source != "shioaji":
                problems.append(_problem("KEEP", "keep is only for shioaji", source=source))
            elif (not isinstance(keep, dict) or set(keep) != set(CATEGORIES)
                  or not all(isinstance(value, bool) for value in keep.values())):
                problems.append(_problem("KEEP", f"keep must name each of {list(CATEGORIES)} with a JSON boolean", source=source))
    return problems


def validate_location(values: dict[str, Any]) -> list[dict[str, Any]]:
    root = (values or {}).get("historical_root")
    if root is None:
        return []
    if not isinstance(root, str) or not root.strip():
        return [_problem("HISTORICAL_ROOT", "historical_root must be null (default) or a folder path")]
    text = root.strip()
    if not (Path(text).is_absolute() or PureWindowsPath(text).is_absolute()):
        return [_problem("HISTORICAL_ROOT", "historical_root must be an absolute path", path=text)]
    anchor = Path(PureWindowsPath(text).anchor or Path(text).anchor)
    if not anchor.exists():
        return [_problem("HISTORICAL_ROOT_DRIVE", f"{anchor} does not exist", path=text)]
    folder = Path(text)
    try:
        names = [entry.name for entry in folder.iterdir()] if folder.is_dir() else []
    except OSError as exc:  # not an error: answered to the caller with the reason
        return [_problem("HISTORICAL_ROOT_UNREADABLE", f"{folder} cannot be read: {type(exc).__name__}", path=text)]
    # Health moves only what StockMonitor owns and never merges into another folder (config/js/storage_settings.js):
    # a folder holding anything else must be refused here, not discovered at the next start.
    if names and MARKER not in names:
        return [_problem("HISTORICAL_ROOT_NOT_EMPTY", "the folder is not empty and is not a StockMonitor history folder; "
                         "choose an empty folder", path=text)]
    return []


def _active_values(domain: str, config_root: Path | None) -> dict[str, Any] | None:
    from config.config_revisions import ConfigRevisionStore, config_root as default_config_root

    document = ConfigRevisionStore(config_root or default_config_root(), domain).active()
    values = (document or {}).get("values")
    return values if isinstance(values, dict) else None


def retention(config_root: Path | None = None) -> dict[str, Any]:
    """The active retention, falling back to the defaults for a source the revision does not name."""
    values = _active_values("storage_retention", config_root) or {}
    saved = values.get("sources") if isinstance(values.get("sources"), dict) else {}
    return {"sources": {source: {**DEFAULT_RETENTION["sources"][source], **(saved.get(source) or {})} for source in SOURCES}}


def historical_root(config_root: Path | None = None, data_root: Path | None = None) -> Path:
    """The active storage location (``storage_location``): it holds the materialized raw history at its root."""
    from service.platform.project_root import storage_default_root

    values = _active_values("storage_location", config_root) or {}
    root = values.get("historical_root")
    if isinstance(root, str) and root.strip():
        return Path(root.strip())
    if data_root is None:
        from service.platform.project_root import DATA_ROOT

        data_root = DATA_ROOT
    return storage_default_root(Path(data_root))


def storage_paths(config_root: Path | None = None, data_root: Path | None = None):
    """The active storage location's children (config/var_layout.json "storage"): B's events, the model datasets and
    registry. Returns service.platform.project_root.StoragePaths."""
    from service.platform.project_root import storage_paths as children_of

    return children_of(historical_root(config_root, data_root))


def location_apply_operation(config_root: Path | None = None) -> dict[str, Any] | None:
    """The last folder move Health ran (``storage_location/apply_operation.json``): its state, error and the running
    copy's progress, for the settings page. None when no move has run."""
    import json

    from config.config_revisions import config_root as default_config_root

    path = Path(config_root or default_config_root()) / "storage_location" / "apply_operation.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:  # not an error: no move has run yet
        return None
    except (OSError, ValueError) as exc:  # not an error: answered to the caller with the reason
        return {"state": "unreadable", "error": f"{type(exc).__name__}: {exc}"}
    keys = ("operation_id", "revision", "from", "to", "mode", "state", "error", "started_at", "updated_at", "progress", "last_pass", "synced_at")
    return {key: value.get(key) for key in keys} if isinstance(value, dict) else {"state": "unreadable", "error": "not an object"}
