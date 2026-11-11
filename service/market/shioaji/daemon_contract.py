from __future__ import annotations

from dataclasses import dataclass
from service.market.shared.daemon_connection import matches_contract
from service.platform.runtime_contract import MARKET_DAEMON_CONTRACT
MARKET_DAEMON_IDENTITY = str(MARKET_DAEMON_CONTRACT["identity"])
MARKET_DAEMON_PROTOCOL_VERSION = int(MARKET_DAEMON_CONTRACT["protocol_version"])
# This version is intentionally independent from the Stage number and UI/backend
# build. Increment only when daemon IPC / broker adapter / native-runtime / recorder
# contracts become incompatible with an existing daemon.
MARKET_DAEMON_RUNTIME_VERSION = str(MARKET_DAEMON_CONTRACT["runtime_version"])

@dataclass(frozen=True)
class MarketDaemonCompatibility:
    identity: str = MARKET_DAEMON_IDENTITY
    protocol_version: int = MARKET_DAEMON_PROTOCOL_VERSION
    runtime_version: str = MARKET_DAEMON_RUNTIME_VERSION


def is_contract_compatible(payload: object) -> bool:
    if not isinstance(payload, dict):
        return False
    return matches_contract(payload, identity=MARKET_DAEMON_IDENTITY,
                            protocol=MARKET_DAEMON_PROTOCOL_VERSION, runtime=MARKET_DAEMON_RUNTIME_VERSION)

