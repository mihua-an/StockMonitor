from __future__ import annotations

import json
import os
import queue
import threading
import time
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo

from config.market_holidays import tw_day_session_opened
from service.market.lifecycle.resolver import MarketSessionResolver, MarketSessionResolution
from service.market.lifecycle.session import SessionIdentity, SessionLifecycleRegistry, session_order_for_name
from service.market.shared.dataflow_health import dataflow_health_ledger
from service.market.lifecycle.policy import SessionAction, SessionPolicyEngine, stk_after_hours_capture, stk_preopen_capture
from service.market.shared.materialization_ledger import (
    MaterializationKey, MaterializationLedger, drain_intents, settle_intent,
    PENDING, RUNNING, SUCCEEDED, FAILED_RETRYABLE, FAILED_TERMINAL, NO_INPUT,
)
from service.market.shared.closed_session_retention import prune_closed_sessions
from service.market.shared.materialization_jobs import publish_settled_session
from service.market.shared.partition_evidence import PartitionEvidence
from service.market.shared.wal_retention import WalRetentionPolicy
from service.market.shared.session_identity_contract import (
    session_windows, market_zone, partition_end, wal_sessions,
)
import logging
from service.platform.failure_record import record_failure
from service.platform.atomic_files import write_json_atomic


_failure_log = logging.getLogger(__name__)

TAIPEI = ZoneInfo("Asia/Taipei")
# manifest statuses that can no longer change: never re-polled (a terminal failure must not slow every reconcile)
_SETTLED_STATUSES = {"materialized", "failed", "no_input", "no_new_partitions"}
# Markets whose evidence carries a market's session clock. IDX rides the STK session, which is
# why _finalize_prepared/_submit_sealed_materialization already treat the two as one unit.
_CLOCK_MARKETS = {"STK": ("STK", "IDX"), "FUT": ("FUT",)}
# How long the stream may stop producing market time before the wall clock takes over again.
DEFAULT_MARKET_CLOCK_STALE_SECONDS = 20.0


# Attempts of one session finalization before it is stated FAILED (each retry backs off 1, 2, 4 ... 8 s).
FINALIZATION_MAX_ATTEMPTS = 4


def _regular_stock_lanes(streams: dict[str, Any], quote_type: str, code: str = "") -> list[dict[str, Any]]:
    """The regular-session (not odd-lot) stock streams of one lane in the broker status' subscription_streams."""
    return [dict(row) for row in streams.values()
            if isinstance(row, dict) and row.get("security_type") == "STK" and row.get("quote_type") == quote_type
            and not row.get("intraday_odd") and (not code or row.get("code") == code)]


def _regular_stock_lane(streams: dict[str, Any], code: str, quote_type: str) -> dict[str, Any]:
    rows = _regular_stock_lanes(streams, quote_type, code)
    return rows[0] if rows else {}


class ObservedMarketClock:
    """The market's own session clock, taken from the events it actually produced.

    ``SessionOrchestrator`` decides ACTIVATE/SEAL from a session calendar evaluated at some
    ``now``. Every other stage of the pipeline takes its identity from the *exchange*
    timestamp on the event (Market Runtime partitions the WAL by it, and records its newest value per partition
    as ``last_ts_ns``); the
    orchestrator was the only one still reading the local wall clock instead. In live the two
    are the same clock, so this changes nothing there -- but when they disagree the orchestrator
    could seal a ``trading_date`` no event in the WAL ever belonged to. ``observe_first_market_event`` already
    reconciles on the exchange timestamp for the first callback of a generation; this is the
    same authority, applied continuously.

    A market clock is used only while it is *advancing*: if this market's newest exchange
    timestamp has not moved for ``stale_seconds`` of real time, the stream is quiet and the wall
    clock takes over again. So the worst this can do to a live session boundary is delay it by
    ``stale_seconds``; it can never hold a session open indefinitely, and it can never seal a
    market while that market's events are still arriving.
    """

    def __init__(self, *, stale_seconds: float = DEFAULT_MARKET_CLOCK_STALE_SECONDS,
                 monotonic: Callable[[], float] = time.monotonic) -> None:
        self.stale_seconds = max(0.0, float(stale_seconds))
        self._monotonic = monotonic
        self._state: dict[str, tuple[int, float]] = {}

    def observe(self, market: str, exchange_ts_ns: int) -> None:
        """Record this market's newest exchange timestamp. Only an INCREASE counts as advancing."""
        market_u = str(market or "").upper()
        ts = int(exchange_ts_ns or 0)
        if ts <= 0:
            return
        previous = self._state.get(market_u)
        if previous is None:
            # First sight is only a baseline: a value is not market time being produced now until a later
            # one is seen. The broker's snapshot on subscribing carries the last exchange time it has --
            # at night the previous close -- and taken as advancing it held the DAY session "live" with no
            # data for the staleness window (10-23 01:11: 37 s of 行情停滯 after a restart).
            self._state[market_u] = (ts, float("-inf"))
        elif ts > previous[0]:
            self._state[market_u] = (ts, self._monotonic())

    def now(self, market: str) -> datetime | None:
        """This market's session clock, or None when the stream is not currently advancing it."""
        state = self._state.get(str(market or "").upper())
        if state is None:
            return None
        ts_ns, seen_at = state
        if self._monotonic() - seen_at > self.stale_seconds:
            return None
        return datetime.fromtimestamp(ts_ns / 1_000_000_000, tz=TAIPEI)

    def last(self, market: str) -> datetime | None:
        """The newest market time this stream ever reached, advancing or not (None if never seen)."""
        state = self._state.get(str(market or "").upper())
        return None if state is None else datetime.fromtimestamp(state[0] / 1_000_000_000, tz=TAIPEI)

    def snapshot(self) -> dict[str, Any]:
        return {
            market: {
                "exchange_time": datetime.fromtimestamp(ts / 1_000_000_000, tz=TAIPEI).isoformat(timespec="milliseconds"),
                "advancing": (self._monotonic() - seen) <= self.stale_seconds,
            }
            for market, (ts, seen) in self._state.items()
        }


@dataclass
class ActiveMarketSession:
    market: str
    trading_date: str
    session: str
    actual_contract: str = ""
    generation: int = 0
    state: str = "CLOSED"
    stream_id: str = ""
    activated_at: str | None = None

    @property
    def identity(self) -> SessionIdentity:
        return SessionIdentity("shioaji", self.market, self.trading_date, self.session, session_order=session_order_for_name(self.session), variant=self.actual_contract if self.market.upper() == "FUT" else "")

    def as_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["session_identity"] = self.identity.as_dict()
        return payload


@dataclass(frozen=True)
class _FinalizationEvidence:
    evidence: dict[str, Any]
    in_flight: int          # events (and loss reports) before the session's end Market Runtime has not answered yet


@dataclass(frozen=True)
class _GateOutcome:
    ran: bool
    result: dict[str, Any]
    materialized_views: dict[str, Any]


@dataclass(frozen=True)
class _AuthorityTransition:
    authority_committed: bool = False
    generation_committed: bool = False
    identity: dict[str, Any] = field(default_factory=dict)


