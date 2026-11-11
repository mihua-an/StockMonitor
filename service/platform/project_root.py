"""Single authority for the StockMonitor project root and the var/ runtime layout (data, output, state, logs, temp) and the separate per-user AUTH_ROOT.

Nothing is resolved at import (F1): importing this module reads no file and no environment variable, so any module
can import it, and a process that sets STOCK_MONITOR_VAR_ROOT / STOCK_MONITOR_PROJECT_ROOT before its first use of a
path gets that path. Each value is resolved on first use and then fixed for the process:

  - the functions ``project_root()``, ``runtime_paths()`` and ``storage_paths()`` (the children of a storage location);
  - the module attributes ``PROJECT_ROOT``, ``VAR_ROOT``, ``DATA_ROOT``, ``OUTPUT_ROOT``, ``STATE_ROOT``,
    ``LOG_ROOT``, ``TEMP_ROOT``, ``CONFIG_ROOT`` and ``AUTH_ROOT`` (PEP 562), for the composition roots that read them.

Reusable modules do not read these: they take their paths as arguments, and the process's entry point (a daemon,
an API, a script) passes them.
"""
from __future__ import annotations

import functools
import json
import os
from dataclasses import dataclass
from pathlib import Path


_ROOT_ENV = "STOCK_MONITOR_PROJECT_ROOT"
_MARKERS = ("main.py", "service", "config")


def _validate(root: Path) -> Path:
    root = root.expanduser().resolve()
    missing = [marker for marker in _MARKERS if not (root / marker).exists()]
    if missing:
        raise RuntimeError(f"Invalid StockMonitor project root {root}: missing {', '.join(missing)}")
    return root


@functools.cache
def project_root() -> Path:
    configured = os.environ.get(_ROOT_ENV)
    if configured:
        return _validate(Path(configured))
    here = Path(__file__).resolve()
    for candidate in (here, *here.parents):
        if all((candidate / marker).exists() for marker in _MARKERS):
            return candidate
    raise RuntimeError(f"Unable to discover StockMonitor project root from {here}")


# ---------------------------------------------------------------------------------------------------------------
# var/ layout: the ONE description of every writable runtime location lives in config/var_layout.json. This module
# (Python) and config/js/var_paths.js (Node) both resolve from it with the same rules; tests/var_layout_parity_contract.cjs
# proves they agree. Native/Rust receives explicit --data-dir arguments from the launcher and never guesses a path.
#
#   VAR_ROOT = $STOCK_MONITOR_VAR_ROOT, else <PROJECT_ROOT>/var   (the launcher sets it once for a packaged app, where the
#                                                                  install directory is not writable)
#   <child>  = first set env override of that child, else VAR_ROOT/<dir>
#   A retired env name ("retired_env") is refused, never ignored: an ignored data-root override would put that run's
#   data into the live root.
#   AUTH_ROOT = $STOCK_MONITOR_AUTH_ROOT, else the flavor's per-user directory. It is NOT under VAR_ROOT: it holds only
#   secret material (local IPC tokens). Broker credentials are not files at all (Windows Credential Manager).
# ---------------------------------------------------------------------------------------------------------------
@functools.cache
def _layout() -> dict:
    return json.loads((project_root() / "config" / "var_layout.json").read_text(encoding="utf-8"))


def _first_env(names) -> Path | None:
    for name in names:
        configured = str(os.environ.get(name) or "").strip()
        if configured:
            return Path(configured).expanduser().resolve()
    return None


@dataclass(frozen=True)
class RuntimePaths:
    """Every writable location of this process, resolved once from config/var_layout.json and the environment."""

    project_root: Path
    var_root: Path
    data_root: Path
    output_root: Path
    state_root: Path              # daemon lock / owner / health / startup metadata (no secrets)
    log_root: Path
    temp_root: Path
    config_root: Path             # versioned config revisions, Health operations, bootstrap records


class RetiredEnvironmentVariable(RuntimeError):
    """The environment sets a variable this layout no longer reads."""


def refuse_retired_env(env=None) -> None:
    """Raise when any retired layout variable is set (config/var_layout.json "retired_env")."""
    env = os.environ if env is None else env
    retired = (_layout().get("retired_env") or {}).get("names") or {}
    found = sorted(name for name in retired if str(env.get(name) or "").strip())
    if found:
        raise RetiredEnvironmentVariable(
            "retired environment variable(s) set: "
            + ", ".join(f"{name} (use {retired[name]})" for name in found))


