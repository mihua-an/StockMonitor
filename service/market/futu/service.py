from __future__ import annotations

import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from service.market.futu.reference import FutuReferencePublisher
from service.market.futu.callback import FutuThinCallbackAdapter
from service.market.futu.subscriptions import FutuSubscriptionManager
from service.market.futu.store import FutuControlStore
from service.market.futu.product_catalog import FutuProductCatalog
from service.market.futu.security_master import FutuSecurityMasterLifecycle
from config.market_holidays import us_calendar_path
from config.network_settings import endpoint
from service.market.futu.trading_calendar import FutuTradingCalendar
from service.market.futu.opend_lifecycle import FutuOpenDLifecycle, OpenDConnectionState
from service.market.shared.generation_seed import advance_generation, reserve_generation
from service.market.futu.session_lifecycle import FutuSessionLifecycleCoordinator
from service.market.storage.market_storage_layout import process_market_layout
from service.market.shared.provider import ProviderMarketBackend
from service.market.shared.provider_contract import FUTU_CAPABILITIES, FUTU_LANE_KINDS
from service.market.shared.provider_contract import (
    lane_stale_after_seconds,
    provider_lane_freshness,
    provider_readiness,
)
from service.market.shared.rust_live import RustDaemonEventSink, RustEventSink
from service.market.lifecycle.session import futu_session_spec, resolve_session
import logging
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)

# A watch code in its session that delivered nothing on any watchlist lane for this long is reported as stale
# (never resubscribed). Thin names are often quiet for minutes; the threshold keeps them out.
WATCH_SILENT_SECONDS = 600.0
_LANE_BY_KIND = {"quote": "QUOTE", "minute_bar": "RT_DATA", "trade": "TICKER", "orderbook": "ORDER_BOOK"}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _seed_path():
    return process_market_layout().futu_root / "cache" / "context_generation_seed.txt"


def _load_and_advance_persisted_generation_seed() -> int:
    """This process's first OpenD context generation (service/market/shared/generation_seed.py); OpenD may never
    connect, and control events still need a new incarnation."""
    return reserve_generation(_seed_path())


def _advance_generation_seed(value: int) -> int:
    return advance_generation(_seed_path(), value)



