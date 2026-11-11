from __future__ import annotations

import importlib
import socket
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Protocol
from service.market.shared.rust_live import sdk_payload
from service.platform.api_call_log import api_call
from service.platform.remediation import Recovery
from service.market.shared.broker_operation_log import broker_operation, batch_broker_operations
import logging
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)


def _frame_rows(frame: Any) -> list[dict[str, Any]]:
    """The rows of a ``get_market_snapshot`` / ``request_history_kline`` answer, which the SDK gives as a DataFrame."""
    return [sdk_payload(row) for row in frame.to_dict("records")]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _opend_port_reachable(host: str, port: int, *, timeout: float = 1.0) -> bool:
    # moomoo's own OpenQuoteContext does not raise when OpenD is simply not
    # listening -- it logs "Connect fail ... WSAECONNREFUSED" internally and
    # keeps retrying on its own schedule (roughly every 8s), so our outer
    # except/backoff loop below never actually observes that failure as an
    # exception and never gets to say why. A plain TCP probe is the one
    # SDK-independent, immediate way to tell "OpenD is not running" apart
    # from every other kind of connection problem.
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:  # not an error: a refused connection is the probe's "OpenD is not listening" answer
        return False



class StepIncomplete(RuntimeError):
    """A cycle step that ran without raising but did not reach its goal."""

@dataclass
class OpenDConnectionState:
    """The OpenD connection as the lifecycle runs it and the provider service reports it (status, plan report,
    callbacks' generation). Both read and write it under the provider's lock."""

    context_generation: int
    context: Any = None
    sdk: Any = None
    connected: bool = False
    # None until the first reachability probe runs; False once OpenD's port is found not accepting connections.
    opend_reachable: bool | None = None
    handlers_installed: bool = False
    last_error: str = ""
    last_poll_at: str = ""
    last_connected_at: str = ""
    poll_count: int = 0
    last_cycle_ms: float = 0.0
    ignored_unknown_codes: list[str] = field(default_factory=list)


class FutuProviderPort(Protocol):
    """What the OpenD lifecycle uses of the Futu provider service."""

    host: str
    port: int
    poll_seconds: float
    subscription_manager: Any
    session_lifecycle: Any
    reference: Any
    security_master: Any
    trading_calendar: Any
    provider_backend: Any
    # Per-operation outcome of the OpenD cycle (security_master / session_lifecycle / subscription_sync).
    operation_state: dict[str, dict[str, Any]]

    def pollable_watch_codes(self) -> tuple[list[str], list[str]]: ...

    def notify_subscriptions_changed(self) -> None: ...

    def observe_subscription_quota(self, data: Any) -> None: ...

    def advance_context_generation(self, generation: int) -> int: ...

    def reset_lane_activity(self) -> None: ...


