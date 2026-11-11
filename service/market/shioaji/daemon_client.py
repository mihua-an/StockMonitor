from __future__ import annotations

import logging
import threading
import time
import uuid
from copy import deepcopy
from datetime import datetime
from typing import Any

from service.market.shared.daemon_connection import join_workers
from service.market.shared.daemon_lease import DaemonLease
# Re-exported: these live in a dependency-free module so a caller that only needs to NAME a daemon
# error (api/routes/history_routes.py) does not have to import this module and, through it, the
# whole pandas-backed historical stack.
from service.market.shioaji.daemon_errors import (  # noqa: F401
    ForeignMarketDaemonEndpoint,
    IncompatibleMarketDaemon,
    MarketDaemonError,
)
from service.market.shared.daemon_transport import DaemonHttpTransport, DaemonTransportError
from service.market.shioaji.daemon_probe import (
    inspect_market_daemon_port_owner,
    is_known_market_daemon_owner,
    market_daemon_port_open,
    probe_market_daemon_detailed,
    reprobe_known_daemon,
    is_daemon_usable,
    assess_passive_health_snapshot,
)

from service.market.shioaji.daemon_contract import (
    MARKET_DAEMON_IDENTITY,
    MARKET_DAEMON_PROTOCOL_VERSION,
    MARKET_DAEMON_RUNTIME_VERSION,
)
from service.market.shioaji.daemon_settings import (
    MARKET_DAEMON_CLIENT_HEARTBEAT_SECONDS,
    MARKET_DAEMON_HOST,
    MARKET_DAEMON_PORT,
)
from service.market.shioaji.history_repository import ShioajiHistoricalRepository
from service.market.shioaji.daemon_stream import MarketDaemonStream
from service.market.shared.dataflow_health import (
    dataflow_health_ledger,
    dataflow_snapshot_path,
    read_dataflow_snapshot,
)
from service.market.storage.market_storage_layout import process_market_layout
from service.platform.failure_record import record_failure

_logger = logging.getLogger(__name__)

# Electron's own bounded daemon spawn/attach window is ~60-90s (see health/startup/provider_daemon_ownership.js); a
# background attach still failing past it is logged as an error. The loop never gives up on its own: the Market
# Daemon is this App's, and one that comes back through Electron respawn or Health recovery must still be attached
# (there is no manual retry for it). A foreign program on its port stops the loop at once.
MARKET_DAEMON_ATTACH_ESCALATION_SECONDS = 90.0
_ATTACH_PERMANENT = frozenset({"FOREIGN_ENDPOINT"})


_transport = DaemonHttpTransport(MARKET_DAEMON_HOST, MARKET_DAEMON_PORT)


def _port_open(timeout: float = 0.2) -> bool:
    return market_daemon_port_open(timeout)


def ensure_market_daemon(*, timeout: float = 60.0) -> dict[str, Any]:
    """Attach to an existing daemon without acquiring process-control rights.

    Initial startup belongs to Electron; runtime recovery belongs to
    the external Recovery Executor.
    """
    detailed_probe = probe_market_daemon_detailed()
    health = detailed_probe.get("payload") if detailed_probe.get("ok") else None
    if health is not None:
        if str(health.get("identity") or "") != MARKET_DAEMON_IDENTITY:
            raise ForeignMarketDaemonEndpoint(f"port {MARKET_DAEMON_PORT} is not the Stock Monitor Market Daemon")
        if is_daemon_usable(health):
            if str(health.get("state") or "") in {"STOPPING", "STOPPED"}:
                deadline = time.monotonic() + 20.0
                while time.monotonic() < deadline and _port_open():
                    time.sleep(0.2)
                if _port_open():
                    raise MarketDaemonError("Market Daemon is stopping and did not exit in time")
                health = None
            else:
                return {"ok": True, "action": "reuse", "health": health}
        raise IncompatibleMarketDaemon("Market Daemon contract is incompatible; external recovery is required")
    elif _port_open():
        # FINAL v3: a transient HTTP200 INVALID_RESPONSE/TIMEOUT is not evidence
        # that 8010 belongs to a foreign process. Resolve listener ownership first.
        classification = str(detailed_probe.get("classification") or "INVALID_RESPONSE")
        owner = inspect_market_daemon_port_owner()
        if is_known_market_daemon_owner(owner):
            recovered = reprobe_known_daemon()
            recovered_health = recovered.get("payload") if recovered.get("ok") else None
            if isinstance(recovered_health, dict):
                if str(recovered_health.get("identity") or "") != MARKET_DAEMON_IDENTITY:
                    raise MarketDaemonError("known daemon process returned an unexpected health identity")
                if is_daemon_usable(recovered_health):
                    return {"ok": True, "action": "reuse", "health": recovered_health, "probe_recovered": True, "owner": owner}
                raise IncompatibleMarketDaemon("known Market Daemon is incompatible; external recovery is required")
            else:
                raise MarketDaemonError(
                    f"known Market Daemon owns port {MARKET_DAEMON_PORT} but health remained transiently unavailable ({classification}); refusing secondary spawn"
                )
        elif isinstance(owner, dict) and (owner.get("pid") or owner.get("commandLine") or owner.get("executablePath")):
            raise ForeignMarketDaemonEndpoint(f"port {MARKET_DAEMON_PORT} is occupied by a confirmed foreign endpoint")
        else:
            raise MarketDaemonError(
                f"Market Daemon port {MARKET_DAEMON_PORT} is open but ownership is unresolved after health failure ({classification}); refusing secondary spawn"
            )

    raise MarketDaemonError("Market Daemon is not running; external recovery is required")


