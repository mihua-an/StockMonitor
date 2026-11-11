"""Shioaji daemon endpoint discovery and provider-specific classification."""
from __future__ import annotations

from service.market.shared.daemon_probe import assess_passive_health_snapshot, build_daemon_probe
from service.market.shioaji.daemon_contract import is_contract_compatible
from service.market.shioaji.daemon_settings import MARKET_DAEMON_HOST, MARKET_DAEMON_PORT

__all__ = [
    "assess_passive_health_snapshot",
    "is_daemon_usable",
    "probe_market_daemon_detailed",
    "probe_market_daemon",
    "market_daemon_port_open",
    "inspect_market_daemon_port_owner",
    "is_known_market_daemon_owner",
    "reprobe_known_daemon",
]

KNOWN_PROCESS_PATTERNS = (
    "run_shioaji_daemon.py",
    "stock-monitor-market-daemon",
    "stock_monitor_market_daemon",
)

_probe = build_daemon_probe(
    host=MARKET_DAEMON_HOST,
    port=MARKET_DAEMON_PORT,
    is_contract_compatible=is_contract_compatible,
    known_process_patterns=KNOWN_PROCESS_PATTERNS,
)

is_daemon_usable = _probe.is_daemon_usable
probe_market_daemon_detailed = _probe.probe_detailed
probe_market_daemon = _probe.probe
market_daemon_port_open = _probe.port_open
inspect_market_daemon_port_owner = _probe.inspect_port_owner
is_known_market_daemon_owner = _probe.is_known_owner
reprobe_known_daemon = _probe.reprobe_known
