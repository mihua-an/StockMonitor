from __future__ import annotations

import sys
from pathlib import Path
# A direct `python <this file>` run: every entry script sits two levels below the project root.
_ROOT = str(Path(__file__).resolve().parents[2])
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
from backend.shared.provider_main import ProviderEntry, ProviderParts, run_provider_daemon

ENTRY = ProviderEntry(source="futu", label="FUTU DAEMON", refusal="second OpenD owner", component="futu_daemon",
                      detached_env="MOOMOO_DAEMON_DETACHED", log_name="moomoo_daemon.log", detached_source="FUTU_DAEMON")


def _load() -> ProviderParts:
    from backend.futu.server import api, futu_daemon
    from service.market.futu.daemon_contract import MOOMOO_DAEMON_PROTOCOL_VERSION, MOOMOO_DAEMON_RUNTIME_VERSION
    from service.market.futu.daemon_settings import MOOMOO_DAEMON_HOST, MOOMOO_DAEMON_PORT
    from service.market.futu.daemon_singleton import MoomooDaemonSingletonError, MoomooDaemonSingletonLock

    return ProviderParts(
        app=api, daemon=futu_daemon, host=MOOMOO_DAEMON_HOST, port=MOOMOO_DAEMON_PORT,
        runtime_version=MOOMOO_DAEMON_RUNTIME_VERSION, protocol_version=MOOMOO_DAEMON_PROTOCOL_VERSION,
        singleton_type=MoomooDaemonSingletonLock, singleton_error=MoomooDaemonSingletonError,
        enrich=futu_daemon.health, stop_account=futu_daemon.stop_account)


def main() -> int:
    return run_provider_daemon(ENTRY, _load)


if __name__ == "__main__":
    _code = main()
    from service.platform.process_exit import exit_bounded
    exit_bounded(_code)
