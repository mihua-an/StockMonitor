from __future__ import annotations

import logging
import re
import threading
import time
from copy import deepcopy
from datetime import date, datetime, time as dt_time, timedelta
from decimal import Decimal
from typing import Any, Callable, Iterable, NamedTuple

from service.platform.api_call_log import SYMBOL_SAMPLE_LIMIT, api_call, record_api_call
from service.platform.credential_service import CredentialError, CredentialService
from service.platform import project_root as process_paths
from service.platform import remediation
from service.monitoring.runtime_profiler import runtime_profiler
from service.market.shared.startup_realtime_diagnostic import startup_realtime_diagnostic
from service.market.shared.broker_operation_log import broker_operation, batch_broker_operations
from service.market.shared.daemon_connection import ReconnectBackoff
from service.market.shared.market_identity_authority import MarketIdentityAuthority
from service.market.shioaji.log_rotation import configure_shioaji_log_path, ensure_shioaji_log_rotation
from service.market.shared.provider_contract import SHIOAJI_CAPABILITIES, SHIOAJI_LANE_KINDS
from service.market.shioaji.subscriptions import (
    TAIEX_CODE, StreamIdentity, ShioajiSubscriptionManager, regular_stock_lane, wal_instrument)
from service.market.shioaji.callback import ShioajiThinCallbackAdapter
from service.market.shared.provider import ProviderMarketBackend
from service.market.shared.session_identity_contract import wal_session
from service.market.shared.rust_live import RustDaemonEventSink, RustEventSink, RustLiveEvent
from service.market.shared.native_values import DEFAULT_PRICE_SCALE, price_to_units
from service.market.shared.provider_contract import (
    LaneDeliveryEvidence,
    lane_stale_after_seconds,
    lanes_market_data_ready,
    provider_lane_freshness,
    provider_readiness,
)
from service.market.storage.market_storage_layout import process_market_layout
from service.market.shared.generation_seed import advance_generation, reserve_generation
from service.platform.failure_record import record_failure

# A refusal the broker sends as an event after a subscribe it took (Shioaji answers subscribe() at once and refuses
# later): "Max Num Subscriptions Exceeded - Topic 'TIC/v1/STK/*/OTC/3490' Subscribe: ...".
_MAX_SUBSCRIPTIONS = "Max Num Subscriptions Exceeded"
_TOPIC = re.compile(r"Topic '([A-Z]+)/v\d+/([A-Z]+)/[^/]*/[A-Z]+/([A-Z0-9]+)'")
# The topic's security token -> the capability security type; the lane of a security type with two lanes (a stock)
# is read from the topic's kind, a security type with one lane needs none.
_TOPIC_SECURITY = {"STK": "STK", "IND": "IND", "FOP": "FUT", "FUT": "FUT"}
_TOPIC_LANE = {"TIC": "Tick", "QUO": "BidAsk"}


class _SdkReconnect(NamedTuple):
    """One connection the SDK is reconnecting: its remediation, when it went down (monotonic for the gap, the wall
    clock for the session evidence) and the instruments (market, code) its streams carried then."""
    operation: remediation.RemediationOperation
    down_ns: int
    down_at: str
    down_epoch_ns: int
    instruments: list[tuple[str, str]]


logger = logging.getLogger(__name__)


def _seed_path():
    return process_market_layout().shioaji_root / "cache" / "session_generation_seed.txt"


def _load_and_advance_persisted_generation_seed() -> int:
    """This process's first session generation, reserved before login: coverage can be emitted without any broker
    callback. The caller advances it on each broker login (service/market/shared/generation_seed.py)."""
    return reserve_generation(_seed_path())


def _advance_generation_seed(value: int) -> int:
    return advance_generation(_seed_path(), value)