@functools.cache
def runtime_paths() -> RuntimePaths:
    layout = _layout()
    refuse_retired_env()
    root = project_root()
    var_root = _first_env([layout["root_env"]]) or (root / layout["default_root"]).resolve()

    def child(name: str) -> Path:
        spec = layout["children"][name]
        return _first_env(spec["env"]) or (var_root / spec["dir"])

    return RuntimePaths(
        project_root=root,
        var_root=var_root,
        data_root=child("data"),
        output_root=child("output"),
        state_root=child("state"),
        log_root=child("logs"),
        temp_root=child("temp"),
        config_root=child("config"),
    )


@dataclass(frozen=True)
class StoragePaths:
    """config/var_layout.json "storage": what lives under the user's storage location. ``root`` itself holds the
    raw-history partitions; the rest are the children that grow without bound."""

    root: Path
    analysis_events: Path       # Rust B's rule-event archive, one file per trading date
    model_datasets: Path        # training datasets and their per-date feature shards
    daily_summary: Path         # per-session daily summaries (training data, native/analysis_runtime/src/daily_summary.rs)
    kbars: Path                 # 技術分析's K bars, one file per product (native/analysis_runtime/src/kbar_store.rs)
    model_registry: Path        # registered ONNX models and the champion per horizon/direction
    query_cache: Path           # closed sessions fetched for a view (service/market/history/query_cache.py)


def storage_default_root(data_root: Path) -> Path:
    """The storage location when the user picked none: under this process's data root."""
    return Path(data_root) / _layout()["storage"]["default_dir"]


def storage_paths(storage_root: Path) -> StoragePaths:
    """The children of the storage location ``storage_root`` (the active one comes from config/storage_settings.py)."""
    children = _layout()["storage"]["children"]
    root = Path(storage_root)
    return StoragePaths(root=root, **{name: root.joinpath(*rel.split("/")) for name, rel in children.items()})


def storage_owned_entry(name: str) -> bool:
    """Whether the top-level entry ``name`` of a storage location is StockMonitor's: what a move carries."""
    spec = _layout()["storage"]
    return (any(name.startswith(prefix) for prefix in spec["root_prefixes"])
            or name in {rel.split("/")[0] for rel in spec["children"].values()})


def install_flavor() -> str:
    """"source" (the default) or "installed": which per-user directories this process uses (var_layout.json "flavors";
    the launcher sets STOCK_MONITOR_INSTALL_FLAVOR once). Same rule as config/js/var_paths.js installFlavor()."""
    layout = _layout()
    value = str(os.environ.get(layout["flavor_env"]) or "").strip().lower() or "source"
    if value not in layout["flavors"]:
        raise RuntimeError(f"{layout['flavor_env']}={value} is not a known flavor ({', '.join(layout['flavors'])})")
    return value


# A process launched with a scrubbed environment -- no %LOCALAPPDATA%, no USERPROFILE/HOMEDRIVE, e.g. a subprocess
# given an explicit env= dict -- makes Path.home() raise; only code that actually reads or writes a token can then
# fail, with a message naming the override that fixes it. There is no silent fallback to another directory (temp,
# cwd, ...): forking the token location is worse than a clear failure, since every client reads the token from
# exactly one place (daemon_auth.py).
def _resolve_auth_root() -> Path:
    layout = _layout()
    spec = layout["auth_root"]
    explicit = _first_env(spec["env"])
    if explicit:
        return explicit
    auth_dir = layout["flavors"][install_flavor()][spec["dir_from_flavor"]]
    base = str(os.environ.get(spec["base_env"]) or "").strip()
    if base:
        return Path(base).expanduser().resolve().joinpath(*auth_dir)
    try:
        home = Path.home()
    except RuntimeError as exc:                          # no HOME/USERPROFILE/HOMEDRIVE either
        raise RuntimeError(
            f"cannot resolve AUTH_ROOT: neither {spec['base_env']} nor a home directory is set in this "
            f"environment; set {spec['env'][0]} to a per-user writable directory"
        ) from exc
    return home.joinpath(*spec["base_fallback"]).resolve().joinpath(*auth_dir)


# AUTH_ROOT: local IPC tokens ONLY (client / controller / daemon); never packaged, never in the repo.
_AUTH_ROOT: Path | None = None

_PATH_ATTRIBUTES = {
    "VAR_ROOT": "var_root", "DATA_ROOT": "data_root", "OUTPUT_ROOT": "output_root", "STATE_ROOT": "state_root",
    "LOG_ROOT": "log_root", "TEMP_ROOT": "temp_root", "CONFIG_ROOT": "config_root",
}


def __getattr__(name: str):
    global _AUTH_ROOT
    if name == "PROJECT_ROOT":
        return project_root()
    if name in _PATH_ATTRIBUTES:
        return getattr(runtime_paths(), _PATH_ATTRIBUTES[name])
    if name == "AUTH_ROOT":
        if _AUTH_ROOT is None:
            _AUTH_ROOT = _resolve_auth_root()
        return _AUTH_ROOT
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
