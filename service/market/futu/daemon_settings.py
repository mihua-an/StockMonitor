"""Futu (Moomoo) market daemon settings.

Host/port are not a second copy of the literal: they are read from
config/network_manifest.json (the single network-topology source of truth;
see config/network_settings.py's docstring). Only this daemon's own timing
behavior (idle grace, heartbeat/lease cadence) stays a local constant here,
since those are not network location and are not duplicated anywhere else.
"""
from __future__ import annotations

from config.network_settings import FUTU_DAEMON_HOST as MOOMOO_DAEMON_HOST
from config.network_settings import FUTU_DAEMON_PORT as MOOMOO_DAEMON_PORT

MOOMOO_DAEMON_IDLE_GRACE_SECONDS = 8 * 60
MOOMOO_DAEMON_CLIENT_HEARTBEAT_SECONDS = 5
MOOMOO_DAEMON_CLIENT_LEASE_SECONDS = 20

__all__ = ["MOOMOO_DAEMON_HOST", "MOOMOO_DAEMON_PORT", "MOOMOO_DAEMON_IDLE_GRACE_SECONDS", "MOOMOO_DAEMON_CLIENT_HEARTBEAT_SECONDS", "MOOMOO_DAEMON_CLIENT_LEASE_SECONDS"]