class DaemonShioajiProxy:
    def __init__(self, client: "MarketDaemonClient") -> None:
        self.client = client

    def status(self) -> dict[str, Any]:
        return deepcopy(self.client.cached_health().get("shioaji") or {"connected": False, "running": False})

    def sync_now(self) -> dict[str, Any]:
        return self.client.post_json("/v1/shioaji/sync")

    def reconnect(self, reason: str = "manual_request") -> dict[str, Any]:
        # A credential change has its own control route, so the daemon records why its broker session restarts.
        if reason == "credentials_changed":
            # The daemon answers after unsubscribing every stream and logging out, which outlasts the default deadline.
            return self.client.post_json("/v1/control/credentials-changed", timeout=20.0)
        return self.client.post_json("/v1/shioaji/reconnect")

    def get_api(self) -> None:
        # Broker API object is process-local to the daemon and is deliberately not
        # exposed across IPC.
        return None


class DaemonMarketIndexProxy:
    def __init__(self, client: "MarketDaemonClient") -> None:
        self.client = client

    def get_history_session(self, date_text: str) -> dict[str, Any]:
        payload = self.client.get_json("/v1/history/taiex-session", params={"date": str(date_text)})
        payload.pop("ok", None)
        return payload


class ShioajiDaemonClientView:
    """Remote Shioaji service view used by existing FastAPI services.

    It deliberately contains no Shioaji API object, in-process runtime, or
    recorder writer. Live market truth lives in the external Market Runtime.
    """

    def __init__(self, client: "MarketDaemonClient") -> None:
        self.client = client
        self.broker_service = DaemonShioajiProxy(client)
        from service.market.history.rust_historical_store_reader import default_historical_root

        self.historical_repository = ShioajiHistoricalRepository(
            lambda: None, layout=process_market_layout(), historical_root=default_historical_root())
        self.market_index_service = DaemonMarketIndexProxy(client)

    def get_market_index_history_session(self, date_text: str) -> dict[str, Any]:
        return self.market_index_service.get_history_session(date_text)

    def get_data_center_dates(self) -> dict[str, Any]:
        try:
            # A cold Data Center request can legitimately open several evidence
            # files; product-list volume comparison itself uses the compact
            # post-close minute baseline and does not scan Raw Tick here.
            return self.client.get_json("/v1/data-center/dates", timeout=20.0)
        except MarketDaemonError as exc:
            record_failure(_logger, "reading the Data Center dates from the market daemon", exc)
            return {
                "ok": False,
                "items": [],
                "count": 0,
                "classification": "DATA_CENTER_DAEMON_TIMEOUT",
                "error": str(exc),
            }

    def get_data_center_closing(self) -> dict[str, Any]:
        try:
            return self.client.get_json("/v1/data-center/closing", timeout=10.0)
        except MarketDaemonError as exc:
            record_failure(_logger, "reading 收盤整理 from the market daemon", exc)
            return {"ok": False, "sessions": [], "classification": "DATA_CENTER_DAEMON_TIMEOUT", "error": str(exc)}

    def get_data_center_date(self, date_text: str) -> dict[str, Any]:
        try:
            return self.client.get_json(
                "/v1/data-center/date",
                params={"date": str(date_text)},
                timeout=20.0,
            )
        except MarketDaemonError as exc:
            record_failure(_logger, f"reading Data Center date {date_text} from the market daemon", exc)
            return {
                "ok": False,
                "categories": [],
                "classification": "DATA_CENTER_DAEMON_TIMEOUT",
                "error": str(exc),
            }

    # The K-bar endpoints (資料中心 K 線下載). Written over `self.client`'s get_json / post_json, which both clients
    # have: handing them through to the client worked only where it was a MarketDaemonClient -- app_api's
    # ProviderHttpClient has neither, so every call there answered 503 (10-14).

    def preview_kbar_download(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self.client.post_json("/v1/history/kbars/preview", payload, timeout=15.0)

    def create_kbar_download_job(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self.client.post_json("/v1/history/kbars/jobs", payload, timeout=15.0)

    def list_kbar_download_jobs(self, limit: int = 50) -> dict[str, Any]:
        return self.client.get_json("/v1/history/kbars/jobs", params={"limit": int(limit)}, timeout=8.0)

    def get_kbar_download_job(self, job_id: str) -> dict[str, Any]:
        return self.client.get_json(f"/v1/history/kbars/jobs/{job_id}", timeout=8.0)

    def action_kbar_download_job(self, job_id: str, action: str) -> dict[str, Any]:
        return self.client.post_json(f"/v1/history/kbars/jobs/{job_id}/action", {"action": str(action)}, timeout=15.0)

    def request_older_kbars(self, code: str, before: str) -> dict[str, Any]:
        return self.client.post_json("/v1/history/kbars/older", {"code": str(code), "before": str(before)}, timeout=15.0)

    def older_kbars_status(self, code: str) -> dict[str, Any]:
        return self.client.get_json("/v1/history/kbars/older", params={"code": str(code)}, timeout=8.0)


    def refresh_security_master(self) -> dict[str, Any]:
        return self.client.post_json("/v1/security-master/refresh")


class MarketDaemonClient:
    HEALTH_POLL_SECONDS = 2.0
    # How old the daemon's snapshot may be and still count as the daemon's current state. The daemon writes it every
    # second; this is about that writer, so it does not move with how often this client reads.
    SNAPSHOT_MAX_AGE_SECONDS = 6.0
    HEARTBEAT_SECONDS = float(MARKET_DAEMON_CLIENT_HEARTBEAT_SECONDS)

    def __init__(self, *, health_ledger=None) -> None:
        self._health_ledger = health_ledger if health_ledger is not None else dataflow_health_ledger
        # Runtime process ownership belongs to the external recovery executor.
        # Electron performs initial startup only; this client attaches, leases
        # and consumes and can never acquire spawn/stop/restart authority.
        self.app = ShioajiDaemonClientView(self)
        self._running = threading.Event()
        self._stream_thread: threading.Thread | None = None
        self._health_thread: threading.Thread | None = None
        self._lock = threading.RLock()
        self._lifecycle_lock = threading.RLock()
        self._snapshot_read_lock = threading.Lock()
        self._stopping = False
        self._health: dict[str, Any] = {
            "ok": False,
            "identity": MARKET_DAEMON_IDENTITY,
            "protocol_version": MARKET_DAEMON_PROTOCOL_VERSION,
            "daemon_runtime_version": MARKET_DAEMON_RUNTIME_VERSION,
            "shioaji_connected": False,
            "shioaji": {"connected": False, "running": False},
        }
        self._stream_received = 0
        self._stream_reconnects = 0
        self._stream_last_at: str | None = None
        self._stream_last_error: str | None = None
        self._stream_decode_errors = 0
        self._daemon_recovery_count = 0
        self._last_daemon_recovery_at: str | None = None
        self._last_daemon_recovery_monotonic = 0.0
        self._client_id = uuid.uuid4().hex
        self._lease = DaemonLease(
            provider="shioaji", client_id=self._client_id, client_name="fastapi",
            post=lambda path, body, timeout: self.post_json(path, body, timeout=timeout),
            component="market_daemon_client", attach_mechanism="client.shioaji_daemon_attach",
            reattach_mechanism="client.shioaji_lease_reattach")
        self._suppress_recovery = False
        # The last background attach attempt, for status().
        self.started_at: str | None = None
        self.last_error: str | None = None
        self.last_result: dict[str, Any] | None = None

    def start(self) -> dict[str, Any]:
        with self._lifecycle_lock:
            if self._stopping:
                return {"ok": False, "attached": False, "error": "client_stop_incomplete"}
            try:
                return self._start_locked()
            except Exception as exc:
                # not an error: the failure is start()'s answer; its callers record it (_attempt_start's
                # attach_in_background recovery)
                self._stopping = True
                cleanup = self._stop_locked(wait=True, timeout=8.0)
                return {"ok": False, "attached": False, "error": str(exc), "cleanup": cleanup}

    def _current_instance(self) -> str:
        with self._lock:
            return str(self._health.get("daemon_instance_id") or "")

    def _start_locked(self) -> dict[str, Any]:
        if self._running.is_set():
            self._lease.observe(self._current_instance())
            if self._lease.attached:
                return {"ok": True, "attached": True, "daemon": self.cached_health()}
            # Running but not attached (a reattach after a daemon restart failed): attach now, and say how it went --
            # never "ok" for a client that holds no lease.
            try:
                self._lease.attach(self._current_instance())
                attach: dict[str, Any] = {"ok": True}
            except Exception as exc:
                # not an error: answered as start()'s failed attach, which its callers record
                attach = {"ok": False, "error": str(exc)}
            return {"ok": bool(attach.get("ok")), "attached": bool(attach.get("ok")), "error": attach.get("error"),
                    "daemon": self.cached_health()}
        self._suppress_recovery = False
        try:
            ensured = ensure_market_daemon()
            with self._lock:
                self._health = dict(ensured.get("health") or self._health)
            self._lease.attach(self._current_instance())
        except Exception as exc:
            # not an error: answered as start()'s failure with its classification, which its callers record
            with self._lock:
                self._stream_last_error = str(exc)
            # FastAPI remains available for account/history/settings even when the
            # daemon is unavailable. Realtime status is explicit UNAVAILABLE.
            classification = ("FOREIGN_ENDPOINT" if isinstance(exc, ForeignMarketDaemonEndpoint)
                              else "RUNTIME_UNUSABLE" if isinstance(exc, IncompatibleMarketDaemon) else "UNAVAILABLE")
            return {"ok": False, "attached": False, "error": str(exc), "classification": classification}
        self._running.set()
        self._health_thread = threading.Thread(target=self._health_loop, name="MarketDaemonHealth", daemon=True)
        self._stream_thread = threading.Thread(target=self._stream_loop, name="MarketDaemonStream", daemon=True)
        self._health_thread.start()
        self._stream_thread.start()
        return {"ok": True, "attached": True, "client_id": self._client_id, "daemon": self.cached_health()}

    def stop(self, *, wait: bool = True, timeout: float = 8.0) -> dict[str, Any]:
        with self._lifecycle_lock:
            self._stopping = True
            return self._stop_locked(wait=wait, timeout=timeout)

    def _stop_locked(self, *, wait: bool = True, timeout: float = 8.0) -> dict[str, Any]:
        # Normal App/FastAPI shutdown releases the client lease only. The last
        # Detach starts the daemon's shared 8-minute IDLE_GRACE; no broker logout occurs.
        self._running.clear()
        alive = join_workers([self._stream_thread, self._health_thread], wait=wait, timeout=timeout)
        if alive:
            if wait:
                record_failure(_logger, f"stopping the market daemon client workers {alive} within {timeout}s")
            return {"ok": False, "detached": False, "error": "client_stop_incomplete", "workers_alive": alive, "daemon_kept_alive": True}
        daemon_health = self.cached_health()
        attached_instance_id = self._lease.instance_id or None
        # A lease taken from a daemon instance that is gone is not offered to the one answering now.
        self._lease.observe(self._current_instance())
        detach_result = self._lease.detach(timeout=3.0)
        self._stopping = not bool(detach_result.get("ok"))
        return {
            "ok": bool(detach_result.get("ok")),
            "detached": bool(detach_result.get("detached")),
            "error": detach_result.get("error"),
            "daemon_kept_alive": True,
            "daemon_idle_grace": detach_result.get("state") == "IDLE_GRACE",
            "idle_shutdown_deadline": detach_result.get("idle_shutdown_deadline"),
            "idle_remaining_seconds": detach_result.get("idle_remaining_seconds"),
            "daemon_instance_id": attached_instance_id,
            "daemon_pid": daemon_health.get("daemon_pid"),
            "detach": detach_result,
        }

    def cached_health(self) -> dict[str, Any]:
        with self._lock:
            return deepcopy(self._health)

    def stream_stats(self) -> dict[str, Any]:
        lease = self._lease.snapshot()
        with self._lock:
            return {
                "owner": "persistent_market_daemon",
                "running": self._running.is_set(),
                "attached": lease["attached"],
                "daemon_instance_id": lease["attached_daemon_instance_id"],
                "received": self._stream_received,
                "reconnects": self._stream_reconnects,
                "last_event_at": self._stream_last_at,
                "last_error": self._stream_last_error,
                "decode_errors": self._stream_decode_errors,
                "daemon_recovery_count": self._daemon_recovery_count,
                "last_daemon_recovery_at": self._last_daemon_recovery_at,
                "client_id": self._client_id,
                "control_lease_id": lease["lease_id"],
                "client_lease_attached": lease["attached"],
                "last_heartbeat_at": lease["last_heartbeat_at"],
                "last_heartbeat_error": lease["last_heartbeat_error"],
                "recovery_suppressed": self._suppress_recovery,
                "process_spawn_authority": "external_supervisor_via_electron",
            }

    def get_json(self, path: str, *, params: dict[str, Any] | None = None, timeout: float = 3.0) -> dict[str, Any]:
        try:
            return _transport.get(path, params=params, timeout=timeout)
        except DaemonTransportError as exc:
            raise MarketDaemonError(str(exc)) from exc

    def post_json(self, path: str, body: dict[str, Any] | None = None, *, params: dict[str, Any] | None = None, timeout: float = 8.0) -> dict[str, Any]:
        try:
            return _transport.post(path, json_body=body, params=params, timeout=timeout)
        except DaemonTransportError as exc:
            raise MarketDaemonError(str(exc)) from exc

    def _attempt_start(self) -> dict[str, Any]:
        """Call start() once, recording the attempt for status()."""
        self.started_at = datetime.now().isoformat(timespec="seconds")
        result = self.start()
        self.last_result = result
        self.last_error = None if result.get("ok") else str(result.get("error") or "Market Daemon unavailable")
        if result.get("ok"):
            _logger.info(f"[APP] attached market daemon instance={self.cached_health().get('daemon_instance_id')}")
        return {**result, "started_at": self.started_at}

    def start_in_background(self, shutdown_requested: threading.Event, *,
                             on_attempt=None, logger: logging.Logger | None = None) -> threading.Thread:
        """Attach in a background thread until it succeeds (DaemonLease.attach_in_background).

        Electron is the single initial-startup owner; this only retries attach
        until Electron has completed the daemon handoff, so FastAPI readiness
        never gains process spawn/stop/restart authority. ``on_attempt(started_ns)``
        is called after every attempt so a caller can profile it.
        """
        return self._lease.attach_in_background(
            self._attempt_start, shutdown_requested, stop=lambda: self.stop(wait=False, timeout=1.0),
            log=logger or _logger, thread_name="FastAPIMarketDaemonAttach", permanent=_ATTACH_PERMANENT,
            give_up_seconds=None, escalation_seconds=MARKET_DAEMON_ATTACH_ESCALATION_SECONDS, on_attempt=on_attempt)

    def status(self) -> dict[str, Any]:
        """Connectivity report for this optional RPC/control client (not a readiness authority)."""
        health = self.cached_health()
        stream = self.stream_stats()
        return {
            "ok": True,
            "source": "shioaji",
            "source_status": health.get("source_status"),
            "owner": "persistent_market_daemon_client",
            "attached": bool(stream.get("attached")),
            "stream_running": bool(stream.get("running")),
            "last_result": self.last_result,
            "last_error": self.last_error or health.get("last_error"),
            "market_daemon": health,
            "market_daemon_stream": stream,
        }

    def refresh_health(self) -> None:
        """Bring cached_health() up to the daemon's snapshot as it is now, for a reader that reports the current state
        (/api/status) and should not answer with what the health loop saw up to HEALTH_POLL_SECONDS ago."""
        if self._running.is_set():
            self._adopt_snapshot()

    def _adopt_snapshot(self) -> dict[str, Any]:
        """Read the daemon's snapshot into the cache; returns the fresh health read from it, {} when there is none."""
        # One reader at a time, so a slower read can never overwrite the newer one that finished before it.
        with self._snapshot_read_lock:
            snapshot = read_dataflow_snapshot(dataflow_snapshot_path("market_daemon"))
            passive = assess_passive_health_snapshot(
                snapshot,
                now_epoch_ns=time.time_ns(),
                max_age_seconds=self.SNAPSHOT_MAX_AGE_SECONDS,
            )
            producer = passive["producer"]
            snapshot_fresh = bool(passive["snapshot_fresh"])
            snapshot_age = passive["snapshot_age_seconds"]
            daemon_pid = int(passive["daemon_pid"] or 0)
            health = dict(producer) if snapshot_fresh else {}
            if health:
                callback_lanes: dict[str, dict[str, Any]] = {}
                stages = snapshot.get("stages") if isinstance(snapshot.get("stages"), dict) else {}
                for record in stages.values():
                    if not isinstance(record, dict) or str(record.get("stage") or "") != "callback_received":
                        continue
                    lane = str(record.get("lane") or "").strip()
                    if lane:
                        callback_lanes[lane] = dict(record)
                health["callback_lanes"] = callback_lanes
            self._health_ledger.set_component_state(
                market_daemon_snapshot_fresh=snapshot_fresh,
                market_daemon_snapshot_age_seconds=round(snapshot_age, 3) if snapshot_age is not None else None,
                market_daemon_pid=daemon_pid or None,
            )
            with self._lock:
                if health and str(health.get("identity") or "") == MARKET_DAEMON_IDENTITY:
                    self._health = dict(health)
                    self._stream_last_error = None
                else:
                    self._health["ok"] = False
                    self._health["shioaji_connected"] = False
                    self._stream_last_error = (
                        "foreign daemon identity"
                        if health else "market daemon passive health snapshot unavailable"
                    )
            return health

    def _health_loop(self) -> None:
        next_heartbeat = 0.0
        while self._running.is_set():
            health = self._adopt_snapshot()
            if health and str(health.get("identity") or "") == MARKET_DAEMON_IDENTITY:
                instance_id = str(health.get("daemon_instance_id") or "")
                state = str(health.get("state") or "")
                if state not in {"STOPPING", "STOPPED"} and time.monotonic() >= next_heartbeat:
                    self._lease.keep(instance_id)
                    next_heartbeat = time.monotonic() + self.HEARTBEAT_SECONDS
                else:
                    self._lease.observe(instance_id)
            else:
                if not health and time.monotonic() >= next_heartbeat:
                    # The daemon's snapshot file is late (a disk freeze holds its write): the held lease is renewed on
                    # its own cadence all the same; the instance is learned again from the next fresh snapshot.
                    self._lease.keep(None)
                    next_heartbeat = time.monotonic() + self.HEARTBEAT_SECONDS
            time.sleep(self.HEALTH_POLL_SECONDS)

    def _stream_loop(self) -> None:
        def prepare_connection() -> None:
            with self._lock:
                self._stream_reconnects += 1
                self._stream_last_error = None

        def failed(message: str) -> None:
            with self._lock:
                self._stream_last_error = message

        def decode_error() -> None:
            with self._lock:
                self._stream_decode_errors += 1

        MarketDaemonStream(
            client_id=self._client_id,
            heartbeat_seconds=self.HEARTBEAT_SECONDS,
            prepare_connection=prepare_connection,
            route=self._handle_wire_message,
            failed=failed,
            decode_error=decode_error,
        ).run(self._running)

    def _handle_wire_message(self, message: dict[str, Any]) -> bool | None:
        """Routes one stream frame. For the attached frame: True when it was accepted (the daemon's identity), False
        when refused; None for any other frame."""
        event_type = str(message.get("type") or "")
        now_text = datetime.now().isoformat(timespec="milliseconds")
        with self._lock:
            self._stream_received += 1
            self._stream_last_at = now_text

        if event_type == "system.market_daemon.attached":
            payload = dict(message.get("payload") or {})
            if str(payload.get("identity") or "") != MARKET_DAEMON_IDENTITY:
                with self._lock:
                    self._stream_last_error = "daemon stream identity mismatch"
                return False
            with self._lock:
                self._health = payload
            self._lease.observe(str(payload.get("daemon_instance_id") or ""))
            return True

        # Nothing else is sent on this channel: the daemon sends no market.daemon.snapshot and no signal
        # analytics fanout -- model signals come from Rust B through Market Runtime. Any other
        # frame (daemon.pong) only counts as stream liveness above.
        return None

