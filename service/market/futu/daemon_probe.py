"""Futu/Moomoo daemon endpoint discovery and provider-specific classification."""
from __future__ import annotations

from service.market.futu.daemon_contract import is_contract_compatible
from service.market.futu.daemon_settings import MOOMOO_DAEMON_HOST, MOOMOO_DAEMON_PORT
from service.market.shared.daemon_probe import build_daemon_probe

__all__ = [
    "is_daemon_usable",
    "probe_moomoo_daemon_detailed",
    "probe_moomoo_daemon",
    "moomoo_daemon_port_open",
    "inspect_moomoo_daemon_port_owner",
    "is_known_moomoo_daemon_owner",
    "reprobe_known_moomoo_daemon",
]

KNOWN_PROCESS_PATTERNS = (
    "run_futu_daemon.py",
    "stock-monitor-moomoo-daemon",
    "stock_monitor_moomoo_daemon",
)

_probe = build_daemon_probe(
    host=MOOMOO_DAEMON_HOST,
    port=MOOMOO_DAEMON_PORT,
    is_contract_compatible=is_contract_compatible,
    known_process_patterns=KNOWN_PROCESS_PATTERNS,
)

is_daemon_usable = _probe.is_daemon_usable
probe_moomoo_daemon_detailed = _probe.probe_detailed
probe_moomoo_daemon = _probe.probe
moomoo_daemon_port_open = _probe.port_open
inspect_moomoo_daemon_port_owner = _probe.inspect_port_owner
is_known_moomoo_daemon_owner = _probe.is_known_owner
reprobe_known_moomoo_daemon = _probe.reprobe_known
