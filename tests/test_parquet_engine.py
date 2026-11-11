"""parquet_available() answered True for a fastparquet-only environment, while read_frame() and the
compact evidence codec always import pyarrow -- the first read then failed."""
from __future__ import annotations

import sys
import types

from service.market.storage import storage_codec


def test_parquet_is_available_only_with_pyarrow(monkeypatch):
    assert storage_codec.parquet_available() is True
    monkeypatch.setitem(sys.modules, "fastparquet", types.ModuleType("fastparquet"))
    monkeypatch.setitem(sys.modules, "pyarrow.parquet", None)  # import raises ImportError
    storage_codec.parquet_available.cache_clear()
    try:
        assert storage_codec.parquet_available() is False, "fastparquet alone cannot run read_frame"
    finally:
        monkeypatch.undo()
        storage_codec.parquet_available.cache_clear()
