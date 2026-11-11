from __future__ import annotations

import os
import uuid
from functools import lru_cache
from pathlib import Path
from typing import Any

from service.platform.lazy_pandas import pd  # pandas on first use: these load on every API start
from service.platform.atomic_files import fsync_directory
import logging
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def parquet_available() -> bool:
    """Whether this process can read and write the canonical Parquet storage. pyarrow is the one engine: read_frame and
    the compact evidence codec use it directly, so fastparquet alone must not answer "available" for an environment that
    would then fail on the first read."""
    try:
        import pyarrow.parquet  # noqa: F401
        return True
    except Exception as exc:
        record_failure(_failure_log, "importing pyarrow.parquet", exc)
        return False


def _fsync_parent(path: Path) -> None:
    try:
        fsync_directory(path.parent)
    except OSError as exc:
        record_failure(_failure_log, "fsyncing a storage directory", exc)


def write_frame(
    frame: pd.DataFrame,
    path: str | Path,
    *,
    arrow_schema: Any | None = None,
    validate_readback: bool = False,
) -> Path:
    """Atomically write canonical tabular storage as Parquet only."""
    target = Path(path)
    if target.suffix.lower() != ".parquet":
        raise ValueError(f"canonical tabular storage requires .parquet: {target}")
    if not parquet_available():
        raise RuntimeError("PARQUET_ENGINE_REQUIRED: install pyarrow for canonical market storage")
    target.parent.mkdir(parents=True, exist_ok=True)
    if arrow_schema is None:
        arrow_schema = frame.attrs.get("_arrow_schema") if hasattr(frame, "attrs") else None
    if not validate_readback and hasattr(frame, "attrs"):
        validate_readback = bool(frame.attrs.get("_validate_readback", False))
    if hasattr(frame, "attrs") and frame.attrs:
        # The hints are not data (and pyarrow would try to serialize them): written from a shallow copy without
        # them, never by clearing the caller's own frame.
        frame = frame.copy(deep=False)
        frame.attrs = {}
    temp = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp.parquet")
    try:
        if arrow_schema is not None:
            import pyarrow as pa
            import pyarrow.parquet as pq
            table = pa.Table.from_pandas(frame, schema=arrow_schema, preserve_index=False, safe=False)
            pq.write_table(table, temp)
        else:
            frame.to_parquet(temp, index=False)
        if validate_readback:
            check = pd.read_parquet(temp)
            if len(check) != len(frame):
                raise RuntimeError(f"parquet readback row mismatch {len(check)} != {len(frame)}")
        os.replace(temp, target)
        _fsync_parent(target)
        return target
    finally:
        try:
            if temp.exists(): temp.unlink()
        except OSError as exc:
            record_failure(_failure_log, "removing a storage temp file", exc)

def read_frame(path: str | Path, **kwargs: Any) -> pd.DataFrame:
    target = Path(path)
    if target.suffix.lower() != ".parquet":
        raise ValueError(f"canonical tabular storage requires .parquet: {target}")
    if not target.exists():
        raise FileNotFoundError(str(target))
    import pyarrow.parquet as pq
    from service.market.storage.compact_evidence_codec import KEY, read_table
    if KEY in (pq.ParquetFile(target).schema_arrow.metadata or {}):
        columns = kwargs.pop('columns', None)
        if kwargs:
            raise ValueError(f'Unsupported compact evidence read options: {list(kwargs)}')
        table = read_table(target)
        if columns is not None:
            table = table.select(columns)
        return table.to_pandas()
    return pd.read_parquet(target, **kwargs)

def frame_exists(path: str | Path) -> bool:
    target = Path(path)
    return target.suffix.lower() == ".parquet" and target.exists()
