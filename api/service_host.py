"""Shared host for every Python business API process (docs/system-architecture/00 sections 1-4, 07).

Each service (quote_api, history_api, model_api, data_center_api, actual_account_api, paper_account_api,
settings_api) is its own process with its own app factory and minimal resource graph; this module only gives them
the same shell:

* ``/api/service/identity|metrics|drain|stop`` -- management endpoints on the service's own port (no extra
  monitoring port), authorized by the service-management credential Health holds (never the renderer's token);
* business routes behind the per-launch client token (``ClientAuthenticationMiddleware``);
* request metrics per route group (rate, in-flight, errors, latency percentiles) -- counters and gauges, never
  invented percentages;
* a drain gate: new business requests get 503 while in-flight ones finish, then resources close.

A service binds exactly the port the resolver gives it for its service_id (``--port`` from Health must agree), and
reports the config revision it was started from.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import threading
import time
from collections import deque
from contextlib import asynccontextmanager
from typing import Any, Callable, Protocol

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware
from starlette.responses import JSONResponse

from api.client_auth import ClientAuthenticationMiddleware
from api.source_gate import SourceAdmissionMiddleware
from config.observability_contract import histogram_summary, metric, service_metrics_document
import logging
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)

SERVICE_PROTOCOL = "stock-monitor-service-v1"
MANAGEMENT_PREFIX = "/api/service/"


class ServiceResources(Protocol):
    def bind(self, app: FastAPI) -> None: ...
    async def start(self) -> None: ...
    async def close(self) -> None: ...
    def metrics(self) -> list[dict[str, Any]]: ...
    def prepare_shutdown(self) -> dict[str, Any]: ...


def management_token() -> str:
    """Health's management credential, for a caller started by hand (tests, developer tools). A service started by
    Health is never given it, only its digest; with the daemon token instead, which every API holds, any API could stop another."""
    from service.platform.daemon_auth import load_or_create_management_token

    return load_or_create_management_token()


def management_digest() -> str | None:
    from service.platform.daemon_auth import CredentialNotGranted, expected_digest

    try:
        return expected_digest("management")
    except CredentialNotGranted:  # not an error: this service was not granted the management credential: no digest by contract
        return None


def route_group(path: str) -> str:
    parts = [p for p in path.split("/") if p]
    if len(parts) >= 2 and parts[0] in {"api", "ws"}:
        return "/" + "/".join(parts[:2])
    return "/" + (parts[0] if parts else "")


class RequestMetrics:
    WINDOW_S = 60.0

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.inflight = 0
        self.total = 0
        self.errors = 0
        # 2xx JSON answers whose top-level ``ok`` is false: the service answered, the operation failed. Only
        # >= 500 alone would count, so a sync or write failing on every call would look healthy.
        self.app_failures = 0
        self.rejected_draining = 0
        self._groups: dict[str, dict[str, Any]] = {}
        # Route group -> requests of it open now: what a drain that runs out its time was waiting on.
        self._open: dict[str, int] = {}

    def begin(self, group: str) -> None:
        with self._lock:
            self.inflight += 1
            self.total += 1
            self._open[group] = self._open.get(group, 0) + 1

    def open_groups(self) -> dict[str, int]:
        with self._lock:
            return dict(self._open)

    def end(self, group: str, status: int, elapsed_us: float, *, app_failure: bool = False) -> None:
        now = time.monotonic()
        with self._lock:
            self.inflight -= 1
            left = self._open.get(group, 0) - 1
            if left > 0:
                self._open[group] = left
            else:
                self._open.pop(group, None)
            if status >= 500:
                self.errors += 1
            g = self._groups.setdefault(group, {"count": 0, "errors": 0, "app_failures": 0, "samples": deque()})
            g["count"] += 1
            if status >= 500:
                g["errors"] += 1
            if app_failure:
                self.app_failures += 1
                g["app_failures"] += 1
            g["samples"].append((now, elapsed_us))
            self._expire(g["samples"], now)

    def _expire(self, samples: deque, now: float) -> None:
        # Both on write and on read: an idle service's histogram must not keep reporting minutes-old requests.
        while samples and now - samples[0][0] > self.WINDOW_S:
            samples.popleft()

    def document(self, service_id: str) -> list[dict[str, Any]]:
        now = time.monotonic()
        with self._lock:
            for g in self._groups.values():
                self._expire(g["samples"], now)
            out = [
                metric("http.inflight", service_id, value=self.inflight, unit="requests"),
                metric("http.requests_total", service_id, value=self.total, unit="requests", kind="counter"),
                metric("http.errors_total", service_id, value=self.errors, unit="requests", kind="counter"),
                metric("http.app_failures_total", service_id, value=self.app_failures, unit="requests", kind="counter"),
                metric("http.rejected_draining_total", service_id, value=self.rejected_draining, unit="requests", kind="counter"),
            ]
            for group, g in sorted(self._groups.items()):
                samples = [s[1] for s in g["samples"]]
                out.append(histogram_summary(f"http.latency{group}", service_id, samples, start="request_received",
                                             end="response_started", window_ms=int(self.WINDOW_S * 1000), route_group=group))
                out.append(metric(f"http.requests{group}", service_id, value=g["count"], unit="requests", kind="counter", route_group=group))
                out.append(metric(f"http.app_failures{group}", service_id, value=g["app_failures"], unit="requests",
                                  kind="counter", route_group=group))
            return out


class _BodyProbe:
    """Copies a small JSON response body (already sent on) to read its top-level ``ok`` afterwards."""

    LIMIT = 64 * 1024

    def __init__(self) -> None:
        self._json = False
        self._chunks: list[bytes] = []
        self._size = 0
        # A body past LIMIT is not a small JSON document: what was copied is dropped and nothing more is copied.
        self._overflow = False

    def start(self, message: dict[str, Any]) -> None:
        headers = {bytes(k).lower(): bytes(v) for k, v in message.get("headers") or []}
        self._json = headers.get(b"content-type", b"").startswith(b"application/json")

    def add(self, chunk: bytes) -> None:
        if not self._json or self._overflow:
            return
        if self._size + len(chunk) > self.LIMIT:
            self._overflow = True
            self._chunks.clear()
            return
        self._chunks.append(bytes(chunk))
        self._size += len(chunk)

    def reports_failure(self) -> bool:
        if not self._json or self._overflow:
            return False
        try:
            document = json.loads(b"".join(self._chunks))
        except ValueError:  # not an error: a body that is not JSON is not an ok:false document
            return False
        return isinstance(document, dict) and document.get("ok") is False


class ServiceHostMiddleware:
    """Pure ASGI: request metrics, the drain gate, and management authorization."""

    def __init__(self, app, *, host: "ServiceHost"):
        self.app = app
        self.host = host

    async def __call__(self, scope, receive, send):
        kind = scope.get("type")
        if kind not in {"http", "websocket"}:
            return await self.app(scope, receive, send)
        path = str(scope.get("path") or "")
        if path.startswith(MANAGEMENT_PREFIX):
            from service.platform.daemon_auth import bearer_matches

            if not bearer_matches(scope, self.host.management_digest):
                return await JSONResponse({"ok": False, "error": "SERVICE_MANAGEMENT_AUTH_REQUIRED"}, status_code=401)(scope, receive, send)
            return await self.app(scope, receive, send)
        if self.host.draining:
            self.host.requests.rejected_draining += 1
            if kind == "websocket":
                await send({"type": "websocket.close", "code": 1012})
                return
            return await JSONResponse({"ok": False, "error": "service is draining", "service_id": self.host.service_id},
                                      status_code=503)(scope, receive, send)
        started = time.perf_counter()
        status_holder = {"status": 101 if kind == "websocket" else 500}
        body = _BodyProbe()
        # The latency is request received -> response started (http.latency end=response_started). Timing to the end of
        # the response counted a stream -- 實際庫存's positions/events SSE -- as one request as long as it stayed open
        # (10-19: P95 1,336,212 ms). A response that never starts ends the timing when the app returns.
        responded: dict[str, float] = {}

        async def tracking_send(message):
            kind_of = message.get("type")
            if kind_of in {"http.response.start", "websocket.accept", "websocket.close"} and "at" not in responded:
                responded["at"] = time.perf_counter()
            if kind_of == "http.response.start":
                status_holder["status"] = int(message.get("status") or 500)
                body.start(message)
            elif kind_of == "http.response.body":
                body.add(message.get("body") or b"")
            await send(message)

        group = route_group(path)
        self.host.requests.begin(group)
        try:
            await self.app(scope, receive, tracking_send)
        finally:
            status = status_holder["status"]
            self.host.requests.end(group, status, (responded.get("at", time.perf_counter()) - started) * 1e6,
                                   app_failure=200 <= status < 300 and body.reports_failure())


class ServiceHost:
    def __init__(self, service_id: str, *, port: int | None, config_revision: int | None,
                 bind_host: str | None = None) -> None:
        self.service_id = service_id
        self.port = port
        # The address uvicorn binds: Health compares it with the revision's host, never assumes loopback.
        self.bind_host = bind_host
        self.config_revision = config_revision
        self.instance_id = f"{service_id}-{os.getpid()}-{time.time_ns()}"
        self.management_digest = management_digest()
        self.requests = RequestMetrics()
        self.draining = False
        self.resources: Any = None
        self.exit_callback: Callable[[], None] | None = None
        self.components: Any = None  # the process's shared api.components.Components, built on first use
        # Ends long-lived response streams (Server-Sent Events) when the service drains: an open stream counts as an
        # in-flight request, so a drain would otherwise wait out its whole timeout and report not idle.
        self.stream_closers: list[Callable[[], None]] = []
        # The resources' shutdown runs once per process, whichever path asks first: /stop's forced drain, a plain
        # drain, or the lifespan's end -- never two or three times.
        self._shutdown_receipt: dict[str, Any] | None = None
        self._shutdown_guard = threading.Lock()

    def _shutdown_once(self) -> dict[str, Any]:
        # The receipt is terminal whatever it says: a prepare that failed is not run again by the next path --
        # its side effects already happened -- and its failure is the receipt every later caller gets.
        with self._shutdown_guard:
            if self._shutdown_receipt is None:
                prepare = getattr(self.resources, "prepare_shutdown", None)
                try:
                    self._shutdown_receipt = (prepare() if callable(prepare) else {}) or {}
                except Exception as exc:  # noqa: BLE001 -- recorded and returned as the shutdown's terminal receipt
                    record_failure(_failure_log, f"{self.service_id}: preparing the resources for shutdown", exc)
                    self._shutdown_receipt = {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:500]}
                if self.components is not None:
                    self.components.shutdown()
                # failures repeated within their last minute are written now, not lost with the process
                from service.platform.failure_record import flush_failure_repeats
                flush_failure_repeats()
            return self._shutdown_receipt

    async def shutdown_resources(self) -> dict[str, Any]:
        return await asyncio.to_thread(self._shutdown_once)

    def identity(self) -> dict[str, Any]:
        return {"ok": True, "protocol": SERVICE_PROTOCOL, "service_id": self.service_id, "instance_id": self.instance_id,
                "pid": os.getpid(), "host": self.bind_host, "port": self.port,
                "config_revision": self.config_revision,
                "draining": self.draining}

    async def drain(self, timeout_s: float = 10.0, *, force: bool = False) -> dict[str, Any]:
        """Stop admitting, wait for in-flight requests, then prepare the resources for shutdown.

        ``ok`` is whether it drained. Resources are prepared (closed) only once nothing is in flight, or when the
        caller forces it (stop), which is then reported as ``forced``. The identity is merged first, so its
        ``ok: True`` never overwrites a failed drain and resources are never closed under active requests.
        """
        self.draining = True
        started = time.monotonic()
        for close_stream in list(self.stream_closers):
            try:
                close_stream()
            except Exception as exc:
                record_failure(_failure_log, "closing a stream at shutdown", exc)
        streams_closed = time.monotonic()
        deadline = streams_closed + timeout_s
        while self.requests.inflight > 0 and time.monotonic() < deadline:
            await asyncio.sleep(0.02)
        idle = self.requests.inflight == 0
        waited = time.monotonic()
        if not idle:
            # A drain that runs out its time is a failure: something did not end when the service drained (a stream
            # without a closer, a request stuck on a dead peer), and the stop waited for it.
            record_failure(_failure_log, f"{self.service_id}: draining",
                           TimeoutError(f"{self.requests.inflight} request(s) still open after {timeout_s} s: "
                                        f"{self.requests.open_groups()}"))
        receipt = {}
        if (idle or force) and self.resources is not None:
            receipt = await self.shutdown_resources()
        timings = {"close_streams_ms": round((streams_closed - started) * 1000), "wait_inflight_ms": round((waited - streams_closed) * 1000),
                   "shutdown_resources_ms": round((time.monotonic() - waited) * 1000)}
        _failure_log.info("[SHUTDOWN] %s drained idle=%s forced=%s %s", self.service_id, idle, bool(force and not idle), timings)
        return {**self.identity(), "ok": idle, "inflight": self.requests.inflight, "receipt": receipt,
                "forced": bool(force and not idle), "timings_ms": timings}


def create_service_app(service_id: str, resources_factory: Callable[[FastAPI, ServiceHost], Any], *, port: int | None = None,
                       config_revision: int | None = None, client_token: str | None = None,
                       bind_host: str | None = None) -> FastAPI:
    host = ServiceHost(service_id, port=port, config_revision=config_revision, bind_host=bind_host)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        resources = resources_factory(app, host)
        host.resources = resources
        app.state.resources = resources
        if hasattr(resources, "bind"):
            resources.bind(app)
        try:
            if hasattr(resources, "start"):
                await resources.start()
            yield
        finally:
            # A start that failed part-way is closed like a finished run; the shutdown runs at most once, and
            # the resources are closed whatever it answered.
            try:
                await host.shutdown_resources()
            finally:
                if hasattr(resources, "close"):
                    await resources.close()

    from service.platform.http.errors import register_error_handlers
    from service.platform.http.safe_json_response import SafeJSONResponse

    app = FastAPI(title=f"StockMonitor {service_id}", lifespan=lifespan, default_response_class=SafeJSONResponse)
    register_error_handlers(app)
    app.state.service_host = host
    app.state.resources = None
    # Innermost first: a disabled source's routes are refused before any handler can build its services.
    app.add_middleware(SourceAdmissionMiddleware)
    app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=5)
    app.add_middleware(ClientAuthenticationMiddleware, token=client_token)
    app.add_middleware(ServiceHostMiddleware, host=host)
    from config.network_settings import CORS_ALLOWED_ORIGINS

    app.add_middleware(CORSMiddleware, allow_origins=list(CORS_ALLOWED_ORIGINS), allow_credentials=False,
                       allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"], allow_headers=["Content-Type", "Authorization"])

    @app.get("/api/service/identity")
    def service_identity():
        return host.identity()

    @app.get("/api/service/metrics")
    def service_metrics():
        extra = []
        if host.resources is not None and hasattr(host.resources, "metrics"):
            try:
                extra = list(host.resources.metrics() or [])
            except Exception as exc:  # noqa: BLE001 -- a failing resource metric is reported, not fatal
                record_failure(_failure_log, f"{service_id}: reading the resource metrics", exc)
                extra = [metric("resource.metrics", service_id, unit="n/a", availability="TEMPORARILY_UNAVAILABLE", reason=str(exc)[:200])]
        return service_metrics_document(service_id, host.instance_id, host.requests.document(service_id) + extra,
                                        config_revision=host.config_revision, pid=os.getpid())

    @app.post("/api/service/drain")
    async def service_drain():
        return await host.drain()

    @app.post("/api/service/stop")
    async def service_stop():
        # The process exits after a stop whatever the drain answered: a failed shutdown left it draining --
        # refusing every request -- and running.
        try:
            receipt = await host.drain(force=True)
        except Exception as exc:  # noqa: BLE001 -- recorded; the stop still ends the process
            record_failure(_failure_log, f"{service_id}: draining for stop", exc)
            receipt = {**host.identity(), "ok": False, "error": f"{type(exc).__name__}: {exc}"[:500]}
        finally:
            callback = host.exit_callback
            if callback is not None:
                asyncio.get_running_loop().call_later(0.2, callback)
        return {**receipt, "stopping": True}

    @app.get("/api/diagnostics/client-auth")
    def client_auth_status():
        return {"ok": True}

    return app


class CompositeResources:
    """Several business parts (one per former service module) served by one process.

    Each part keeps its own routes, start/close, metrics and shutdown receipt; the process owns the port, the auth,
    the request metrics and the drain gate. Parts start in the given order and close in reverse.
    """

    def __init__(self, host: ServiceHost, parts: tuple[tuple[str, Callable[[ServiceHost], Any]], ...]) -> None:
        self.host = host
        self.parts: list[tuple[str, Any]] = [(name, factory(host)) for name, factory in parts]
        self._started: list[tuple[str, Any]] = []

    def bind(self, app: FastAPI) -> None:
        for _name, part in self.parts:
            part.bind(app)

    async def start(self) -> None:
        # A part that fails to start leaves the ones before it started: those -- and only those -- are closed in
        # reverse by close().
        for name, part in self.parts:
            await part.start()
            self._started.append((name, part))
        # Components the parts handed out unbuilt (api/components.py Deferred) are built once the process listens.
        components = getattr(self.host, "components", None)
        if components is not None and hasattr(components, "warm"):
            components.warm(delay_s=2.0)

    async def close(self) -> None:
        started, self._started = self._started, []
        errors = []
        for name, part in reversed(started):
            try:
                await part.close()
            except Exception as exc:  # noqa: BLE001 -- every started part is closed; failures are raised together
                # not an error: collected and raised together below
                errors.append(f"{name}: {type(exc).__name__}: {exc}")
        if errors:
            raise RuntimeError("closing parts failed: " + "; ".join(errors))

    def metrics(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for name, part in self.parts:
            try:
                out.extend(part.metrics() or [])
            except Exception as exc:  # noqa: BLE001 -- one part's failing metric never hides the others
                record_failure(_failure_log, f"{name}: reading its metrics", exc)
                out.append(metric("resource.metrics", name, unit="n/a", availability="TEMPORARILY_UNAVAILABLE", reason=str(exc)[:200]))
        return out

    def prepare_shutdown(self) -> dict[str, Any]:
        # Every started part is prepared, in reverse; one failing never skips the others.
        receipts: dict[str, Any] = {}
        for name, part in reversed(self._started):
            try:
                receipts[name] = part.prepare_shutdown()
            except Exception as exc:  # noqa: BLE001 -- recorded in this part's receipt; the others still run
                record_failure(_failure_log, f"{self.host.service_id}/{name}: preparing for shutdown", exc)
                receipts[name] = {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:500]}
        return receipts


def create_composite_app(service_id: str, parts: tuple[tuple[str, Callable[[ServiceHost], Any]], ...], **kwargs: Any) -> FastAPI:
    """One process serving several parts: their components are shared (one instance per process, see
    api.components.Components.for_host), so one file has one owner in memory instead of one per process."""
    return create_service_app(service_id, lambda app, host: CompositeResources(host, parts), **kwargs)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--config-revision", type=int, default=None)
    return parser.parse_args(argv)


def run_service(service_id: str, build_app: Callable[..., FastAPI], argv: list[str] | None = None) -> None:
    """Resolve this service's endpoint, verify it matches what Health asked for, and serve."""
    from service.platform.interpreter_guard import refuse_optimized_interpreter

    refuse_optimized_interpreter(service_id)
    import uvicorn

    from config import config_revisions
    from config.network_settings import EFFECTIVE, endpoint
    from service.platform.logging_setup import configure_logging
    from service.platform.remediation import emitter

    configure_logging()
    # config/ never starts runtime machinery itself: a config lock takeover reaches Health's ledger through this
    # process's emitter, installed here.
    config_revisions.set_remediation_emitter(emitter)
    args = parse_args(argv)
    host, port = endpoint(service_id)
    if args.port is not None and args.port != port:
        raise SystemExit(f"{service_id}: Health asked for port {args.port} but the effective config says {port}; refusing to guess")
    revision = args.config_revision if args.config_revision is not None else EFFECTIVE.get("revision")
    app = build_app(port=port, bind_host=host, config_revision=revision)
    server = uvicorn.Server(uvicorn.Config(app, host=host, port=port, log_level="info", access_log=False, timeout_graceful_shutdown=10))
    app.state.service_host.exit_callback = lambda: setattr(server, "should_exit", True)
    server.run()
