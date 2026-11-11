"""Market daemon error contract, kept free of any heavy dependency.

These three classes live apart from `daemon_client` because `api/routes/history_routes.py` imports
`MarketDaemonError` to write its `except` clauses, and importing it from `daemon_client` would make
the FastAPI process load the entire historical stack at startup: `daemon_client` subclasses
`ShioajiHistoricalRepository`, and `history_repository` imports pandas at module scope (it uses it
~69 times, legitimately). Every API start would pay a full pandas import -- measured as the single
largest item in the Python process's startup cost -- to name an exception type.

Nothing in this module may import anything heavier than the standard library. `daemon_client`
re-exports all three names, so existing imports from there keep working.
"""
from __future__ import annotations


class MarketDaemonError(RuntimeError):
    pass


class ForeignMarketDaemonEndpoint(MarketDaemonError):
    pass


class IncompatibleMarketDaemon(MarketDaemonError):
    pass
