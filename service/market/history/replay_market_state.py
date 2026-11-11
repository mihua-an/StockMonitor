from __future__ import annotations

import ast
from typing import Any

from service.platform.lazy_pandas import pd  # pandas on first use: these load on every API start


def as_levels(value: Any) -> list[Any]:
    """One stored order-book level cell as a list (list, tuple, NumPy/Arrow array, or its text) -- the one reader of
    stored depth for replay and recovery."""
    if isinstance(value, list):
        return list(value)
    if isinstance(value, tuple):
        return list(value)
    # Parquet/Arrow readback commonly returns NumPy arrays or Arrow scalars
    # instead of Python lists.  Treat those as the same durable depth payload;
    # otherwise restart recovery silently discards real bid/ask levels.
    to_list = getattr(value, "tolist", None)
    if callable(to_list):
        try:
            converted = to_list()
            if isinstance(converted, (list, tuple)):
                return list(converted)
        except Exception:  # not an error: level conversion: a to_list that fails falls through to the generic conversions below
            pass
    if value is None:
        return []
    try:
        if pd.isna(value):
            return []
    except Exception:  # not an error: pd.isna is undefined for array-like values; those are converted below
        pass
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        try:
            parsed = ast.literal_eval(text)
        except Exception:  # not an error: level text that is not a literal list is an empty level list by contract
            return []
        return list(parsed) if isinstance(parsed, (list, tuple)) else []
    return []
