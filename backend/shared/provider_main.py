"""The one main flow of a provider daemon (Futu, Shioaji).

A provider's entry script names itself (`ProviderEntry`) and hands over what only it knows (`ProviderParts`): its app,
daemon object, singleton lock and stop account. Everything else -- process setup, the singleton, health publishing,
the server's run and the stop receipt -- happens here, so the providers cannot drift apart.
"""
from __future__ import annotations

import logging
import os
import sys
import traceback
from dataclasses import dataclass
from typing import Any, Callable, Mapping

from service.platform.failure_record import record_failure
from service.platform.project_root import PROJECT_ROOT

_failure_log = logging.getLogger(__name__)


@dataclass(frozen=True)
class ProviderEntry:
    """What an entry script knows before it imports its provider."""

    source: str              # the config/source_settings id
    label: str               # the log prefix, e.g. "FUTU DAEMON"
    refusal: str             # what the singleton refuses, e.g. "second OpenD owner"
    component: str           # the dataflow component and log name
    detached_env: str
    log_name: str
    detached_source: str


@dataclass(frozen=True)
class ProviderParts:
    """The provider's own objects, imported only after logging is configured."""

    app: Any
    daemon: Any              # carries instance_id and server_exit_callback
    host: str
    port: int
    runtime_version: Any
    protocol_version: Any
    singleton_type: Callable[..., Any]
    singleton_error: type[Exception]
    enrich: Callable[[], Mapping[str, Any] | None]
    stop_account: Callable[[], Mapping[str, Any]]


def _configure_process() -> None:
    if str(PROJECT_ROOT) not in sys.path:
        sys.path.insert(0, str(PROJECT_ROOT))
    os.chdir(PROJECT_ROOT)
    # On Windows the Proactor accept loop can terminate permanently after a renderer/FastAPI socket reset
    # (WinError 64/10054), leaving SDK callback threads alive but closing the port. Selector keeps the daemon control
    # plane alive across ordinary client disconnects.
    import asyncio
    if os.name == "nt" and hasattr(asyncio, "WindowsSelectorEventLoopPolicy"):
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


def _exit_code_of(exc: SystemExit) -> int:
    try:
        return 0 if int(exc.code) == 0 else 2
    except Exception:  # not an error: a SystemExit code that is not a number exits as failed (2)
        return 2


def run_provider_daemon(entry: ProviderEntry, load: Callable[[], ProviderParts]) -> int:
    from service.platform.interpreter_guard import refuse_optimized_interpreter

    refuse_optimized_interpreter(f"{entry.source} daemon")
    _configure_process()
    from config.source_settings import source_enabled
    if not source_enabled(entry.source):
        print(f"[DAEMON] {entry.source} source disabled; no services started", flush=True)
        return 0
    # Per App run (var/logs/<startup_timestamp>/<log_name>), bounded like every provider daemon's log.
    from backend.shared.detached_output import redirect_detached_output
    redirect_detached_output(env_flag=entry.detached_env, log_name=entry.log_name, source=entry.detached_source, label=entry.label)
    # Configure logging only after a possible stdout/stderr redirect above, so the logging StreamHandler binds to
    # wherever diagnostics actually end up (detached log file or console), matching print()'s behavior.
    from service.platform.logging_setup import configure_logging
    configure_logging()
    try:
        import uvicorn
        from backend.shared.daemon_server import ReadyWhenServing
        from service.market.shared.daemon_transport import DAEMON_SERVER_KEEP_ALIVE_SECONDS
        from service.market.shared.dataflow_health import DataFlowSnapshotPublisher, dataflow_health_ledger
        from service.platform.dataflow_log import DataFlowIntervalLogger
        parts = load()
    except Exception:
        traceback.print_exc()
        return 2

    singleton = parts.singleton_type(metadata={
        "daemon_instance_id": parts.daemon.instance_id,
        "runtime_version": parts.runtime_version,
        "protocol_version": parts.protocol_version,
        "port": parts.port,
        "project_root": str(PROJECT_ROOT),
    })
    try:
        singleton.acquire()
    except parts.singleton_error as exc:
        print(f"[{entry.label}] singleton already active; refusing {entry.refusal} "
              f"classification={exc.classification} owner={exc.owner}", flush=True)
        return 3
    except Exception:
        traceback.print_exc()
        return 2

    singleton.start_heartbeat()
    dataflow_health_ledger.assign_process(entry.component, instance_id=parts.daemon.instance_id)
    health_publisher = DataFlowSnapshotPublisher(
        dataflow_health_ledger, component=entry.component, interval_seconds=1.0, enrich=parts.enrich)
    health_publisher.start()
    # Interval dataflow time series for this run (var/logs/<run>/dataflow-<component>.log). It differences the same
    # snapshot the health publisher already produces -- no extra hot-path sampling -- and writes nothing during an
    # idle interval.
    dataflow_logger = DataFlowIntervalLogger(entry.component, dataflow_health_ledger.snapshot)
    dataflow_logger.start()
    exit_code = 2
    try:
        config = uvicorn.Config(
            parts.app,
            host=parts.host,
            port=int(parts.port),
            log_level="info",
            # Successful 1-second quote/status reads are normal data-plane traffic: logging every 2xx request wrote
            # hundreds of megabytes and competed with durable market-data persistence.
            access_log=False,
            timeout_keep_alive=DAEMON_SERVER_KEEP_ALIVE_SECONDS,
        )
        server = ReadyWhenServing(config)

        def request_exit() -> None:
            server.should_exit = True

        parts.daemon.server_exit_callback = request_exit
        server.run()
        exit_code = 0
        return 0
    except SystemExit as exc:
        exit_code = _exit_code_of(exc)
        return exit_code
    except KeyboardInterrupt:  # not an error: Ctrl+C is a clean stop
        exit_code = 0
        return 0
    except Exception:
        traceback.print_exc()
        return 2
    finally:
        try:
            health_publisher.stop()
        except Exception as exc:
            record_failure(_failure_log, f"stopping the {entry.source} health publisher", exc)
        # Its thread samples the ledger every interval: it ends with the server, not with the interpreter.
        dataflow_logger.stop()
        parts.daemon.server_exit_callback = None
        # The owner's stop receipt: this daemon's own account of its stop, bound to its instance.
        try:
            account = {**parts.stop_account(), "exit_code": exit_code}
        except Exception as exc:  # noqa: BLE001 -- the lock is released whatever the account says
            record_failure(_failure_log, f"writing the {entry.source} daemon's stop account", exc)
            account = {"clean": False, "error": f"stop account unavailable: {type(exc).__name__}", "exit_code": exit_code}
        singleton.release(receipt=account)
