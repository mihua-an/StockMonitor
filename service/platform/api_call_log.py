"""Log of every call *we* make to a broker SDK / OpenD -- never what the broker pushes to us.

One JSON Lines file per source per App run: ``var/logs/<startup_timestamp>/api-shioaji.log`` and
``api-futu.log`` (see service/platform/log_session.py). One line per *operation*, so a subscribe of
80 symbols is one record with a symbol count and a bounded symbol sample, not 80 lines of noise.

Scope, explicitly:
  * IN  -- login/logout, subscribe/unsubscribe, contract or product-catalog requests, historical
           tick/K-bar requests, snapshot requests, reconnect/control calls, account queries: the
           things we asked the broker to do, which is what an incident review needs to reconstruct.
  * OUT -- market data the SDK pushes back at us. A quote callback is not an API call, and writing
           one line per tick is exactly the log flood this file exists to avoid
           (service/platform/logging_setup.py's header records what that cost the last time).

Every record carries: time, source, operation, the caller's reason, market, symbol count and
sample, an optional correlation id, duration, outcome, and on failure an error type/code. Nothing
else: `detail` rejects anything that looks like a credential so a token can never reach a log file.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

from service.platform.log_session import log_session_path
from service.platform.atomic_files import append_line, rotate_if_larger
import logging
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)

# Enough symbols to recognise what a batch was, few enough that one line stays readable.
SYMBOL_SAMPLE_LIMIT = 12
MAX_BYTES = 8 * 1024 * 1024

_SENSITIVE = ("token", "password", "secret", "credential", "apikey", "api_key", "ca_passwd", "passwd", "account")

_lock = threading.RLock()


class SensitiveApiLogField(ValueError):
    """Raised when a caller tries to put credential-shaped data in an API log record."""


def _path(source: str) -> Path:
    name = str(source or "").strip().lower()
    if name not in {"shioaji", "futu"}:
        raise ValueError(f"unsupported API log source: {source!r}")
    return log_session_path(f"api-{name}.log")


def _symbols(symbols: Iterable[Any] | None) -> tuple[int, list[str]]:
    if symbols is None:
        return 0, []
    rows = [str(item).strip().upper() for item in symbols if str(item).strip()]
    return len(rows), rows[:SYMBOL_SAMPLE_LIMIT]


# A credential inside a value: a URL query parameter, an Authorization header value, "key=value" text.
_SENSITIVE_VALUE = re.compile(
    r"(?i)(bearer\s+\S|[?&;\s](token|access_token|api_?key|secret|password|passwd)=|^(token|api_?key|secret|password|passwd)=)"
)


REDACTED = "[REDACTED: credential-shaped value]"


def _check_value(value: Any, path: str, depth: int = 0) -> Any:
    """Walk nested dicts/lists/tuples: checking only the top-level keys would let {"url": "...?token=x"}
    and {"meta": {"token": "x"}} into the log.

    A credential-shaped KEY at any depth is a programming error and refuses the record (SensitiveApiLogField). A
    credential-shaped VALUE is runtime data (an SDK's error text, a URL): it is replaced by REDACTED, never written,
    and never raises -- a log record must not break the broker call it describes.
    """
    if depth > 8:
        return REDACTED
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            lowered = str(key).lower()
            if any(marker in lowered for marker in _SENSITIVE):
                raise SensitiveApiLogField(f"refusing to write {path}{key!r} to an API call log")
            out[key] = _check_value(item, f"{path}{key!r}.", depth + 1)
        return out
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_check_value(item, f"{path}[{index}].", depth + 1) for index, item in enumerate(value)]
    if isinstance(value, (str, bytes)):
        text = value.decode("utf-8", "replace") if isinstance(value, bytes) else value
        return REDACTED if _SENSITIVE_VALUE.search(text) else value
    return value


def _check_detail(detail: dict[str, Any] | None) -> dict[str, Any]:
    if not detail:
        return {}
    return _check_value(dict(detail), "")


def record_api_call(
    source: str,
    operation: str,
    *,
    reason: str,
    market: str | None = None,
    symbols: Iterable[Any] | None = None,
    symbol_count: int | None = None,
    request_id: str | None = None,
    duration_ms: float | None = None,
    ok: bool = True,
    error_type: str | None = None,
    error_code: Any = None,
    detail: dict[str, Any] | None = None,
) -> None:
    """Append one operation record. Never raises for an I/O problem: logging must not break a call."""
    counted, sample = _symbols(symbols)
    row = {
        "at": datetime.now().astimezone().isoformat(timespec="milliseconds"),
        "source": str(source).strip().lower(),
        "operation": str(operation).strip(),
        "reason": str(reason).strip(),
        "market": (str(market).strip().upper() or None) if market else None,
        "symbol_count": int(symbol_count) if symbol_count is not None else counted,
        "symbols": sample,
        "symbols_truncated": max(0, counted - len(sample)),
        "request_id": str(request_id) if request_id else None,
        "duration_ms": round(float(duration_ms), 3) if duration_ms is not None else None,
        "ok": bool(ok),
        "error_type": error_type,
        "error_code": error_code,
        "pid": os.getpid(),
        **_check_detail(detail),
    }
    try:
        path = _path(source)
        with _lock:
            rotate_if_larger(path, MAX_BYTES)
            append_line(path, json.dumps(row, ensure_ascii=False, separators=(",", ":")))
    except SensitiveApiLogField:
        raise
    except Exception as exc:
        record_failure(_failure_log, "writing the broker API call log", exc)


class api_call:                            # noqa: N801 - used as a context manager, reads as a verb
    """Time one broker operation and record it, whatever its outcome.

        with api_call("shioaji", "subscribe", reason="watchlist_sync", market="STK", symbols=codes):
            api.quote.subscribe(...)

    An exception is recorded with its type and re-raised; `.detail[...]` adds fields the caller
    only learns while the call runs (an assigned request id, a returned row count).
    """

    def __init__(self, source: str, operation: str, *, reason: str, market: str | None = None,
                 symbols: Iterable[Any] | None = None, symbol_count: int | None = None,
                 request_id: str | None = None) -> None:
        self.source, self.operation, self.reason = source, operation, reason
        self.market, self.symbols, self.symbol_count = market, list(symbols) if symbols is not None else None, symbol_count
        self.request_id = request_id
        self.detail: dict[str, Any] = {}
        self._started = 0.0

    def __enter__(self) -> "api_call":
        self._started = time.perf_counter()
        return self

    def __exit__(self, exc_type, exc, _traceback) -> bool:
        record_api_call(
            self.source, self.operation, reason=self.reason, market=self.market,
            symbols=self.symbols, symbol_count=self.symbol_count, request_id=self.request_id,
            duration_ms=(time.perf_counter() - self._started) * 1000.0,
            ok=exc_type is None,
            error_type=exc_type.__name__ if exc_type else None,
            error_code=getattr(exc, "code", None) if exc is not None else None,
            detail=self.detail or None,
        )
        return False