class FutuMarketService:
    """Futu source daemon service: OpenD connection, subscriptions and event forwarding.

    Provider callbacks are decoded by ``FutuThinCallbackAdapter`` and forwarded
    to Market Runtime through ``event_sink``. This service keeps no
    current-market state and writes no market rows: its only local persistence
    is the control store (watchlist + session lifecycle) and the security-master
    reference file. Market Runtime owns live state and its WAL/checkpoint.
    """

    source = "futu"

    def __init__(self, db_path: Path | None = None, *, event_sink: RustEventSink | None = None) -> None:
        layout = process_market_layout()
        self.db_path = Path(db_path or os.environ.get("FUTU_MARKET_DB", str(layout.futu_canonical_root / "futu_market.db")))
        self.security_master_path = Path(os.environ.get("FUTU_SECURITY_MASTER_FILE") or layout.futu_security_master)
        # OpenD address: the same effective network setting Health probes (Settings can move its port).
        self.host, self.port = endpoint("external_futu_opend")
        # Push callbacks are the live authority. This interval is only the worker
        # synchronization cadence (subscription reconcile); it never polls data.
        self.poll_seconds = max(0.05, float(os.environ.get("MOOMOO_POLL_SECONDS", "0.20") or 0.20))
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        # The plan's instruments this provider refused (no capability), with the reason.
        self._plan_refused: dict[tuple[str, str], str] = {}
        self.subscription_manager = FutuSubscriptionManager(
            capabilities=FUTU_CAPABILITIES,
            minimum_subscription_seconds=60.0,
            unsubscribe_retry_seconds=5.0,
        )
        self._lane_last_event_monotonic: dict[tuple[str, str], float] = {}
        self._lane_last_event_at: dict[tuple[str, str], str] = {}
        self._lane_callback_count: dict[tuple[str, str], int] = {}
        # Per-operation outcome of the OpenD cycle (security_master / session_lifecycle / subscription_sync): a failed
        # step is reported here, the context is kept.
        self.operation_state: dict[str, dict[str, Any]] = {}
        self._last_callback_at = ""
        self.event_sink = event_sink or RustDaemonEventSink()
        # The OpenD connection the lifecycle runs (opend_lifecycle.py), reported here.
        self._opend = OpenDConnectionState(context_generation=_load_and_advance_persisted_generation_seed())
        self.thin_callback = FutuThinCallbackAdapter(
            self.event_sink,
            generation=lambda: self._opend.context_generation,
            observe=self._observe_callback,
        )
        # 昨收 outside the US regular session, when Futu pushes no quote rows (reference.py).
        self.reference = FutuReferencePublisher(self.thin_callback.publish_reference)
        self.provider_backend = ProviderMarketBackend(
            provider="futu",
            thin_callback=self.thin_callback,
            subscription_manager=self.subscription_manager,
            capabilities=FUTU_CAPABILITIES,
        )
        register_adapter = getattr(self.event_sink, "register_adapter", None)
        if callable(register_adapter):
            # OpenD's quota counts subscriptions by type (每檔每種類型各 1 個) and is OpenD's to say: the adapter is
            # registered with Market Runtime once query_subscription has answered (observe_subscription_quota), in
            # OpenD's unit, and not before -- no capacity is assumed for it.
            register_adapter(
                source="futu",
                max_subscriptions=None,
                replace_subscriptions=lambda items, _generation: self.apply_demand_plan(items),
                report_subscriptions=self.plan_report,
            )
        self.control_store = FutuControlStore(self.db_path)
        self._last_watchlist_rejected_codes: list[str] = []
        self.product_catalog = FutuProductCatalog(
            self.control_store, security_master_path=self.security_master_path, owner=self)
        self.security_master = FutuSecurityMasterLifecycle(
            path=self.security_master_path,
            lock=self._lock,
            catalog=self.product_catalog,
            sdk_provider=lambda: self._opend.sdk,
            call=self._call,
            worker_alive=lambda: bool(self._thread and self._thread.is_alive()),
            wake=self._wake.set,
        )
        self.trading_calendar = FutuTradingCalendar(self._call, lambda: self._opend.sdk, path=us_calendar_path())
        self.opend_lifecycle = FutuOpenDLifecycle(self, state=self._opend, lock=self._lock, stop=self._stop, wake=self._wake)
        self.advance_context_generation = _advance_generation_seed
        self.control_store.initialize_schema()
        self.session_lifecycle = FutuSessionLifecycleCoordinator(self.control_store, event_sink=self.event_sink)
        self.security_master.load()

    def _observe_callback(self, code: str, kind: str) -> None:
        """An event admitted for ``code``: the lane evidence for readiness/Health records which lanes have called back,
        when. (The session lifecycle learns of each session from Market Runtime's partition records.)"""
        lane = _LANE_BY_KIND.get(str(kind))
        if not lane:
            return
        key = (str(code).upper(), lane)
        now_text = _utc_now()
        with self._lock:
            self._lane_last_event_monotonic[key] = time.monotonic()
            self._lane_last_event_at[key] = now_text
            self._lane_callback_count[key] = self._lane_callback_count.get(key, 0) + 1
            self._last_callback_at = now_text

    def reset_lane_activity(self) -> None:
        """A new (or no) quote context: no lane has called back on it yet."""
        with self._lock:
            self._lane_last_event_monotonic.clear()
            self._lane_last_event_at.clear()
            self._lane_callback_count.clear()

    def start(self) -> None:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop.clear()
            start_sink = getattr(self.event_sink, "start", None)
            if callable(start_sink):
                start_sink()
            self._thread = threading.Thread(target=self._run, name="MoomooOpenDQuotes", daemon=True)
            self._thread.start()

    def stop(self, timeout: float = 5.0) -> dict[str, Any]:
        self.event_sink.stop_admission()
        self._stop.set()
        self._wake.set()
        # Freeze OpenD callbacks first so no new provider events arrive while
        # the main worker stops.
        self._close_context()
        thread = self._thread
        if thread and thread.is_alive():
            thread.join(timeout=max(0.0, timeout))
        close_sink = getattr(self.event_sink, "close", None)
        ingress_receipt = {"ok": True}
        if callable(close_sink):
            ingress_receipt = close_sink(timeout=min(1.5, max(0.0, timeout))) or {"ok": True}
        return {"ok": not bool(thread and thread.is_alive()) and ingress_receipt.get("ok", False),
                "rust_ingress": ingress_receipt, "status": self.status()}

    def _close_context(self) -> None:
        self.opend_lifecycle.close_context()

    def _run(self) -> None:
        self.opend_lifecycle.run()

    def security_rows_snapshot(self) -> list[dict[str, Any]]:
        return self.security_master.rows_snapshot()

    def ensure_security_master_current(self, timeout: float = 30.0) -> dict[str, Any]:
        return self.security_master.ensure_current(timeout)

    def refresh_security_master(self, timeout: float = 30.0) -> dict[str, Any]:
        return self.security_master.refresh(timeout)

    def search_security_master(self, query: str, limit: int = 50) -> list[dict[str, Any]]:
        return self.product_catalog.search_security_master(query, limit)

    def _call(self, context: Any, method: str, *args: Any, **kwargs: Any) -> Any:
        return self.opend_lifecycle.call(context, method, *args, **kwargs)

    @staticmethod
    def _canonical_futu_code(code: str) -> str:
        raw = str(code or "").strip().upper()
        normalized = raw if "." in raw else (f"US.{raw}" if raw else "")
        if normalized and not (normalized.startswith("US.") or normalized.startswith("CC.")):
            raise ValueError("Futu 商品代碼必須使用 US. 或 CC. 前綴")
        return normalized

    def pollable_watch_codes(self) -> tuple[list[str], list[str]]:
        watch_codes = [str(row.get("code") or "").upper() for row in self.watchlist()]
        known = self.security_master.known_codes_view()
        # During the very first bootstrap the security master may not exist yet; in
        # that narrow case preserve the old behavior. Once a master is available,
        # an unverified symbol must never poison the batch subscription for
        # every valid US watch item.
        if not known:
            return [code for code in watch_codes if code], []
        pollable = [code for code in watch_codes if code in known]
        unknown = [code for code in watch_codes if code and code not in known]
        return pollable, unknown


    def _silent_watch_codes(self, watch_codes: list[str], now_monotonic: float) -> tuple[list[str], list[str]]:
        """(watch codes in their session, "CODE:LANE" of each subscribed lane silent for WATCH_SILENT_SECONDS). Caller
        holds the lock. Diagnostics only: a quiet name is usually just quiet, so silence never decides readiness
        Each lane is judged on its own -- the newest mark across a code's lanes would hide one callback
        family that stopped while another kept delivering.
        """
        in_session: list[str] = []
        silent: list[str] = []
        for code in watch_codes:
            try:
                if not resolve_session(futu_session_spec(code)).active:
                    continue
            except Exception as exc:
                record_failure(_failure_log, "resolving the Futu session for a subscribed code", exc)
                continue
            in_session.append(code)
            for lane in self.subscription_manager.subscription_plan(code).watchlist_lanes:
                subscribed = self.subscription_manager.subscribed_since((code, lane))
                if subscribed is None:
                    continue          # never subscribed: not judged here
                # Silent since the newer of: this lane's last event, its (re)subscription.
                delivered = self._lane_last_event_monotonic.get((code, lane))
                newest = max(mark for mark in (subscribed, delivered) if mark is not None)
                if now_monotonic - newest > WATCH_SILENT_SECONDS:
                    silent.append(f"{code}:{lane}")
        return in_session, silent

    def read_status(self) -> dict[str, Any]:
        """Small provider status/readiness contract (control plane, not market data)."""
        subscription = self.subscription_manager.readiness_snapshot()
        sink_stats = self._sink_stats()
        with self._lock:
            now_monotonic = time.monotonic()
            desired_pairs = set(self.subscription_manager.desired_pairs())
            confirmed_pairs = set(subscription.get("confirmed_pairs") or ())
            planned = self.subscription_manager.planned()
            # Every planned lane is judged, as for Shioaji: the provider keeps no focus of its own (Market Runtime's plan
            # is the one demand authority; the product the user opened is the instrument planned with its order book).
            lane_freshness = []
            active_codes: set[str] = set()
            for (_market, code), lanes in sorted(planned.items(), key=lambda item: item[0][1]):
                plan = self.subscription_manager.subscription_plan(code)
                try:
                    code_active = bool(resolve_session(futu_session_spec(code)).active)
                except Exception as exc:
                    record_failure(_failure_log, "resolving the Futu session for a planned code", exc)
                    code_active = False
                for lane in lanes:
                    key = (code, lane)
                    last_monotonic = self._lane_last_event_monotonic.get(key)
                    age_seconds = (now_monotonic - last_monotonic) if last_monotonic else None
                    # One tiering rule for both providers: ORDER_BOOK is the high-frequency lane (the only lane outside
                    # watchlist_lanes), QUOTE/RT_DATA/TICKER are ordinary.
                    threshold = lane_stale_after_seconds(plan, lane)
                    # A delivering lane proves its own session is active; the calendar alone would call a live lane
                    # IDLE whenever the session spec disagrees with what is actually arriving.
                    delivering = age_seconds is not None and age_seconds <= threshold
                    if code_active or delivering:
                        active_codes.add(code)
                    lane_status = provider_lane_freshness(
                        provider="futu",
                        code=code,
                        lane=lane,
                        desired=key in desired_pairs,
                        confirmed=key in confirmed_pairs,
                        last_event_at=self._lane_last_event_at.get(key),
                        age_seconds=age_seconds,
                        expected_active=code_active or delivering,
                        stale_after_seconds=threshold,
                    )
                    lane_status["stale_after_seconds"] = threshold
                    lane_status["callback_count"] = int(self._lane_callback_count.get(key, 0))
                    lane_freshness.append(lane_status)
            watch_codes = [str(code or "").upper() for code in subscription.get("planned_codes", []) if str(code or "").strip()]
            # Readiness is what OpenD confirmed: every planned subscription acknowledged. Whether a name traded lately
            # proves nothing about the link -- a quiet name must not read as "not ready" until its first callback.
            watch_ready = desired_pairs <= confirmed_pairs
            in_session, silent = self._silent_watch_codes(watch_codes, now_monotonic)
            worker_alive = bool(self._thread and self._thread.is_alive())
            # A fault of the link itself makes the provider STALE; silent lanes are reported below, never a verdict.
            stale_reason = None
            if int(sink_stats.get("dropped") or 0) and int(sink_stats.get("queue_depth") or 0) >= 1024:
                stale_reason = "EVENT_SINK_SATURATED"
            elif self.thin_callback.callback_backlog() is not None:
                # The SDK's callback queue stays deep (callback_queue.py): every view shows the past.
                stale_reason = "CALLBACK_BACKLOG"
            readiness = provider_readiness(
                provider="futu",
                connected=self._opend.connected,
                worker_alive=worker_alive,
                market_data_ready=watch_ready,
                market_closed=bool(planned) and not active_codes,
                stale_reason=stale_reason,
            )
            return {
                "provider": "futu",
                "opend_reachable": self._opend.opend_reachable,
                "readiness": readiness,
                "context_generation": int(self._opend.context_generation),
                "worker_alive": worker_alive,
                "last_poll_at": self._opend.last_poll_at or None,
                "last_callback_at": self._last_callback_at or None,
                "lane_freshness": lane_freshness,
                # Subscribed lanes ("CODE:LANE") of in-session watch codes that delivered nothing for
                # WATCH_SILENT_SECONDS: reported, never "renewed" by forgetting their subscription,
                # never a readiness verdict -- a quiet name is usually just quiet.
                "stale_watch_codes": sorted({entry.split(":", 1)[0] for entry in silent}),
                "stale_watch_lanes": silent,
                "operations": {name: dict(state) for name, state in self.operation_state.items()},
                "callback_queue_depth": int(sink_stats.get("queue_depth") or 0),
                "callback_queue_overflow_count": int(sink_stats.get("dropped") or 0),
                "last_error": self._opend.last_error or None,
            }

    def _sink_stats(self) -> dict[str, Any]:
        stats = getattr(self.event_sink, "stats", None)
        try:
            return dict(stats()) if callable(stats) else {}
        except Exception as exc:
            record_failure(_failure_log, "reading Futu event sink stats", exc)
            return {}

    def status(self) -> dict[str, Any]:
        subscription = self.subscription_manager.snapshot()
        compact = self.read_status()
        sink_stats = self._sink_stats()
        with self._lock:
            return {
                "connected": self._opend.connected,
                "sdk_loaded": self._opend.sdk is not None,
                "host": self.host,
                "port": self.port,
                "provider": "futu",
                "readiness": compact["readiness"],
                "last_connected_at": self._opend.last_connected_at or None,
                "last_poll_at": self._opend.last_poll_at or None,
                "last_error": self._opend.last_error or None,
                "worker_alive": bool(compact["worker_alive"]),
                "opend_reachable": compact.get("opend_reachable"),
                "acquisition_mode": "push",
                "context_generation": self._opend.context_generation,
                "poll_count": self._opend.poll_count,
                "last_cycle_ms": self._opend.last_cycle_ms,
                "callback_queue_depth": int(sink_stats.get("queue_depth") or 0),
                "callback_queue_overflow_count": int(sink_stats.get("dropped") or 0),
                "event_sink": sink_stats,
                "last_push_at": self._last_callback_at or None,
                "subscription_manager": subscription,
                # OpenD's quota in its unit (每檔每種類型各 1 個) beside what this connection holds of it.
                "subscription_quota": self.subscription_manager.quota_snapshot(),
                "lane_freshness": compact.get("lane_freshness", []),
                "thin_callback": self.thin_callback.snapshot(),
                "reference": self.reference.snapshot_status(),
                "provider_backend": self.provider_backend.snapshot(),
                "watchlist_ticker_stream": True,
                "ignored_unknown_codes": list(self._opend.ignored_unknown_codes),
                "control_store": str(self.db_path),
                "session_lifecycle": self.session_lifecycle.status(),
                "security_master": {
                    "file": str(self.security_master_path),
                    **self.security_master.status(),
                },
            }

    def watchlist(self) -> list[dict[str, Any]]:
        return self.product_catalog.watchlist()

    def replace_watchlist(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        requested: list[tuple[str, str, int, str]] = []
        invalid: list[str] = []
        seen: set[str] = set()
        for index, item in enumerate(items):
            raw = str(item.get("code") or "").strip()
            try:
                code = self._canonical_futu_code(raw)
            except ValueError:  # not an error: a malformed code is reported as invalid below
                code = ""
            if not code:
                # A malformed code is a rejection like an unknown one, reported -- never silently dropped.
                invalid.append(raw or "<empty>")
                continue
            if code in seen:
                continue
            seen.add(code)
            requested.append((code, str(item.get("name") or "").strip(), index, _utc_now()))
        if items and not requested:
            # A non-empty request with nothing valid in it is refused whole: it never clears the watchlist (only an
            # empty request does).
            self._record_watchlist_rejections(invalid)
            return self.watchlist()

        self.control_store.replace_watchlist(
            requested,
            known_codes_snapshot=self._watchlist_security_codes,
            report_rejected=lambda rejected: self._record_watchlist_rejections(invalid + list(rejected)),
        )
        self._wake.set()
        return self.watchlist()

    def _watchlist_security_codes(self) -> set[str]:
        return self.security_master.known_codes()

    def _record_watchlist_rejections(self, rejected: list[str]) -> None:
        with self._lock:
            self._last_watchlist_rejected_codes = rejected

    def last_watchlist_rejected_codes(self) -> list[str]:
        with self._lock:
            return list(self._last_watchlist_rejected_codes)

    def apply_demand_plan(self, items: list[dict[str, Any]]) -> dict[str, Any]:
        """Market Runtime's plan (the Shioaji twin is ShioajiBrokerService.apply_demand_plan): the desired pairs become
        exactly its instruments; OpenD is subscribed on the next sync, and the report says what is subscribed NOW --
        a received plan is never reported as subscribed. The sync reports again when it moves."""
        self._plan_refused = self.subscription_manager.replace_plan(items)
        self._wake.set()
        return self.plan_report()

    def stream_budget(self) -> dict[str, Any] | None:
        """The capacity Market Runtime plans within, in OpenD's unit: the subscriptions this connection may hold, and
        what each kind of an instrument of each market takes (報價 two -- QUOTE and RT_DATA --, 明細 TICKER one, 五檔
        ORDER_BOOK one). None until OpenD's quota is read."""
        streams = self.subscription_manager.quota_streams()
        if streams is None:
            return None
        return {"streams": streams, "kinds_by_market": FUTU_CAPABILITIES.kinds_by_market(FUTU_LANE_KINDS)}

    def observe_subscription_quota(self, data: Any) -> None:
        """OpenD's query_subscription answer: a capacity that changed is told to Market Runtime, which plans again."""
        if not self.subscription_manager.observe_quota(data):
            return
        budget = self.stream_budget()
        if budget is None or budget["streams"] < 1:
            # Another connection holds the whole quota: nothing fits, and Market Runtime keeps the last capacity it
            # was told until OpenD has room again (each subscribe it plans waits for the room).
            _failure_log.error("OpenD quota leaves no subscription for this connection: %s",
                               self.subscription_manager.quota_snapshot())
            return
        _failure_log.info("[FUTU] OpenD subscription quota: %s", {k: v for k, v in self.subscription_manager.quota_snapshot().items()
                                                                  if k in ("streams", "total", "own_used", "used_by_others")})
        set_limit = getattr(self.event_sink, "set_max_subscriptions", None)
        if callable(set_limit):
            set_limit(max(1, budget["streams"] // FUTU_CAPABILITIES.most_lanes()), stream_budget=budget)

    def subscription_quota(self) -> dict[str, Any]:
        """設定 → 訂閱管理's Futu quota: OpenD's capacity, what is held, 退訂中 and waiting; read again from OpenD on the
        next cycle, so a raised quota (the user asked Futu for more) is seen without a reconnect."""
        self.subscription_manager.request_quota_read()
        self._wake.set()
        return {"ok": True, "connected": bool(self._opend.connected), **self.subscription_manager.quota_snapshot(),
                "kinds_by_market": FUTU_CAPABILITIES.kinds_by_market(FUTU_LANE_KINDS)}

    def notify_subscriptions_changed(self) -> None:
        notify = getattr(self.event_sink, "subscriptions_changed", None)
        if callable(notify):
            notify()

    def plan_report(self) -> dict[str, Any]:
        planned = self.subscription_manager.planned()
        confirmed, errors, waiting = self.subscription_manager.plan_snapshot()
        connected = bool(self._opend.connected)
        subscribed, failed = [], []
        for (market, code), reason in sorted(self._plan_refused.items()):
            failed.append({"market": market, "code": code, "reason": reason})
        for (market, code), lanes in sorted(planned.items()):
            if lanes and all((code, lane) in confirmed for lane in lanes):
                subscribed.append({"market": market, "code": code})
                continue
            # OPEND_QUOTA_FULL: OpenD holds no room for it yet (pairs the plan dropped wait out their minimum).
            reason = next((errors[(code, lane)] for lane in lanes if (code, lane) in errors), "") or (
                "SOURCE_NOT_CONNECTED" if not connected
                else "OPEND_QUOTA_FULL" if any((code, lane) in waiting for lane in lanes) else "SUBSCRIBE_PENDING")
            failed.append({"market": market, "code": code, "reason": reason[:120]})
        draining = [{"market": market, "code": code} for market, code in self.subscription_manager.draining()]
        return {"subscribed": subscribed, "failed": failed, "draining": draining}
