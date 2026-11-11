from __future__ import annotations

import sys
from pathlib import Path
# A direct `python <this file>` run: every entry script sits two levels below the project root.
_ROOT = str(Path(__file__).resolve().parents[2])
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
from backend.shared.provider_main import ProviderEntry, ProviderParts, run_provider_daemon

ENTRY = ProviderEntry(source="shioaji", label="SHIOAJI DAEMON", refusal="second broker owner", component="market_daemon",
                      detached_env="MARKET_DAEMON_DETACHED", log_name="market_daemon.log", detached_source="SHIOAJI_DAEMON")


def _load() -> ProviderParts:
    from backend.shioaji.daemon_health import passive_runtime_health_payload
    from backend.shioaji.daemon_shutdown import stop_account
    from backend.shioaji.server import api, daemon_context
    from service.market.shioaji.daemon_contract import MARKET_DAEMON_PROTOCOL_VERSION, MARKET_DAEMON_RUNTIME_VERSION
    from service.market.shioaji.daemon_settings import MARKET_DAEMON_HOST, MARKET_DAEMON_PORT
    from service.market.shioaji.daemon_singleton import MarketDaemonSingletonError, MarketDaemonSingletonLock

    return ProviderParts(
        app=api, daemon=daemon_context, host=MARKET_DAEMON_HOST, port=MARKET_DAEMON_PORT,
        runtime_version=MARKET_DAEMON_RUNTIME_VERSION, protocol_version=MARKET_DAEMON_PROTOCOL_VERSION,
        singleton_type=MarketDaemonSingletonLock, singleton_error=MarketDaemonSingletonError,
        enrich=lambda: passive_runtime_health_payload(daemon_context, include_sessions=True),
        stop_account=lambda: stop_account(daemon_context))


def main() -> int:
    return run_provider_daemon(ENTRY, _load)


if __name__ == "__main__":
    _code = main()
    from service.platform.process_exit import exit_bounded
    exit_bounded(_code)
