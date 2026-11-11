from __future__ import annotations

import functools
import json
import logging
from dataclasses import dataclass
from pathlib import Path

from service.platform import project_root as process_paths
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)

VERDICT_SCHEMA = "daily-summary-verdict-v1"


@dataclass(frozen=True)
class ModelStorageLayout:
    """The one model chain's files.

    * ``registry``  -- registered ONNX models and the champion per horizon/direction (online_training/registry.py);
    * ``datasets``  -- training datasets and their per-date Rust B feature shards (online_training/dataset.py);
    * ``daily_summary`` -- each Shioaji session's daily summary, written by the materialization
      (native/analysis_runtime/src/daily_summary.rs) and read by Rust B's day features;
    * ``training``  -- the training job's status, state, run reports and manual requests (online_training/job.py).

    The registry, the datasets and the summaries grow without bound, so they live under the storage location (config/var_layout.json
    "storage"); the job's own files are of steady size and stay under DATA_ROOT/model.
    """

    registry: Path
    datasets: Path
    daily_summary: Path
    training: Path


@functools.cache
def process_model_layout() -> ModelStorageLayout:
    """This process's model layout, resolved on first use (F1): the active storage location's model children, and the
    training job's files under DATA_ROOT. The location only changes at a full start, before any service runs."""
    from config.storage_settings import storage_paths

    data_root = Path(process_paths.DATA_ROOT)
    storage = storage_paths(data_root=data_root)
    return ModelStorageLayout(registry=storage.model_registry, datasets=storage.model_datasets,
                              daily_summary=storage.daily_summary, training=data_root / "model" / "online_training")


@functools.cache
def process_kbar_root() -> Path:
    """This process's K-bar store (native/analysis_runtime/src/kbar_store.rs), under the active storage location."""
    from config.storage_settings import storage_paths

    return storage_paths(data_root=Path(process_paths.DATA_ROOT)).kbars


def day_tick_complete(trading_date: str, summary_root: Path | None = None) -> bool | None:
    """Whether a trading date is 完整 (user 10-28): its Shioaji STK day session's daily summary says every stock's
    ticks reconcile with the exchange's cumulative volume (``tick_complete``, decided by Rust B when it writes the
    summary -- native/analysis_runtime/src/daily_summary.rs). Only a complete day is trained on; any other is test
    data only. Read from the summary's verdict file, which B writes with the summary (a few bytes, not every stock's
    minutes). None when the date has no verdict: not known, never complete."""
    root = Path(summary_root) if summary_root is not None else process_model_layout().daily_summary
    path = (root / "source=shioaji" / "market=STK" / f"trading_date={str(trading_date)[:10]}" / "session=DAY.verdict.json")
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:  # not an error: the date's session was not summarized -- its completeness is unknown
        return None
    except (OSError, ValueError) as exc:
        record_failure(_failure_log, f"reading the daily summary verdict {path}", exc)
        return None
    if not isinstance(doc, dict) or doc.get("schema") != VERDICT_SCHEMA:
        record_failure(_failure_log, f"reading the daily summary verdict {path}", ValueError(f"schema is not {VERDICT_SCHEMA}"))
        return None
    verdict = doc.get("tick_complete")
    return verdict if isinstance(verdict, bool) else None