class FutuOpenDLifecycle:
    """Own OpenD connection, reconnect, subscription and repair coordination.

    The provider service remains the public facade.  This object owns the provider control-plane
    algorithm; it never enters the SDK callback hot path.
    """

    def __init__(self, provider: FutuProviderPort, *, state: OpenDConnectionState, lock: threading.RLock,
                 stop: threading.Event, wake: threading.Event) -> None:
        self.provider = provider
        self.state = state
        self._lock = lock
        self._stop = stop
        self._wake = wake
        # A query_subscription that failed: one remediation until a read succeeds, read again after a growing wait.
        self._quota_recovery = Recovery(component="futu_opend", mechanism_id="provider.futu_quota_read_retry")
        self._quota_failures = 0
        self._quota_retry_at = 0.0

    def load_sdk(self) -> Any:
        for name in ("moomoo", "futu"):
            try:
                sdk = importlib.import_module(name)
            except ModuleNotFoundError:  # not an error: that SDK package name is not installed; the next name is tried and the absence of both raises
                continue
            # The SDK's file log defaults to DEBUG: two lines a push on the callback thread, about 1 GB a trading day.
            # INFO keeps its connects, closes and warnings (the callback queue size among them).
            try:
                importlib.import_module(f"{name}.common.ft_logger").logger.file_level = logging.INFO
            except (ImportError, AttributeError) as exc:
                record_failure(_failure_log, "lowering the SDK file log to INFO", exc)
            return sdk
        raise RuntimeError("尚未安裝 moomoo Python SDK；請安裝 SDK 並啟動、登入 OpenD")

    def close_context(self) -> None:
        o = self.provider
        s = self.state
        with self._lock:
            context, s.context = s.context, None
            generation = s.context_generation
            s.connected = False
            o.subscription_manager.reset_session()
            s.handlers_installed = False
        # A quota read still failing ends with its context: the next context reads its own quota at once.
        self._quota_failures, self._quota_retry_at = 0, 0.0
        self._quota_recovery.finish("abandoned", detail={"reason": "session_reset"})
        # The context is gone and every subscription with it: Market Runtime is told (no sync runs until a reconnect).
        o.notify_subscriptions_changed()
        with self._lock:
            o.provider_backend.reset_callbacks()
        o.reset_lane_activity()
        if context is not None:
            try:
                with broker_operation("futu", "logout", generation, lane="quote_context"), api_call("futu", "close_quote_context", reason="opend_disconnect"):
                    context.close()
            except Exception as exc:
                record_failure(_failure_log, "closing the Futu quote context on OpenD disconnect", exc)

    def call(self, context: Any, method: str, *args: Any, **kwargs: Any) -> Any:
        if method in {"subscribe", "unsubscribe"}:
            with broker_operation("futu", method, self.state.context_generation,
                                  symbol=str(args[0][0]), lane=str(args[1][0])):
                return self._call(context, method, *args, **kwargs)
        return self._call(context, method, *args, **kwargs)

    def _call(self, context: Any, method: str, *args: Any, **kwargs: Any) -> Any:
        s = self.state
        result = getattr(context, method)(*args, **kwargs)
        if not isinstance(result, tuple) or len(result) < 2:
            return result
        code, data = result[0], result[1]
        success = getattr(s.sdk, "RET_OK", 0)
        if code != success:
            raise RuntimeError(str(data))
        return data

    def session_all(self) -> Any:
        return getattr(getattr(self.state.sdk, "Session", object()), "ALL", None)

    def install_push_handlers(self, context: Any) -> None:
        o = self.provider
        s = self.state
        if s.handlers_installed:
            return
        installed = o.provider_backend.install_callbacks(context, s.sdk)
        s.handlers_installed = bool(installed)

    def context_current(self, context: Any) -> bool:
        """False once the provider is stopping or this context was closed (close_context detaches it first)."""
        s = self.state
        with self._lock:
            return not self._stop.is_set() and s.context is context

    def read_quota(self, context: Any) -> dict[str, Any]:
        """OpenD's subscription quota, read when it is due (subscriptions.py observe_quota): the capacity Market
        Runtime plans the Futu streams within, in OpenD's unit. A read that fails is recorded and read again after a
        growing wait; until a read answers on this context, nothing new is subscribed on it."""
        o = self.provider
        if not o.subscription_manager.quota_due():
            return {"ok": True}
        wait = self._quota_retry_at - time.monotonic()
        if wait > 0:
            return {"ok": False, "pending": True, "retry_in_seconds": round(wait, 1)}
        try:
            with api_call("futu", "query_subscription", reason="subscription_quota"):
                data = self.call(context, "query_subscription", is_all_conn=True)
            o.observe_subscription_quota(data)
        except Exception as exc:
            if not self.context_current(context):
                raise
            self._quota_failures += 1
            self._quota_retry_at = time.monotonic() + min(15.0, 2.0 ** min(4, self._quota_failures - 1))
            self._quota_recovery.failed("quota_read_failed", identity={"host": o.host, "port": o.port},
                                        detail={"error": f"{type(exc).__name__}: {exc}"[:300]})
            raise
        self._quota_failures, self._quota_retry_at = 0, 0.0
        self._quota_recovery.finish("succeeded", identity={"host": o.host, "port": o.port})
        return {"ok": True}

    @batch_broker_operations
    def sync_context(self, context: Any) -> dict[str, Any]:
        o = self.provider
        s = self.state
        codes, unknown_codes = o.pollable_watch_codes()
        with self._lock:
            s.ignored_unknown_codes = list(unknown_codes)
        # What is subscribed is Market Runtime's plan alone; the watch list above is display only.
        before = o.subscription_manager.confirmed_snapshot()
        outcome = o.subscription_manager.sync(
            context, s.sdk, call=self.call, session_current=lambda: self.context_current(context),
            session_all=self.session_all()
        )
        if outcome.get("session_ended"):
            return outcome
        moved = o.subscription_manager.confirmed_snapshot() != before
        if moved:
            # Market Runtime hears what OpenD actually took, not what the plan asked for.
            o.notify_subscriptions_changed()
        # Every subscribed code's 昨收 for its current trading date (Futu pushes no quote outside regular hours); a
        # crypto's from its 1-minute bars at the US close (reference.py; the user allowed this history read 11-12).
        subscribed = {code for code, _ in o.subscription_manager.confirmed_snapshot()}
        one_minute = getattr(getattr(s.sdk, "KLType", None), "K_1M", None)
        o.reference.run(
            lambda codes: _frame_rows(self.call(context, "get_market_snapshot", codes)), subscribed,
            lambda code, start, end: _frame_rows(self.call(context, "request_history_kline", code, start=start, end=end,
                                                           ktype=one_minute, max_count=20)))
        return outcome

    def run_operation(self, name: str, step: Any) -> bool:
        """One maintenance/subscription step of a cycle; its outcome is its own state (the provider's operation_state), and
        returned: a cycle with a step not done does not complete a reconnect.

        A step fails by raising or by returning an outcome that is not ok; that is recorded once per real attempt.
        An outcome marked ``pending`` (the subscription sync whose missing pairs all wait out their own retry time)
        made no attempt: the state says pending and keeps its current error, and nothing new is recorded -- the
        0.2 s cycle would otherwise log the same wait as a new failure five times a second.

        ``current_error`` is what is wrong now and is cleared by the next success (``ok`` is never true beside one);
        ``last_failure`` keeps the last failure with when it happened and when it recovered."""
        o = self.provider
        s = self.state
        try:
            result = step()
            if isinstance(result, dict) and not result.get("ok", True):
                if result.get("session_ended"):
                    # not an error: the context was closed under this step (the provider's stop or a lost OpenD);
                    # the cycle ends on it and the close is what is recorded.
                    return False
                if result.get("pending"):
                    with self._lock:
                        state = o.operation_state.setdefault(name, {"failures": 0, "current_error": None})
                        state.update({"ok": False, "pending": True, "retry_in_seconds": result.get("retry_in_seconds")})
                    return False
                raise StepIncomplete(str(result.get("error") or f"{name} did not complete"))
        except Exception as exc:
            record_failure(_failure_log, f"Futu OpenD cycle step {name}", exc)
            error = f"{type(exc).__name__}: {exc}"[:300]
            with self._lock:
                state = o.operation_state.setdefault(name, {"failures": 0})
                state.update({"ok": False, "pending": False, "current_error": error,
                              "last_failure": {"error": error, "at": _utc_now(), "recovered_at": None},
                              "failures": int(state.get("failures") or 0) + 1})
                s.last_error = f"{name}: {exc}"[:500]
            return False
        with self._lock:
            state = o.operation_state.get(name)
            if state is not None and not state.get("ok", True):
                state.update({"ok": True, "pending": False, "current_error": None})
                if isinstance(state.get("last_failure"), dict):
                    state["last_failure"]["recovered_at"] = _utc_now()
                if s.last_error.startswith(f"{name}: "):
                    s.last_error = ""   # that step's failure was the provider's current error; it is over
        return True

    def run(self) -> None:
        o = self.provider
        s = self.state
        # OpenD not answering, or the quote context lost, is one recovery -- open until a new context completes
        # its first cycle (handlers installed, plan subscribed). The first start is not one: nothing was lost yet.
        recovery = Recovery(component="futu_opend", mechanism_id="provider.futu_opend_reconnect")
        ever_connected = False
        try:
            retry_seconds = 1.0
            while not self._stop.is_set():
                if not _opend_port_reachable(o.host, o.port):
                    if ever_connected:
                        recovery.failed("opend_unreachable", identity={"host": o.host, "port": o.port})
                    with self._lock:
                        s.connected = False
                        s.opend_reachable = False
                        s.last_error = f"OpenD not reachable at {o.host}:{o.port} (connection refused/timeout)"
                    # Sessions still seal without OpenD; a tick that fails is that step's failure, not the end of this worker.
                    self.run_operation("session_lifecycle", o.session_lifecycle.tick)
                    self._stop.wait(retry_seconds)
                    retry_seconds = min(30.0, retry_seconds * 2.0)
                    continue
                with self._lock:
                    s.opend_reachable = True
                try:
                    s.sdk = self.load_sdk()
                    # The context's generation is recorded durably before the context can deliver a push carrying it
                    # (service/market/shared/generation_seed.py); a seed that cannot be written fails this attempt.
                    next_generation = o.advance_context_generation(s.context_generation + 1)
                    # OpenD has no login: opening the quote context IS the connect call we make,
                    # so that is what the API log records (one line per attempt, not per retry tick).
                    with broker_operation("futu", "login", next_generation, lane="quote_context"), api_call("futu", "open_quote_context", reason="opend_connect") as call:
                        call.detail["host"] = o.host
                        call.detail["port"] = o.port
                        context = s.sdk.OpenQuoteContext(host=o.host, port=o.port)
                    with self._lock:
                        s.context = context
                        s.connected = True
                        s.last_error = ""
                        s.last_connected_at = _utc_now()
                        o.subscription_manager.reset_session()
                        s.context_generation = next_generation
                    o.reset_lane_activity()
                    self.install_push_handlers(context)
                    retry_seconds = 1.0
                    while not self._stop.is_set():
                        started = time.perf_counter()
                        # The context is lost only when OpenD itself is: a maintenance or subscription
                        # step that fails is that operation's failure, recorded and retried next cycle -- never a reason to
                        # tear the whole context down and resubscribe everything.
                        # Lost is read from the open context's own state (its KeepAlive notices OpenD going away), never
                        # by opening another TCP connection: a probe per 0.2 s cycle is ~17k connect/close per hour, and
                        # OpenD's API listener stops accepting after ~44k of them (all Futu data gone).
                        status = getattr(context, "status", None)
                        if isinstance(status, str) and status != "READY":
                            raise ConnectionError(f"OpenD at {o.host}:{o.port} stopped answering (quote context {status})")
                        cycle_ok = True
                        for name, step in (("security_master", lambda: o.security_master.refresh_if_needed(context)),
                                           ("session_lifecycle", o.session_lifecycle.tick),
                                           ("subscription_quota", lambda: self.read_quota(context)),
                                           ("subscription_sync", lambda: self.sync_context(context))):
                            # The provider's stop closes this context from its own thread while a cycle may be mid-way:
                            # a step started after that would only fail on the closed context (a full close would
                            # re-subscribe every pair after logout, each logged as a subscribe failure).
                            if not self.context_current(context):
                                break
                            cycle_ok = self.run_operation(name, step) and cycle_ok
                        if not self.context_current(context):
                            break
                        # The US exchange calendar: one read per New York day (trading_calendar.py). A refused read is
                        # that operation's failure, not the context's: it does not hold a reconnect open.
                        if o.trading_calendar.due():
                            self.run_operation("us_trading_calendar", lambda: o.trading_calendar.refresh(context))
                        with self._lock:
                            s.last_poll_at = _utc_now()
                            s.poll_count += 1
                            s.last_cycle_ms = round((time.perf_counter() - started) * 1000.0, 2)
                            generation = s.context_generation
                        if not ever_connected:
                            ever_connected = True
                        elif cycle_ok:
                            # The new context has run a whole cycle -- plan subscribed, maintenance done: only then is
                            # the reconnect over (whatever the steps did would otherwise close it as succeeded).
                            recovery.finish("succeeded", identity={"host": o.host, "port": o.port,
                                                                   "context_generation": generation})
                        self._wake.wait(o.poll_seconds)
                        self._wake.clear()
                except Exception as exc:
                    with self._lock:
                        s.last_error = str(exc)
                        lost = s.connected
                        s.connected = False
                        generation = s.context_generation
                    if ever_connected:
                        recovery.failed("connection_lost" if lost else "context_open_failed",
                                        identity={"host": o.host, "port": o.port, "context_generation": generation},
                                        detail={"error": f"{type(exc).__name__}: {exc}"[:300]})
                    else:
                        # Before the first context ran a cycle nothing was lost (no recovery), but the open failed.
                        record_failure(_failure_log, f"opening the first Futu quote context at {o.host}:{o.port}", exc)
                    self.close_context()
                    self._stop.wait(retry_seconds)
                    retry_seconds = min(30.0, retry_seconds * 2.0)
        finally:
            recovery.finish("abandoned", detail={"reason": "provider_stop"})
            self.close_context()
