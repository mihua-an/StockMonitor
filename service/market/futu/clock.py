"""The Futu provider's timestamp for its own records (status, store rows, security master, OpenD lifecycle)."""
from __future__ import annotations

from datetime import datetime, timezone


def utc_now() -> str:
    """Now in UTC, ISO 8601 with milliseconds."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")
