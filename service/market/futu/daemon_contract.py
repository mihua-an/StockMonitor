from __future__ import annotations

from service.market.shared.daemon_connection import matches_contract
from service.platform.runtime_contract import MOOMOO_DAEMON_CONTRACT
MOOMOO_DAEMON_IDENTITY = str(MOOMOO_DAEMON_CONTRACT["identity"])
MOOMOO_DAEMON_PROTOCOL_VERSION = int(MOOMOO_DAEMON_CONTRACT["protocol_version"])
# Independent from UI/FastAPI build number. Bump only when the daemon IPC,
# OpenD adapter, persistence or lifecycle contract becomes incompatible.
MOOMOO_DAEMON_RUNTIME_VERSION = str(MOOMOO_DAEMON_CONTRACT["runtime_version"])


def is_contract_compatible(payload: object) -> bool:
    if not isinstance(payload, dict):
        return False
    return matches_contract(payload, identity=MOOMOO_DAEMON_IDENTITY,
                            protocol=MOOMOO_DAEMON_PROTOCOL_VERSION, runtime=MOOMOO_DAEMON_RUNTIME_VERSION)

