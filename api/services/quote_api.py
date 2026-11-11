"""quote_api (a part of realtime_api; no process or factory of its own): low-frequency page initialization, product display info and small queries (00 section 2).

It never builds a second intraday state: quotes, ticks, BidAsk, trends and signals go Backend -> market_runtime ->
UI directly. What stays here is page bootstrap, source/broker status and operations (reconnect, holdings), the
security master, trade-detail pages and the analysis event archive of past days.
"""
from __future__ import annotations

import logging
import threading
from typing import Any

from fastapi import FastAPI

from api.components import Components, Deferred, run_read
from api.service_host import ServiceHost
from config.observability_contract import metric
from config.source_settings import source_enabled
from service.platform.failure_record import record_failure

SERVICE_ID = "quote_api"
logger = logging.getLogger(__name__)


def _built(client: Any) -> Any:
    """A daemon client as far as it exists: a deferred one not built yet is None (a status read never builds it)."""
    return client.built() if isinstance(client, Deferred) else client


class Resources:
    def __init__(self, host: ServiceHost) -> None:
        from service.market.shared.disabled_source import DisabledSourceClient
        from service.market.shared.dataflow_health import DataFlowHealthLedger

        self.host = host
        self.components = Components.for_host(host)
        self.shutdown = threading.Event()
        self.ledger = DataFlowHealthLedger(component=SERVICE_ID, instance_id=host.instance_id)

        # The daemon clients are built (and their streams started) after the process listens, not in front of it:
        # constructing them was 1.2 s of every realtime_api start. A request that needs one waits for it.
        # A disabled source is only a small stand-in and is built right away.
        def shioaji_client():
            from service.market.shioaji.daemon_client import MarketDaemonClient
            return MarketDaemonClient(health_ledger=self.ledger)

        def futu_client():
            from service.market.futu.daemon_client import MoomooDaemonClient
            return MoomooDaemonClient()

        self.runtime = (self.components.lazy("quote.shioaji_client", shioaji_client) if source_enabled("shioaji")
                        else DisabledSourceClient("shioaji"))
        self.futu = (self.components.lazy("quote.futu_client", futu_client) if source_enabled("futu")
                     else DisabledSourceClient("futu"))
        from api.source_diagnostics import create_source_diagnostics
        self.diagnostics = create_source_diagnostics(self.runtime, self.futu)

    def bind(self, app: FastAPI) -> None:
        from api.routes.futu_routes import FutuRouteDependencies, create_futu_router
        from api.routes.market_routes import MarketRouteDependencies, create_market_router
        from api.routes.product_routes import SecurityMasterRouteDependencies, create_security_master_router
        from service.market.projection.analysis_event_archive import AnalysisEventArchive

        c = self.components

        app.include_router(create_market_router(MarketRouteDependencies(
            runtime=self.runtime, futu_client=self.futu, broker_status=self.diagnostics.broker_status,
            events=AnalysisEventArchive())))
        app.include_router(create_security_master_router(SecurityMasterRouteDependencies(
            security_master=c.lazy("security_master"), shioaji_app=lambda: getattr(self.runtime, "app", None))))
        stats = lambda: getattr(self.futu, "stats", lambda: {})()  # noqa: E731 -- resolved per request
        app.include_router(create_futu_router(FutuRouteDependencies(proxy=c.futu_proxy(), run_blocking_read=run_read, client_stats=stats)))

        @app.get("/api/status")
        async def status():
            def build():
                runtime_health: dict[str, Any]
                try:
                    from service.market.shared.rust_view_client import RustViewClient
                    runtime_health = RustViewClient().health(timeout=1.5)
                except Exception as exc:  # noqa: BLE001 -- reported, never fatal
                    # Polled status: no socket error text to the client; debug log only.
                    logger.debug("[QUOTE API] market_runtime health unreachable: %r", exc)
                    runtime_health = {"status": "unreachable", "error": "Market Runtime 無法連線"}
                # Once, before both readers below, so the whole answer describes one snapshot.
                self.runtime.refresh_health()
                return {"ok": True, "service_id": SERVICE_ID, "sources": self.diagnostics.status_snapshot(),
                        "broker_status": self.diagnostics.broker_status(), "market_runtime": runtime_health,
                        "market_sessions": self.diagnostics.market_sessions()}
            return await run_read(build)

        @app.get("/api/sources")
        def sources():
            return {"ok": True, "sources": self.diagnostics.status_snapshot()}

        @app.get("/api/diagnostics/readiness")
        def readiness():
            return {"ok": True, "ready": True, "service_id": SERVICE_ID}

        @app.get("/api/diagnostics/heartbeat")
        def heartbeat():
            # Electron's startup rows wait on exactly these three facts. A heartbeat answering only ok and
            # service_id would let every wait run to its timeout (8-12 s on each start) and the rows end degraded.
            # All three are the clients' in-memory state: no daemon call is made here, and a client still being
            # built reads as not attached -- never waited for (the build lock held the heartbeat past Electron's
            # 800 ms: "[STARTUP heartbeat predicate read] failed This operation was aborted").
            def read(owner, method):
                reader = getattr(owner, method, None)
                try:
                    return dict(reader() or {}) if callable(reader) else {}
                except Exception as exc:
                    record_failure(logger, "reading a diagnostic for the heartbeat", exc)
                    return {}
            runtime, futu = _built(self.runtime), _built(self.futu)
            ingress = dict(read(runtime, "cached_health").get("live_ingress") or {})
            return {"ok": True, "service_id": SERVICE_ID,
                    "stream": {"attached": read(runtime, "stream_stats").get("attached") is True},
                    "live_ingress": {"running": ingress.get("running") is True, "ready": ingress.get("ready") is True},
                    "moomoo": {"attached": read(futu, "stats").get("attached") is True}}

        @app.get("/api/profiling")
        def profiling():
            return {"ok": True, "requests": self.host.requests.document(SERVICE_ID)}

    async def start(self) -> None:
        # realtime_api starts beside app_api, not after the provider daemons (it listens first; only these clients
        # need a daemon): each client attaches once its daemon's owner record says READY -- the record Health's own
        # start of that daemon waits on -- so the window and the APIs never wait for a broker login.
        from service.market.futu.daemon_singleton import owner_metadata_path as futu_owner
        from service.market.shared.disabled_source import DisabledSourceClient
        from service.market.shared.daemon_singleton import wait_until_owner_ready
        from service.market.shioaji.daemon_singleton import singleton_owner_metadata_path as shioaji_owner

        def start_client(label: str, client: Any, method: str, owner_path) -> None:
            if isinstance(client, DisabledSourceClient):
                return  # a disabled source has no daemon to wait for
            # Build the client now, while its daemon is still starting: building it (its imports, pandas and requests
            # among them) took ~2 s, and done after READY it held the attach -- the 永豐 light -- 2.3 s behind a
            # broker that had already logged in (10-19). Construction does no I/O.
            starter = getattr(client, method, None)
            if not wait_until_owner_ready(owner_path(), self.shutdown, label=label, logger=logger):
                return
            if callable(starter) and not self.shutdown.is_set():
                starter(self.shutdown, logger=logger)

        for label, client, method, owner_path in (("shioaji", self.runtime, "start_in_background", shioaji_owner),
                                                  ("futu", self.futu, "attach_in_background", futu_owner)):
            threading.Thread(target=start_client, args=(label, client, method, owner_path), daemon=True,
                             name=f"quote-{label}-client").start()

    async def close(self) -> None:
        # The shutdown itself runs once, through ServiceHost.shutdown_resources.
        return None

    def metrics(self) -> list[dict[str, Any]]:
        out = [metric("components.built", SERVICE_ID, value=len(self.components.built()), unit="components"),
                metric("components.failed", SERVICE_ID, value=len(self.components.failed()), unit="components")]
        stream = getattr(_built(self.runtime), "stream_stats", None)
        if callable(stream):
            s = stream()
            out.append(metric("provider_shioaji.stream_attached", SERVICE_ID, value=int(bool(s.get("attached"))), unit="bool"))
        return out

    def prepare_shutdown(self) -> dict[str, Any]:
        self.shutdown.set()
        receipt = {}
        for name, client in (("shioaji", self.runtime), ("futu", self.futu)):
            if not getattr(client, "is_built", True):
                continue  # never built (the process stopped before its first use): nothing to detach
            stop = getattr(client, "stop", None)
            if callable(stop):
                try:
                    result = stop() or {}
                except Exception as exc:  # noqa: BLE001 -- a courtesy detach never blocks shutdown
                    record_failure(logger, f"stopping the {name} daemon client at shutdown", exc)
                    receipt[name] = f"detach failed: {type(exc).__name__}"
                    continue
                # The receipt says what the stop did: a refused or failed detach is not "detached".
                if not result.get("ok", True):
                    receipt[name] = f"detach failed: {result.get('error') or 'refused'}"
                elif result.get("detached"):
                    receipt[name] = "detached"
                else:
                    receipt[name] = "no lease held"
        return receipt
