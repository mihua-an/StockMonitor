"""Shioaji market daemon settings.

Host/port are not a second copy of the literal: they are read from
config/network_manifest.json (the single network-topology source of truth;
see config/network_settings.py's docstring). Only this daemon's own timing
behavior (idle grace, heartbeat/lease cadence) stays a local constant here,
since those are not network location and are not duplicated anywhere else.
"""
from __future__ import annotations

from config.network_settings import SHIOAJI_DAEMON_HOST as MARKET_DAEMON_HOST
from config.network_settings import SHIOAJI_DAEMON_PORT as MARKET_DAEMON_PORT

MARKET_DAEMON_IDLE_GRACE_SECONDS = 8 * 60
MARKET_DAEMON_CLIENT_HEARTBEAT_SECONDS = 5
MARKET_DAEMON_CLIENT_LEASE_SECONDS = 20

__all__ = ["MARKET_DAEMON_HOST", "MARKET_DAEMON_PORT", "MARKET_DAEMON_IDLE_GRACE_SECONDS", "MARKET_DAEMON_CLIENT_HEARTBEAT_SECONDS", "MARKET_DAEMON_CLIENT_LEASE_SECONDS"]
