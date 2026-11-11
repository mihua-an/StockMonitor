from __future__ import annotations

import logging
import math
from dataclasses import asdict, is_dataclass
from datetime import date, datetime, time
from decimal import Decimal
from enum import Enum
from pathlib import Path
from typing import Any, Mapping
from uuid import UUID

_log = logging.getLogger(__name__)


class JsonSerializationError(TypeError):
    """A payload holds a value of a type no adapter here converts: a schema or program error, not data to send as
    its text (a repr can carry paths or secrets to the renderer). `where` is the value's path in the payload."""

    def __init__(self, type_name: str) -> None:
        super().__init__(type_name)
        self.type_name = type_name
        self.steps: list[str] = []

    @property
    def where(self) -> str:
        return "$" + "".join(reversed(self.steps))

    def __str__(self) -> str:
        return f"{self.type_name} at {self.where} has no JSON form"


def _scalar_item(value: Any) -> Any:
    """Return a Python scalar for numpy/pandas scalar-like values when possible."""
    if isinstance(value, (str, bytes, bytearray, bool, int, float, type(None))):
        return value
    item = getattr(value, "item", None)
    if callable(item):
        try:
            converted = item()
            if converted is not value:
                return converted
        except Exception:  # not an error: serialisation fallback: an item() that fails keeps the value for the conversions below
            pass
    return value


def to_json_safe(value: Any) -> Any:
    """Recursively normalize payloads to strict RFC-compatible JSON values.

    Market/history data often crosses pandas/numpy boundaries where missing numeric
    values become NaN/Inf/pandas.NA.  Starlette intentionally rejects those values
    with ``allow_nan=False`` semantics.  This boundary converts only *missing or
    non-finite* numeric values to ``None``; it never silently converts them to zero
    or the string ``"NaN"``.

    Only the types handled below are converted; any other raises JsonSerializationError naming the type and where in
    the payload it is.
    """
    try:
        return _convert(value, set())
    except JsonSerializationError as error:
        _log.error("refusing to serialise a payload: %s", error)
        raise


def _convert(value: Any, seen: set[int]) -> Any:
    value = _scalar_item(value)

    # numpy arrays and other array-like containers are not JSON serializable,
    # but their ``tolist`` representation is. Keep this outside the market hot
    # path; this helper is only used at HTTP/WS/diagnostic boundaries.
    if not isinstance(value, (str, bytes, bytearray, Mapping, list, tuple, set, frozenset)):
        tolist = getattr(value, "tolist", None)
        if callable(tolist):
            try:
                converted = tolist()
                if converted is not value:
                    return _convert(converted, seen)
            except Exception:  # not an error: serialisation fallback: a tolist() that fails keeps the value for the conversions below
                pass

    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None

    # pandas.NaT may behave like a datetime; detect missing scalars before the
    # datetime branch so it becomes JSON null instead of the string "NaT".
    type_name = f"{type(value).__module__}.{type(value).__name__}".lower()
    if "pandas" in type_name and ("na" in type_name or "nat" in type_name):
        return None
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value) if value.is_finite() else None
    if isinstance(value, Enum):
        return _convert(value.value, seen)
    if isinstance(value, (Path, UUID)):
        return str(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if is_dataclass(value):
        value = asdict(value)

    container_like = isinstance(value, (Mapping, list, tuple, set, frozenset))
    if container_like:
        marker = id(value)
        if marker in seen:
            return None
        seen.add(marker)
    try:
        if isinstance(value, Mapping):
            out: dict[str, Any] = {}
            for key, item in value.items():
                try:
                    out[str(key)] = _convert(item, seen)
                except JsonSerializationError as error:
                    error.steps.append(f".{key}")
                    raise
            return out
        if isinstance(value, (list, tuple, set, frozenset)):
            items: list[Any] = []
            for item in value:
                try:
                    items.append(_convert(item, seen))
                except JsonSerializationError as error:
                    error.steps.append(f"[{len(items)}]")
                    raise
            return items

        # pandas.NA and similar missing scalars compare unequal to themselves.
        try:
            if value != value:  # NaN-like objects
                return None
        except Exception:  # not an error: an object whose comparison raises is not NaN-like; it is refused below
            pass
        raise JsonSerializationError(f"{type(value).__module__}.{type(value).__qualname__}")
    finally:
        if container_like:
            seen.discard(id(value))


def strict_json_dumps(value: Any, **kwargs: Any) -> str:
    import json

    options = {
        "ensure_ascii": False,
        "separators": (",", ":"),
        "allow_nan": False,
    }
    options.update(kwargs)
    return json.dumps(to_json_safe(value), **options)
