"""Futu live session, callbacks, subscriptions and service composition.

Scope: US stocks, plus CC (crypto) as real-time display only. CC is never persisted: no WAL partition, no
materialized history, and Rust A / B drop its state at 00:00 Asia/Taipei. US sessions are persisted (the two most
recent sessions are kept).
"""

__all__ = ["service", "callback", "subscriptions"]
