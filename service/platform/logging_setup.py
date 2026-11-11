"""Standard-library `logging` bootstrap shared by every Python process entry point.

A process-execution function (AGENTS.md section 3), so it lives in service/platform/ next to log_session.py,
not in config/. configure_logging() is called once per process, as early as practical, by every real entry point:
  * api/service_host.py run_service() -- the seven business API processes (quote/history/model/data_center/
    actual_account/paper_account/settings_api);
  * backend/shioaji/run_shioaji_daemon.py and backend/futu/run_futu_daemon.py -- the provider processes.
Rust A/B log through their own stdout, captured by Health.

The level defaults to DEBUG, not INFO, so a first run shows exactly what
print() always showed (everything, unfiltered) while making per-level
filtering available going forward: an operator can now raise the level (env
var, code change, etc.) to quiet noisy output without touching call sites.

Third-party wire loggers are pinned to WARNING on top of that default. They were never
`print()` call sites, so quieting them regresses nothing -- but at DEBUG the `websockets`
loggers emit one line per frame in BOTH directions on the daemons' Rust-ingress sockets,
thousands of lines a second at a normal intraday event rate.

The process's error log (var/logs/<run>/error-<source>.log) is service/platform/error_logging.py's mirror: it
copies a line by its LEVEL (ERROR/CRITICAL/FATAL), with a narrow fallback for level-less
tracebacks, plus a bounded number of following lines as context -- never by the words in it.
"""
from __future__ import annotations

import logging
import sys

_CONFIGURED = False

# Per-frame wire logging from third-party transports: see this module's docstring for the
# measured log sizes. max(level, WARNING) keeps an explicitly-raised level (e.g. ERROR) intact.
NOISY_WIRE_LOGGERS = ("websockets", "websockets.client", "websockets.server", "websockets.protocol")


def configure_logging(level: int = logging.DEBUG) -> None:
    """Idempotently configure the root logger to mirror prior print() behavior.

    Emits to stdout -- not logging's stderr default -- so redirected/piped
    console output and detached log files keep showing diagnostics exactly
    where print() always put them.
    """
    global _CONFIGURED
    if _CONFIGURED:
        return
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stdout,
    )
    for name in NOISY_WIRE_LOGGERS:
        logging.getLogger(name).setLevel(max(level, logging.WARNING))
    _CONFIGURED = True
