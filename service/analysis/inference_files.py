"""The two files between model_api and Rust B, replacing the producer IPC.

* ``config.json`` -- the inference config (enabled horizons, champion manifests, limits). model_api writes it whenever
  it changes; Rust B reads it on its own, so a stopped FastAPI leaves B running the last config.
* ``status.json`` -- Rust B's capability per slot and the health of its signal authority, rewritten every 2 s. model_api's
  status routes read it.

Both live in ``<DATA_ROOT>/<analysis_runtime data dir>/inference`` (Health passes the same dir to B as
``--inference-dir``). Rust B validates and publishes its own model signals to Market Runtime; nothing here is on the
signal path.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Mapping
import logging
from service.platform.atomic_files import read_text_shared, write_bytes_atomic
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)

CONFIG_FILE = "config.json"
STATUS_FILE = "status.json"
# What native/analysis_runtime/src/runtime/inference_runtime.rs writes; any other document is not B's status.
STATUS_SCHEMA = "analysis-inference-status-v1"
# B rewrites its status every 2 s: older than this, B is not running (or not writing).
STATUS_STALE_SECONDS = 10.0


def inference_dir() -> Path:
    explicit = str(os.environ.get("STOCK_MONITOR_INFERENCE_DIR") or "").strip()
    if explicit:
        return Path(explicit)
    from config.system_contract import data_child
    from service.platform.project_root import DATA_ROOT

    return Path(DATA_ROOT) / data_child("analysis_runtime") / "inference"


def write_config(config: Mapping[str, Any], directory: Path | None = None) -> bool:
    """Atomically write the config when its content changed. Returns whether it wrote. A value JSON cannot hold is a
    TypeError for the caller to report, never written as its str() for Rust B to misread."""
    target = Path(directory or inference_dir())
    target.mkdir(parents=True, exist_ok=True)
    path = target / CONFIG_FILE
    text = json.dumps({"type": "config", **dict(config)}, sort_keys=True, separators=(",", ":"), allow_nan=False)
    try:
        if read_text_shared(path) == text:
            return False
    except FileNotFoundError:  # not an error: no file yet, so it is written
        pass
    except OSError as exc:
        record_failure(_failure_log, "reading the current inference file before rewriting it", exc)
    write_bytes_atomic(path, text.encode("utf-8"))
    return True


def _unavailable(reason: str) -> dict[str, Any]:
    # A status file that exists but cannot be used: reported with why, and never fresh (no capability, no digest).
    return {"available": False, "unavailable_reason": reason, "stale": True}


def read_status(directory: Path | None = None, *, now: float | None = None) -> dict[str, Any] | None:
    """B's last status, with ``stale`` set when B has not rewritten it lately; None when it never wrote one. A file
    that cannot be read, or is not B's status document, is ``available: False`` with its reason (and recorded)."""
    path = Path(directory or inference_dir()) / STATUS_FILE
    try:
        status = json.loads(read_text_shared(path))
        written = path.stat().st_mtime
    except FileNotFoundError:  # not an error: no inference status yet
        return None
    except (OSError, ValueError) as exc:
        record_failure(_failure_log, "reading the inference status", exc)
        return _unavailable(f"{type(exc).__name__}: {exc}"[:300])
    if not isinstance(status, dict) or status.get("schema") != STATUS_SCHEMA:
        reason = f"not an {STATUS_SCHEMA} document"
        record_failure(_failure_log, "reading the inference status", ValueError(reason))
        return _unavailable(reason)
    status["available"] = True
    age = (time.time() if now is None else now) - written
    status["age_seconds"] = round(age, 3)
    status["stale"] = age > STATUS_STALE_SECONDS
    return status
