"""One record of a handled failure (no error is swallowed silently).

A handler that deliberately carries on after a failure -- a fallback, a skip, a retry next time -- still leaves one
WARNING in its service log with the reason. The same failure (same place, exception type and message) within a
minute is counted instead of being written again, so a failure in a hot loop is recorded without flooding the log.
The count is written when its minute is over (a background sweep each minute) or when the process shuts down
(``flush_failure_repeats``, also run at interpreter exit) -- never only with the next occurrence, which may not come.
Never includes credentials: only the exception's type and message are written.
"""
from __future__ import annotations

import atexit
import logging
import threading
import time

_WINDOW_SECONDS = 60.0
_MAX_KEYS = 1024
_lock = threading.Lock()
# key -> [first record time, repeats since]
_seen: dict[tuple[str, str, str, str], list[float]] = {}
_sweeper: threading.Thread | None = None


def _repeat_line(key: tuple[str, str, str, str], count: int, level: int = logging.WARNING) -> None:
    name, what, kind, message = key
    detail = f": {kind}: {message}" if kind else ""
    logging.getLogger(name).log(level, "%s failed%s (repeated %d more time(s) in the minute after the record above)",
                                what, detail, count)


def flush_failure_repeats(*, force: bool = True, now: float | None = None) -> int:
    """Write the repeat count of every failure whose minute is over (``force``: of every failure). Returns how many
    lines were written. Service shutdown calls this; it also runs at interpreter exit."""
    at = time.monotonic() if now is None else now
    due: list[tuple[tuple[str, str, str, str], int]] = []
    with _lock:
        for key, seen in list(_seen.items()):
            if seen[1] and (force or at - seen[0] >= _WINDOW_SECONDS):
                due.append((key, int(seen[1])))
                seen[1] = 0
            if at - seen[0] >= _WINDOW_SECONDS and not seen[1]:
                _seen.pop(key, None)
    for key, count in due:
        _repeat_line(key, count)
    return len(due)


def _sweep() -> None:
    while True:
        time.sleep(_WINDOW_SECONDS / 2)
        try:
            flush_failure_repeats(force=False)
        except Exception as exc:  # noqa: BLE001 -- the sweep must outlive a broken handler; the failure goes to stderr
            logging.getLogger(__name__).error("writing failure repeat counts failed: %s: %s", type(exc).__name__, exc)


def _ensure_sweeper() -> None:
    global _sweeper
    if _sweeper is not None:
        return
    _sweeper = threading.Thread(target=_sweep, name="failure-record-sweep", daemon=True)
    _sweeper.start()


atexit.register(flush_failure_repeats)


def record_failure(log: logging.Logger, what: str, exc: BaseException | None = None, *,
                   level: int = logging.WARNING) -> None:
    """Record that ``what`` failed with ``exc`` and the code carried on."""
    kind = type(exc).__name__ if exc is not None else ""
    message = str(exc)[:300] if exc is not None else ""
    key = (log.name, what, kind, message)
    now = time.monotonic()
    with _lock:
        _ensure_sweeper()
        seen = _seen.get(key)
        if seen is not None and now - seen[0] < _WINDOW_SECONDS:
            seen[1] += 1
            return
        repeated = int(seen[1]) if seen is not None else 0
        _seen.pop(key, None)
        _seen[key] = [now, 0]
        if len(_seen) > _MAX_KEYS:
            oldest = next(iter(_seen))
            dropped = _seen.pop(oldest)
            if dropped[1]:
                # a count about to be forgotten is written now
                threading.Thread(target=_repeat_line, args=(oldest, int(dropped[1])), daemon=True).start()
    suffix = f" (also {repeated} more time(s) in the minute before)" if repeated else ""
    detail = f": {kind}: {message}" if exc is not None else ""
    log.log(level, "%s failed%s%s", what, detail, suffix)