class SessionOrchestrator:
    """Owns *market-session* generation independently from broker login state.

    It never logs Shioaji out, never clears durable history, and never tears down
    permanent broker subscriptions for a normal DAY/CLOSED/NIGHT boundary. A
    boundary finalizes canonical/durable ownership only; broker subscription reset
    is reserved for shutdown, reconnect, or explicit watchdog recovery.
    """

    def __init__(
        self,
        *,
        app_provider: Callable[[], Any],
        now_provider: Callable[[], datetime] | None = None,
        poll_seconds: float = 1.0,
        finalization_grace_seconds: float = 2.0,
        session_policy: SessionPolicyEngine | None = None,
        manifest_dir: str | Path,
        materialization_jobs_root: str | Path | None = None,
        market_clock_stale_seconds: float = DEFAULT_MARKET_CLOCK_STALE_SECONDS,
        wal_retention: bool = False,
        fill_gaps: bool = False,
    ) -> None:
        self.app_provider = app_provider
        self.now_provider = now_provider or (lambda: datetime.now(TAIPEI))
        self.poll_seconds = max(0.2, float(poll_seconds))
        self.finalization_grace_seconds = max(0.0, float(finalization_grace_seconds))
        self.session_policy = session_policy or SessionPolicyEngine()
        self.market_clock = ObservedMarketClock(stale_seconds=market_clock_stale_seconds)
        self.manifest_dir = Path(manifest_dir)
        # None means "the real project output/materialization_jobs/" (see
        # materialization_jobs.default_jobs_root()) -- tests must pass their
        # own, the same injectable-directory
        # pattern manifest_dir above already uses.
        self._materialization_jobs_root = Path(materialization_jobs_root) if materialization_jobs_root is not None else None
        self._intent_dir = self.manifest_dir / "pending"
        # The ONLY object that may create Rust Materializer jobs for Shioaji.
        self._ledger = MaterializationLedger("shioaji", jobs_root=self._materialization_jobs_root)
        self._pruned_for: date | None = None
        # The WAL's retention cutoff (B14): decided here from every source's ledger and evidence, executed by A.
        # Opt-in: only the daemon's own orchestrator may ask Health to remove WAL segments.
        self._wal_retention = WalRetentionPolicy(jobs_root=self._materialization_jobs_root) if wal_retention else None
        # A materialized session's gaps filled from the broker's history (history_fill.py), one session at a time on
        # its own thread. Opt-in like the WAL retention: only the daemon's own orchestrator holds the broker login.
        self._fill_gaps = fill_gaps
        self._fill_thread: threading.Thread | None = None
        self._query_cache_pruned_for: set[str] = set()
        # What the last look for newly listed codes found nothing in: see _sessions_with_newly_listed_codes.
        self._newly_listed_checked: tuple[Any, ...] | None = None
        # Manifests found settled, with the modification time they were read at: a settled one is not read again.
        self._settled_manifests: dict[Path, int] = {}
        self._lock = threading.RLock()
        # Poll reconciliation and first-callback reconciliation can arrive on
        # different threads. Session rotation is a transaction, so only one may
        # inspect/replace `_active` at a time.
        self._reconcile_lock = threading.Lock()
        self._running = threading.Event()
        self._thread: threading.Thread | None = None
        self._generation = 0
        self._market_generation: dict[str, int] = {"STK": 0, "FUT": 0}
        self._active: dict[str, ActiveMarketSession] = {}
        self._last_resolution: dict[str, dict[str, Any]] = {}
        self._finalizations: list[dict[str, Any]] = []
        self._last_error: str | None = None
        self._transition_count = 0
        self._finalization_queue: queue.Queue[Any] = queue.Queue(maxsize=32)
        self._finalization_stop = object()
        self._finalization_thread: threading.Thread | None = None
        self._pending_finalizations: dict[str, dict[str, Any]] = {}
        # job_id -> (prepared job, monotonic time it is due): finalizations waiting for the queue -- a full queue or a
        # retry backing off. Each reconcile pass schedules the due ones; nothing is dropped.
        self._deferred_finalizations: dict[str, tuple[dict[str, Any], float]] = {}
        self._last_policy_decisions: dict[str, dict[str, Any]] = {}
        # Provider-neutral lifecycle authority.  Shioaji's existing durable
        # finalizer remains the implementation of SEALING, while identity /
        # generation state is now shared with Futu.
        self._session_lifecycle = SessionLifecycleRegistry()
        # Set once the service graph is bound (bind_service). Every session decision -- recovering the intents an
        # earlier process left, activating, sealing -- writes through that graph (the session manifest, the identity
        # authority, the recorder's evidence gate), so none runs before it exists.
        self._bound = threading.Event()
        self._bind_lock = threading.Lock()

    @property
    def generation(self) -> int:
        with self._lock:
            return int(self._generation)

    def generation_for(self, market: str = "") -> int:
        with self._lock:
            market_u = str(market or "").upper()
            if not market_u:
                return int(self._generation)
            return int(self._market_generation.get(market_u, 0))

    def start(self) -> None:
        if self._running.is_set():
            return
        self._running.set()
        self._finalization_thread = threading.Thread(target=self._finalization_run, name="SessionFinalizationWorker", daemon=True)
        self._finalization_thread.start()
        # The daemon starts this owner while its runtime is still building the service graph on another thread; the
        # runtime binds it when built (on_service_built). A graph that already exists is bound here.
        app = self._app()
        if app is not None:
            self.bind_service(app)
        self._thread = threading.Thread(target=self._run, name="MarketSessionRollover", daemon=True)
        self._thread.start()

    def bind_service(self, app: Any) -> None:
        """Called by the runtime with its built service graph before the service starts (broker login, the first
        callbacks): the market-session generation is installed now, and the first-event listener with it, so no
        startup event can carry the broker-login generation instead. The session intents an earlier process left are
        recovered here, first: a session that closed while the process was down is finalized with the graph it
        needs, not attempted without it and retried."""
        with self._bind_lock:
            if self._bound.is_set():
                return
            app.broker_service.set_market_session_event_listener(self.observe_first_market_event)
            try:
                self._recover_session_intents()
                self.reconcile(self.now_provider())
            except Exception as exc:
                # The session owner could not establish the session: the service must not start (broker login, first
                # callbacks) without it (keeping the error and starting the runtime anyway is not allowed). The runtime turns this
                # into start_failed, with the error.
                with self._lock:
                    self._last_error = f"startup reconcile: {exc}"
                raise
            self._bound.set()

    def stop(self, timeout: float = 5.0) -> dict[str, Any]:
        self._running.clear()
        app = self._app()
        if app is not None:
            try:
                app.broker_service.set_market_session_event_listener(None)
            except Exception as exc:
                record_failure(_failure_log, "detaching the market session event listener", exc)
        thread = self._thread
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=max(0.1, float(timeout)))
        try:
            self._finalization_queue.put_nowait(self._finalization_stop)
        except queue.Full:  # not an error: a full finalization queue already wakes the finalizer, which then sees the stop flag
            pass
        finalizer = self._finalization_thread
        if finalizer is not None and finalizer.is_alive() and finalizer is not threading.current_thread():
            finalizer.join(timeout=max(0.1, float(timeout)))
        return self.status()

    def _run(self) -> None:
        while self._running.is_set():
            if not self._bound.wait(self.poll_seconds):
                continue
            try:
                self._schedule_deferred_finalizations()
                self.reconcile()
            except Exception as exc:
                record_failure(_failure_log, "running the session rollover poll", exc)
                with self._lock:
                    self._last_error = str(exc)
            time.sleep(self.poll_seconds)

    def _app(self) -> Any | None:
        try:
            return self.app_provider()
        except Exception as exc:
            record_failure(_failure_log, "getting the broker app for session rollover", exc)
            return None

    def _resolver(self) -> MarketSessionResolver:
        app = self._app()
        repository = getattr(app, "historical_repository", None) if app is not None else None
        return MarketSessionResolver(repository)

    def observe_first_market_event(self, security_type: str, exchange_timestamp: str = "") -> None:
        """Use the first broker event as a strong OPEN confirmation.

        The polling resolver remains a fallback for liveness/close detection, but
        the first Tick/BidAsk of a new generation reconciles immediately instead
        of waiting for the next one-second poll.
        """
        stamp: datetime | None = None
        text = str(exchange_timestamp or "").strip()
        if text:
            try:
                stamp = datetime.fromisoformat(text.replace("Z", "+00:00"))
                if stamp.tzinfo is None:
                    stamp = stamp.replace(tzinfo=TAIPEI)
                else:
                    stamp = stamp.astimezone(TAIPEI)
            except Exception:  # not an error: a timestamp that cannot be parsed is treated as absent
                stamp = None
        security = str(security_type or "").strip().upper()
        target_market = "FUT" if security == "FUT" else "STK" if security in {"STK", "IND", "IDX"} else ""
        if not target_market:
            return
        try:
            # An exchange timestamp belongs only to the event's own market.
            # Applying a FUT/IDX timestamp to every resolver could close a just
            # activated STK pre-open generation and finalize its live streams.
            self.reconcile(stamp or self.now_provider(), markets={target_market}, wait=False, event_driven=True)
        except Exception as exc:
            record_failure(_failure_log, "event-driven session reconcile", exc)

    def _actual_contract(self) -> str:
        app = self._app()
        if app is None:
            return ""
        try:
            status = app.broker_service.status()
            return str(((status.get("txf") or {}).get("target_code") or "")).strip().upper()
        except Exception as exc:
            record_failure(_failure_log, "reading the TXF target code from broker status", exc)
            return ""

    @staticmethod
    def _has_policy_action(policy: Any, action: SessionAction) -> bool:
        actions = getattr(policy, "actions", ())
        return action.value in {str(item) for item in (actions or ())}

    @staticmethod
    def _session_identity(resolution: MarketSessionResolution, actual_contract: str = "") -> str:
        return "|".join((
            resolution.market.upper(), resolution.trading_date, resolution.session.upper(), str(actual_contract or "").upper()
        ))

    @staticmethod
    def _stream_id(market: str, logical_code: str, trading_date: str, session: str, contract_code: str = "", source: str = "shioaji") -> str:
        """source:market:logical_code:trading_date:session[:contract_code], all normalized.

        The source is explicit so a Shioaji and a Futu stream can never share an id. Consumers only compare the
        string or pass it through; nothing parses its shape.
        """
        source = str(source or "shioaji").strip().lower()
        market = str(market or "").upper()
        logical_code = str(logical_code or "").upper()
        trading_date = str(trading_date or "")[:10]
        session = str(session or "").upper()
        contract_code = str(contract_code or "").upper()
        suffix = f":{contract_code}" if contract_code else ""
        return f"{source}:{market}:{logical_code}:{trading_date}:{session}{suffix}"

    def _subscription_lane(self, market: str, quote_type: str, logical_code: str = "") -> dict[str, Any]:
        app = self._app()
        if app is None:
            return {}
        try:
            status = app.broker_service.status()
        except Exception as exc:
            record_failure(_failure_log, "reading broker status for the session rollover", exc)
            return {}
        if market.upper() == "FUT":
            return dict(((status.get("txf") or {}).get(quote_type) or {}))
        code = str(logical_code or "").upper()
        streams = status.get("subscription_streams") or {}
        if code:
            return _regular_stock_lane(streams, code, quote_type)
        lanes = _regular_stock_lanes(streams, quote_type)
        if not lanes:
            return {}
        last_event = max([str(row.get("last_event_at") or "") for row in lanes] or [""]) or None
        return {
            "desired": any(bool(row.get("desired")) for row in lanes),
            "requested": any(bool(row.get("requested")) for row in lanes),
            "confirmed": any(bool(row.get("confirmed")) for row in lanes),
            "last_event_at": last_event,
            "last_sequence": max([int(row.get("last_sequence") or 0) for row in lanes] or [0]),
            "callback_count": sum(int(row.get("callback_count") or 0) for row in lanes),
        }

    @staticmethod
    def close_operation_id(session_key: str) -> str:
        """The one id of a session's close: stable across restarts, named by the session it closes.
        The finalization manifest, its materialization jobs and every recovery of the close carry it."""
        return f"close:{session_key}"

    def _close_record(self, mechanism: str, trigger: str, outcome: str, *, session_key: str, identity: dict[str, Any],
                      attempt: int | None = None, detail: dict[str, Any] | None = None) -> None:
        try:
            from service.platform.remediation import emitter

            emitter().emit(component="session_close", mechanism_id=mechanism, trigger_reason=trigger, outcome=outcome,
                           attempt=attempt, identity={"source": "shioaji", **identity},
                           detail={"close_operation_id": self.close_operation_id(session_key), **(detail or {})})
        except Exception as exc:
            record_failure(_failure_log, "recording a session-close remediation event", exc)

    def _write_finalization_manifest(self, payload: dict[str, Any]) -> None:
        payload.setdefault("close_operation_id", self.close_operation_id(str(payload.get("session_key") or "session")))
        safe = "".join(
            ch if ch.isalnum() or ch in "-_." else "_"
            for ch in str(payload.get("session_key") or "session")
        )
        write_json_atomic(self.manifest_dir / f"{safe}.json", payload, durable=True, indent=2)

    # -- persisted lifecycle: open -> expired -> sealed -> materialization -------------------------

    def _sealed_manifests(self) -> list[dict[str, Any]]:
        """Every sealed finalization manifest, from the one index of them: each file is parsed once and again only
        when it changes (path + mtime), so the sealed check per materialization intent costs a directory listing, not a parse of the whole history kept."""
        index: dict[Path, tuple[int, dict[str, Any] | None]] = getattr(self, "_manifest_index", None) or {}
        seen: dict[Path, tuple[int, dict[str, Any] | None]] = {}
        if self.manifest_dir.exists():
            for path in self.manifest_dir.glob("*.json"):
                try:
                    mtime = path.stat().st_mtime_ns
                except OSError:  # not an error: the manifest vanished between listing and stat; nothing to index
                    continue
                known = index.get(path)
                if known is not None and known[0] == mtime:
                    seen[path] = known
                    continue
                try:
                    payload = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, ValueError) as exc:
                    record_failure(_failure_log, "reading a session manifest", exc)
                    continue
                sealed = isinstance(payload, dict) and payload.get("lifecycle_state") == "sealed"
                seen[path] = (mtime, payload if sealed else None)
        self._manifest_index = seen
        return [payload for _mtime, payload in seen.values() if payload is not None]

    def _is_sealed(self, market: str, trading_date: str, session: str = "") -> bool:
        """True only if this orchestrator's PERSISTED lifecycle recorded the session as sealed.

        Never inferred from the date, the wall clock or the existence of a materialized
        artifact: ``expired`` (time is up) is not ``sealed`` (finalization completed).
        A FUT session partition (DAY, or a NIGHT dated by its open) is sealed once a FUT finalization completed
        at or after the partition's own end (13:45 for a DAY, 05:00 the next day for a NIGHT).
        """
        market_u, date_text = str(market).upper(), str(trading_date)[:10]
        manifests = self._sealed_manifests()
        if market_u in {"STK", "IDX"}:
            return any(m.get("market") == "STK" and str(m.get("trading_date"))[:10] == date_text for m in manifests)
        if market_u == "FUT":
            ends = [partition_end("shioaji", "FUT", date_text, s) for s in ([session] if session else wal_sessions("shioaji", "FUT"))]
            # Without a named session, the partition dated here that ends last must be covered.
            ends_at = max(ends)
            for m in manifests:
                if m.get("market") != "FUT":
                    continue
                finalized = self._parse_time(m.get("finalized_at"))
                if finalized is not None and finalized.astimezone(market_zone("FUT")) >= ends_at:
                    return True
        return False

    @staticmethod
    def _parse_time(value: Any) -> datetime | None:
        try:
            return datetime.fromisoformat(str(value)) if value else None
        except ValueError:  # not an error: time coercion: text that is not an ISO time is None by contract
            return None

    def _refresh_market_clock(self) -> None:
        """Pull each market's newest exchange timestamp from the event sink's queue, the one choke point every market
        event passes: no new callback, no broker call and no disk read.
        """
        try:
            sink = self._sink(self._app())
            for market, sources in _CLOCK_MARKETS.items():
                self.market_clock.observe(market, sink.observed_market_clock(*sources))
        except Exception as exc:
            record_failure(_failure_log, "observing the market clock", exc)
            with self._lock:
                self._last_error = f"market clock: {exc}"

    @staticmethod
    def _sink(app: Any) -> Any:
        sink = getattr(app, "live_event_sink", None) if app is not None else None
        if sink is None:
            raise RuntimeError("session evidence unavailable: the broker app has no live event sink")
        return sink

    def _evidence_ledger(self, app: Any) -> PartitionEvidence:
        """Market Runtime's partition records, read from its files and decided through the event sink's commands."""
        return self._sink(app).evidence

    def _await_sink_drain(self, app: Any, *, timeout: float) -> None:
        sink = getattr(app, "live_event_sink", None) if app is not None else None
        stats = getattr(sink, "stats", None)
        if not callable(stats):
            return
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                data = stats()
            except Exception as exc:
                record_failure(_failure_log, "reading ingest stats while waiting for the queue to drain", exc)
                return
            if not int(data.get("queue_depth") or 0) and not data.get("pending"):
                return
            time.sleep(0.05)

    def _submit_sealed_materialization(self, payload: dict[str, Any], active: ActiveMarketSession) -> list[MaterializationKey]:
        """Owner decision (session sealed): submit every WAL partition it covers, deduped by the ledger.

        STK/IDX: the session's own date. FUT: every calendar-date FULL partition that has PERSISTED
        evidence of real WAL events and whose calendar date has ended (strictly before the finalization
        date) - enumerated from the session evidence, never from fixed day arithmetic, so a long holiday
        gap cannot strand a partition. Already-submitted/materialized partitions dedupe in the ledger;
        calendar days without any WAL evidence are legitimately empty and are not submitted.
        """
        app = self._app()
        evidence = self._evidence_ledger(app)
        session_completeness = str(payload.get("completeness") or "gap_detected")
        keys: list[MaterializationKey] = []
        targets: list[tuple[str, str, str, str]] = []
        if active.market.upper() == "STK":
            # Each partition's claim is Market Runtime's own verdict when the finalization passed: a `repaired` one
            # (a restart's gap filled from the broker's history) is not complete (its book of the gap is lost).
            def claim(market: str) -> str:
                if session_completeness != "complete":
                    return session_completeness
                return str(evidence.summary("shioaji", market, active.trading_date, "DAY").get("completeness") or "gap_detected")
            targets = [("STK", active.trading_date, "DAY", claim("STK")), ("IDX", active.trading_date, "DAY", claim("IDX"))]
            # The day's 盤中零股 is never materialized: sealed with the stock session, so the WAL can let it go.
            evidence.seal("shioaji", "ODD", active.trading_date, "DAY")
        elif active.market.upper() == "FUT":
            # Every FUT session partition (DAY, or a NIGHT dated by its open) whose session is over.
            now = self.now_provider()
            for _src, market, date_text, wal in evidence.sessions("shioaji"):
                if market != "FUT" or wal not in wal_sessions("shioaji", "FUT"):
                    continue
                if now >= partition_end("shioaji", "FUT", date_text, wal):
                    completeness = str(evidence.summary("shioaji", "FUT", date_text, wal).get("completeness") or "gap_detected")
                    targets.append(("FUT", date_text, wal, completeness))
        close_operation_id = self.close_operation_id(str(payload.get("session_key") or "session"))
        for market, date_text, wal, completeness in targets:
            key = MaterializationKey.for_session("shioaji", market, date_text, session=wal)
            known = self._ledger.status(key) is not None
            # Frozen first (Market Runtime answers once written): later restarts add no gap, and what is read is final.
            evidence.seal("shioaji", market, date_text, key.session)
            # The codes a connection outage during trading left a hole in: gaps of their own partitions; those whose
            # holes were all filled from the broker's history: repaired.
            summary = evidence.summary("shioaji", market, date_text, key.session)
            self._ledger.submit(key, completeness=completeness, gap_codes=summary.get("gap_codes") or [],
                                repaired_codes=summary.get("repaired_codes") or [], close_operation_id=close_operation_id)
            if market == "FUT" and known:
                continue  # an earlier finalization already owns this partition: keep each manifest's key set bounded
            keys.append(key)
        return keys

    _STATE_TO_STATUS = {
        PENDING: "pending", RUNNING: "pending", SUCCEEDED: "materialized", NO_INPUT: "no_input",
        FAILED_RETRYABLE: "retryable", FAILED_TERMINAL: "failed",
    }

    def process_materialization_intents(self) -> int:
        """Session-owner decision on intents proposed by readers/routes/scripts (they never create jobs).

        An intent is honoured only when the persisted lifecycle says the covering session is sealed;
        otherwise it waits (TTL-bounded). The key comes from the same builder the proposer used.
        """
        handled = 0
        for intent in drain_intents("shioaji", jobs_root=self._materialization_jobs_root):
            market = str(intent.get("market") or "").upper()
            date_text = str(intent.get("trading_date") or "")[:10]
            key_id = str(intent.get("key_id") or "")
            if market not in {"STK", "IDX", "FUT"}:
                settle_intent("shioaji", key_id, jobs_root=self._materialization_jobs_root)
                continue
            if not self._is_sealed(market, date_text, str(intent.get("session") or "")):
                continue  # not sealed by persisted lifecycle: wait
            key = MaterializationKey.from_dict(intent)
            evidence = self._evidence_ledger(self._app())
            if not evidence.seal("shioaji", key.market, key.trading_date, key.session):
                # Market Runtime holds no record of it: finished and pruned with the WAL that kept it (or nothing was
                # stored). A job would publish what is left of it over the complete history.
                _failure_log.warning("materialization intent for %s %s %s refused: Market Runtime holds no record of the session",
                             key.market, key.trading_date, key.session)
                settle_intent("shioaji", key_id, jobs_root=self._materialization_jobs_root)
                continue
            summary = evidence.summary("shioaji", key.market, key.trading_date, key.session)
            completeness = str(summary.get("completeness") or "gap_detected")
            # An operator's explicit retry may relaunch a terminal failure; every other intent never does.
            self._ledger.submit(key, completeness=completeness, gap_codes=summary.get("gap_codes") or [],
                                repaired_codes=summary.get("repaired_codes") or [],
                                retry_terminal=bool(intent.get("retry_terminal")),
                                reason=str(intent.get("reason") or ""))
            settle_intent("shioaji", key_id, jobs_root=self._materialization_jobs_root)
            handled += 1
        return handled

    def _prune_closed_sessions(self) -> None:
        """Once a day: this owner deletes the evidence rows and ledger records of its finished sessions."""
        now = self.now_provider().astimezone(TAIPEI)
        if self._pruned_for == now.date():
            return
        app = self._app()
        if app is None:
            return   # not an error: no broker app yet (its absence is recorded by _app); pruned on a later poll
        prune_closed_sessions("shioaji", evidence=self._evidence_ledger(app), ledger=self._ledger, now=now,
                              keep=self._unsettled_manifest_sessions())
        self._pruned_for = now.date()

    def _unsettled_manifest_sessions(self) -> set[tuple[str, str, str]]:
        """The sessions a session manifest still mirrors from the ledger: a missing record would read as pending."""
        sessions: set[tuple[str, str, str]] = set()
        for manifest_path in self.manifest_dir.glob("*.json"):
            try:
                payload = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                record_failure(_failure_log, "reading a session manifest", exc)
                continue
            if payload.get("materialization_status") in _SETTLED_STATUSES:
                continue
            for raw in payload.get("materialization_keys") or []:
                key = MaterializationKey.from_dict(raw).normalized()
                sessions.add((key.market, key.trading_date, key.session))
        return sessions

    def _fill_materialized_sessions(self) -> None:
        """Start filling the next materialized session that has not been filled (decisions.md 盤中重啟的缺口只補空檔時段;
        補齊的資料仍不完整): its gaps' windows from the broker's history, then a job folding it again with them. A
        session every code of which is complete needs none. Waits for the broker's login."""
        if not self._fill_gaps or (self._fill_thread is not None and self._fill_thread.is_alive()):
            return
        app = self._app()
        broker = getattr(app, "broker_service", None) if app is not None else None
        if broker is None or not broker.is_connected():
            return
        candidates = self._ledger.fill_candidates() or self._sessions_with_newly_listed_codes()
        if not candidates:
            return
        self._fill_thread = threading.Thread(target=self._fill_session, args=(candidates[0], broker), name="ShioajiHistoryFill", daemon=True)
        self._fill_thread.start()

    def _sessions_with_newly_listed_codes(self) -> list[dict[str, Any]]:
        """The newest materialized session of each market reopened for codes listed after it traded; each code once."""
        from service.market.history.rust_historical_store_reader import default_historical_root
        from service.market.history import history_fill

        # Asked every pass, but the answer moves only with the background list or a settled session: reading the list's
        # whole revision history each second was most of this provider's idle CPU.
        settled = self._ledger.fill_settled_newest()
        checked = (history_fill.background_list_revision(),
                   tuple((str(r["key_id"]), tuple(sorted(str(c) for c in r.get("fill_listed") or ()))) for r in settled))
        if checked == self._newly_listed_checked:
            return []
        self._newly_listed_checked = checked
        for record in settled:
            codes = set(history_fill.listed_without_partition(default_historical_root(), str(record["market"]), str(record["trading_date"]), str(record["session"])))
            codes -= {str(c).upper() for c in record.get("fill_listed") or ()}
            if codes:
                self._ledger.fill_reopen(str(record["key_id"]), sorted(codes))
                return self._ledger.fill_candidates()
        return []

    def _prune_query_cache(self) -> None:
        """Once for each session that has just materialized: the query cache past its 保存天數 is removed."""
        if not self._fill_gaps:
            return
        fresh = {str(record["key_id"]) for record in self._ledger.fill_candidates()} - self._query_cache_pruned_for
        if not fresh:
            return
        self._query_cache_pruned_for |= fresh
        from config import query_cache_settings, storage_settings
        from service.market.history.query_cache import QueryCache

        removed = QueryCache(storage_settings.storage_paths().query_cache).prune(query_cache_settings.retention_days(), self.now_provider().date())
        if removed:
            _failure_log.info("query cache: removed the dates past its retention: %s", removed)

    def _fill_session(self, record: dict[str, Any], broker: Any) -> None:
        from service.market.history.rust_historical_store_reader import default_historical_root
        from service.market.shared.materialization_jobs import default_jobs_root
        from service.market.history import history_fill
        from service.platform.native_binaries import analysis_runtime_job_binary

        key_id = str(record["key_id"])
        market, trading_date, session = str(record["market"]), str(record["trading_date"]), str(record["session"])
        codes = (record.get("result") or {}).get("codes") or []
        # A later round has its own folder: the first round's fills are already in the store.
        round_suffix = f"-{record['fill_round']}" if record.get("fill_round") else ""
        fills_dir = (self._materialization_jobs_root or default_jobs_root()) / "fills" / f"{key_id}{round_suffix}"
        try:
            # An IDX session whose index the background list held has no partition of it (a whole day the WAL never
            # got: the session's job found no input) is fetched for the whole session.
            # Codes listed after the session traded take the same path: run here, after its materialization.
            expected = sorted({*history_fill.expected_codes(default_historical_root(), market, trading_date, session),
                               *history_fill.listed_without_partition(default_historical_root(), market, trading_date, session)})
            held = {str(c.get("code") or "").upper() for c in codes}
            if codes and all(c.get("completeness") == "complete" for c in codes) and held.issuperset(expected):
                self._ledger.fill_update(key_id, state="not_needed")
                return
            self._ledger.fill_update(key_id, state="preparing")
            summary = history_fill.prepare(lambda items: broker.fill_history_windows(items)["results"], analysis_runtime_job_binary(),
                                           default_historical_root(), market, trading_date, session, fills_dir, expected)
            if not summary["refold"]:
                self._ledger.fill_update(key_id, state="not_needed", summary=summary)
                return
            self._ledger.fill_submit(key_id, fills_dir=fills_dir, unresolved_codes=sorted(summary["unresolved"]), summary=summary)
        except Exception as exc:
            record_failure(_failure_log, f"filling the gaps of {record.get('market')} {record.get('trading_date')} {record.get('session')}", exc)
            self._ledger.fill_update(key_id, state="failed", error=f"{type(exc).__name__}: {exc}"[:300])

    def poll_materialization_jobs(self) -> int:
        """Advance the ledger (results, leases, bounded retries) and mirror it into session manifests."""
        self._ledger.tick()
        try:
            self._prune_query_cache()
        except Exception as exc:
            record_failure(_failure_log, "removing the query cache past its retention", exc)
        try:
            self._fill_materialized_sessions()
        except Exception as exc:
            record_failure(_failure_log, "starting the fill of a materialized session's gaps", exc)
        try:
            self._prune_closed_sessions()
            self.process_materialization_intents()
        except Exception as exc:
            record_failure(_failure_log, "advancing materialization intents", exc)
            with self._lock:
                self._last_error = f"materialization intents: {exc}"
        try:
            if self._wal_retention is not None:
                self._wal_retention.maybe_request(self.now_provider(), time.monotonic())
        except Exception as exc:
            record_failure(_failure_log, "WAL retention status / request", exc)
            with self._lock:
                self._last_error = f"wal retention: {exc}"
        if not self.manifest_dir.exists():
            return 0
        updated = 0
        for manifest_path in self.manifest_dir.glob("*.json"):
            try:
                modified = manifest_path.stat().st_mtime_ns
                if self._settled_manifests.get(manifest_path) == modified:
                    continue
                payload = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                record_failure(_failure_log, "reading a session manifest", exc)
                continue
            keys = payload.get("materialization_keys")
            if not isinstance(keys, list) or payload.get("materialization_status") in _SETTLED_STATUSES:
                self._settled_manifests[manifest_path] = modified
                continue
            states = []
            for raw in keys:
                record = self._ledger.status(MaterializationKey.from_dict(raw))
                states.append(str((record or {}).get("state") or PENDING))
            if not states:
                continue
            if SUCCEEDED in states and set(states) <= {SUCCEEDED, NO_INPUT}:
                # a calendar date with no events (weekend/holiday) is legitimately empty next to real data
                status = "materialized"
            else:
                # NO_INPUT ranks after the unfinished states: it is only a settled outcome once no key can still change
                order = [FAILED_TERMINAL, FAILED_RETRYABLE, RUNNING, PENDING, NO_INPUT, SUCCEEDED]
                worst = next(state for state in order if state in states)
                status = self._STATE_TO_STATUS.get(worst, "pending")
            if status != payload.get("materialization_status"):
                stk = next((k for k in keys if str(k.get("market")).upper() == "STK"
                            and str(k.get("session") or "DAY").upper() == "DAY"), None)
                if stk is not None and status in _SETTLED_STATUSES:
                    # Published before the manifest settles: a failed publish leaves the manifest unsettled, and the
                    # next poll publishes again.
                    try:
                        publish_settled_session(source="shioaji", market="STK", trading_date=str(stk.get("trading_date"))[:10],
                                                session="DAY", status=status,
                                                settled_at=self.now_provider().astimezone(TAIPEI).isoformat(timespec="seconds"),
                                                jobs_root=self._materialization_jobs_root)
                    except OSError as exc:
                        record_failure(_failure_log, "publishing the settled STK day session", exc)
                        continue
                if status in _SETTLED_STATUSES:
                    self._release_held_subscriptions(keys)
                payload["materialization_status"] = status
                self._write_finalization_manifest(payload)
                updated += 1
        return updated

    # The markets whose subscriptions are held for a settled session, by the market of its materialization key: a
    # stock's 盤中零股 (ODD) is held with the stock session.
    _HELD_MARKETS = {"STK": ["STK", "ODD"], "IDX": ["IDX"], "FUT": ["FUT"]}

    def _release_held_subscriptions(self, keys: list[Any]) -> None:
        """A session settled (materialized, or nothing left to materialize): Market Runtime lets go of what it kept
        subscribed for it (decisions.md 盤中訂閱過的商品不退訂)."""
        release = getattr(getattr(self._app(), "live_event_sink", None), "release_held", None)
        if not callable(release):
            return
        for key in keys:
            markets = self._HELD_MARKETS.get(str(key.get("market") or "").upper())
            if markets:
                release(markets, str(key.get("trading_date"))[:10], str(key.get("session") or "DAY").upper())

    def _intent_path(self, active: ActiveMarketSession) -> Path:
        safe = "".join(
            ch if ch.isalnum() or ch in "-_." else "_"
            for ch in (
                active.stream_id
                or f"{active.market}:{active.trading_date}:{active.session}:{active.actual_contract}"
            )
        )
        return self._intent_dir / f"{safe}.json"

    def _write_session_intent(self, active: ActiveMarketSession) -> None:
        """Persist session ownership so restart cannot lose close finalization."""
        payload = {"schema": "session-intent-v1", "state": "ACTIVE", "active": active.as_dict()}
        write_json_atomic(self._intent_path(active), payload, durable=True, indent=2)

    def _remove_session_intent(self, active: ActiveMarketSession, recovered_from: str | None = None) -> None:
        """The intent's file -- and, for a finalization recovered at start, the very file it was read from. The name
        is recomputed from the session for one this process wrote; a recovered one may carry another (an earlier
        naming wrote "F_U_T___T_X_F_R_1___2_0_2_6..."): only the recomputed name was removed, the file stayed, and the
        9/2 close was finalized again at every start (10-14)."""
        paths = {self._intent_path(active)}
        if recovered_from:
            paths.add(Path(recovered_from))
        for path in paths:
            try:
                path.unlink(missing_ok=True)
            except OSError as exc:
                with self._lock:
                    self._last_error = f"session intent cleanup pending: {exc}"
                record_failure(_failure_log, f"removing the session intent {path.name}", exc)

    @staticmethod
    def _parse_session_intent(document: Any) -> ActiveMarketSession:
        """The session an intent file holds; ValueError for anything that is not a complete identity (an `active`
        that is a number or a list, a generation that is not a number, a missing market / date / session)."""
        row = document.get("active") if isinstance(document, dict) else None
        if not isinstance(row, dict):
            raise ValueError(f"session intent has no `active` object (found {type(row).__name__})")
        try:
            generation = max(1, int(row.get("generation") or 1))
        except (TypeError, ValueError) as exc:
            raise ValueError(f"session intent generation is not a number: {row.get('generation')!r}") from exc
        active = ActiveMarketSession(
            market=str(row.get("market") or "").upper(),
            trading_date=str(row.get("trading_date") or "")[:10],
            session=str(row.get("session") or "").upper(),
            actual_contract=str(row.get("actual_contract") or "").upper(),
            generation=generation,
            state="ACTIVE",
            stream_id=str(row.get("stream_id") or ""),
            activated_at=row.get("activated_at"),
        )
        if not active.market or not active.trading_date or not active.session:
            raise ValueError("invalid session intent identity")
        return active

    def _read_session_intents(self) -> list[tuple[Path, ActiveMarketSession]]:
        """Every intent file read once into its session, in recovery order: a FUT intent without its contract after
        every other, so the session's real intent is restored first and the placeholder is recognised as its leftover.
        A file that cannot be read is recorded and left for the next start; one whose content is not a valid intent is
        recorded and moved aside to `unreadable/` -- it can never be recovered, and it never stops the others."""
        intents: list[tuple[Path, ActiveMarketSession]] = []
        for path in sorted(self._intent_dir.glob("*.json")):
            try:
                text = path.read_text(encoding="utf-8")
            except OSError as exc:
                self._intent_unreadable(path, exc, quarantine=False)
                continue
            try:
                intents.append((path, self._parse_session_intent(json.loads(text))))
            except ValueError as exc:
                self._intent_unreadable(path, exc, quarantine=True)
        intents.sort(key=lambda item: (item[1].market == "FUT" and not item[1].actual_contract, item[0].name))
        return intents

    def _intent_unreadable(self, path: Path, exc: BaseException, *, quarantine: bool) -> None:
        detail: dict[str, Any] = {"file": path.name, "error": f"{type(exc).__name__}: {exc}"[:300]}
        if quarantine:
            target = path.parent / "unreadable" / path.name
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                os.replace(path, target)
                detail["moved_to"] = str(target)
            except OSError as move_error:
                record_failure(_failure_log, f"moving the invalid session intent {path.name} aside", move_error)
                detail["move_error"] = f"{type(move_error).__name__}: {move_error}"[:200]
        with self._lock:
            self._last_error = f"session intent recovery failed for {path.name}: {exc}"
        self._close_record("session.close_recovery", "intent_unreadable", "failed", session_key=path.stem,
                           identity={}, detail=detail)

    def _recover_session_intents(self) -> None:
        """Restore a live identity or finalize it when startup occurs after close."""
        if not self._intent_dir.exists():
            return
        resolver = self._resolver()
        now = self.now_provider()
        for path, active in self._read_session_intents():
            try:
                resolution = resolver.resolve(active.market, market=active.market, now=now)
                owns_now = bool(
                    resolution.live
                    or (active.market == "STK" and stk_preopen_capture(resolution, now))
                )
                # Between the 13:30 close and STK_AFTER_HOURS_END the stock day is still held open for the 14:30
                # 盤後定價 print (policy.stk_after_hours_capture): a restart then takes it back like a live session,
                # and the regular pass seals it at 14:40. Finalizing it here wrote the history at 13:50 without
                # the after-hours print (10-20).
                held_after_hours = bool(
                    active.market == "STK" and active.session == "DAY"
                    and stk_after_hours_capture(resolution, now)
                    and resolution.trading_date == active.trading_date
                )
                same_identity = bool(
                    owns_now
                    and resolution.trading_date == active.trading_date
                    and resolution.session.upper() == active.session
                ) or held_after_hours
                session_key = active.stream_id or f"{active.market}:{active.trading_date}:{active.session}:{active.actual_contract}"
                close_identity = {"market": active.market, "trading_date": active.trading_date, "session": active.session}
                if same_identity:
                    with self._lock:
                        held = self._active.get(active.market)
                    # A FUT empty-contract placeholder of the session already restored with its contract (an earlier
                    # process replaced the placeholder but left its intent; placeholders are read last): the contract
                    # is the session, the placeholder's file goes. Restoring both re-activated the session one
                    # generation up at each start.
                    if (
                        active.market == "FUT" and not active.actual_contract and held is not None
                        and held.actual_contract and (held.trading_date, held.session) == (active.trading_date, active.session)
                    ):
                        self._remove_session_intent(active, str(path))
                        self._close_record("session.close_recovery", "placeholder_intent_dropped", "succeeded",
                                           session_key=session_key, identity=close_identity,
                                           detail={"file": path.name, "generation": active.generation})
                        with self._lock:
                            self._generation = max(self._generation, active.generation)
                            self._market_generation[active.market] = max(
                                self._market_generation.get(active.market, 0), active.generation)
                        continue
                    with self._lock:
                        self._active[active.market] = active
                        self._generation = max(self._generation, active.generation)
                        self._market_generation[active.market] = max(
                            self._market_generation.get(active.market, 0), active.generation
                        )
                    self._session_lifecycle.observe(active.market, active.identity)
                    # The session a restart interrupted is still live -- its identity is taken back. That is what the
                    # intent is kept for: the normal load of a running session, not a remediation (only logged).
                    _failure_log.info("[SESSION CLOSE] %s session intent restored (generation %s, close operation %s)",
                                      session_key, active.generation, self.close_operation_id(session_key))
                    continue
                # Generations restart at 1 in every process. A recovered session keeps its old
                # number, so the next activation must start above it: otherwise the identity
                # authority refuses to reactivate "closed generation 1" and the new session is
                # never published there.
                with self._lock:
                    self._generation = max(self._generation, active.generation)
                    self._market_generation[active.market] = max(
                        self._market_generation.get(active.market, 0), active.generation
                    )
                app = self._app()
                if app is not None:
                    try:
                        app.broker_service.mark_market_session_transition(
                            market=active.market,
                            trading_date=active.trading_date,
                            session=active.session,
                            generation=active.generation,
                            live=False,
                            actual_contract=active.actual_contract,
                        )
                    except Exception as exc:
                        record_failure(_failure_log, "writing the closing session manifest", exc)
                prepared = self._prepare_finalization(active)
                prepared["recovered"] = True
                prepared["intent_path"] = str(path)
                self._schedule_finalization(prepared)
                # It closed while the process was down -- its finalization runs now, recorded.
                self._close_record("session.close_recovery", "intent_finalized_after_restart", "succeeded",
                                   session_key=session_key, identity=close_identity, detail={"generation": active.generation})
            except Exception as exc:
                with self._lock:
                    self._last_error = f"session intent recovery failed for {path.name}: {exc}"
                self._close_record("session.close_recovery", "intent_recovery_failed", "failed", session_key=path.stem,
                                   identity={"market": active.market, "trading_date": active.trading_date, "session": active.session},
                                   detail={"file": path.name, "error": f"{type(exc).__name__}: {exc}"[:300]})

    def _prepare_finalization(self, active: ActiveMarketSession) -> dict[str, Any]:
        """Cut over liveness quickly; durable finalization continues in background."""
        # Atomic lifecycle rotation: the old identity enters SEALING before a
        # new generation can become ACTIVE. Durable cleanup happens later.
        self._session_lifecycle.begin_sealing(active.market, active.identity)
        # Normal market-session rollover must never tear down broker subscriptions.
        # Permanent WATCHLIST/FIXED ownership remains subscribed across CLOSED
        # windows; session rollover only rotates canonical/durable ownership.
        # Broker unsubscribe/resubscribe is reserved for daemon shutdown, broker
        # reconnect and explicit watchdog recovery.
        quiesce = {
            "ok": True,
            "market": active.market,
            "reason": "SESSION_BOUNDARY_SUBSCRIPTION_PRESERVED",
            "broker_subscription_action": "PRESERVE",
            "quiesced_streams": 0,
        }
        job_id = active.stream_id or f"{active.market}:{active.trading_date}:{active.session}:{active.actual_contract}"
        prepared = {
            "job_id": job_id, "active": active, "quiesce": quiesce,
            "prepared_at": datetime.now(TAIPEI).isoformat(timespec="milliseconds"), "attempt": 0,
        }
        with self._lock:
            self._pending_finalizations[job_id] = {
                "session_key": job_id, "market": active.market, "trading_date": active.trading_date,
                "session": active.session, "actual_contract": active.actual_contract, "state": "PENDING", "attempt": 0,
            }
        return prepared

    def _schedule_finalization(self, prepared: dict[str, Any], *, due: float = 0.0) -> bool:
        """Queue a prepared finalization now, or keep it deferred (a full queue, a retry not due yet) for the next
        reconcile pass. A finalization is never dropped: a full queue would leave the session unfinalized for good."""
        job_id = str(prepared.get("job_id") or "")
        if due <= time.monotonic():
            try:
                self._finalization_queue.put_nowait(prepared)
                with self._lock:
                    self._deferred_finalizations.pop(job_id, None)
                return True
            except queue.Full:  # not an error: recorded as the job's QUEUE_FULL state and last_error, and deferred
                with self._lock:
                    if job_id in self._pending_finalizations:
                        self._pending_finalizations[job_id]["state"] = "QUEUE_FULL"
                    self._last_error = "session finalization queue full; deferred"
        with self._lock:
            self._deferred_finalizations[job_id] = (prepared, due)
        return False

    def _schedule_deferred_finalizations(self) -> int:
        """Queue every deferred finalization that is due (run by each reconcile pass)."""
        now = time.monotonic()
        with self._lock:
            due = [(prepared, at) for prepared, at in self._deferred_finalizations.values() if at <= now]
        return sum(1 for prepared, at in due if self._schedule_finalization(prepared, due=at))

    def _finalization_failed(self, job: dict[str, Any], *, result: Any, error: str | None) -> None:
        """An attempt that did not complete: retry later with backoff, or after the last attempt stop as FAILED --
        stated, not left looking pending (never only `_last_error`)."""
        job_id = str(job.get("job_id") or "")
        attempt = int(job.get("attempt") or 0)
        final = attempt >= FINALIZATION_MAX_ATTEMPTS - 1
        with self._lock:
            self._pending_finalizations[job_id] = {
                "session_key": job_id, "state": "FAILED" if final else "FAILED_RETRY", "attempt": attempt,
                "last_result": result, "last_error": error,
                "updated_at": datetime.now(TAIPEI).isoformat(timespec="milliseconds"),
            }
            if error:
                self._last_error = f"background finalization: {error}"
        active = job.get("active")
        identity = ({"market": active.market, "trading_date": active.trading_date, "session": active.session}
                    if active is not None else {})
        if not final and self._running.is_set():
            retry = dict(job)
            retry["attempt"] = attempt + 1
            delay = min(8.0, 1.0 * (2 ** attempt))
            self._schedule_finalization(retry, due=time.monotonic() + delay)
            self._close_record("session.close_recovery", "finalization_retry", "failed", session_key=job_id, identity=identity,
                               attempt=attempt + 1, detail={"error": error, "retry_in_s": delay})
        else:
            self._close_record("session.close_recovery", "finalization_retry", "abandoned", session_key=job_id, identity=identity,
                               attempt=attempt + 1, detail={"error": error, "final": True})

    def _finalization_run(self) -> None:
        while self._running.is_set() or not self._finalization_queue.empty():
            try:
                job = self._finalization_queue.get(timeout=0.25)
            except queue.Empty:  # not an error: queue wait timed out; the loop re-checks the running flag
                continue
            if job is self._finalization_stop:
                self._finalization_queue.task_done()
                break
            try:
                payload = self._finalize_prepared(job)
                job_id = str(job.get("job_id") or "")
                if bool(payload.get("cache_cleanup_allowed")):
                    with self._lock:
                        self._pending_finalizations[job_id] = {
                            "session_key": job_id, "state": "COMPLETE", "attempt": int(job.get("attempt") or 0),
                            "last_result": payload.get("finalization_status"),
                            "updated_at": datetime.now(TAIPEI).isoformat(timespec="milliseconds"),
                        }
                    if int(job.get("attempt") or 0) > 0:
                        # A finalization that needed retries ends recorded, not only as its failed attempts
                        # (three failed retries with nothing after them were seen live).
                        active = job.get("active")
                        identity = ({"market": active.market, "trading_date": active.trading_date, "session": active.session}
                                    if active is not None else {})
                        self._close_record("session.close_recovery", "finalization_retry", "succeeded", session_key=job_id,
                                           identity=identity, attempt=int(job.get("attempt") or 0) + 1,
                                           detail={"result": str(payload.get("finalization_status"))[:300]})
                else:
                    # Not complete without an exception: what the finalization said is the reason (it was recorded as
                    # `error: null`).
                    because = "; ".join(payload.get("failed_because") or []) or "unstated"
                    self._finalization_failed(job, result=payload.get("finalization_status"),
                                              error=f"not complete: {str(payload.get('finalization_status'))} ({because})"[:300])
            except Exception as exc:
                self._finalization_failed(job, result=None, error=f"{type(exc).__name__}: {exc}")
            finally:
                self._finalization_queue.task_done()

    def _finalize_prepared(self, prepared: dict[str, Any]) -> dict[str, Any]:
        """Finalize a prepared close: collect its evidence, run the evidence gate, judge the barrier, then build the
        manifest and commit it (each step below has its own result)."""
        active: ActiveMarketSession = prepared["active"]
        started = str(prepared.get("prepared_at") or datetime.now(TAIPEI).isoformat(timespec="milliseconds"))
        app = self._app()
        # The new market generation may already be active. The barrier below filters by the old canonical identity,
        # so liveness never waits on old durable completion.
        if self.finalization_grace_seconds > 0:
            time.sleep(self.finalization_grace_seconds)
        evidence = self._collect_evidence(app, active)
        gate = self._run_post_close_gate(app, active)
        authority = self._authority_transition(app, active, recovered=bool(prepared.get("recovered")))
        barrier = self.session_policy.finalization_barrier(
            authority_transition_committed=authority.authority_committed,
            generation_transition_committed=authority.generation_committed,
            durable_landed=evidence.in_flight == 0,
            # Sealing is gated on the closed-session evidence gate having run. Historical materialization is a
            # separate, later capability (materialization_status).
            post_close_products_ready=gate.ran,
        )
        payload = self._build_manifest(active, prepared, started, evidence, gate, authority, barrier)
        return self._commit_finalization(payload, active, prepared)

    def _collect_evidence(self, app: Any, active: ActiveMarketSession) -> "_FinalizationEvidence":
        """The session's evidence once the sink has drained what it can.

        Seal authority = Market Runtime's records of the session's partitions (what it stored, what the provider
        reported lost, what it refused, the restarts it saw), read from the files it writes."""
        sink = self._sink(app)
        ledger = sink.evidence
        self._await_sink_drain(app, timeout=5.0)
        windows = session_windows("shioaji", active.market, active.trading_date, active.session,
                                  start=self._parse_time(active.activated_at))
        if active.market.upper() == "STK":
            windows += session_windows("shioaji", "IDX", active.trading_date, "DAY")
        # Finalization (sealing) is gated on the evidence being FINALIZED and readable, not on it being
        # loss-free: a gap is an outcome recorded as FINALIZED_WITH_GAPS / gap_detected, never a blocker.
        # What does gate it is durability: events of these markets from before the session's end that Market Runtime
        # has not answered for good yet (after the drain wait). Not the whole sink: at the 13:30 STK close the
        # futures stream is still trading, so the shared queue is rarely empty. Market Runtime writes what an answer
        # changes in a record before it answers, so once nothing is outstanding the files are final.
        # Through the end of each partition's closing minute (its closing match is stamped within it).
        end = max(partition_end(src, market, date_text, wal) for src, market, date_text, wal in windows) + timedelta(minutes=1)
        in_flight = sink.unconfirmed_before({market for _src, market, _date, _wal in windows}, int(end.timestamp() * 1_000_000_000))
        return _FinalizationEvidence(evidence=ledger.combined(windows), in_flight=in_flight)

    def _run_post_close_gate(self, app: Any, active: ActiveMarketSession) -> "_GateOutcome":
        """The closed-session evidence gate (session_evidence_gate.evaluate_session): it must have run for the session
        to seal. The automatic rollover is its only caller."""
        gate = getattr(app, "session_evidence_gate", None) if app is not None else None
        if gate is None:
            return _GateOutcome(ran=False, result={"ok": False, "skipped": False, "reason": "POST_SESSION_MAINTENANCE_UNAVAILABLE"},
                                materialized_views={"ok": False, "skipped": True, "reason": "MATERIALIZATION_DELEGATED_TO_RUST_JOB"})
        try:
            result = gate.evaluate_session(
                market=active.market, trading_date=active.trading_date, session=active.session,
                actual_contract=active.actual_contract if active.market.upper() == "FUT" else "",
            )
        except Exception as exc:
            record_failure(_failure_log, "running the closed-session evidence gate", exc)
            return _GateOutcome(ran=False, result={"ok": False, "reason": str(exc)},
                                materialized_views={"ok": False, "reason": str(exc), "repairable_from_raw": True})
        return _GateOutcome(ran=True, result=result, materialized_views=dict(result.get("materialized") or {}))

    def _authority_transition(self, app: Any, active: ActiveMarketSession, *, recovered: bool) -> "_AuthorityTransition":
        """Whether the market identity authority has moved past the session being finalized."""
        if app is None:
            return _AuthorityTransition()
        try:
            current = app.broker_service.market_identity_authority.current(active.market)
        except Exception as exc:
            record_failure(_failure_log, "reading the market identity authority for a finalization", exc)
            return _AuthorityTransition()
        if current is None:
            if recovered:
                # Recovered from an earlier process after its close, and this process never activated the
                # market (e.g. restarted in the evening): nothing here can still be that session. Waiting for
                # an authority entry that will not come would leave the STK close unsealed.
                return _AuthorityTransition(True, True, {"recovered": True, "current": None})
            return _AuthorityTransition()
        # The authority has moved to another session (a recovered session from an
        # earlier process: generation numbers are not comparable across processes).
        current_date = str(getattr(current, "trading_date", "") or "")[:10]
        moved_on = bool(current_date) and (
            current_date, str(getattr(current, "session", "") or "").upper()
        ) != (active.trading_date, str(active.session).upper())
        return _AuthorityTransition(
            authority_committed=bool(
                moved_on
                or current.generation > active.generation
                or (current.generation == active.generation and not current.live)
            ),
            # A CLOSED identity is itself a committed non-live generation; otherwise the newly ACTIVE generation must
            # be newer.
            generation_committed=bool(
                moved_on
                or (not current.live and current.generation >= active.generation)
                or (current.live and current.generation > active.generation)
            ),
            identity=current.as_dict(),
        )

    def _build_manifest(self, active: ActiveMarketSession, prepared: dict[str, Any], started: str,
                        evidence: "_FinalizationEvidence", gate: "_GateOutcome",
                        authority: "_AuthorityTransition", barrier: Any) -> dict[str, Any]:
        """The finalization manifest: every gate's result and the outcome, whole before anything is written."""
        session_evidence = evidence.evidence
        coverage = {
            "ok": True, "authority": "session_evidence", "streams": [], "evidence": session_evidence,
            "complete": session_evidence["completeness"] in {"complete", "repaired"},
            "has_gaps": session_evidence["completeness"] == "gap_detected",
        }
        if evidence.in_flight == 0 and gate.ran:
            status = "FINALIZED_WITH_GAPS" if coverage["has_gaps"] else "PASS"
        else:
            status = "FAILED"
        tick_lane = self._subscription_lane(active.market, "Tick")
        bidask_lane = self._subscription_lane(active.market, "BidAsk")
        barrier_state = barrier.as_dict()
        payload = {
            "schema": "session-finalization-v1",
            "session_key": active.stream_id or f"{active.market}:{active.trading_date}:{active.session}:{active.actual_contract}",
            "state": "SESSION_FINALIZED", "closing_started_at": started,
            "finalized_at": self.now_provider().astimezone(TAIPEI).isoformat(timespec="milliseconds"),
            "market_session_generation": active.generation,
            "tick": {
                "last_received_sequence": int(tick_lane.get("last_sequence") or 0),
                "rows": int(session_evidence.get("accepted") or 0),
                # Persist lag: the in-flight count the durability gate was read from.
                "persist_lag": evidence.in_flight,
            },
            "bidask": {"last_received_sequence": int(bidask_lane.get("last_sequence") or 0), "rows": 0, "persist_lag": 0},
            "session_evidence": session_evidence,
            "materialized_views": gate.materialized_views,
            "post_session_maintenance": gate.result,
            "source_quiesce": dict(prepared.get("quiesce") or {}), "closing": [],
            "recorder": {"ok": True, "authority": "market_runtime_wal", "reason": ""}, "coverage": coverage,
            "identity_authority": authority.identity,
            "finalization_barrier": barrier_state,
            "cache_cleanup_allowed": barrier.allow_ephemeral_cleanup,
            "finalization_status": status, "durable_history_retained": True,
            "attempt": int(prepared.get("attempt") or 0),
            # Durable completeness (docs/system-architecture/03_protocol_and_storage.md §6), from the final status:
            # a partition Market Runtime judged "repaired" (a restart's gap filled from the broker's history and
            # verified, restart_backfill.py) passes the evidence gate like a complete one; Rust B's materialization
            # still checks each code's volume against the exchange's cumulative total.
            "completeness": "complete" if status == "PASS" else "gap_detected",
            "market": active.market, "trading_date": active.trading_date, "session": active.session,
            "actual_contract": active.actual_contract,
            # persisted business lifecycle (open -> expired -> sealed): `_is_sealed` reads ONLY this.
            "lifecycle_state": "sealed" if barrier.allow_ephemeral_cleanup else "expired",
        }
        # What kept this finalization from completing, by gate, in the manifest itself so a restart reads the cause.
        failed_because: list[str] = []
        if not gate.ran:
            failed_because.append(f"evidence_gate_not_run: {gate.result.get('reason') or 'no evidence gate'}"[:200])
        if evidence.in_flight > 0:
            failed_because.append(f"persist_lag: {evidence.in_flight}")
        if not barrier.allow_ephemeral_cleanup:
            failed_because += [f"barrier: {b}" for b in (barrier_state.get("blocked_by") or [])]
        payload["failed_because"] = failed_because
        return payload

    def _commit_finalization(self, payload: dict[str, Any], active: ActiveMarketSession,
                             prepared: dict[str, Any]) -> dict[str, Any]:
        """Request the sealed session's materialization (the per-source owner's job: STK as one wildcard unit, FUT per
        session partition), write the manifest, and release the session."""
        if payload["lifecycle_state"] == "sealed":
            try:
                requested = self._submit_sealed_materialization(payload, active)
                payload["materialization_keys"] = [k.as_dict() for k in requested]
                # FUT: partitions already owned by an earlier finalization are not repeated here
                payload["materialization_status"] = "pending" if requested else "no_new_partitions"
            except OSError as exc:
                record_failure(_failure_log, f"requesting the materialization of {active.market} {active.trading_date} {active.session}", exc)
                payload["materialization_status"] = "retryable"
                payload["materialization_error"] = f"request write failed: {exc}"
        else:
            payload["materialization_status"] = "not_requested"
        self._write_finalization_manifest(payload)
        if payload.get("cache_cleanup_allowed"):
            self._session_lifecycle.mark_sealed(active.market, active.identity)
            self._remove_session_intent(active, prepared.get("intent_path"))
        with self._lock:
            self._finalizations.append(payload)
            self._finalizations[:] = self._finalizations[-50:]
        return payload

    def _activate(self, resolution: MarketSessionResolution, actual_contract: str, *, activated_at: datetime | None = None) -> ActiveMarketSession:
        with self._lock:
            self._generation += 1
            market_u = resolution.market.upper()
            self._market_generation[market_u] = int(self._market_generation.get(market_u, 0)) + 1
            generation = self._market_generation[market_u]
        logical = "TXFR1" if resolution.market.upper() == "FUT" else "*"
        stream_id = self._stream_id(
            resolution.market, logical, resolution.trading_date, resolution.session,
            actual_contract if resolution.market.upper() == "FUT" else "",
        )
        app = self._app()
        if app is not None:
            try:
                app.broker_service.mark_market_session_transition(
                    market=resolution.market, trading_date=resolution.trading_date,
                    session=resolution.session, generation=generation, live=True,
                    actual_contract=actual_contract,
                )
            except Exception as exc:
                record_failure(_failure_log, "writing the live session manifest", exc)
        active = ActiveMarketSession(
            market=resolution.market, trading_date=resolution.trading_date,
            session=resolution.session, actual_contract=actual_contract,
            generation=generation, state="ACTIVE", stream_id=stream_id,
            # The session clock this generation was activated on -- the same clock the WAL
            # partitions its events by. session_windows() uses it as the FUT window start, so it
            # must be market time, not local time, or a FUT session would enumerate the calendar
            # dates of the machine's clock instead of the dates its events actually carry.
            activated_at=(activated_at or datetime.now(TAIPEI)).astimezone(TAIPEI).isoformat(timespec="milliseconds"),
        )
        self._session_lifecycle.observe(active.market, active.identity)
        self._write_session_intent(active)
        return active

    @staticmethod
    def _day_session_opened(resolution: MarketSessionResolution) -> bool:
        """Whether the resolved day session has had its first print (Market Runtime records it); a futures NIGHT has
        no such gate here -- a day that never opened is an observed closure, and its night is no session either."""
        if str(resolution.session or "").upper() == "NIGHT":
            return True
        try:
            trading_date = date.fromisoformat(str(resolution.trading_date)[:10])
        except ValueError:  # not an error: an unresolved session has no date to gate
            return True
        return tw_day_session_opened(trading_date)

    def _older_than_active(self, market: str, resolution: MarketSessionResolution) -> bool:
        with self._lock:
            current = self._active.get(market)
        if current is None or current.state != "ACTIVE":
            return False
        candidate = (str(resolution.trading_date or "")[:10], int(session_order_for_name(resolution.session) or 0))
        return candidate < current.identity.sort_key

    def reconcile(
        self,
        now: datetime | None = None,
        *,
        markets: set[str] | None = None,
        wait: bool = True,
        event_driven: bool = False,
    ) -> dict[str, Any]:
        acquired = self._reconcile_lock.acquire(blocking=bool(wait))
        if not acquired:
            return {"ok": True, "skipped": "RECONCILE_BUSY"}
        try:
            return self._reconcile_locked(now, markets=markets, event_driven=event_driven)
        finally:
            self._reconcile_lock.release()

    def _reconcile_locked(
        self, now: datetime | None = None, *, markets: set[str] | None = None, event_driven: bool = False,
    ) -> dict[str, Any]:
        try:
            self.poll_materialization_jobs()
        except Exception as exc:
            # Never let a materialization-job poll glitch block the real,
            # safety-critical session rollover reconciliation below.
            record_failure(_failure_log, "polling materialization jobs before the rollover reconcile", exc)
        stamp = now or self.now_provider()
        self._refresh_market_clock()
        resolver = self._resolver()
        actual_contract = self._actual_contract()
        transitions: list[dict[str, Any]] = []
        expected_activity: dict[str, bool] = {}
        expected_lanes: dict[str, float] = {}
        requested_markets = {str(item or "").upper() for item in markets} if markets else None
        for market, security in (("STK", "STK"), ("FUT", "FUT")):
            if requested_markets is not None and market not in requested_markets:
                continue
            # An explicit ``now`` (observe_first_market_event passes the callback's own exchange
            # timestamp) is the caller's authority and is used verbatim; otherwise this market's
            # stream clock decides, and the wall clock takes over the moment it stops advancing.
            market_stamp = stamp if now is not None else (self.market_clock.now(market) or stamp)
            resolution = resolver.resolve(security, market=market, now=market_stamp)
            if event_driven and self._older_than_active(market, resolution):
                # A late event from an earlier session (yesterday's night print arriving after the day
                # session opened) is evidence for that session only. It must never seal the current
                # session and re-activate the older one.
                transitions.append({"market": market, "skipped": "STALE_EVENT_SESSION", "to": resolution.as_dict()})
                continue
            # Equity pre-open is not a regular trading session, but it already
            # owns today's broker subscription generation.  BidAsk callbacks can
            # start at 08:30 and are the source of indicative pre-open prices.
            # Waiting for ``resolution.live`` (09:00) leaves an overnight-stale
            # Shioaji subscription unprobed until the continuous session opens.
            # Activate the DAY ownership at 08:30, then keep the same identity at
            # 09:00 so there is no duplicate rollover or resubscribe burst.
            equity_preopen = stk_preopen_capture(resolution, market_stamp)
            base_policy = self.session_policy.evaluate(
                resolution,
                equity_preopen=equity_preopen,
                now=market_stamp,
                opened=self._day_session_opened(resolution),
            )
            owns_market_data = base_policy.owns_market_data
            expected_activity[market] = owns_market_data
            expected_lanes.update(base_policy.expected_lanes)
            with self._lock:
                previous = self._active.get(market)
                self._last_resolution[market] = resolution.as_dict()
            contract = actual_contract if market == "FUT" else ""
            # The broker names TXFR1's contract only once it is logged in. A contract not known yet is not another
            # contract: the session that already owns one keeps it. Read as "" at a restart (bound before the
            # login), it sealed the live night session the restart had just restored and opened an empty-contract
            # one in its place (10-17 01:26, 10-19 23:19).
            if (
                market == "FUT" and not contract and previous is not None and previous.actual_contract
                and (previous.trading_date, previous.session.upper()) == (resolution.trading_date, resolution.session.upper())
            ):
                contract = previous.actual_contract
            identity = self._session_identity(resolution, contract) if owns_market_data else ""
            # During daemon bootstrap the session reconciler can run before
            # Shioaji has resolved TXFR1 to the actual front-month contract.
            # An empty-contract FUT entry is only a placeholder: it has never
            # owned a broker subscription and therefore must not enter durable
            # finalization when the real contract becomes available.  Doing so
            # leaves the live session stuck in FINALIZATION_FAILED and prevents
            # Tick/BidAsk callbacks from being resumed.
            if (
                market == "FUT"
                and previous is not None
                and not str(previous.actual_contract or "").strip()
                and bool(contract)
            ):
                with self._lock:
                    self._active.pop(market, None)
                # Its intent goes with it: left behind, the next start restored the placeholder too.
                self._remove_session_intent(previous)
                transitions.append({
                    "market": market,
                    "from": previous.as_dict(),
                    "to": resolution.as_dict(),
                    "placeholder_replaced": True,
                })
                previous = None
            previous_identity = ""
            if previous and previous.state == "ACTIVE":
                previous_identity = "|".join((previous.market, previous.trading_date, previous.session, previous.actual_contract))
            policy = self.session_policy.evaluate(
                resolution,
                equity_preopen=equity_preopen,
                previous_identity=previous_identity,
                candidate_identity=identity,
                now=market_stamp,
                opened=self._day_session_opened(resolution),
            )
            with self._lock:
                self._last_policy_decisions[market] = policy.as_dict()
            if (
                previous
                and previous.state == "ACTIVE"
                and self._has_policy_action(policy, SessionAction.SEAL)
                and self._has_policy_action(policy, SessionAction.FINALIZE)
            ):
                prepared = self._prepare_finalization(previous)
                with self._lock:
                    self._active.pop(market, None)
                scheduled = self._schedule_finalization(prepared)
                transitions.append({
                    "market": market, "from": previous.as_dict(), "to": resolution.as_dict(),
                    "finalization": {"state": "PENDING", "scheduled": scheduled, "session_key": prepared.get("job_id")},
                    "cache_directive": policy.cache_directive.value,
                    "actions": list(policy.actions),
                })
                # Publish the CLOSED identity to broker health exactly once when
                # an active market generation ends.  Downstream watchdogs now
                # read this contract instead of recalculating calendars.
                if not owns_market_data:
                    app = self._app()
                    if app is not None:
                        try:
                            app.broker_service.mark_market_session_transition(
                                market=market, trading_date=resolution.trading_date,
                                session=resolution.session, generation=previous.generation,
                                live=False, actual_contract=previous.actual_contract,
                            )
                        except Exception as exc:
                            record_failure(_failure_log, "writing the previous session's closing manifest", exc)
            if owns_market_data:
                with self._lock:
                    current = self._active.get(market)
                current_identity = "|".join((current.market, current.trading_date, current.session, current.actual_contract)) if current else ""
                if (
                    current is None
                    or current_identity != identity
                    or self._has_policy_action(policy, SessionAction.ACTIVATE)
                ):
                    active = self._activate(resolution, contract, activated_at=market_stamp)
                    with self._lock:
                        self._active[market] = active
                    transitions.append({
                        "market": market,
                        "from": current.as_dict() if current else None,
                        "to": active.as_dict(),
                        "actions": list(policy.actions),
                    })
        if transitions:
            with self._lock:
                self._transition_count += len(transitions)
                self._last_error = None
        with self._lock:
            health_sessions = {key: value.as_dict() for key, value in self._active.items()}
            health_generation = int(self._generation)
        # Partial callback reconciliation must preserve the other market's
        # expected activity/lanes instead of publishing it as inactive.
        if requested_markets is not None:
            previous_context = dataflow_health_ledger.snapshot().get("context") or {}
            merged_activity = dict(previous_context.get("expected_activity") or {})
            merged_activity.update(expected_activity)
            expected_activity = merged_activity
            merged_lanes = dict(previous_context.get("expected_lanes") or {})
            target_prefixes = {"STK": ("stk.", "index."), "FUT": ("futures.",)}
            for market in requested_markets:
                for lane in list(merged_lanes):
                    if str(lane).startswith(target_prefixes.get(market, ())):
                        merged_lanes.pop(lane, None)
            merged_lanes.update(expected_lanes)
            expected_lanes = merged_lanes
        dataflow_health_ledger.set_context(
            generation=health_generation,
            expected_activity=expected_activity,
            expected_lanes=expected_lanes,
            market_sessions=health_sessions,
        )
        return {"ok": True, "transitions": transitions, **self.status()}

    def status(self) -> dict[str, Any]:
        app = self._app()
        broker = {}
        identity_authority = {}
        if app is not None:
            try:
                broker = app.broker_service.status()
            except Exception as exc:
                record_failure(_failure_log, "reading the broker status", exc)
                broker = {}
            try:
                identity_authority = app.broker_service.market_identity_authority.snapshot()
            except Exception as exc:
                record_failure(_failure_log, "reading the market identity authority snapshot", exc)
                identity_authority = {}
        with self._lock:
            active = {key: value.as_dict() for key, value in self._active.items()}
            resolutions = {key: dict(value) for key, value in self._last_resolution.items()}
            finalizations = list(self._finalizations[-10:])
            generation = self._generation
            market_generation = dict(self._market_generation)
            error = self._last_error
            transitions = self._transition_count
            pending_finalizations = {key: dict(value) for key, value in self._pending_finalizations.items()}
            policy_decisions = {key: dict(value) for key, value in self._last_policy_decisions.items()}
        return {
            "schema": "session-rollover-v1",
            "orchestrator": {"authority": type(self).__name__},
            "running": self._running.is_set(),
            "market_session_generation": generation,
            "market_session_generation_by_market": market_generation,
            "broker": {
                "connected": bool(broker.get("connected")),
                "session_generation": int(broker.get("session_generation") or 0),
                "login_count": int(broker.get("login_count") or 0),
                "reconnect_count": int(broker.get("reconnect_count") or 0),
            },
            "active": active,
            "expected": resolutions,
            # Which clock each market's session decision is currently being made on.
            "market_clock": self.market_clock.snapshot(),
            "transition_count": transitions,
            "finalizations": finalizations,
            "pending_finalizations": pending_finalizations,
            "deferred_finalizations": sorted(self._deferred_finalizations),
            "session_policy": {
                "authority": type(self.session_policy).__name__,
                "decisions": policy_decisions,
                "durable_history_action": "RETAIN",
            },
            "identity_authority": identity_authority,
            "session_lifecycle": self._session_lifecycle.status(),
            "wal_retention": dict(self._wal_retention.last) if self._wal_retention is not None else {"enabled": False},
            "last_error": error,
        }

    def lightweight_status(self) -> dict[str, Any]:
        """Cached session ownership without entering broker/native status paths."""
        identity_authority = {}
        app = self._app()
        if app is not None:
            try:
                identity_authority = app.broker_service.market_identity_authority.snapshot()
            except Exception as exc:
                record_failure(_failure_log, "reading the market identity authority snapshot", exc)
                identity_authority = {}
        with self._lock:
            return {
                "schema": "session-rollover-v1",
                "orchestrator": {"authority": type(self).__name__},
                "running": self._running.is_set(),
                "market_session_generation": int(self._generation),
                "market_session_generation_by_market": dict(self._market_generation),
                "active": {key: value.as_dict() for key, value in self._active.items()},
                "expected": {key: dict(value) for key, value in self._last_resolution.items()},
                "transition_count": int(self._transition_count),
                "session_policy": {
                    "authority": type(self.session_policy).__name__,
                    "decisions": {key: dict(value) for key, value in self._last_policy_decisions.items()},
                    "durable_history_action": "RETAIN",
                },
                "identity_authority": identity_authority,
                "session_lifecycle": self._session_lifecycle.status(),
                "last_error": self._last_error,
            }

    def selected_product_diagnostic(self, *, market: str, logical_code: str, actual_contract: str = "") -> dict[str, Any]:
        market_u = str(market or "").upper()
        code = str(logical_code or "").upper()
        if market_u == "FUT" and not actual_contract:
            actual_contract = self._actual_contract()
        actual_contract = str(actual_contract or "").upper()
        with self._lock:
            expected = dict(self._last_resolution.get(market_u) or {})
            active = self._active.get(market_u)
        app = self._app()
        shioaji = app.broker_service.status() if app is not None else {}
        quote: dict[str, Any] = {}
        if market_u == "FUT":
            quote = dict(((shioaji.get("txf") or {}).get("Quote") or {}))
            # TXFR1 subscribes Quote only; its trades and depth come from that one stream.
            tick, bidask = {}, {}
        else:
            streams = shioaji.get("subscription_streams") or {}
            tick = _regular_stock_lane(streams, code, "Tick")
            bidask = _regular_stock_lane(streams, code, "BidAsk")
        # active.stream_id and expected_stream are computed independently, so STALE_ACTIVE_SESSION is a real check.
        expected_stream = ""
        if expected.get("live"):
            expected_stream = self._stream_id(
                market_u, "TXFR1" if market_u == "FUT" else code,
                str(expected.get("trading_date") or ""), str(expected.get("session") or ""),
                actual_contract if market_u == "FUT" else "",
            )
        active_stream = str(active.stream_id if active else "")
        status = "PASS"
        broker_connected = bool(shioaji.get("connected"))
        if not broker_connected:
            status = "BROKER_DISCONNECTED"
        elif market_u == "FUT" and expected.get("live") and not bool(quote.get("confirmed")):
            status = "QUOTE_STALE"
        elif market_u != "FUT" and expected.get("live") and not bool(tick.get("confirmed")):
            status = "TICK_STALE"
        elif market_u != "FUT" and expected.get("live") and not bool(bidask.get("confirmed")):
            status = "BIDASK_STALE"
        elif market_u != "FUT" and expected.get("live") and active_stream and expected_stream and active_stream != expected_stream:
            status = "STALE_ACTIVE_SESSION"
        return {
            "selected": {"market": market_u, "logical_code": code, "actual_contract": actual_contract},
            "expected": {**expected, "stream_id": expected_stream},
            "subscription_quote": quote,
            "subscription_tick": tick,
            "subscription_bidask": bidask,
            "cache": {"cache_stream_id": active_stream, "cache_session": active.session if active else "", "cache_generation": active.generation if active else 0},
            "status": status,
        }

