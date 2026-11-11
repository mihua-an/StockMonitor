from __future__ import annotations

import logging
import logging.handlers
import os
from pathlib import Path
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)

# The shioaji SDK attaches its own logging.FileHandler (no rotation) pointed
# at "shioaji.log" in the process working directory as a side effect of
# `import shioaji` / `shioaji.Shioaji(...)`. Left alone that file grows
# without bound -- it has been observed past 180MB in production. This module
# does not patch or depend on shioaji internals: it scans whatever loggers
# exist for a plain FileHandler writing to a file literally named
# "shioaji.log" and swaps it for a TimedRotatingFileHandler that rotates at
# midnight and keeps a bounded number of days. Everything else about the
# logger (level, other handlers, formatter) is left untouched.

_MANAGED_ATTR = "_stock_monitor_rotated"
LOG_PATH_ENV = "SJ_LOG_PATH"      # read by the shioaji SDK core at import; default is ./shioaji.log in the working directory
_TARGET_FILENAME = "shioaji.log"
_DEFAULT_RETENTION_DAYS = 14
_RETENTION_ENV_VAR = "STOCK_MONITOR_SHIOAJI_LOG_RETENTION_DAYS"


def configure_shioaji_log_path() -> Path:
    """Point the shioaji SDK at this run's own shioaji.log BEFORE it is imported (the SDK creates
    the file in the working directory otherwise, i.e. the repository root). The directory must
    exist or the SDK falls back to stdout.

    It lands in var/logs/<startup_timestamp>/ with every other log this run produces, rather than
    in one shared var/logs/shioaji.log that every run appended to -- that file had reached 133 MB
    on the audit machine, and a size rotation alone could never tell one session from another.
    """
    from service.platform.log_session import log_session_dir

    return Path(os.environ.setdefault(LOG_PATH_ENV, str(log_session_dir() / _TARGET_FILENAME)))


def _retention_days() -> int:
    raw = os.environ.get(_RETENTION_ENV_VAR)
    if raw is None or not raw.strip():
        return _DEFAULT_RETENTION_DAYS
    try:
        value = int(raw.strip())
    except ValueError:  # not an error: a retention setting that is not an integer uses the documented default
        return _DEFAULT_RETENTION_DAYS
    return value if value > 0 else _DEFAULT_RETENTION_DAYS


def _candidate_loggers():
    root = logging.getLogger()
    yield root
    manager = logging.Logger.manager
    for name in list(manager.loggerDict.keys()):
        logger = manager.loggerDict.get(name)
        if isinstance(logger, logging.Logger):
            yield logger


def ensure_shioaji_log_rotation(*, retention_days: int | None = None) -> bool:
    """Replace any un-rotated shioaji.log FileHandler with a rotating one.

    Safe to call repeatedly (already-converted handlers are skipped) and safe
    to call before shioaji has attached anything (a no-op). Never raises --
    a logging cosmetics failure must never interrupt a live trading session.
    Returns True if a handler was converted on this call.
    """
    converted = False
    try:
        days = retention_days if retention_days is not None else _retention_days()
        for logger in _candidate_loggers():
            for handler in list(getattr(logger, "handlers", ()) or ()):
                if getattr(handler, _MANAGED_ATTR, False):
                    continue
                if isinstance(handler, logging.handlers.TimedRotatingFileHandler):
                    continue
                if not isinstance(handler, logging.FileHandler):
                    continue
                base_filename = getattr(handler, "baseFilename", None)
                if not base_filename or Path(base_filename).name != _TARGET_FILENAME:
                    continue
                try:
                    logger.removeHandler(handler)
                    handler.close()
                except Exception as exc:
                    record_failure(_failure_log, "closing the old Shioaji log handler", exc)
                new_handler = logging.handlers.TimedRotatingFileHandler(
                    base_filename, when="midnight", backupCount=days,
                    encoding="utf-8", delay=True,
                )
                new_handler.setFormatter(handler.formatter)
                new_handler.setLevel(handler.level)
                setattr(new_handler, _MANAGED_ATTR, True)
                logger.addHandler(new_handler)
                converted = True
    except Exception as exc:
        record_failure(_failure_log, "converting the Shioaji log to a rotating handler", exc)
    return converted