class ShioajiBrokerService:
    """Background Shioaji market-data adapter.

    Goals:
      * login never blocks FastAPI/Electron startup;
      * native callbacks only normalize + non-blocking enqueue;
      * regular stock products subscribe Tick + BidAsk;
      * TAIEX index IX0001 subscribes Quote (the only index quote type);
      * TX front-month continuous future TXFR1 subscribes one Quote lane only;
      * what is subscribed is exactly Market Runtime's plan: the product pages, holdings,
        workspace, focus and market context reach the plan through Market Runtime, never through owner sets here;
      * every plan is answered with what the broker did, and answered again when that changes.

    Credential contract:
      * API Key / Secret Key are loaded only through CredentialService;
      * no project-local .env/config/plaintext credential fallback exists;
      * credentials live only long enough to perform api.login();
      * Rust realtime runtime never receives login secrets.
    """

    TAIEX_CODE = TAIEX_CODE
    TXF_CODE = "TXFR1"

    def __init__(
        self,
        *,
        sync_seconds: float = 3.0,
        on_connected: Callable[[Any], None] | None = None,
        credential_service: CredentialService | None = None,
        event_sink: RustEventSink | None = None,
    ) -> None:
        self.price_scale = DEFAULT_PRICE_SCALE
        self.credential_service = credential_service or CredentialService()
        self.event_sink = event_sink or RustDaemonEventSink()
        # The broker's production environment, always: there is no simulation-environment switch.
        self.production = True
        self.sync_seconds = max(1.0, float(sync_seconds))
        self.on_connected = on_connected

        self._api: Any | None = None
        self._sj: Any | None = None
        self._thread: threading.Thread | None = None
        self._running = threading.Event()
        self._stop_event = threading.Event()
        # The session thread sleeps on this between passes: stop() and the broker's session-down callback wake it.
        self._wake = threading.Event()
        # Set by the SDK's session-down callback (e.g. the broker answering 401 and dropping its quote session):
        # the session thread then logs out and logs in again. Without it a dropped session would stay "connected"
        # with no data for hours.
        self._broker_session_down = threading.Event()
        self._connected = threading.Event()
        self._lock = threading.RLock()
        # Broker subscription changes run on the session thread AND on HTTP worker threads (sync_now, workspace,
        # holdings, search focus); reconnect tears the session down from an HTTP thread. Each sync read its plan
        # under _lock but called the broker outside it, so two syncs could both subscribe a stream, or a reconnect
        # could clear the session mid-sync. One re-entrant mutex now covers a whole sync and a whole
        # disconnect. Lock order: _sync_mutex before _lock, never the reverse. _lock is never held across a broker
        # call: the SDK's own threads take it (_on_broker_event) while the call waits for them.
        self._sync_mutex = threading.RLock()
        # Persistent-daemon subscription state. `confirmed` is scoped to
        # the current live Shioaji session_generation; persisted desired state is
        # never allowed to masquerade as broker-side active subscription truth.
        self.provider_capabilities = SHIOAJI_CAPABILITIES
        # 設定 → 券商帳號 → 永豐行情連線 (config/broker_connection_settings.py): up to `connections` broker logins of
        # `per_connection_limit` subscriptions each. The first login is the session; the next one opens only when the
        # plan's streams no longer fit (_pick_connection), and one holding nothing is logged out after a sync.
        self._connection_settings = self._read_connection_settings(None)
        self.subscription_manager = ShioajiSubscriptionManager(
            subscription_limit=self._total_stream_limit(), capabilities=self.provider_capabilities
        )
        # The pool: connection index -> its api (0 is self._api, the session's own login); stream key -> the
        # connection that holds it; and, per connection, the number of streams the broker took before it refused one
        # (an account whose broker limit is below the setting). All of it belongs to the current session generation.
        self._extra_apis: dict[int, Any] = {}
        self._stream_connection: dict[str, int] = {}
        self._connection_cap: dict[int, int] = {}
        # Every added connection's state (index -> record, shown in the status): OPENING while it logs in and takes
        # its callbacks; ACTIVE in the pool (_extra_apis); CLOSING while it logs out; CLOSE_FAILED when the logout
        # failed. Out of the pool a connection is only in _closing_apis: its handle is kept until the logout succeeds
        # (it may still hold one of the person ID's broker connections), tried again after each sync up to
        # CLOSE_ATTEMPTS times -- one recorded recovery per connection -- and its index is not logged in again meanwhile.
        self._connection_states: dict[int, dict[str, Any]] = {}
        self._closing_apis: dict[int, Any] = {}
        self._close_recoveries: dict[int, remediation.Recovery] = {}
        # (connection, broker text) refusals from the SDK event thread, attributed to a stream by the next sync.
        self._broker_refusals: list[tuple[int, str]] = []
        self._unattributed_refusals = 0
        self._refusal_resync = remediation.Recovery(component="shioaji_connection_pool", mechanism_id="provider.shioaji_refusal_resync")
        self._connections_opened = 0
        # A login of an added connection that failed (the person ID's 5 connections taken by the phone and other
        # programs, a broker error): not tried again for EXTRA_LOGIN_BACKOFF_SECONDS -- never a login every pass.
        self._extra_login_failed: tuple[float, str] | None = None
        self.market_identity_authority = MarketIdentityAuthority("shioaji")
        # The plan's instruments this provider refused (no capability, past the stream limit), with the reason.
        self._plan_refused: dict[tuple[str, str], str] = {}
        # Every stream: its identity key -> its state; and the keys this session currently holds.
        self._stream_subscription_state: dict[str, dict[str, Any]] = {}
        self._active_subscription_keys: set[str] = set()
        self._active_stream_contracts: dict[str, Any] = {}
        # When each stream was first subscribed in this process (wall clock ns): kept across a new broker login, which
        # loses nothing the gap ledger does not already record; forgotten when the plan drops the stream. Each report
        # states it per instrument (plan_report `since_ns`): Market Runtime judges a late join by it (late_join.rs).
        self._stream_since: dict[str, int] = {}
        # Seeded from disk, not 0 -- see _load_and_advance_persisted_generation_seed()'s
        # docstring for why a hardcoded restart-to-0 permanently stalled live data.
        self._session_generation = _load_and_advance_persisted_generation_seed()
        self._daemon_lifetime_login_count = 0
        self._full_subscription_sync_count = 0
        self._delta_subscribe_count = 0
        self._delta_unsubscribe_count = 0
        self._reconnect_count = 0
        # The open session recovery (provider.broker_session_reconnect), if any, and its attempt count.
        self._session_recovery: remediation.RemediationOperation | None = None
        self._session_recovery_attempts = 0
        # The SDK's own reconnects in progress (connection index -> its operation and when the session went down),
        # from its "Session reconnecting" event until "Session reconnected" (provider.shioaji_sdk_session_reconnect).
        self._sdk_reconnects: dict[int, _SdkReconnect] = {}
        # Outages of the connections whose streams stopped and were not reconnected by the SDK -- one it gave up on, and
        # every connection of a broker session the App logs out (its re-login after a session down, a failed sync, a
        # re-layout, the user's 重新連線): they deliver again only once the next login has subscribed them, which
        # ends these outages. connection id -> (from ns, instruments); a connection keeps its earliest start.
        self._unrestored_outages: dict[str, tuple[int, list[tuple[str, str]]]] = {}
        # When the broker reported the session down (wall clock): the start of every connection's outage, since the
        # session thread logs out only on its next pass. None while the session is up.
        self._session_down_epoch_ns: int | None = None
        self._last_login_attempt_at: str | None = None
        self._stock_contracts: dict[str, Any] = {}
        self._symbol_ids: dict[str, int] = {}
        self._price_scale_errors = 0
        from service.platform.remediation import Recovery

        self._stock_limits_state: dict[str, dict[str, Any]] = {}
        self._stock_limits_recovery = Recovery(component="stock_limits", mechanism_id="provider.metadata_refetch")
        # TXF limits the contract does not yet carry for a trading date its quotes already trade: open from the first
        # pass that finds them missing until they are published.
        self._txf_limits_recovery = Recovery(component="txf_limits", mechanism_id="provider.metadata_refetch")
        # A TXF reference (session reference or contract limits) Market Runtime's ingress refused: open from the first
        # refusal until one is admitted, each later refusal an attempt.
        self._reference_publish_recovery = Recovery(component="txf_reference", mechanism_id="provider.metadata_refetch")
        # The TXF references Market Runtime refused and that have not been admitted since: the recovery ends only when
        # every one of them is in, never on whichever publish happens to succeed next.
        self._reference_refused: set[tuple[str, ...]] = set()
        self._callback_errors = 0
        self._last_callback_error: str | None = None
        self._last_callback_epoch_ns = 0
        # The single delivery-evidence authority for this provider. It is written
        # by ShioajiThinCallbackAdapter for every accepted callback, and it is the
        # only input the readiness/lane projection uses to decide "is this lane
        # delivering?". _stream_subscription_state cannot serve that role: its
        # last_event_at is never written on any callback path.
        self.delivery_evidence = LaneDeliveryEvidence()
        self._taiex_contract: Any | None = None
        self._txf_contract: Any | None = None
        # The reference the newest TXF quote states (close - price_chg, price units) and its exchange time: which
        # trading date the contract's limits are for is read from it (_refresh_txf_limits).
        self._txf_stated_reference: tuple[int, int] | None = None
        # Where the current trading date's TXF limits stand (PUBLISHED / WAITING_QUOTE / REFERENCE_MISMATCH /
        # UNAVAILABLE / PUBLISH_FAILED), and when the contract was last read for them.
        self._txf_limits_state: dict[str, Any] = {}
        self._txf_limits_attempted = -1e9
        self._reference_stream_seq: dict[str, int] = {}
        # (contract, trading date) of the TXF limits already handed to Market Runtime: published once per date.
        # (contract, trading date, partition date, partition session) of every TXF limits reference Market Runtime's
        # ingress ADMITTED: a partition whose publish was refused is published again on the next attempt.
        self._txf_limits_published: set[tuple[str, str]] = set()
        # Per-stock 漲停/跌停 published to Market Runtime: code -> trading date published, and the last attempt.
        self._stock_limits_published: dict[str, str] = {}
        self._stock_limits_attempted: dict[str, float] = {}
        self._stock_limits_worker: threading.Thread | None = None
        self._last_error: str | None = None
        self._last_login_at: str | None = None
        # When the current broker login happened (local time): the daily pre-open re-login reads it.
        self._logged_in_at: datetime | None = None
        # The broker's own system events (SDK event callback), newest last, shown in status().
        self._broker_events: list[dict[str, Any]] = []
        self._last_sync_at: str | None = None
        # One back-off for both recoveries (a failed login, a failed subscription sync): 2 s doubling to 60 s, reset by
        # the next success. Broker recovery must not become a rapid relogin loop.
        self._recovery_backoff = ReconnectBackoff(2.0, 60.0)
        self._subscription_mutation_frozen = False
        self._market_session_event_listener: Callable[[str, str], None] | None = None
        # Security types that delivered an event in their current market-session generation: the callback path's
        # one-time "first event" signal to the session owner (reset by each live transition).
        self._markets_seen: set[str] = set()
        self.thin_callback = ShioajiThinCallbackAdapter(self)
        self.provider_backend = ProviderMarketBackend(
            provider="shioaji",
            thin_callback=self.thin_callback,
            subscription_manager=self.subscription_manager,
            capabilities=self.provider_capabilities,
        )
        register_adapter = getattr(self.event_sink, "register_adapter", None)
        if callable(register_adapter):
            # The broker limit counts streams: the stream budget (with each market's lanes) is what this provider can
            # carry; max_subscriptions is the instrument count for a planner that counts instruments.
            register_adapter(
                source="shioaji",
                max_subscriptions=self._instrument_limit(),
                stream_budget=self._stream_budget(),
                replace_subscriptions=lambda items, _generation: self.apply_demand_plan(items),
                report_subscriptions=self.plan_report,
            )
        from service.market.shioaji.restart_backfill import IntradayTicksBudget, RestartBackfill

        # The prints a restart of this provider missed, filled from the broker's history window by window
        # (restart_backfill.py; decisions.md 盤中重啟的缺口只補空檔時段). Market Runtime names the gaps in its hello answer.
        self._ticks_budget = IntradayTicksBudget(process_paths.STATE_ROOT / "shioaji_intraday_ticks.json")
        self._closed_views_asked: set[tuple[str, str, str, str]] = set()
        self._closed_views_waiting: list[dict[str, Any]] = []
        self._daily_closes: dict[Any, dict[str, float]] = {}
        self._restart_backfill = RestartBackfill(
            fetch=self._fetch_gap_ticks, query_dates=self._gap_query_dates, publish=lambda event: self.event_sink.publish(event),
            next_sequence=self.thin_callback._next_sequence, admission_lock=self.thin_callback._event_admission_lock,
            generation=lambda: self._session_generation, scale=self.price_scale,
            report=lambda reports: self.event_sink.report_backfill(reports),
            session_open_ns=self._gap_session_open_ns, session_end_ns=self._gap_session_end_ns,
            stored=lambda market, before_ns: self.event_sink.unconfirmed_before([market], before_ns) == 0,
            history_held_from=self._gap_history_held_from_ns, ticks_budget=self._ticks_budget, prev_close=self._session_prev_close,
            closing_state=self._exchange_closing_state, cache=self._query_cache())
        fill_gaps_with = getattr(self.event_sink, "fill_gaps_with", None)
        if callable(fill_gaps_with):
            fill_gaps_with(self._restart_backfill.requested)
        view_history_with = getattr(self.event_sink, "view_history_with", None)
        if callable(view_history_with):
            view_history_with(self._closed_view_requested)

    # ===== lifecycle =====

    def set_market_session_event_listener(self, listener: Callable[[str, str], None] | None) -> None:
        self._market_session_event_listener = listener

    def start_background(self) -> None:
        with self._lock:
            # Graceful shutdown is a one-way lifecycle transition for this
            # service graph.  A delayed recovery request must never thaw the
            # broker after the mediator/recorder consumers have been stopped.
            if self._subscription_mutation_frozen:
                raise RuntimeError("Shioaji broker is shutting down; daemon replacement required")
            if self._thread and self._thread.is_alive():
                return
            self._stop_event.clear()
            self._running.set()
            start_sink = getattr(self.event_sink, "start", None)
            if callable(start_sink):
                start_sink()
            self._thread = threading.Thread(
                target=self._run,
                name="ShioajiMarketData",
                daemon=True,
            )
            self._thread.start()

    @batch_broker_operations
    def begin_graceful_shutdown(self, *, wait: bool = True, timeout: float = 12.0) -> dict[str, Any]:
        """Freeze broker mutation and unsubscribe, but defer logout until storage drains.

        Durability requires accepted native/raw events to reach the recorder
        before the broker session is destroyed.  This producer gate stops the sync
        loop and removes subscriptions; :meth:`logout_after_drain` is called only
        after native/egress/recorder workers have flushed.
        """
        # A recovery still open when the daemon stops ends here, as abandoned -- never as silence.
        self._finish_session_recovery("abandoned", {"reason": "daemon_shutdown"})
        # So do the SDK's reconnects, and the outages of their connections end here: from now on the restart's
        # window (session evidence) covers the session.
        self._end_sdk_reconnects("abandoned", "daemon_shutdown")
        with self._lock:
            # A session the broker reported down that the session thread has not logged out yet: its streams have
            # delivered nothing since.
            self._keep_stopped_session_outages_locked(logged_out=False)
        self._end_unrestored_outages()
        self._restart_backfill.stop()
        # Close admission before SDK unsubscription so callbacks racing the
        # control request cannot enter a Python-owned replacement path.
        self.event_sink.stop_admission()
        with self._lock:
            self._subscription_mutation_frozen = True
            self._running.clear()
            self._stop_event.set()
            self._wake.set()
            thread = self._thread
        if wait and thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=max(0.0, float(timeout)))
            if thread.is_alive():
                logger.warning("[Shutdown][TIMEOUT] Shioaji sync loop")
        # The unsubscribes take the sync mutex like every subscription mutation (never beside a sync still in
        # progress after a join that timed out). A sync that does not finish in time is not raced:
        # nothing is unsubscribed here and logout ends the broker session -- said in the result.
        if not self._sync_mutex.acquire(timeout=max(0.0, float(timeout))):
            logger.warning("[Shutdown] subscription sync still running: unsubscribes left to logout")
            return {**self.status(), "unsubscribe": "SKIPPED_SYNC_BUSY"}
        try:
            with self._lock:
                active = [self._identity_from_state(key) for key in sorted(self._active_subscription_keys)]
            for identity in [item for item in active if item is not None]:
                try:
                    self._unsubscribe_stream(identity)
                except Exception as exc:
                    record_failure(logger, "unsubscribing a stream at logout", exc)
        finally:
            self._sync_mutex.release()
        return {**self.status(), "unsubscribe": "DONE"}

    def logout_after_drain(self) -> dict[str, Any]:
        api = self._api
        self._connected.clear()
        self._api = None
        self._logout_extra_connections("broker_session_stop")
        with self._lock:
            self._reset_session_state_locked()
        if api is not None:
            try:
                with broker_operation("shioaji", "logout", self._session_generation), api_call("shioaji", "logout", reason="broker_session_stop"):
                    api.logout()
            except Exception as exc:
                logger.error(f"[SHIOAJI] logout failed: {exc}")
        close_sink = getattr(self.event_sink, "close", None)
        if callable(close_sink):
            close_sink(timeout=1.5)
        return self.status()

    def stop(self, *, wait: bool = True, timeout: float = 12.0) -> dict[str, Any]:
        self.begin_graceful_shutdown(wait=wait, timeout=timeout)
        result = self.logout_after_drain()
        logger.info("[Shutdown] Shioaji stopped")
        return result

    # ------------------------------------------------------------------ session recovery
    def _begin_session_recovery(self, trigger: str, error: Any = None) -> None:
        """A broker session torn down (or a login that failed) is one remediation, open until a login and its full
        re-subscribe succeed. Every further failed try is an attempt of the same operation."""
        detail = {"session_generation": self._session_generation}
        if error is not None:
            detail["error"] = self.credential_service.redact_text(error)
        if self._session_recovery is None:
            self._session_recovery = remediation.emitter().begin(
                component="shioaji_session", mechanism_id="provider.broker_session_reconnect", trigger_reason=trigger,
                identity={"source": "shioaji", "session_generation": self._session_generation}, detail=detail)
            self._session_recovery_attempts = 0
        self._session_recovery_attempts += 1

    def _finish_session_recovery(self, outcome: str, detail: dict[str, Any] | None = None) -> None:
        operation, self._session_recovery = self._session_recovery, None
        if operation is not None:
            operation.finish(outcome, attempt=self._session_recovery_attempts, detail=detail or {})

    def reconnect(self, reason: str = "manual_request") -> dict[str, Any]:
        """`reason` is "manual_request" (the UI's 重新連線) or "credentials_changed" (saved/cleared credentials)."""
        # Only the sync mutex is held across the teardown: the SDK's event thread takes _lock in _on_broker_event while
        # unsubscribe/logout wait for that thread, so holding _lock here deadlocked the whole session.
        with self._sync_mutex:
            with self._lock:
                if self._subscription_mutation_frozen or self._stop_event.is_set():
                    return {
                        "ok": False,
                        "accepted": False,
                        "message": "Shioaji 正在關閉；必須由新的 Market Daemon 接手，拒絕在舊資料管線重新登入",
                    }
                self._reconnect_count += 1
            # The user's own action (重新連線, a saved or cleared credential), not a recovery from a fault: written to
            # the operation log, never a remediation (docs/decisions.md 什麼算補救). A login that then fails opens
            # one (login_failed) in _run.
            logger.info("[SHIOAJI] reconnect requested by the user (%s); session_generation=%s",
                        "credentials_changed" if reason == "credentials_changed" else "manual_request",
                        self._session_generation)
            self._disconnect()
            if not self._running.is_set():
                self.start_background()
        return {"ok": True, "message": "已要求 Shioaji 重新連線"}

    def sync_now(self) -> dict[str, Any]:
        if not self._connected.is_set() or self._api is None:
            return {"ok": False, "message": "Shioaji 尚未連線"}
        try:
            self._sync_subscriptions()
            return {"ok": True, "message": "Shioaji 訂閱已同步", **self.status()}
        except Exception as exc:
            self._set_error(exc)
            return {"ok": False, "message": str(exc), **self.status()}

    def _run(self) -> None:
        while self._running.is_set():
            if not self._connected.is_set():
                try:
                    self._connect()
                    self._recovery_backoff.reset()
                    if not self._running.is_set():
                        self._disconnect()
                        break
                except Exception as exc:
                    self._set_error(exc)
                    self._begin_session_recovery("login_failed", exc)
                    # If login succeeded far enough to create a session but initial
                    # subscription setup failed, tear that truth domain down before
                    # retrying. Never leave half-confirmed subscription state alive.
                    if self._connected.is_set() or self._api is not None:
                        self._reconnect_count += 1
                        self._disconnect()
                    if self._stop_event.wait(self._recovery_backoff.next_delay()):
                        break
                    continue

            self._apply_connection_settings()
            if not self._connected.is_set():
                continue
            replace = self._session_replacement_reason(datetime.now())
            if replace == "daily_relogin":
                # A scheduled routine, not a recovery from a fault: logged, never a remediation (docs/decisions.md
                # 什麼算補救).
                logger.info("[SHIOAJI] daily re-login before the open (logged in at %s)", self._logged_in_at)
            elif replace is not None:
                self._begin_session_recovery(replace)
            if replace is not None:
                self._reconnect_count += 1
                self._disconnect()
                continue

            try:
                self._sync_subscriptions()
                self._refresh_stock_limits()
                self._refresh_txf_limits()
                self._recovery_backoff.reset()
            except Exception as exc:
                self._set_error(exc)
                self._begin_session_recovery("subscription_sync_failed", exc)
                # A broken quote session is safer to recreate than to leave with a
                # partially stale subscription set. Back off before the next login
                # instead of immediately cycling broker sessions.
                self._reconnect_count += 1
                self._disconnect()
                if self._stop_event.wait(self._recovery_backoff.next_delay()):
                    break
                continue

            self._wake.wait(self.sync_seconds)
            self._wake.clear()
            if self._stop_event.is_set():
                break

    # The broker's login is replaced once a day before the market opens, while nothing trades: Shioaji's session
    # stops (401) about 24 h after its login, so a login made during trading hours would otherwise expire during the
    # next day's session. The login is also when the SDK takes the day's contracts (it compares the broker's contract
    # version with its disk cache), and the security master is rewritten from them: the broker publishes the day's
    # futures contracts at 07:50 and stock contracts at 08:00, so a login before 08:00 keeps the previous day's until
    # the next login. 08:05-08:25 is after both and before the 08:30 stock pre-open.
    DAILY_RELOGIN_WINDOW = (dt_time(8, 5), dt_time(8, 25))

    def _session_replacement_reason(self, now: datetime) -> str | None:
        """Why the current broker session must be replaced now, or None."""
        if not self._connected.is_set():
            return None
        if self._broker_session_down.is_set():
            return "broker_session_down"
        start, end = self.DAILY_RELOGIN_WINDOW
        window_start = datetime.combine(now.date(), start)
        if (self._logged_in_at is not None and start <= now.time() < end and self._logged_in_at < window_start):
            return "daily_relogin"
        return None

    def _on_broker_session_down(self, *_args: Any) -> None:
        # SDK thread: only flag it; the session thread replaces the session (and records the recovery).
        logger.error("[SHIOAJI] the broker reported its session down; logging in again")
        # The SDK gives up its own reconnect with this callback; the App's re-login is a remediation of its own.
        self._end_sdk_reconnects("failed", "sdk_gave_up")
        with self._lock:
            if self._session_down_epoch_ns is None:
                self._session_down_epoch_ns = time.time_ns()
        self._broker_session_down.set()
        self._wake.set()

    # The SDK's session events (event_code): it reconnects a dropped session by itself before giving up with the
    # session-down callback.
    SDK_SESSION_RECONNECTING = "12"
    SDK_SESSION_RECONNECTED = "13"

    def _note_sdk_reconnect(self, connection: int, event_code: str) -> None:
        """One remediation per SDK reconnect of a connection, with the time its quotes could not arrive, and that time
        handed to the session evidence as an outage of the instruments the connection carried (the broker never
        re-sends what it streamed meanwhile). The broker's text is not recorded: its client name carries the person
        ID."""
        identity = {"source": "shioaji", "connection_id": f"connection {connection + 1}"}
        if event_code == self.SDK_SESSION_RECONNECTING:
            with self._lock:
                if connection in self._sdk_reconnects:
                    return      # the same drop, still reconnecting: one remediation until it ends
                down_at = remediation.local_iso()
                operation = remediation.emitter().begin(
                    component="shioaji_session", mechanism_id="provider.shioaji_sdk_session_reconnect",
                    trigger_reason="sdk_session_down", identity=identity,
                    detail={"connection": connection + 1, "session_generation": self._session_generation,
                            "down_at": down_at})
                pending = self._sdk_reconnects[connection] = _SdkReconnect(
                    operation, time.monotonic_ns(), down_at, time.time_ns(), self._connection_instruments_locked(connection))
            self._record_connection_down(identity["connection_id"], pending.down_epoch_ns, pending.instruments)
            return
        with self._lock:
            pending = self._sdk_reconnects.pop(connection, None)
        if pending is None:
            logger.error("[SHIOAJI] connection %s reported its session reconnected without reconnecting first",
                         connection + 1)
            return
        pending.operation.finish("succeeded", detail={
            "connection": connection + 1, "down_at": pending.down_at, "reconnected_at": remediation.local_iso(),
            "gap_ms": round((time.monotonic_ns() - pending.down_ns) / 1_000_000, 3)})
        self._record_connection_outage(identity["connection_id"], pending.down_epoch_ns, time.time_ns(), pending.instruments)

    def _end_sdk_reconnects(self, outcome: str, reason: str) -> None:
        """The SDK's reconnects end without reconnecting (it gave up, the session was logged out): their outages stay
        open until the next login has subscribed the streams again (``_end_unrestored_outages``)."""
        with self._lock:
            pending, self._sdk_reconnects = self._sdk_reconnects, {}
            for connection, item in pending.items():
                self._keep_unrestored_outage_locked(f"connection {connection + 1}", item.down_epoch_ns, item.instruments)
        for connection, item in pending.items():
            item.operation.finish(outcome, detail={"connection": connection + 1, "down_at": item.down_at, "reason": reason})

    def _keep_unrestored_outage_locked(self, connection_id: str, from_ns: int,
                                       instruments: Iterable[tuple[str, str]]) -> None:
        """Caller holds _lock: a connection's streams stopped at ``from_ns`` and wait for the next login's resubscribe.
        A connection already waiting keeps its earlier start and adds the instruments."""
        earlier = self._unrestored_outages.get(connection_id)
        if earlier is not None:
            from_ns = min(from_ns, earlier[0])
            instruments = [*earlier[1], *instruments]
        self._unrestored_outages[connection_id] = (int(from_ns), sorted(set(instruments)))
        self._record_connection_down(connection_id, int(from_ns), self._unrestored_outages[connection_id][1])

    def _end_unrestored_outages(self) -> None:
        """The streams of the connections that stopped without the SDK reconnecting them are subscribed again (a
        login's full resubscribe) or never will be by this process (its shutdown, after which the restart's own window
        takes over): their outages end now."""
        with self._lock:
            outages, self._unrestored_outages = self._unrestored_outages, {}
        now = time.time_ns()
        for connection_id, (from_ns, instruments) in sorted(outages.items()):
            self._record_connection_outage(connection_id, from_ns, now, instruments)

    def _keep_stopped_session_outages_locked(self, *, logged_out: bool) -> None:
        """Caller holds _lock: every connection's streams stopped with the broker session -- from the moment the broker
        reported it down, else (``logged_out``: the App logs it out now) from now -- until the next login has
        subscribed them again. The session-down moment is consumed: it belongs to this session only."""
        down_ns, self._session_down_epoch_ns = self._session_down_epoch_ns, None
        if down_ns is None and not logged_out:
            return      # not an error: the session is up and its streams still deliver
        from_ns = time.time_ns() if down_ns is None else down_ns
        connections = {self._stream_connection.get(key, 0) for key in self._active_subscription_keys}
        for connection in sorted(connections):
            instruments = self._connection_instruments_locked(connection)
            if instruments:
                self._keep_unrestored_outage_locked(f"connection {connection + 1}", from_ns, instruments)

    def _connection_instruments_locked(self, connection: int) -> list[tuple[str, str]]:
        """Caller holds _lock: the instruments (market, code) whose streams a connection carries now."""
        found: set[tuple[str, str]] = set()
        for key in self._active_subscription_keys:
            if self._stream_connection.get(key, 0) != connection:
                continue
            identity = self._identity_from_state(key)
            instrument = None if identity is None else wal_instrument(identity.security_type, identity.code)
            if instrument is not None:
                found.add(instrument)
        return sorted(found)

    def _record_connection_down(self, connection_id: str, from_ns: int, instruments: list[tuple[str, str]]) -> None:
        """Tell Market Runtime a connection's streams stopped at ``from_ns`` (``ingest.outage``): it takes each stored
        code's gap start now, before the reconnected stream stores anything newer, and once the outage's report says it
        touched trading hands the gaps back to be filled from the broker's history (restart_backfill.py, cause
        ``outage``). A connection reported again before its end keeps its first start there."""
        if not instruments:
            return      # not an error: the connection carried no stream, so no instrument can miss anything
        began = getattr(self.event_sink, "report_outage_began", None)
        if not callable(began):
            return      # not an error: a sink that stores nothing (the reference sink) fills no gaps
        try:
            began(instruments, from_ns, connection=connection_id)
        except Exception as exc:
            record_failure(logger, f"telling Market Runtime that Shioaji {connection_id} went down", exc)

    def _record_connection_outage(self, connection_id: str, from_ns: int, to_ns: int,
                                  instruments: list[tuple[str, str]]) -> None:
        """Report an outage of a connection's streams to Market Runtime (``ingest.loss``), which judges it against the
        trading minutes and keeps it in the partitions' evidence."""
        if not instruments:
            return      # not an error: the connection carried no stream, so no instrument missed anything
        try:
            self.event_sink.report_outage(instruments, from_ns, to_ns, connection=connection_id)
        except Exception as exc:
            record_failure(logger, f"reporting the outage of Shioaji {connection_id} to Market Runtime", exc)

    def _on_broker_event(self, *args: Any, connection: int = 0) -> None:
        # SDK system events (resp_code, event_code, info, event): kept for status() and logged. A dropped session
        # arrives through the session-down callback; a subscription the broker refused after taking it (past the
        # account's limit on that connection) is handed to the session thread (_take_broker_refusals).
        record = {"at": datetime.now().isoformat(timespec="seconds"), "connection": connection + 1,
                  "event": [str(value)[:200] for value in args]}
        logger.info(f"[SHIOAJI] broker event (connection {connection + 1}) {record['event']}")
        info = str(args[2]) if len(args) >= 3 else ""
        refused = _MAX_SUBSCRIPTIONS in info
        # Every connection's SDK thread calls this: the list is changed under the lock so no event is lost.
        with self._lock:
            self._broker_events = (self._broker_events + [record])[-20:]
            if refused:
                self._broker_refusals.append((connection, info))
        if refused:
            self._wake.set()
        event_code = str(args[1]) if len(args) >= 2 else ""
        if event_code in (self.SDK_SESSION_RECONNECTING, self.SDK_SESSION_RECONNECTED):
            self._note_sdk_reconnect(connection, event_code)

    def _connect(self) -> None:
        started_ns = time.perf_counter_ns()
        configure_shioaji_log_path()          # var/logs/shioaji.log; must precede the SDK import
        try:
            import shioaji as sj  # optional runtime dependency
        except Exception as exc:
            raise RuntimeError(f"找不到 Shioaji，請先安裝最新版 shioaji：{exc}") from exc
        # shioaji attaches its own unrotated FileHandler for shioaji.log on
        # import/construction; replace it with a day-bounded rotating one so
        # it cannot grow without limit (observed at 180MB+ in production).
        ensure_shioaji_log_rotation()

        self._last_login_attempt_at = datetime.now().isoformat(timespec="seconds")
        startup_realtime_diagnostic.mark("SHIOAJI_LOGIN_START", detail={"production": self.production}, once=True)

        # Production contract: Shioaji stock callbacks have no Python
        # per-event fallback. Refuse a live quote session if the packaged PyO3
        # extension is missing or failed to start. Login secrets stay
        # entirely on the Python side of this boundary.
        # The whole login holds the sync mutex, as a disconnect does: a reconnect asked for meanwhile (重新連線, saved
        # credentials) waits for this login and then tears it down, so it never finds no session yet and lets a
        # login with the old credentials stand, nor logs out a session this thread is still marking connected.
        with self._sync_mutex:
            self._sj = sj
            # The login's generation is recorded durably before any callback can carry it; a seed that cannot be
            # written fails this connect attempt (GenerationPersistError) instead of running on a value a restart
            # could reuse.
            next_generation = _advance_generation_seed(self._session_generation + 1)
            # Credentials are never part of the record (api_call_log refuses credential-shaped fields) nor kept.
            api = self._login(sj, next_generation, "broker_session_start")
            self._api = api
            self._register_callbacks(api)
            self._connected.set()
            self._session_generation = next_generation
            self._daemon_lifetime_login_count += 1
            self._logged_in_at = datetime.now()
            self._last_login_at = self._logged_in_at.isoformat(timespec="seconds")
            self._broker_session_down.clear()
            with self._lock:
                # A new broker login is a new truth domain. No confirmed subscription
                # from the previous session may suppress a real subscribe call.
                self._reset_session_state_locked()
                waiting, self._closed_views_waiting = self._closed_views_waiting, []
            self._last_error = None
            for payload in waiting:
                self._closed_view_requested(payload)
            startup_realtime_diagnostic.mark(
                "SHIOAJI_LOGIN_OK",
                detail={"session_generation": self._session_generation, "login_count": self._daemon_lifetime_login_count},
                once=True,
            )
            runtime_profiler.observe_ns(
                "shioaji_login",
                started_ns,
                detail={"production": self.production, "version": getattr(sj, "__version__", None)},
            )
            # A new login is a new broker session: every desired lane is subscribed again (part of the recovery
            # recorded above, not a mechanism of its own).
            self._sync_subscriptions(force=True)
            self._end_unrestored_outages()
            with self._lock:
                lanes = len(self._active_subscription_keys)
            self._finish_session_recovery("succeeded", {"session_generation": self._session_generation,
                                                        "resubscribed_lanes": lanes})
        if self.on_connected is not None:
            try:
                self.on_connected(api)
            except Exception as exc:
                record_failure(logger, "the Shioaji post-login initialization", exc)

    def _reset_session_state_locked(self) -> None:
        """Forget everything that belonged to the broker session that ended (a login starts from nothing too).
        Caller holds _lock."""
        self._stream_connection.clear()
        self._connection_cap.clear()
        self._broker_refusals.clear()
        self._stream_subscription_state.clear()
        self._active_subscription_keys.clear()
        self._active_stream_contracts.clear()
        self._stock_contracts.clear()
        self._symbol_ids.clear()
        self._taiex_contract = None
        self._txf_contract = None
        self._txf_stated_reference = None

    def _disconnect(self) -> None:
        with self._sync_mutex:
            self._disconnect_locked()

    @batch_broker_operations
    def _disconnect_locked(self) -> None:
        api = self._api
        sj = self._sj
        self._connected.clear()
        self._api = None
        self._notify_subscriptions_changed()
        with self._lock:
            active = [
                (key, self._active_stream_contracts.get(key), dict(self._stream_subscription_state.get(key) or {}),
                 # self._api is already cleared: the first connection is `api`.
                 api if self._stream_connection.get(key, 0) == 0 else self._extra_apis.get(self._stream_connection[key]))
                for key in sorted(self._active_subscription_keys)
            ]
            self._keep_stopped_session_outages_locked(logged_out=True)
            self._reset_session_state_locked()
        # A connection still reconnecting is logged out with the session: its reconnect never finishes.
        self._end_sdk_reconnects("abandoned", "session_logged_out")
        if api is None:
            self._logout_extra_connections("broker_session_stop")
            return
        # Explicit unsubscribe prevents quote producers from continuing while
        # downstream queues/recorders are being drained. Logout is the final step.
        if sj is not None:
            for _key, contract, state, stream_api in active:
                if contract is None or stream_api is None:
                    continue
                quote_name = str(state.get("quote_type") or "")
                quote_type = self._quote_type_value(sj, quote_name)
                if quote_type is None:
                    continue
                try:
                    with broker_operation("shioaji", "unsubscribe", self._session_generation,
                                          symbol=_key.split(":")[1], lane=quote_name):
                        stream_api.unsubscribe(contract, quote_type=quote_type)
                except Exception as exc:
                    record_failure(logger, "unsubscribing a contract", exc)
        self._logout_extra_connections("broker_session_stop")
        try:
            with broker_operation("shioaji", "logout", self._session_generation), api_call("shioaji", "logout", reason="graceful_shutdown_drain"):
                api.logout()
        except Exception as exc:
            logger.error(f"[SHIOAJI] logout failed: {exc}")

    # ===== callback registration =====

    def _register_callbacks(self, api: Any) -> None:
        # Quote callback ownership lives entirely in the provider backend; the session's own health is this class's.
        self.provider_backend.install_callbacks(api)
        api.set_session_down_callback(self._on_broker_session_down)
        api.set_event_callback(self._on_broker_event)

    # ===== connection pool =====

    EXTRA_LOGIN_BACKOFF_SECONDS = 60.0

    def _read_connection_settings(self, current: dict[str, Any] | None) -> dict[str, Any]:
        """The active 永豐行情連線 settings; a store that cannot be read keeps what runs (`current`) or the defaults."""
        from config import broker_connection_settings

        try:
            return broker_connection_settings.shioaji()
        except Exception as exc:
            record_failure(logger, "reading the 永豐行情連線 settings (kept what runs)", exc)
            return current or {**broker_connection_settings.DEFAULTS["shioaji"], "revision": None}

    def _total_stream_limit(self) -> int:
        s = self._connection_settings
        return max(1, int(s["connections"]) * int(s["per_connection_limit"]))

    def _instrument_limit(self) -> int:
        """The instruments that fit however the plan mixes them -- every one counted at the most lanes any takes (a
        stock: Tick + BidAsk) -- for a planner that counts instruments; ``_stream_budget`` is the exact capacity."""
        return max(1, self._total_stream_limit() // max(1, self.provider_capabilities.most_lanes()))

    def _stream_budget(self) -> dict[str, Any]:
        """The capacity in the broker's own unit: streams, every connection's together, and the streams each kind of
        an instrument of each market takes (a stock's trade and orderbook one each, an index's quote one, a futures
        month's trade and orderbook one each, TXFR1's quote one)."""
        return {"streams": self._total_stream_limit(),
                "kinds_by_market": self.provider_capabilities.kinds_by_market(SHIOAJI_LANE_KINDS)}

    def _apply_connection_settings(self) -> None:
        """Take a saved 永豐行情連線 revision: more capacity at once (Market Runtime plans again); less than what is in
        use by logging in again, so the streams are laid out anew within it."""
        current = self._connection_settings
        fresh = self._read_connection_settings(current)
        if fresh.get("revision") == current.get("revision") and fresh == current:
            return
        self._connection_settings = fresh
        self.subscription_manager.set_subscription_limit(self._total_stream_limit())
        logger.info("[SHIOAJI] 永豐行情連線 settings revision %s: %s connections x %s subscriptions",
                    fresh.get("revision"), fresh["connections"], fresh["per_connection_limit"])
        set_limit = getattr(self.event_sink, "set_max_subscriptions", None)
        if callable(set_limit):
            set_limit(self._instrument_limit(), stream_budget=self._stream_budget())
        with self._lock:
            loads = self._connection_loads()
            opened = 1 + len(self._extra_apis)
        if opened > int(fresh["connections"]) or any(n > int(fresh["per_connection_limit"]) for n in loads.values()):
            logger.info("[SHIOAJI] fewer connections or subscriptions than in use: logging in again to lay them out")
            self._disconnect()
            return
        # More room than before: the streams of added connections go back onto fewer, and the ones left empty log
        # out (user 10-22) -- not only at the next start.
        self._consolidate_connections()

    def _consolidate_connections(self) -> None:
        """Move each instrument held by an added connection onto the lowest connection with room for all its lanes,
        last connection first, then log out the connections left empty. A stream is subscribed on its new connection
        before it is unsubscribed on the old one, so no print falls between them: the overlap delivers a print twice,
        and Market Runtime drops the copy (its cumulative volume did not move; a book or index quote is simply the
        latest). A move that fails is recorded and the stream stays where it was."""
        with self._sync_mutex:
            sj = self._sj
            if sj is None or not self._connected.is_set():
                return
            with self._lock:
                loads = self._connection_loads()
                groups: dict[tuple[int, str, str], list[str]] = {}
                for key, index in sorted(self._stream_connection.items()):
                    if index > 0 and key in self._active_subscription_keys:
                        security_type, code = key.split(":")[:2]
                        groups.setdefault((index, security_type, code), []).append(key)
            moved = 0
            for (source, _, code), keys in sorted(groups.items(), key=lambda item: -item[0][0]):
                target = next((index for index in sorted(loads)
                               if index < source and self._connection_room(index) - loads[index] >= len(keys)), None)
                if target is None:
                    continue
                for key in keys:
                    if self._move_stream(key, source, target):
                        loads[source] -= 1
                        loads[target] += 1
                        moved += 1
            if moved:
                logger.info("[SHIOAJI] %s streams moved onto fewer connections after the setting grew", moved)
            self._close_idle_extra_connections()

    def _move_stream(self, key: str, source: int, target: int) -> bool:
        """One stream from connection `source` to `target`: subscribe there first, then unsubscribe here."""
        sj = self._sj
        lane = key.split(":")[2]
        with self._lock:
            contract = self._active_stream_contracts.get(key)
            from_api, to_api = self._api_for(source), self._api_for(target)
        quote_type = self._quote_type_value(sj, lane) if sj is not None else None
        if contract is None or quote_type is None or from_api is None or to_api is None:
            record_failure(logger, f"moving {key} from connection {source + 1} to {target + 1} (no contract, lane or connection)")
            return False
        code = key.split(":")[1]
        try:
            with broker_operation("shioaji", "subscribe", self._session_generation, symbol=code, lane=lane):
                to_api.subscribe(contract, quote_type=quote_type)
        except Exception as exc:
            record_failure(logger, f"moving {key} onto connection {target + 1} (it stays on {source + 1})", exc)
            return False
        with self._lock:
            self._stream_connection[key] = target
            state = self._stream_subscription_state.get(key)
            if state is not None:
                state["connection"] = target + 1
        try:
            with broker_operation("shioaji", "unsubscribe", self._session_generation, symbol=code, lane=lane):
                from_api.unsubscribe(contract, quote_type=quote_type)
        except Exception as exc:
            # Moved all the same: the old connection's copy is dropped downstream, and it ends when that connection
            # logs out empty.
            record_failure(logger, f"unsubscribing {key} on connection {source + 1} after moving it to {target + 1}", exc)
        return True

    def _api_for(self, index: int) -> Any | None:
        return self._api if index == 0 else self._extra_apis.get(index)

    def _connection_loads(self) -> dict[int, int]:
        """Streams held per open connection (call with self._lock)."""
        loads = {0: 0, **{index: 0 for index in self._extra_apis}}
        for key, index in self._stream_connection.items():
            if key in self._active_subscription_keys:
                loads[index] = loads.get(index, 0) + 1
        return loads

    def _connection_room(self, index: int) -> int:
        limit = int(self._connection_settings["per_connection_limit"])
        return min(limit, self._connection_cap.get(index, limit))

    def _pick_connection(self, identity: StreamIdentity) -> int:
        """The connection a new stream goes on: the one already holding the same instrument's other lane when it has
        room, else the first open one with room, else a new login while the setting allows one."""
        with self._lock:
            loads = self._connection_loads()
            sibling = next((index for key, index in self._stream_connection.items()
                            if key in self._active_subscription_keys and key.split(":")[:2] == [identity.security_type, identity.code]), None)
            if sibling is not None and loads.get(sibling, 0) < self._connection_room(sibling):
                return sibling
            for index in sorted(loads):
                if loads[index] < self._connection_room(index):
                    return index
            # A connection whose logout has not succeeded keeps its index: it may still hold a broker connection.
            free = [i for i in range(1, int(self._connection_settings["connections"]))
                    if i not in self._extra_apis and i not in self._closing_apis]
        if not free:
            s = self._connection_settings
            raise RuntimeError(f"SUBSCRIPTION_CAPACITY_FULL: {s['connections']} 條連線都已訂滿")
        failed = self._extra_login_failed
        if failed is not None and time.monotonic() - failed[0] < self.EXTRA_LOGIN_BACKOFF_SECONDS:
            raise RuntimeError(f"CONNECTION_OPEN_FAILED: 第 {free[0] + 1} 條連線登入失敗，稍後再試：{failed[1]}")
        try:
            index = self._open_extra_connection(free[0])
        except Exception as exc:
            self._extra_login_failed = (time.monotonic(), str(exc)[:160])
            record_failure(logger, f"opening Shioaji connection {free[0] + 1}", exc)
            raise
        self._extra_login_failed = None
        return index

    def _login(self, sj: Any, generation: int, reason: str) -> Any:
        """One broker login with the stored keys; the keys are never kept."""
        try:
            credentials = self.credential_service.load_shioaji_credentials()
        except CredentialError as exc:
            raise RuntimeError(str(exc)) from None
        api = sj.Shioaji(simulation=not self.production)
        ensure_shioaji_log_rotation()
        try:
            with broker_operation("shioaji", "login", generation), api_call("shioaji", "login", reason=reason,
                                                                         request_id=str(generation)) as call:
                call.detail["simulation"] = not self.production
                api.login(api_key=credentials.api_key, secret_key=credentials.secret_key, subscribe_trade=False)
        except Exception as exc:
            safe_error = self.credential_service.redact_text(exc, credentials)
            raise RuntimeError(f"Shioaji login 失敗：{safe_error}") from None
        finally:
            del credentials
            ensure_shioaji_log_rotation()
        return api

    CLOSE_ATTEMPTS = 3

    def _set_connection_state(self, index: int, state: str, **fields: Any) -> None:
        """One added connection's state record (call with self._lock)."""
        record = self._connection_states.setdefault(index, {"connection": index + 1})
        record.update({"state": state, "since": datetime.now().isoformat(timespec="seconds"), **fields})

    def _open_extra_connection(self, index: int) -> int:
        """Log in connection `index` for subscriptions only: the same callbacks, its own refusals; a dropped one
        replaces the whole session like the first. A login whose setup then fails is logged out at once -- never
        left holding one of the person ID's connections with no handle to it."""
        sj = self._sj
        if sj is None:
            raise RuntimeError("Shioaji 尚未載入")
        with self._lock:
            self._set_connection_state(index, "OPENING", error=None, close_attempts=0)
        try:
            api = self._login(sj, self._session_generation, "broker_connection_open")
        except Exception:
            with self._lock:
                self._connection_states.pop(index, None)
            raise
        try:
            self.provider_backend.install_callbacks(api)
            api.set_session_down_callback(self._on_broker_session_down)
            api.set_event_callback(lambda *args, _index=index: self._on_broker_event(*args, connection=_index))
        except Exception as exc:
            record_failure(logger, f"setting up Shioaji connection {index + 1} after its login (logging it out)", exc)
            with self._lock:
                self._closing_apis[index] = api
            self._close_connection(index, api, "broker_connection_setup_failed")
            raise RuntimeError(f"CONNECTION_SETUP_FAILED: 第 {index + 1} 條連線登入後設定失敗：{type(exc).__name__}: {exc}"[:200]) from None
        with self._lock:
            self._extra_apis[index] = api
            self._set_connection_state(index, "ACTIVE", opened_at=datetime.now().isoformat(timespec="seconds"), error=None)
            self._connection_cap.pop(index, None)
        self._connections_opened += 1
        logger.info("[SHIOAJI] connection %s opened (the subscriptions no longer fit the open ones)", index + 1)
        return index

    def _close_connection(self, index: int, api: Any, reason: str) -> bool:
        """Log out one added connection already out of the pool (in _closing_apis). Its handle and state go only once
        the logout succeeded; a failure keeps both (CLOSE_FAILED) for the next try. After CLOSE_ATTEMPTS failures the
        handle is let go, the recovery abandoned and the state kept to say so."""
        with self._lock:
            attempts = int((self._connection_states.get(index) or {}).get("close_attempts") or 0) + 1
            self._set_connection_state(index, "CLOSING", reason=reason, close_attempts=attempts)
        error = self._logout(api, index, reason)
        if error is None:
            with self._lock:
                self._closing_apis.pop(index, None)
                self._connection_states.pop(index, None)
                self._connection_cap.pop(index, None)
                recovery = self._close_recoveries.pop(index, None)
            if recovery is not None:
                recovery.finish("succeeded", detail={"connection": index + 1, "attempts": attempts})
            return True
        abandoned = attempts >= self.CLOSE_ATTEMPTS
        with self._lock:
            self._set_connection_state(index, "CLOSE_FAILED", reason=reason, error=error, abandoned=abandoned)
            recovery = self._close_recoveries.setdefault(index, remediation.Recovery(
                component="shioaji_connection_pool", mechanism_id="provider.shioaji_connection_close_retry"))
            if abandoned:
                self._closing_apis.pop(index, None)
                self._close_recoveries.pop(index, None)
        recovery.failed("logout_failed", identity={"lane": f"connection {index + 1}"},
                        detail={"connection": index + 1, "reason": reason, "error": error})
        if abandoned:
            recovery.finish("abandoned", detail={"connection": index + 1, "attempts": attempts, "error": error})
            logger.error("[SHIOAJI] connection %s did not log out after %s attempts (%s); its handle is let go",
                         index + 1, attempts, error)
        return False

    def _close_idle_extra_connections(self) -> None:
        """Log out every added connection that holds no stream (the plan shrank), and try again the logouts that
        failed before."""
        with self._lock:
            loads = self._connection_loads()
            idle = [(index, self._extra_apis.pop(index)) for index in sorted(self._extra_apis) if loads.get(index, 0) == 0]
            retry = sorted(self._closing_apis.items())
            self._closing_apis.update(idle)
        for index, api in idle:
            self._close_connection(index, api, "broker_connection_idle")
        for index, api in retry:
            self._close_connection(index, api, "broker_connection_close_retry")

    def _logout(self, api: Any, index: int, reason: str) -> str | None:
        """One logout; the error text when it failed (recorded), None when it succeeded."""
        try:
            with broker_operation("shioaji", "logout", self._session_generation), api_call("shioaji", "logout", reason=reason):
                api.logout()
        except Exception as exc:
            record_failure(logger, f"logging out connection {index + 1}", exc)
            return f"{type(exc).__name__}: {exc}"[:200]
        logger.info("[SHIOAJI] connection %s logged out (%s)", index + 1, reason)
        return None

    def _logout_extra_connections(self, reason: str) -> None:
        with self._lock:
            extras = sorted(self._extra_apis.items())
            self._extra_apis.clear()
            self._connection_cap.clear()
            self._closing_apis.update(extras)
            closing = sorted(self._closing_apis.items())
        for index, api in closing:
            self._close_connection(index, api, reason)

    def _refused_stream_key(self, index: int, info: str) -> str | None:
        """The held stream on connection `index` a broker refusal names (call with self._lock), or None when its
        topic cannot be attributed. The topic's security token is mapped through the capability table; its code is
        the broker's contract code (a futures contract month, not TXFR1), so it is matched against the contracts of
        the streams that connection holds."""
        match = _TOPIC.search(str(info or ""))
        if match is None:
            return None
        kind, security, code = match.groups()
        security_type = _TOPIC_SECURITY.get(security)
        if security_type is None:
            return None
        for key in sorted(self._active_subscription_keys):
            if self._stream_connection.get(key, 0) != index:
                continue
            identity = self._identity_from_state(key)
            if identity is None or identity.security_type != security_type:
                continue
            lanes = self.subscription_manager.subscription_plan(security_type, identity.code).lanes
            lane = lanes[0] if len(lanes) == 1 else _TOPIC_LANE.get(kind)
            if identity.quote_type != lane:
                continue
            contract = self._active_stream_contracts.get(key)
            names = {identity.code, *(str(getattr(contract, attr, "") or "").upper()
                                      for attr in ("code", "target_code", "symbol"))}
            if code in names or any(name.endswith(code) for name in names if name):
                return key
        return None

    def _take_broker_refusals(self) -> None:
        """The streams the broker refused after taking the subscribe: no longer held, and their connection's room is
        what it holds now -- the next pass puts them on another connection (or a new one). A refusal that names no
        held stream of that connection cannot say which stream the broker dropped: every stream of the connection
        is marked unverifiable and laid out again (one recorded resync), within one stream less than it held."""
        with self._lock:
            refusals, self._broker_refusals = self._broker_refusals, []
        for index, info in refusals:
            with self._lock:
                key = self._refused_stream_key(index, info)
                if key is not None:
                    self._active_subscription_keys.discard(key)
                    self._active_stream_contracts.pop(key, None)
                    self._stream_connection.pop(key, None)
                    self._connection_cap[index] = self._connection_loads().get(index, 0)
                    state = self._stream_subscription_state.get(key)
                    if state is not None:
                        state.update({"requested": False, "confirmed": False, "health": "SUBSCRIBE_ERROR",
                                      "last_subscribe_error": f"connection {index + 1}: {info}"[:200]})
                    unverified: list[str] = []
                else:
                    unverified = sorted(k for k in self._active_subscription_keys if self._stream_connection.get(k, 0) == index)
                    self._connection_cap[index] = max(0, len(unverified) - 1)
                    self._unattributed_refusals += 1
                    for stream_key in unverified:
                        self._active_subscription_keys.discard(stream_key)
                        self._active_stream_contracts.pop(stream_key, None)
                        self._stream_connection.pop(stream_key, None)
                        state = self._stream_subscription_state.get(stream_key)
                        if state is not None:
                            state.update({"requested": False, "confirmed": False, "health": "UNVERIFIED",
                                          "last_subscribe_error": f"connection {index + 1} refused a stream it did not name: {info}"[:200]})
            if key is not None:
                logger.warning("[SHIOAJI] connection %s refused %s (%s); it holds %s now", index + 1, key, info[:80],
                               self._connection_cap.get(index))
                continue
            record_failure(logger, f"attributing a refusal of connection {index + 1} to a stream it holds "
                                   f"({len(unverified)} stream(s) laid out again)", ValueError(info[:200]))
            self._refusal_resync.failed("unattributed_refusal", detail={"connection": index + 1, "streams": len(unverified),
                                                                       "info": info[:200]})

    # ===== subscription sync =====

    @staticmethod
    def _new_subscription_lane(*, desired: bool = False) -> dict[str, Any]:
        return {
            "desired": bool(desired),
            "requested": False,
            "confirmed": False,
            # What the lane DELIVERED is not kept here: delivery_evidence is the one record.
            "last_request_at": None,
            "last_confirm_at": None,
            "unsubscribe_uncertain": False,
            "last_unsubscribe_error": None,
            "session_generation": 0,
            "market_session_generation": 0,
            "market_session": "",
            "trading_date": "",
            "health": "PENDING" if desired else "NOT_DESIRED",
        }

    @staticmethod
    def _quote_type_value(sj: Any, quote_type: str) -> Any | None:
        quote_type = str(quote_type or "")
        mapping = {
            "Tick": getattr(sj.QuoteType, "Tick", None),
            "BidAsk": getattr(sj.QuoteType, "BidAsk", None),
            "Quote": getattr(sj.QuoteType, "Quote", None),
        }
        return mapping.get(quote_type)

    def _ensure_stream_state(self, identity: StreamIdentity) -> dict[str, Any]:
        owners = list(self.subscription_manager.owners_for(identity))
        plan = self.subscription_manager.subscription_plan(identity.security_type, identity.code)
        allowed = plan.allows(identity.quote_type)
        market_identity = self.market_identity_authority.current(plan.session_market)
        with self._lock:
            state = self._stream_subscription_state.setdefault(identity.key, {
                **identity.as_dict(),
                **self._new_subscription_lane(desired=bool(owners)),
                "owners": owners,
            })
            state.update(identity.as_dict())
            state["owners"] = owners
            state["desired"] = bool(owners)
            state["capability_allowed"] = bool(allowed)
            state["subscription_plan"] = plan.as_dict()
            if market_identity is not None:
                state["market_session_generation"] = market_identity.generation
                state["market_session"] = market_identity.session
                state["trading_date"] = market_identity.trading_date
                state["market_identity_key"] = market_identity.key
            if not owners and not state.get("confirmed"):
                state["health"] = "NOT_DESIRED"
            if owners and not allowed:
                state["health"] = "CAPABILITY_REJECTED"
            return state

    def _mark_stream_confirmed(self, identity: StreamIdentity) -> None:
        state = self._ensure_stream_state(identity)
        now_text = datetime.now().isoformat(timespec="milliseconds")
        state["requested"] = True
        state["confirmed"] = True
        state["last_request_at"] = state.get("last_request_at") or now_text
        state["last_confirm_at"] = now_text
        state["session_generation"] = self._session_generation
        state["unsubscribe_uncertain"] = False
        state["last_unsubscribe_error"] = None
        state["health"] = "CONFIRMED_AWAITING_EVENT"

    def note_market_event(self, security_type: str, exchange_timestamp: str = "") -> None:
        """Called by the callback path for every delivered event (after delivery_evidence, the one record of what a
        lane delivered). The first event of a security type in its current market-session generation is handed to
        the session owner once; every later one is a set lookup without a lock.

        This replaces `_mark_stream_event`, which no callback ever called: the per-stream event fields
        it was to write stayed empty, the TXF watchdog read them, fell back to the subscribe time and re-subscribed
        TXFR1 every three minutes, and the first-event listener never fired."""
        security = str(security_type or "").upper()
        if security in self._markets_seen:
            return
        with self._lock:
            if security in self._markets_seen:
                return
            self._markets_seen.add(security)
            listener = self._market_session_event_listener
        if listener is not None:
            try:
                listener(security, str(exchange_timestamp or ""))
            except Exception as exc:
                record_failure(logger, "notifying the market session event listener", exc)

    def mark_market_session_transition(
        self,
        *,
        market: str,
        trading_date: str,
        session: str,
        generation: int,
        live: bool = True,
        actual_contract: str = "",
    ) -> dict[str, Any]:
        """Accept one authoritative market-session transition from the rollover owner.

        This service does not recalculate ``trading_date``/``session`` from wall
        clock for health decisions.  It stamps every provider lane from the same
        immutable market identity contract.
        """
        market_u = str(market or "").upper()
        logical_code = self.TXF_CODE if market_u == "FUT" else "*"
        if market_u == "FUT" and not actual_contract:
            with self._lock:
                contract = self._txf_contract
                actual_contract = str(getattr(contract, "target_code", None) or getattr(contract, "code", None) or "")
        authority_identity = self.market_identity_authority.transition(
            market=market_u,
            trading_date=str(trading_date or "")[:10],
            session=str(session or "").upper(),
            generation=int(generation),
            logical_code=logical_code,
            actual_contract=str(actual_contract or ""),
            live=bool(live),
        )
        with self._lock:
            if bool(live):
                # The new generation's first event is signalled again (note_market_event).
                self._markets_seen -= {"FUT"} if market_u == "FUT" else {"STK", "IND"}
            for state in self._stream_subscription_state.values():
                security = str(state.get("security_type") or "").upper()
                code = str(state.get("code") or "").upper()
                plan = self.subscription_manager.subscription_plan(security, code)
                if plan.session_market != market_u:
                    continue
                state["market_session_generation"] = authority_identity.generation
                state["market_session"] = authority_identity.session
                state["trading_date"] = authority_identity.trading_date
                state["market_identity_key"] = authority_identity.key
                lane_allowed = plan.allows(str(state.get("quote_type") or ""))
                if bool(live) and lane_allowed and state.get("confirmed"):
                    state["health"] = "CONFIRMED_AWAITING_EVENT"
        return {
            "ok": True,
            **authority_identity.as_dict(),
            "market_session_generation": authority_identity.generation,
        }

    def _current_market_identity(self, market: str):
        return self.market_identity_authority.current(market)

    def _resolve_contract(self, identity: StreamIdentity) -> Any | None:
        api = self._api
        if api is None:
            return None
        code = identity.code
        if identity.security_type == "FUT" and code != self.TXF_CODE:
            # A dated month is named by its symbol (TXF202612); the broker knows it by its contract code (TXFL6).
            month = self.subscription_manager.futures_table().by_symbol.get(code)
            if month is None:
                return None
            code = month.code
        return api.contracts.get(code)

    TXF_LIMITS_RETRY_S = 60.0

    def note_txf_stated_reference(self, units: int, exchange_ns: int) -> None:
        """The reference a real TXF quote states (close - price_chg, price units) at its exchange time: the thin
        callback hands it here per quote, and _refresh_txf_limits reads from it which trading date the contract's
        limits are for. Nothing else happens on the callback thread."""
        self._txf_stated_reference = (int(units), int(exchange_ns))

    def _txf_limit_state(self, state: str, **detail: Any) -> None:
        """Where the current trading date's TXF limits stand. A change of state or reason is logged once: a reason
        not to publish is never silent, and a pass that finds the same reason again adds nothing."""
        entry = {"state": state, **detail}
        with self._lock:
            changed, self._txf_limits_state = self._txf_limits_state != entry, entry
        if not changed:
            return
        level = logging.INFO if state in ("PUBLISHED", "WAITING_QUOTE") else logging.WARNING
        logger.log(level, "[SHIOAJI] TXF limits %s: %s", state, {k: v for k, v in entry.items() if k != "state"})

    def _txf_limits_missing(self, state: str, trading_date: str, **detail: Any) -> None:
        """Limits a trading date its quotes already trade still lacks: one recorded refetch recovery
        (provider.metadata_refetch), open until they are published. A refused publish is the reference recovery's
        (_reference_admitted), not this one's."""
        self._txf_limit_state(state, trading_date=trading_date, **detail)
        if state == "PUBLISH_FAILED":
            return
        trigger = "txf_limits_not_updated" if state == "REFERENCE_MISMATCH" else "txf_limits_unavailable"
        self._txf_limits_recovery.failed(trigger, detail={"trading_date": trading_date, **detail,
                                                          "retry_seconds": self.TXF_LIMITS_RETRY_S})

    def _txf_limits_summary(self) -> dict[str, Any]:
        with self._lock:
            state = dict(self._txf_limits_state)
        return {**state, "refetch_open": self._txf_limits_recovery.open}

    def _refresh_txf_limits(self) -> None:
        """Publish the current trading date's TXF 漲停/跌停 to Market Runtime (a futures quote carries none).

        The limits are the contract's (``contracts.info`` of TXFR1, which is its month contract's: TXFK6 answered
        the same reference, limits and dates). Which trading date they are for is read from the quotes, never from
        the contract's ``update_date``: the broker updates the contract after the day session that sets the next
        trading date's reference and dates it by that day (on the night that opened 11-06 15:00, trading date 11-09,
        the contract said update_date 11-06 with that night's reference 39652 and limits 43617 / 35687). A contract
        whose reference is the one this trading date's quotes state (close - price_chg) carries this trading date's
        limits. Before this trading date's first quote nothing is matched (WAITING_QUOTE); a contract whose reference
        is another is the broker's update still to come (REFERENCE_MISMATCH), read again every TXF_LIMITS_RETRY_S.
        Runs on the session loop, never on a callback; a failure is recorded and asked again, never raised into the
        loop (which would recreate the broker session)."""
        trading_date = self._txf_business_date()
        with self._lock:
            contract = self._txf_contract
            stated = self._txf_stated_reference
            published = any(key[1] == trading_date for key in self._txf_limits_published)
            due = time.monotonic() - self._txf_limits_attempted >= self.TXF_LIMITS_RETRY_S
        if contract is None or published:
            return
        if stated is None or self._txf_business_date(datetime.fromtimestamp(stated[1] / 1_000_000_000)) != trading_date:
            # not an error: no quote of this trading date has stated the reference the contract is matched to yet
            self._txf_limit_state("WAITING_QUOTE", trading_date=trading_date)
            return
        if not due:
            return
        with self._lock:
            self._txf_limits_attempted = time.monotonic()
        try:
            info = self._api.contracts.info(contract)
            reference = self._number(getattr(info, "reference", None))
            limit_up = self._number(getattr(info, "limit_up", None))
            limit_down = self._number(getattr(info, "limit_down", None))
            dated = str(getattr(info, "update_date", "") or "").strip().replace("/", "-")[:10] or None
            code = str(getattr(info, "target_code", None) or getattr(contract, "code", None) or self.TXF_CODE)
            if not all(value is not None and value > 0 for value in (reference, limit_up, limit_down)):
                self._txf_limits_missing("UNAVAILABLE", trading_date, update_date=dated,
                                         reason="the contract carries no reference or limit prices")
                return
            reference_units = price_to_units(float(reference), scale=self.price_scale)
        except Exception as exc:
            record_failure(logger, "reading the TXF contract info for its limit prices", exc)
            self._txf_limits_missing("UNAVAILABLE", trading_date, reason=f"contract info: {type(exc).__name__}: {exc}"[:200])
            return
        if reference_units != stated[0]:
            self._txf_limits_missing("REFERENCE_MISMATCH", trading_date, contract=code, update_date=dated,
                                     contract_reference=reference_units, stated_reference=stated[0])
            return
        if not self._publish_txf_reference(trading_date, code, float(limit_up), float(limit_down)):
            self._txf_limits_missing("PUBLISH_FAILED", trading_date, contract=code,
                                     reason="Market Runtime's ingress did not admit the event")
            return
        self._txf_limit_state("PUBLISHED", trading_date=trading_date, contract=code, update_date=dated,
                              limit_up=float(limit_up), limit_down=float(limit_down))
        self._txf_limits_recovery.finish("succeeded", detail={"trading_date": trading_date, "contract": code})

    STOCK_LIMITS_RETRY_S = 600.0

    def _stock_limits_summary(self) -> dict[str, Any]:
        with self._lock:
            states = {code: dict(s) for code, s in self._stock_limits_state.items()}
        counts: dict[str, int] = {}
        for s in states.values():
            counts[str(s.get("state"))] = counts.get(str(s.get("state")), 0) + 1
        waiting = {code: s for code, s in sorted(states.items()) if s.get("state") != "PUBLISHED"}
        return {"counts": counts, "waiting": dict(list(waiting.items())[:50]), "refetch_open": self._stock_limits_recovery.open}

    def _refresh_stock_limits(self) -> None:
        """Publish each subscribed stock's 漲停/跌停 for today to Market Runtime.

        A Shioaji stock tick carries no limit prices, and until now only TXFR1 published them, so every
        stock's summary had limit_up/limit_down null and no panel could mark a limit price (紅底白字). The
        limits are the contract's (``contracts.info``), dated by its own ``update_date``: a contract not yet
        updated for today is left alone and asked again later, so a session that logged in overnight still
        gets today's limits once the broker publishes them. Runs off the loop thread; never on a callback.
        """
        worker = self._stock_limits_worker
        if worker is not None and worker.is_alive():
            return
        today = self._stock_business_date()
        now = time.monotonic()
        with self._lock:
            contracts = dict(self._stock_contracts)
            due = [code for code in sorted({key.split(":")[1] for key in self._active_subscription_keys if key.startswith("STK:")})
                   if code in contracts and self._stock_limits_published.get(code) != today
                   and now - self._stock_limits_attempted.get(code, -1e9) >= self.STOCK_LIMITS_RETRY_S]
        if not due or self._api is None:
            return
        self._stock_limits_worker = threading.Thread(
            target=self._publish_stock_limits, args=(due, contracts, today), name="shioaji-stock-limits", daemon=True)
        self._stock_limits_worker.start()

    def _stock_limit_state(self, code: str, state: str, **detail: Any) -> None:
        with self._lock:
            self._stock_limits_state[code] = {"state": state, **detail}

    def _publish_stock_limits(self, codes: list[str], contracts: dict[str, Any], today: str) -> None:
        """One pass over the due codes. Every code ends in a named state -- PUBLISHED, NOT_UPDATED (the broker's
        contract is still dated another day), UNAVAILABLE (contract info failed or carries no limits) or
        PUBLISH_FAILED -- shown in the status; while any is not published the refetch is one recorded recovery
        (provider.metadata_refetch), finished when a pass publishes them all."""
        api = self._api
        info_fn = getattr(getattr(api, "contracts", None), "info", None) if api is not None else None
        for code in codes:
            if not self._running.is_set():
                return
            with self._lock:
                self._stock_limits_attempted[code] = time.monotonic()
            contract = contracts.get(code)
            try:
                detail = info_fn(contract) if callable(info_fn) else contract
            except Exception as exc:
                record_failure(logger, f"reading the contract info of {code} for its limit prices", exc)
                self._stock_limit_state(code, "UNAVAILABLE", reason=f"contract info: {type(exc).__name__}: {exc}"[:200])
                continue
            detail = detail or contract
            dated = str(getattr(detail, "update_date", "") or "").strip().replace("/", "-")[:10]
            limit_up = self._number(getattr(detail, "limit_up", None))
            limit_down = self._number(getattr(detail, "limit_down", None))
            if dated != today:
                self._stock_limit_state(code, "NOT_UPDATED", dated=dated or None)
                continue
            if not (limit_up and limit_up > 0) or not (limit_down and limit_down > 0):
                self._stock_limit_state(code, "UNAVAILABLE", reason="the contract carries no limit prices")
                continue
            with self._lock:
                sequence = self._reference_stream_seq.get(code, 0) + 1
                self._reference_stream_seq[code] = sequence
            now_ns = time.time_ns()
            try:
                admitted = self.event_sink.publish(RustLiveEvent(
                    source="shioaji", market="STK", code=code, generation=max(0, int(self._session_generation)), sequence=sequence,
                    event_type="reference", exchange_ts_ns=now_ns, arrival_ns=now_ns, time_quality="backend_clock",
                    describes_trading_date=today,
                    data={
                        "limit_up": price_to_units(float(limit_up), scale=self.price_scale),
                        "limit_down": price_to_units(float(limit_down), scale=self.price_scale),
                    },
                ))
            except Exception as exc:
                record_failure(logger, f"publishing the limit prices of {code}", exc)
                self._stock_limit_state(code, "PUBLISH_FAILED", reason=f"{type(exc).__name__}: {exc}"[:200])
                continue
            # Published only once Market Runtime's ingress admitted it: a refusal keeps the code waiting, so the
            # next pass sends it again and the recovery stays open.
            if admitted is not True:
                self._stock_limit_state(code, "PUBLISH_FAILED", reason="Market Runtime's ingress did not admit the event")
                continue
            with self._lock:
                self._stock_limits_published[code] = today
            self._stock_limit_state(code, "PUBLISHED", dated=today)
            time.sleep(0.02)
        self._settle_stock_limits_pass(codes, today)

    @staticmethod
    def _stock_business_date(now: datetime | None = None) -> str:
        """The TWSE trading date whose stock limits apply right now: today's until its day session is sealed
        (wal_retention.session_end, after the 14:30 after-hours match), else the next trading date.

        Limits are a fact of one session's partition. Dated by the wall clock, every reconnect after the seal
        published the closed day's limits again (the contract stays dated that day until the broker's next
        morning update) into a sealed partition and its session evidence. After the seal the stock feed serves the
        next session, whose limits the broker has not published yet: the pass finds the contracts NOT_UPDATED and
        waits for that session (see _settle_stock_limits_pass)."""
        from service.market.lifecycle.calendar import MarketSessionCalendar
        from service.market.lifecycle.resolver import TAIPEI
        from service.market.shared.wal_retention import session_end

        local = (now or datetime.now(TAIPEI)).astimezone(TAIPEI)
        day = local.date()
        sealed_at = session_end("shioaji", "STK", day, wal_session("shioaji", "STK"))
        if sealed_at is not None and local >= sealed_at:
            day += timedelta(days=1)
        return MarketSessionCalendar().next_trading_date(day, inclusive=True)[0].isoformat()

    @staticmethod
    def _stock_session_begun(*, today: str, now: datetime | None = None) -> bool:
        """Whether the stock session of ``today`` (whose limits a pass asks for) has begun: a TWSE trading day at or
        past its 08:30 pre-open, Taipei time."""
        from service.market.lifecycle.resolver import TAIPEI, TW_EQUITY_PREOPEN_START
        from service.market.shared.session_identity_contract import is_business_session, wal_session

        if not is_business_session("shioaji", "STK", wal_session("shioaji", "STK"), today):
            return False
        local = (now or datetime.now(TAIPEI)).astimezone(TAIPEI)
        return local.date().isoformat() > today or (local.date().isoformat() == today and local.time() >= TW_EQUITY_PREOPEN_START)

    def _settle_stock_limits_pass(self, codes: list[str], today: str) -> None:
        with self._lock:
            states = {code: dict(self._stock_limits_state.get(code) or {}) for code in codes}
        waiting = {code: s for code, s in states.items() if s.get("state") != "PUBLISHED"}
        if not waiting:
            self._stock_limits_recovery.finish("succeeded", detail={"codes": len(codes)})
            return
        kinds = sorted({s.get("state") for s in waiting.values()})
        if kinds == ["NOT_UPDATED"] and not self._stock_session_begun(today=today):
            # The broker dates a contract's limits by the session they are for and publishes them with its daily
            # contract update (about 07:45). From midnight, and all weekend, every pass found yesterday's date: the
            # schedule, not a failure -- it opened a provider.metadata_refetch each night that ran until the morning
            # (or until Monday). The codes stay NOT_UPDATED in the status and are asked again every pass; only a
            # session that has begun without its limits is a recorded recovery.
            return
        trigger = ("stock_limits_not_updated" if kinds == ["NOT_UPDATED"]
                   else "reference_publish_refused" if "PUBLISH_FAILED" in kinds else "stock_limits_unavailable")
        self._stock_limits_recovery.failed(trigger, detail={"waiting": len(waiting), "states": kinds,
                                                            "retry_seconds": self.STOCK_LIMITS_RETRY_S})

    def _reference_admitted(self, admitted: Any, identity: tuple[str, ...], detail: dict[str, Any]) -> bool:
        """One TXF reference publish. A refusal opens (or continues) the recovery with that reference pending; an
        admission clears that reference, and the recovery succeeds once no refused reference is left pending."""
        with self._lock:
            if admitted is True:
                self._reference_refused.discard(identity)
            else:
                self._reference_refused.add(identity)
            pending = sorted(":".join(key) for key in self._reference_refused)
        if admitted is True:
            if not pending:
                self._reference_publish_recovery.finish("succeeded", detail=detail)
            return True
        self._reference_publish_recovery.failed("reference_publish_refused", detail={**detail, "pending": pending})
        return False

    def _txf_business_date(self, at: datetime | None = None) -> str:
        """The TAIFEX trading date a TXF session is for at `at` (local time; now when omitted): that day's while its
        day session may trade, else -- from 15:00, when the night that belongs to the next trading date opens -- the
        next trading date. The one calendar decides (official schedule)."""
        from service.market.lifecycle.calendar import MarketSessionCalendar

        moment = at or datetime.now()
        calendar = MarketSessionCalendar()
        if moment.time() >= dt_time(15, 0):
            return calendar.next_trading_date(moment.date() + timedelta(days=1), inclusive=True)[0].isoformat()
        return calendar.next_trading_date(moment.date(), inclusive=True)[0].isoformat()

    def _publish_txf_reference(self, dated: str, contract_code: str, limit_up: float, limit_down: float) -> bool:
        """The contract's limits for trading date `dated` (_refresh_txf_limits), handed to Market Runtime: it holds and
        serves them for the session, and FastAPI and the renderer read them there, never a copy of their own from the
        daemon. Whether Market Runtime admitted them: once admitted they are not published again for that date.
        """
        # A trading date's limits hold for both of its sessions, the night that opened the trading day before and
        # the day: Market Runtime writes the one reference to both partitions (describes_trading_date).
        with self._lock:
            sequence = self._reference_stream_seq.get(self.TXF_CODE, 0) + 1
            self._reference_stream_seq[self.TXF_CODE] = sequence
        now_ns = time.time_ns()
        admitted = self.event_sink.publish(RustLiveEvent(
            source="shioaji", market="FUT", code=self.TXF_CODE,
            generation=max(0, int(self._session_generation)), sequence=sequence,
            event_type="reference", exchange_ts_ns=now_ns, arrival_ns=now_ns, time_quality="backend_clock",
            describes_trading_date=dated,
            data={
                "limit_up": price_to_units(limit_up, scale=self.price_scale),
                "limit_down": price_to_units(limit_down, scale=self.price_scale),
            },
        ))
        if not self._reference_admitted(admitted, ("limits", str(contract_code), str(dated)),
                                        {"kind": "limits", "contract": contract_code, "trading_date": dated}):
            return False
        with self._lock:
            self._txf_limits_published.add((contract_code, dated))
            # Limits for an earlier trading date are never published again.
            self._txf_limits_published = {key for key in self._txf_limits_published if key[1] >= dated}
        return True

    def _subscribe_stream(self, identity: StreamIdentity) -> None:
        if not self.subscription_manager.is_allowed(identity):
            raise RuntimeError(f"Shioaji capability plan rejects {identity.key}")
        api, sj = self._api, self._sj
        if api is None or sj is None:
            return
        contract = self._resolve_contract(identity)
        if contract is None:
            raise RuntimeError(f"Shioaji 找不到行情合約 {identity.code} ({identity.security_type})")
        quote_type = self._quote_type_value(sj, identity.quote_type)
        if quote_type is None:
            raise RuntimeError(f"Shioaji 不支援 quote type {identity.quote_type}")

        if identity.security_type == "STK":
            with self._lock:
                self._stock_contracts[identity.code] = contract
        elif identity.security_type == "FUT" and identity.code == self.TXF_CODE:
            # Quote-only TXFR1 does not seed/replay TradeDetail into Rust and
            # therefore never waits on the historical futures-flow seed during
            # broker subscription.  Contract metadata below is enough for the
            # summary/trend baseline.
            pass

        index = self._pick_connection(identity)
        stream_api = self._api_for(index)
        if stream_api is None:
            raise RuntimeError(f"Shioaji 連線 {index + 1} 不在")
        state = self._ensure_stream_state(identity)
        state["requested"] = True
        state["last_request_at"] = datetime.now().isoformat(timespec="milliseconds")
        with broker_operation("shioaji", "subscribe", self._session_generation,
                              symbol=identity.code, lane=identity.quote_type):
            stream_api.subscribe(contract, quote_type=quote_type)
        with self._lock:
            self._stream_since.setdefault(identity.key, time.time_ns())
        self._mark_stream_confirmed(identity)
        state["connection"] = index + 1
        with self._lock:
            self._stream_connection[identity.key] = index
            self._active_subscription_keys.add(identity.key)
            self._active_stream_contracts[identity.key] = contract
            if identity.security_type == "IND" and identity.code == self.TAIEX_CODE:
                self._taiex_contract = contract
            elif identity.security_type == "FUT" and identity.code == self.TXF_CODE:
                self._txf_contract = contract

    @staticmethod
    def _gap_session_open_ns(gap: Any) -> int:
        from service.market.shared.session_identity_contract import partition_open

        return int(partition_open("shioaji", gap.market, gap.trading_date, gap.session).timestamp()) * 1_000_000_000

    @staticmethod
    def _gap_history_held_from_ns(gap: Any) -> int:
        """From when the broker's tick history holds a gap's prints. A futures night's from the midnight after the
        evening it opened: asked on that evening it answers another night's prints under both date arguments (11-06
        18:05 to 23:19, six restarts, none of 11-06), after it the night's own (11-07 01:35 to 01:57, five restarts
        filled; 03:07 the evening's 15:00 prints too). Every other session's as it trades."""
        if gap.market != "FUT" or gap.session != "NIGHT":
            return 0
        from service.market.lifecycle.resolver import TAIPEI

        evening = date.fromisoformat(gap.trading_date)
        return int(datetime.combine(evening + timedelta(days=1), dt_time(0, 0), TAIPEI).timestamp()) * 1_000_000_000

    @staticmethod
    def _gap_session_end_ns(gap: Any) -> int:
        """Past the partition's closing minute: a code that does not print again has its gap end at its close."""
        from service.market.shared.session_identity_contract import partition_end

        return (int(partition_end("shioaji", gap.market, gap.trading_date, gap.session).timestamp()) + 60) * 1_000_000_000

    @staticmethod
    def _gap_query_dates(gap: Any, day: Any) -> list[Any]:
        """The date arguments a gap's query on calendar date `day` may need. A futures night belongs to the TAIFEX
        trading day after the evening it opened, and the broker's history files it there or under the evening's own
        date: both are tried (the prints are cut to the window by their own times). Everything else: the date."""
        if gap.market != "FUT" or gap.session != "NIGHT":
            return [day]
        from datetime import date as _date, timedelta as _timedelta
        from config.market_holidays import tw_is_trading_day

        trading_day = _date.fromisoformat(gap.trading_date) + _timedelta(days=1)
        while not tw_is_trading_day(trading_day):
            trading_day += _timedelta(days=1)
        return [trading_day, _date.fromisoformat(gap.trading_date)]

    def fill_history_windows(self, items: list[dict[str, Any]]) -> dict[str, Any]:
        """A closed session's gaps from the broker's history, nothing published (restart_backfill.fetch_windows). Each
        code's windows are one recorded remediation (provider.history_backfill)."""
        from service.market.shioaji.restart_backfill import fetch_windows

        results = []
        for item in items:
            operation = remediation.emitter().begin(
                component="history_backfill", mechanism_id="provider.history_backfill", trigger_reason="closed_session_gap",
                identity={"source": "shioaji", "market": str(item.get("market")), "code": str(item.get("code")),
                          "session": str(item.get("session")), "trading_date": str(item.get("trading_date"))},
                detail={"windows": len(item.get("windows") or [])})
            [result] = fetch_windows(self._fetch_gap_ticks, self._gap_query_dates, self._gap_session_open_ns, [item],
                                     ticks_budget=self._ticks_budget)
            self._add_stock_prev_close(result)
            failed = [w["error"] for w in result["windows"] if "error" in w]
            operation.finish("failed" if failed else "succeeded",
                             detail={"prints": sum(len(w.get("prints") or []) for w in result["windows"]), "errors": failed[:3]})
            results.append(result)
        return {"ok": True, "results": results}

    def _add_stock_prev_close(self, result: dict[str, Any]) -> None:
        """A stock filled whole (no partition of it) gets its 昨收 as a reference window, as an index's has
        (history_fill.fill_events); a code that has a partition has its Reference there."""
        from types import SimpleNamespace

        whole = next((w for w in result["windows"] if w.get("whole_session") and "error" not in w), None)
        if result["market"] != "STK" or whole is None:
            return
        identity = SimpleNamespace(market="STK", code=str(result["code"]).upper(), trading_date=result["trading_date"], session=result["session"])
        close = self._session_prev_close(identity)
        if close is not None:
            result["windows"].insert(0, {"reference": "prev_close", "prints": [[0, close, 0, 0]], "end_ns": whole["end_ns"],
                                         "reference_at_ns": self._gap_session_open_ns(identity)})

    @staticmethod
    def _query_cache() -> Any:
        from config import storage_settings
        from service.market.history.query_cache import QueryCache

        return QueryCache(storage_settings.storage_paths().query_cache)

    @staticmethod
    def _exchange_closing_state(gap: Any) -> Any:
        """A stock's closing state from the set source (closing_state_source.py), called once per closed session viewed. A failure leaves
        the broker's own history as the source."""
        from service.market.shioaji import closing_state_source

        try:
            return closing_state_source.fetch(gap.code, gap.trading_date)
        except Exception as exc:
            record_failure(logger, f"reading the closing state of {gap.code} {gap.trading_date}", exc)
            return None

    def _session_prev_close(self, gap: Any) -> float | None:
        """The 昨收 of a closed session from the broker's history: the previous trading day's close. A stock's from that
        day's quotes of the whole market (one query, kept), an index's from its last print of that day. A futures
        contract's is its settlement price, which no history states: none. On a stock's ex-dividend day this is not the
        reference price, which only that day's stream states. A failure leaves the 昨收 empty and the prices shown."""
        from config.market_holidays import tw_is_trading_day

        if gap.market not in ("STK", "IDX"):
            return None
        try:
            day = date.fromisoformat(gap.trading_date) - timedelta(days=1)
            while not tw_is_trading_day(day):
                day -= timedelta(days=1)
            if gap.market == "IDX":
                ticks = self._fetch_gap_ticks(gap, day, "13:25:00", "13:40:00")
                closes = list(getattr(ticks, "close", []) or [])
                return float(closes[-1]) if closes else None
            with self._lock:
                known = self._daily_closes.get(day)
            if known is None:
                api = self._api
                if api is None:
                    raise RuntimeError("Shioaji is not logged in")
                with api_call("shioaji", "daily_quotes", reason="prev_close", market="STK", symbols=[]) as call:
                    call.detail["date"] = day.isoformat()
                    quotes = api.daily_quotes(date=day)
                    call.detail["codes"] = len(quotes.Code)
                known = {str(code).upper(): float(close) for code, close in zip(quotes.Code, quotes.Close)}
                with self._lock:
                    self._daily_closes[day] = known
            close = known.get(gap.code)
            return close if close else None
        except Exception as exc:
            record_failure(logger, f"reading the 昨收 of {gap.market}:{gap.code} before {gap.trading_date}", exc)
            return None

    def _closed_view_requested(self, payload: dict[str, Any]) -> None:
        """A view opened on a partition Market Runtime holds nothing of (restart_backfill.py closed_view): its session's
        prints are fetched once it is over, once per process. One asked before its close (a stock searched after the
        last print and before the partition's closing minute, or before the open) waits in the fill's queue for that
        close, and a live print of the partition meanwhile drops it (RestartBackfill.observe). One asked before the
        login waits for it: the App opens its views before the broker answers, and an open view is not asked for
        twice."""
        from service.market.shioaji.restart_backfill import CAUSE_CLOSED_VIEW, Gap

        if self._api is None:
            with self._lock:
                self._closed_views_waiting.append(dict(payload))
            return
        market = str(payload.get("market") or "").upper()
        item = {"cause": CAUSE_CLOSED_VIEW, "market": market, "code": payload.get("code"), "trading_date": payload.get("trading_date"),
                "session": payload.get("session"), "after_ns": 0, "volume_at_after": 0.0, "total_before": None if market == "IDX" else 0.0,
                "since_ns": time.time_ns()}
        try:
            gap = Gap.from_wire(item)
        except Exception as exc:
            record_failure(logger, f"reading the closed session a view asked for ({payload!r:.200})", exc)
            return
        with self._lock:
            if gap.key in self._closed_views_asked:
                return
            self._closed_views_asked.add(gap.key)
        self._restart_backfill.requested([item])

    def _fetch_gap_ticks(self, gap: Any, query_day: Any, time_start: str, time_end: str) -> Any:
        """One RangeTime window of a gap from the broker's tick history, under the date argument `query_day`."""
        api, sj = self._api, self._sj
        if api is None or sj is None:
            raise RuntimeError("Shioaji is not logged in")
        broker_code = self.TAIEX_CODE if gap.code == "TAIEX" else gap.code
        if gap.market == "FUT" and gap.code != self.TXF_CODE:
            # A dated month is named by its symbol (TXF202612); the broker knows it by its contract code (TXFL6).
            month = self.subscription_manager.futures_table().by_symbol.get(gap.code)
            if month is None:
                raise RuntimeError(f"no futures contract is listed for {gap.code}")
            broker_code = month.code
        contract = api.contracts.get(broker_code)
        if contract is None:
            raise RuntimeError(f"Shioaji has no contract {broker_code}")
        with api_call("shioaji", "ticks", reason="restart_backfill", market=gap.market, symbols=[gap.code]) as call:
            call.detail.update({"date": query_day.isoformat(), "time_start": time_start, "time_end": time_end})
            ticks = api.ticks(contract, date=query_day.isoformat(), query_type=sj.TicksQueryType.RangeTime,
                              time_start=time_start, time_end=time_end)
            call.detail["ticks"] = len(getattr(ticks, "ts", []) or [])
        return ticks

    def _unsubscribe_stream(self, identity: StreamIdentity, *, preserve_desired: bool = False) -> bool:
        """Unsubscribe one broker lane without inventing broker truth.

        A broker exception is an *uncertain* unsubscribe, not a successful one.
        Keep the active key so the next sync/watchdog can resynchronize the lane
        instead of silently believing it disappeared at the broker.
        """
        sj = self._sj
        quote_type = self._quote_type_value(sj, identity.quote_type) if sj is not None else None
        with self._lock:
            api = self._api_for(self._stream_connection.get(identity.key, 0))
            contract = self._active_stream_contracts.get(identity.key) or self._stock_contracts.get(identity.code)
        unsubscribe_error: Exception | None = None
        if api is not None and contract is not None and quote_type is not None:
            try:
                with broker_operation("shioaji", "unsubscribe", self._session_generation,
                                      symbol=identity.code, lane=identity.quote_type):
                    api.unsubscribe(contract, quote_type=quote_type)
            except Exception as exc:
                unsubscribe_error = exc

        state = self._ensure_stream_state(identity)
        if unsubscribe_error is not None:
            safe_error = self.credential_service.redact_text(unsubscribe_error)
            with self._lock:
                owners = list(self.subscription_manager.owners_for(identity)) if preserve_desired else list(state.get("owners") or [])
                state.update({
                    "desired": bool(owners) if preserve_desired else bool(state.get("desired")),
                    "owners": owners,
                    "unsubscribe_uncertain": True,
                    "last_unsubscribe_error": safe_error,
                    "health": "UNSUBSCRIBE_UNCERTAIN",
                })
                # Deliberately leave requested/confirmed/active-key truth intact.
                # The broker may still be streaming this exact lane.
            return False

        with self._lock:
            self._active_subscription_keys.discard(identity.key)
            self._active_stream_contracts.pop(identity.key, None)
            self._stream_connection.pop(identity.key, None)
            self._stream_since.pop(identity.key, None)
            owners = list(self.subscription_manager.owners_for(identity)) if preserve_desired else []
            state.update({
                "desired": bool(owners) if preserve_desired else False,
                "owners": owners,
                "requested": False,
                "confirmed": False,
                "unsubscribe_uncertain": False,
                "last_unsubscribe_error": None,
                "unsubscribed_at": datetime.now().isoformat(timespec="milliseconds"),
                "session_generation": self._session_generation if preserve_desired else 0,
                "health": "QUIESCED" if preserve_desired and owners else "NOT_DESIRED",
            })

        if identity.security_type == "STK":
            remaining = any(key.startswith(f"STK:{identity.code}:") for key in self._active_subscription_keys)
            if not remaining:
                with self._lock:
                    self._symbol_ids.pop(identity.code, None)
                    self._stock_contracts.pop(identity.code, None)
        elif identity.security_type == "IND" and identity.code == self.TAIEX_CODE:
            with self._lock:
                if not any(key.startswith(f"IND:{self.TAIEX_CODE}:") for key in self._active_subscription_keys):
                    self._taiex_contract = None
        elif identity.security_type == "FUT" and identity.code == self.TXF_CODE:
            with self._lock:
                if not any(key.startswith(f"FUT:{self.TXF_CODE}:") for key in self._active_subscription_keys):
                    self._txf_contract = None
                    self._txf_stated_reference = None
        return True

    @staticmethod
    def _identity_market(identity: StreamIdentity) -> str:
        if identity.security_type == "FUT":
            return "FUT"
        if identity.security_type in {"STK", "IND"}:
            return "STK"
        return identity.security_type

    def _sync_subscriptions(self, *, force: bool = False) -> list[dict[str, str]]:
        with self._sync_mutex:
            return self._sync_subscriptions_locked(force=force)

    @batch_broker_operations
    def _sync_subscriptions_locked(self, *, force: bool = False) -> list[dict[str, str]]:
        if self._subscription_mutation_frozen:
            return []
        api = self._api
        sj = self._sj
        if api is None or sj is None or not self._connected.is_set():
            return []

        started_ns = time.perf_counter_ns()
        if force:
            startup_realtime_diagnostic.mark("SUBSCRIPTION_SYNC_START", detail={"session_generation": self._session_generation}, once=True)
        desired = {
            identity.key: identity for identity in self.subscription_manager.desired_identities()
        }
        with self._lock:
            # Only confirmations owned by the current Shioaji session may suppress
            # a real subscribe. A stale key from an older session is deliberately
            # ignored even if a test/recovery path did not clear every cache.
            current_keys = {
                key for key in self._active_subscription_keys
                if int((self._stream_subscription_state.get(key) or {}).get("session_generation") or 0) == self._session_generation
            }

        if force:
            self._full_subscription_sync_count += 1
        if self._broker_refusals:
            self._take_broker_refusals()
            with self._lock:
                current_keys &= self._active_subscription_keys

        removed = [
            self._identity_from_state(key)
            for key in sorted(current_keys - set(desired))
        ]
        removed = [identity for identity in removed if identity is not None]
        # Release streams the plan no longer holds first, so the broker's stream limit is never exceeded by a plan
        # that swaps instruments.
        removed_codes: set[str] = set()
        unsubscribe_started_ns = time.perf_counter_ns()
        for identity in removed:
            self._unsubscribe_stream(identity)
            removed_codes.add(identity.code)
        if removed:
            record_api_call(
                "shioaji", "unsubscribe",
                reason="full_subscription_sync" if force else "subscription_delta",
                market="STK", symbols=sorted(removed_codes),
                duration_ms=(time.perf_counter_ns() - unsubscribe_started_ns) / 1e6,
                ok=True,
                detail={"lane_count": len(removed), "session_generation": self._session_generation},
            )

        added_codes: set[str] = set()
        subscription_errors: list[dict[str, str]] = []
        for key in sorted(set(desired) - current_keys):
            identity = desired[key]
            try:
                self._subscribe_stream(identity)
                added_codes.add(identity.code)
            except Exception as exc:
                safe_error = self.credential_service.redact_text(exc)
                state = self._ensure_stream_state(identity)
                state.update({
                    "requested": False,
                    "confirmed": False,
                    "health": "SUBSCRIBE_ERROR",
                    "last_subscribe_error": safe_error,
                })
                subscription_errors.append({"code": identity.code, "error": safe_error})

        if subscription_errors:
            logger.error(
                "[SHIOAJI] subscription sync failed session_generation=%s failed=%s symbols=%s",
                self._session_generation, len(subscription_errors),
                ",".join(dict.fromkeys(row["code"] for row in subscription_errors[:3])),
            )

        if added_codes or subscription_errors:
            record_api_call(
                "shioaji", "subscribe",
                reason="full_subscription_sync" if force else "subscription_delta",
                market="STK", symbols=sorted(added_codes),
                duration_ms=(time.perf_counter_ns() - started_ns) / 1e6,
                ok=not subscription_errors,
                error_type="SubscribeError" if subscription_errors else None,
                detail={
                    "failed_count": len(subscription_errors),
                    "failed_symbols": [row["code"] for row in subscription_errors][:SYMBOL_SAMPLE_LIMIT],
                    "desired_lane_count": len(desired),
                    "session_generation": self._session_generation,
                },
            )

        # The streams an unattributed refusal left unverifiable were all subscribed again.
        if self._refusal_resync.open and not subscription_errors:
            self._refusal_resync.finish("succeeded", detail={"resubscribed_streams": len(added_codes)})

        # Refresh plan metadata even when no broker operation was required.
        for identity in desired.values():
            self._ensure_stream_state(identity)
        self._close_idle_extra_connections()

        if not force:
            if added_codes:
                self._delta_subscribe_count += len(added_codes)
            if removed_codes:
                self._delta_unsubscribe_count += len(removed_codes)

        self._last_sync_at = datetime.now().isoformat(timespec="seconds")
        runtime_profiler.observe_ns(
            "shioaji_subscription_sync",
            started_ns,
            detail={
                "streams": len(desired),
                "stocks": len({item.code for item in desired.values() if item.security_type == "STK"}),
                "taiex": bool(self.subscription_manager.subscription_plan("IND", self.TAIEX_CODE).lanes),
                "txf_quote": self.subscription_manager.subscription_plan("FUT", self.TXF_CODE).allows("Quote"),
                "txf_tick": self.subscription_manager.subscription_plan("FUT", self.TXF_CODE).allows("Tick"),
                "txf_bidask": self.subscription_manager.subscription_plan("FUT", self.TXF_CODE).allows("BidAsk"),
            },
        )
        if force:
            startup_realtime_diagnostic.mark(
                "SUBSCRIPTION_SYNC_OK",
                detail={"streams": len(desired), "session_generation": self._session_generation},
                once=True,
            )
        if force or added_codes or removed_codes or subscription_errors:
            self._notify_subscriptions_changed()
        return subscription_errors

    def apply_demand_plan(self, items: Iterable[dict[str, Any]]) -> dict[str, Any]:
        """Make Market Runtime's plan the broker subscriptions and say what the broker did."""
        self._plan_refused = self.subscription_manager.replace_plan(items)
        if self._connected.is_set() and self._api is not None and not self._subscription_mutation_frozen:
            self._sync_subscriptions()
        return self.plan_report()

    # The lanes whose events are an instrument's prints (an order book is none).
    _PRINT_LANES = frozenset({"Tick", "Quote"})

    def plan_report(self) -> dict[str, Any]:
        """The plan in force, instrument by instrument: subscribed only when every stream of it was requested from the
        broker in the current session; otherwise failed, with the reason (not connected, an SDK error, refused)."""
        planned = self.subscription_manager.planned_instruments()
        connected = self._connected.is_set() and self._api is not None
        planned_keys = {identity.key for streams in planned.values() for identity in streams}
        with self._lock:
            states = {key: dict(state) for key, state in self._stream_subscription_state.items()}
            active = {key for key in self._active_subscription_keys
                      if int((states.get(key) or {}).get("session_generation") or 0) == self._session_generation}
            self._stream_since = {key: ns for key, ns in self._stream_since.items() if key in planned_keys}
            since = dict(self._stream_since)
        subscribed, failed = [], []
        for (market, code), reason in sorted(self._plan_refused.items()):
            failed.append({"market": market, "code": code, "reason": reason})
        for (market, code), streams in sorted(planned.items()):
            if connected and all(identity.key in active for identity in streams):
                item: dict[str, Any] = {"market": market, "code": code}
                # Since its print stream (a stock's or futures month's Tick, an index's or TXF's Quote) was subscribed:
                # whether its first print followed the open by a window nothing recorded (a late join).
                print_since = [since[identity.key] for identity in streams
                               if identity.quote_type in self._PRINT_LANES and identity.key in since]
                if print_since:
                    item["since_ns"] = min(print_since)
                subscribed.append(item)
                continue
            errors = [str((states.get(identity.key) or {}).get("last_subscribe_error") or "") for identity in streams]
            reason = next((e for e in errors if e), "") or ("SOURCE_NOT_CONNECTED" if not connected else "SUBSCRIBE_PENDING")
            failed.append({"market": market, "code": code, "reason": reason[:120]})
        return {"subscribed": subscribed, "failed": failed}

    def _notify_subscriptions_changed(self) -> None:
        notify = getattr(self.event_sink, "subscriptions_changed", None)
        if callable(notify):
            notify()

    def _identity_from_state(self, key: str) -> StreamIdentity | None:
        with self._lock:
            state = dict(self._stream_subscription_state.get(str(key)) or {})
        if not state:
            parts = str(key).split(":")
            if len(parts) >= 3:
                return StreamIdentity(parts[0], parts[1], parts[2], len(parts) >= 4 and parts[3] == "odd")
            return None
        return StreamIdentity(
            str(state.get("security_type") or ""),
            str(state.get("code") or ""),
            str(state.get("quote_type") or ""),
            bool(state.get("intraday_odd")),
        )

    # ===== native -> canonical helpers =====

    @staticmethod
    def _value(obj: Any, name: str, default: Any = None) -> Any:
        try:
            value = getattr(obj, name)
        except Exception:  # not an error: an SDK object without that attribute answers the default
            return default
        return default if value is None else value

    @staticmethod
    def _number(value: Any) -> float | int | None:
        if value is None:
            return None
        if isinstance(value, bool):
            return int(value)
        if isinstance(value, int):
            return value
        if isinstance(value, (float, Decimal)):
            return float(value)
        try:
            number = float(value)
            return int(number) if number.is_integer() else number
        except Exception:  # not an error: value coercion: a non-numeric value is None (missing) by contract
            return None

    @staticmethod
    def _flag_bits(obj: Any) -> int:
        """Encode broker callback flags for the native realtime ABI.

        Bit 0 is the stable cross-layer ``simtrade`` contract used by Raw,
        Canonical, replay, and large-order filtering.  Keep this helper on the
        service because the thin callback adapter deliberately calls only
        allocation-light owner helpers on the hot path.
        """
        try:
            return 1 if bool(getattr(obj, "simtrade", False)) else 0
        except Exception:  # not an error: an SDK object without a readable simtrade flag is a real account (0)
            return 0

    @staticmethod
    def _int_value(value: Any, default: int = 0) -> int:
        """Convert Shioaji numeric wrappers to the native integer ABI safely."""
        if value is None or value == "":
            return int(default)
        try:
            return int(value)
        except (TypeError, ValueError, OverflowError):
            try:
                return int(float(value))
            except (TypeError, ValueError, OverflowError):  # not an error: value coercion: a non-numeric value is the default by contract
                return int(default)

    @staticmethod
    def _date_text(value: Any) -> str:
        if isinstance(value, datetime):
            return value.strftime("%Y-%m-%d")
        if isinstance(value, date):
            return value.isoformat()
        if isinstance(value, tuple) and len(value) >= 3:
            try:
                return f"{int(value[0]):04d}-{int(value[1]):02d}-{int(value[2]):02d}"
            except Exception:  # not an error: a tuple that is not (y, m, d) numbers is formatted as text below
                pass
        return str(value or "")[:10]

    @staticmethod
    def _time_text(value: Any) -> str:
        if isinstance(value, datetime):
            return value.strftime("%H:%M:%S.%f").rstrip("0").rstrip(".")
        if isinstance(value, dt_time):
            return value.strftime("%H:%M:%S.%f").rstrip("0").rstrip(".")
        if isinstance(value, tuple) and len(value) >= 3:
            try:
                base = f"{int(value[0]):02d}:{int(value[1]):02d}:{int(value[2]):02d}"
                if len(value) >= 4 and int(value[3]):
                    return f"{base}.{int(value[3]):06d}".rstrip("0")
                return base
            except Exception:  # not an error: a tuple that is not time numbers is formatted as text below
                pass
        return str(value or "")

    @classmethod
    def _timestamp_fields(cls, obj: Any) -> dict[str, str]:
        raw_dt = cls._value(obj, "datetime")
        if isinstance(raw_dt, datetime):
            return {
                "exchange_date": raw_dt.strftime("%Y-%m-%d"),
                "exchange_time": raw_dt.strftime("%H:%M:%S.%f").rstrip("0").rstrip("."),
                "datetime": raw_dt.isoformat(sep=" "),
            }
        date_text = cls._date_text(cls._value(obj, "date"))
        time_text = cls._time_text(cls._value(obj, "time"))
        return {
            "exchange_date": date_text,
            "exchange_time": time_text,
            "datetime": f"{date_text} {time_text}".strip(),
        }

    @staticmethod
    def _exchange_text(exchange: Any) -> str:
        text = str(getattr(exchange, "value", exchange) or "").upper()
        if "OTC" in text:
            return "otc"
        if "TSE" in text:
            return "tse"
        if "TAIFEX" in text or "TFE" in text:
            return "taifex"
        return text.lower()

    # ===== public status/state =====

    def get_api(self) -> Any | None:
        """Return the live Shioaji API object for repository/contract services."""
        return self._api if self._connected.is_set() else None

    def is_connected(self) -> bool:
        """Logged in now: what the once-a-second heartbeat needs, without building status()."""
        return self._connected.is_set()

    def status(self) -> dict[str, Any]:
        sj = self._sj
        desired_stocks = {code for (market, code) in self.subscription_manager.planned_instruments() if market == "STK"}
        capacity = self.subscription_manager.capacity_snapshot()
        stock_plan = self.subscription_manager.subscription_plan("STK", "*")
        taiex_plan = self.subscription_manager.subscription_plan("IND", self.TAIEX_CODE)
        txf_plan = self.subscription_manager.subscription_plan("FUT", self.TXF_CODE)
        stock_lanes = tuple(stock_plan.lanes)
        with self._lock:
            stream_state = deepcopy(self._stream_subscription_state)
            active_keys = set(self._active_subscription_keys)
            txf_target = getattr(self._txf_contract, "target_code", None) if self._txf_contract is not None else None

        confirmed_symbols = sum(
            1 for code in desired_stocks
            if all(
                bool(regular_stock_lane(stream_state, code, lane).get("confirmed"))
                and int(regular_stock_lane(stream_state, code, lane).get("session_generation") or 0) == self._session_generation
                for lane in stock_lanes
            )
        )
        unhealthy_symbols = sum(
            1 for code in desired_stocks
            if not all(
                bool(regular_stock_lane(stream_state, code, lane).get("confirmed"))
                and int(regular_stock_lane(stream_state, code, lane).get("session_generation") or 0) == self._session_generation
                for lane in stock_lanes
            )
        )
        healthy_symbols = sum(
            1 for code in desired_stocks
            if all(
                str(regular_stock_lane(stream_state, code, lane).get("health") or "") == "HEALTHY"
                and int(regular_stock_lane(stream_state, code, lane).get("session_generation") or 0) == self._session_generation
                for lane in stock_lanes
            )
        )
        confirmed_streams = sum(
            1 for key, state in stream_state.items()
            if key in active_keys
            and bool(state.get("confirmed"))
            and int(state.get("session_generation") or 0) == self._session_generation
        )
        txf_quote = stream_state.get(StreamIdentity("FUT", self.TXF_CODE, "Quote").key, {})
        taiex_quote = stream_state.get(StreamIdentity("IND", self.TAIEX_CODE, "Quote").key, {})
        available_slots = max(0, int(capacity["subscription_limit"]) - int(capacity["active_subscription_count"]))
        session_markets = {
            str(((stream_state.get(key) or {}).get("subscription_plan") or {}).get("session_market") or "").upper()
            for key in active_keys
        }
        session_markets.discard("")
        market_liveness = {
            market: bool(
                (identity := self.market_identity_authority.current(market)) is not None
                and identity.live
            )
            for market in session_markets
        }
        # 休市 vs 盤前試撮 is the status line's, from Market Runtime's session phase (core/status.js).
        all_markets_closed = bool(session_markets) and not any(market_liveness.values())

        # One projection.  Every lane verdict, the stream health counters and
        # readiness below are all read off this list; nothing recomputes lane
        # health from raw subscription state any more.  The row set is the union
        # of "lanes this process subscribed" and "lanes that have delivered".
        evidence = self.delivery_evidence
        lane_freshness = []
        lane_rows_by_key: dict[str, dict[str, Any]] = {}
        for key in sorted(set(active_keys) | set(evidence.keys())):
            state = stream_state.get(key) or {}
            parts = key.split(":")
            security_type = str(state.get("security_type") or (parts[0] if parts else "")).upper()
            code = str(state.get("code") or (parts[1] if len(parts) > 1 else ""))
            quote_type = str(state.get("quote_type") or (parts[2] if len(parts) > 2 else ""))
            plan = self.subscription_manager.subscription_plan(security_type, code)
            session_market = str(
                (state.get("subscription_plan") or {}).get("session_market") or plan.session_market or ""
            ).upper()
            threshold = lane_stale_after_seconds(plan, quote_type)
            evidence_age = evidence.age_seconds(key)
            last_event_at = evidence.last_event_at(key)
            age_seconds = evidence_age
            # A lane that is delivering right now proves its own session is
            # active, whatever the calendar authority believes.  Calendar
            # liveness alone would mark a genuinely live lane IDLE whenever the
            # authority has no identity for that market yet.
            delivering_now = age_seconds is not None and age_seconds <= threshold
            row = provider_lane_freshness(
                provider="shioaji",
                code=code,
                lane=quote_type,
                desired=bool(state.get("desired")) if state else True,
                confirmed=bool(state.get("confirmed")),
                last_event_at=last_event_at,
                age_seconds=age_seconds,
                expected_active=bool(market_liveness.get(session_market, True)) or delivering_now,
                stale_after_seconds=threshold,
                reported_state=str(state.get("health") or ""),
            )
            row["stale_after_seconds"] = threshold
            row["callback_count"] = evidence.count(key)
            lane_freshness.append(row)
            lane_rows_by_key[key] = row

        healthy_streams = sum(
            1 for row in lane_freshness
            if str(row.get("state") or "") in {"HEALTHY", "IDLE"}
        )
        readiness = provider_readiness(
            provider="shioaji",
            connected=self._connected.is_set(),
            worker_alive=self._running.is_set(),
            market_data_ready=lanes_market_data_ready(lane_freshness),
            market_closed=all_markets_closed,
        )

        return {
            "provider": "shioaji",
            "readiness": readiness,
            "enabled": True,
            "connected": self._connected.is_set(),
            "running": self._running.is_set(),
            "version": getattr(sj, "__version__", None) if sj is not None else None,
            "session_generation": self._session_generation,
            "login_count": self._daemon_lifetime_login_count,
            "reconnect_count": self._reconnect_count,
            "last_login_attempt_at": self._last_login_attempt_at,
            # Symbol-level health counters complement stream-level diagnostics.
            "desired_subscription_count": len(desired_stocks),
            "confirmed_subscription_count": confirmed_symbols,
            "healthy_subscription_count": healthy_symbols,
            "unhealthy_subscription_count": unhealthy_symbols,
            # Canonical stream/capacity counters (the limit is every connection's together).
            "subscription_limit": int(capacity["subscription_limit"]),
            "connections": self._connections_status(),
            "active_subscription_count": len(active_keys),
            "desired_stream_count": int(capacity["active_subscription_count"]),
            "confirmed_stream_count": confirmed_streams,
            "healthy_stream_count": healthy_streams,
            "unhealthy_stream_count": max(0, int(capacity["active_subscription_count"]) - healthy_streams),
            "planned_instrument_count": int(capacity["planned_instrument_count"]),
            "refused_instruments": [{"market": m, "code": c, "reason": r} for (m, c), r in sorted(self._plan_refused.items())],
            "available_subscription_slots": available_slots,
            "full_subscription_sync_count": self._full_subscription_sync_count,
            "delta_subscribe_count": self._delta_subscribe_count,
            "delta_unsubscribe_count": self._delta_unsubscribe_count,
            "stock_quote_types": list(stock_lanes),
            "subscription_streams": stream_state,
            "lane_freshness": lane_freshness,
            "subscription_ownership": self.subscription_manager.snapshot(),
            "provider_capabilities": self.provider_capabilities.snapshot(),
            "market_identity_authority": self.market_identity_authority.snapshot(),
            "thin_callback": self.thin_callback.snapshot(),
            "provider_backend": self.provider_backend.snapshot(),
            "taiex": {
                "code": self.TAIEX_CODE,
                "quote_type": taiex_plan.lanes[0] if taiex_plan.lanes else None,
                "subscribed": StreamIdentity("IND", self.TAIEX_CODE, "Quote").key in active_keys,
                "state": taiex_quote,
            },
            "txf": {
                "code": self.TXF_CODE,
                "target_code": txf_target,
                "quote_types": list(txf_plan.lanes),
                "quote_subscribed": StreamIdentity("FUT", self.TXF_CODE, "Quote").key in active_keys,
                "subscribed": StreamIdentity("FUT", self.TXF_CODE, "Quote").key in active_keys,
                "Quote": txf_quote,
            },
            "last_login_at": self._last_login_at,
            "broker_events": list(self._broker_events),
            "last_sync_at": self._last_sync_at,
            "last_callback_at": evidence.last_delivery_at() or (
                datetime.fromtimestamp(self._last_callback_epoch_ns / 1_000_000_000).isoformat(timespec="milliseconds")
                if self._last_callback_epoch_ns else None
            ),
            "lane_delivery_evidence": evidence.snapshot(),
            "native_runtime": {
                "owner": "rust_live_daemon",
                **(self.event_sink.stats() if hasattr(self.event_sink, "stats") else {}),
            },
            "price_scale_errors": self._price_scale_errors,
            # Each subscribed stock's limit publication, by state (PUBLISHED / NOT_UPDATED / UNAVAILABLE /
            # PUBLISH_FAILED); unknown codes are not listed.
            "stock_limits": self._stock_limits_summary(),
            # The current trading date's TXF limits: published, or why not yet.
            "txf_limits": self._txf_limits_summary(),
            # The callback adapter's own counts, read once: invalid_required_*, and unpriced_quotes_* (quotes dropped
            # for having no price yet -- not errors, kept apart), invalid_optional_fields.
            **self.thin_callback.diagnostic_snapshot(),
            "callback_errors": self._callback_errors,
            "last_callback_error": self._last_callback_error,
            "last_error": self._last_error,
        }

    def _connections_status(self) -> dict[str, Any]:
        """設定 → 永豐行情連線 as it runs: the setting, and each open connection with what it holds."""
        s = self._connection_settings
        with self._lock:
            loads = self._connection_loads() if self._connected.is_set() else {}
            rows = [{"connection": index + 1, "streams": loads[index], "room": self._connection_room(index),
                     "state": "ACTIVE" if index == 0 else str((self._connection_states.get(index) or {}).get("state") or "ACTIVE"),
                     "opened_at": self._last_login_at if index == 0 else (self._connection_states.get(index) or {}).get("opened_at")}
                    for index in sorted(loads)]
            # Connections out of the pool that are not closed yet (OPENING, CLOSING, CLOSE_FAILED) or whose logout
            # was given up on: each may still hold one of the person ID's broker connections.
            others = [dict(record) for index, record in sorted(self._connection_states.items()) if index not in loads]
            unattributed = self._unattributed_refusals
        return {"max_connections": int(s["connections"]), "per_connection_limit": int(s["per_connection_limit"]),
                "settings_revision": s.get("revision"), "open": rows, "not_closed": others,
                "unattributed_refusals": unattributed, "opened_since_start": self._connections_opened}

    def lightweight_status(self) -> dict[str, Any]:
        """Lock-light broker truth for the daemon startup/heartbeat endpoint.

        Full ``status()`` also asks the native runtime for diagnostics and walks
        every subscription.  The Electron heartbeat must not wait for either.
        These fields are atomic/event-backed primitives updated by the broker
        thread and are sufficient for the footer and session ownership logic.
        """
        connected = self._connected.is_set()
        running = self._running.is_set()
        evidence = self.delivery_evidence
        return {
            "provider": "shioaji",
            "readiness": provider_readiness(
                provider="shioaji",
                connected=connected,
                worker_alive=running,
                # This lock-light status claims link-level readiness only, so it
                # is exactly "the link is online": `connected and running`.
                # Lane-level truth (the 30s/120s tiers, IDLE) lives in status().
                market_data_ready=True,
            ),
            "connected": connected,
            "running": running,
            "session_generation": int(self._session_generation),
            "login_count": int(self._daemon_lifetime_login_count),
            "reconnect_count": int(self._reconnect_count),
            "last_login_attempt_at": self._last_login_attempt_at,
            "last_login_at": self._last_login_at,
            # The delivery-evidence record is what knows when a callback last delivered.
            "last_callback_at": evidence.last_delivery_at(),
            "last_error": self._last_error,
            # 設定 → 券商帳號 → 永豐行情連線「目前使用」: each open connection and the streams it holds, of the setting
            # (settings_broker_connections.js); 系統拓樸 reads the subscription count below.
            "connections": self._connections_status(),
            "active_subscription_count": len(self._active_subscription_keys),
            "subscription_limit": self._total_stream_limit(),
        }

    def _set_error(self, exc: Exception) -> None:
        safe_error = self.credential_service.redact_text(exc)
        self._last_error = safe_error
        logger.error(f"[SHIOAJI] {safe_error}")
