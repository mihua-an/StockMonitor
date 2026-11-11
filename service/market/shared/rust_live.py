"""Provider-to-Rust-A live event contract (docs/system-architecture/03 section 2, 01 section 3).

Python providers own broker sessions and execute the subscription plan Rust A sends them. Every accepted SDK
callback is wrapped once (raw event contract v2) and handed to market_runtime under the provider's own role
credential (``provider:<source>``); a provider may only ingest its own source's raw kinds. Python never derives
or keeps a live market view from these events.

Delivery: callback threads only ``put_nowait`` into a bounded queue; one sender thread batches up to
``BATCH_MAX`` events per ``event.ingest.batch`` and classifies every per-event ack. Rust A answers at once with each
stored event's durable sequence (``storage: wal``) and pushes, on the same connection, the WAL's committed watermark
(``event.durable``, subscribed when the connection opens) whenever it moves. A stored event stays ours -- not
acknowledged, not ``task_done`` -- until a watermark of the same Rust A process passes its sequence: however long the
disk takes, that is the normal wait, not a remediation. Only another ``instance_id`` (Rust A restarted; its sequences
mean nothing any more) makes the events themselves go again; one that did reach the disk answers ``RejectedSequence``
and counts as a duplicate. What is held needs no bound here: it is what Rust A took into its own bounded WAL queue
and has not synced, and a full queue refuses new events there (``WAL_QUEUE_FULL``).

Control: a second connection (adapter_control.AdapterControlConnection) registers the adapter, receives
``adapter.subscription.replace`` plans, applies them through the provider's callback and reports what was ACTUALLY
subscribed (``adapter.subscription.status``). A provider that fills gaps from its broker's history (``fill_gaps_with``)
says so in ``ingest.hello`` and is answered where each code's restart gap starts, and in a batch's answer where a late
join's starts; it reports each fill with ``ingest.backfill`` (service/market/shioaji/restart_backfill.py). What a late start or a reconnect lost stays marked as
lost input in Rust B. Subscription coverage is not this
sink's to record: Market Runtime writes it from these reports, dated by its calendar. Published by a provider
as ``source_status`` market events on the wall clock, it created sessions that never traded.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import asdict, dataclass, field
import json
import logging
import queue
import threading
import time
import uuid
from pathlib import Path
from threading import Lock
from typing import Any, Callable, Iterable, Mapping, Protocol, runtime_checkable

from service.market.shared.adapter_control import AdapterControlConnection, ReplaceSubscriptions, ReportSubscriptions
from service.market.shared.dataflow_health import DataFlowStage, dataflow_health_ledger
from service.platform import remediation
from service.platform.failure_record import record_failure

LIVE_EVENT_SCHEMA = "market-event-v2"
LIVE_EVENT_TYPES = frozenset({"quote", "trade", "orderbook", "minute_bar", "reference"})
BATCH_MAX = 256
RETRY_FULL_SECONDS = 0.2
_log = logging.getLogger(__name__)
MISSING_TIME_LOG_SECONDS = 60.0
# Events whose time is when the backend read them, not an exchange time: instrument data, not prints.
READ_TIME_EVENTS = frozenset({"reference"})
# While events are held and none are queued, the queue and the connection (whose watermark pushes release them) are
# looked at in turn this often. It never decides an outcome.
HELD_LISTEN_SECONDS = 0.005


# One id per OS process, said to Market Runtime when each ingest connection opens (``ingest.hello``): another id on a
# source's open partitions is a restart of the provider, which Market Runtime records as an interruption. The same
# process reconnecting is none: it kept what it could not send and reports what it dropped (``ingest.loss``).
PROCESS_INSTANCE = uuid.uuid4().hex[:12]
LOSS_DROPPED = "dropped"
LOSS_BROKER_OUTAGE = "broker_outage"


def _retryable(ack: Mapping[str, Any]) -> bool:
    """Market Runtime refused for now, not for good: nothing was applied and the event must be sent again."""
    return str(ack.get("reason") or "").startswith("WAL_QUEUE_FULL")


def _ledger() -> Any:
    return dataflow_health_ledger


def _primitive(value: Any) -> Any:
    """Copy an SDK value into the small, serialization-safe ingress domain."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Mapping):
        return {str(key): _primitive(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_primitive(item) for item in value]
    isoformat = getattr(value, "isoformat", None)
    if callable(isoformat):
        try:
            return isoformat()
        except Exception:  # not an error: serialisation fallback: an isoformat that fails falls through to the next representation
            pass
    item = getattr(value, "item", None)
    if callable(item):
        try:
            return _primitive(item())
        except Exception:  # not an error: serialisation fallback: an item() that fails falls through to str()
            pass
    return str(value)


def sdk_payload(value: Any) -> dict[str, Any]:
    """Extract one provider callback row without constructing a market view."""
    if isinstance(value, Mapping):
        return {str(key): _primitive(item) for key, item in value.items()}
    fields = getattr(value, "_fields", None)
    if fields:
        return {str(name): _primitive(getattr(value, name, None)) for name in fields}
    raw = getattr(value, "__dict__", None)
    if isinstance(raw, Mapping):
        return {str(key): _primitive(item) for key, item in raw.items() if not str(key).startswith("_")}
    return {"value": _primitive(value)}


@dataclass(frozen=True)
class RustLiveEvent:
    source: str
    market: str
    code: str
    generation: int
    sequence: int
    event_type: str
    exchange_ts_ns: int
    arrival_ns: int
    data: Mapping[str, Any]
    schema: str = LIVE_EVENT_SCHEMA
    event_id: str = ""
    #: exchange | backend_clock | synthetic | missing. Derived when empty: never a fake "exchange" time.
    time_quality: str = ""
    flags: Mapping[str, Any] = field(default_factory=dict)
    #: The trading day a reference read from the broker (backend_clock) describes. Its read time names no partition:
    #: Market Runtime writes it to that day's partitions by the session contract. Empty on every other event.
    describes_trading_date: str = ""

    def __post_init__(self) -> None:
        if self.schema != LIVE_EVENT_SCHEMA:
            raise ValueError(f"unsupported live event schema: {self.schema}")
        if self.event_type not in LIVE_EVENT_TYPES:
            raise ValueError(f"unsupported live event type: {self.event_type}")
        if not self.source or not self.code:
            raise ValueError("source and code are required")
        if self.generation < 0 or self.sequence <= 0:
            raise ValueError("generation must be non-negative and sequence must be positive")
        if self.exchange_ts_ns < 0 or self.arrival_ns <= 0:
            raise ValueError("invalid event timestamps")
        if self.describes_trading_date and not (self.event_type in READ_TIME_EVENTS and self.time_quality == "backend_clock"):
            raise ValueError("only a reference read from the broker names the trading day it describes")

    def as_dict(self) -> dict[str, Any]:
        """The ingest envelope. It names no partition (trading date, session, minute): Market Runtime names every one
        from the exchange time and refuses an envelope that carries one."""
        payload = asdict(self)
        if not payload["describes_trading_date"]:
            del payload["describes_trading_date"]
        payload["schema"] = LIVE_EVENT_SCHEMA
        payload["flags"] = dict(self.flags or {})
        if not payload["event_id"]:
            payload["event_id"] = f"{self.source}:{self.market}:{self.code}:{self.generation}:{self.event_type}:{self.sequence}"
        if not payload["time_quality"]:
            payload["time_quality"] = "exchange" if self.exchange_ts_ns > 0 else "missing"
        return payload


def exchange_time_ns(event: Any) -> int:
    """The event's exchange time (ns), 0 when it carries none. A reference's backend_clock stamp is when it was read
    from the broker, not market time: it never moves a market clock or a session's span."""
    ts = int(getattr(event, "exchange_ts_ns", 0) or 0)
    return ts if ts > 0 and str(getattr(event, "time_quality", "") or "") in ("", "exchange") else 0


class DurabilityTracker:
    """Events Market Runtime accepted and has not yet reported on disk: held -- never acknowledged, never task_done --
    until a watermark it pushes releases them (on disk) or orphans them (another Market Runtime process pushes now, so
    they are sent again). Items held against a reported "through here" position: the same shape serves any sender
    that must keep what its peer has not confirmed."""

    def __init__(self) -> None:
        self._lock = Lock()
        # (event, durable_sequence, accepting instance), in ack order.
        self._held: list[tuple[RustLiveEvent, int, str | None]] = []
        self.held_total = 0
        self.confirmed = 0
        self.resent = 0

    def hold(self, event: RustLiveEvent, durable_sequence: int, instance: str | None) -> None:
        with self._lock:
            self.held_total += 1
            self._held.append((event, int(durable_sequence), instance))

    def pending(self) -> int:
        with self._lock:
            return len(self._held)

    def held(self) -> list[Any]:
        with self._lock:
            return [item[0] for item in self._held]

    def settle(self, instance: str | None, committed: int) -> tuple[list[RustLiveEvent], list[tuple[RustLiveEvent, str | None]], int]:
        """Apply a pushed watermark: (released events, orphaned (event, old instance) pairs, events still held)."""
        with self._lock:
            released = [item for item in self._held if item[2] == instance and item[1] <= committed]
            orphaned = [item for item in self._held if item[2] != instance]
            settled = {id(item) for item in released + orphaned}
            self._held = [item for item in self._held if id(item) not in settled]
            self.confirmed += len(released)
            self.resent += len(orphaned)
            return [item[0] for item in released], [(item[0], item[2]) for item in orphaned], len(self._held)

    def stats(self) -> dict[str, int]:
        with self._lock:
            return {"durable_held": self.held_total, "durable_pending": len(self._held),
                    "durable_confirmed": self.confirmed, "durable_resent": self.resent}


@runtime_checkable
class RustEventSink(Protocol):
    """Non-blocking admission surface implemented by the Rust daemon binding."""

    def publish(self, event: RustLiveEvent) -> bool:
        """Try to admit ``event`` without blocking; False means it was NOT admitted."""
        ...

    def stop_admission(self) -> None:
        ...

    def refuse_missing_time(self, *, source: str, market: str, code: str, event_type: str, arrival_ns: int,
                            time_quality: str = "missing", sequence: int = 0) -> None:
        """Count an event the producer refused for lacking the exchange's time."""
        ...


def _runtime_url() -> str:
    from config.network_settings import LIVE_ENGINE_WS_URL

    return LIVE_ENGINE_WS_URL


class RustDaemonEventSink:
    """Bounded, non-blocking provider egress to market_runtime under the provider's role credential."""

    def __init__(
        self,
        *,
        source: str | None = None,
        url: str | None = None,
        token: str | None = None,
        capacity: int = 131_072,
        ack_timeout: float = 5.0,
        evidence_root: str | Path | None = None,
        instance: str | None = None,
    ) -> None:
        from service.market.shared.partition_evidence import PartitionEvidence

        # Market Runtime's partition records (it judges and writes them): read from their files, decided through
        # this provider's commands.
        self.evidence = PartitionEvidence(root=evidence_root, command=self.evidence_command)
        self._instance = str(instance or PROCESS_INSTANCE)
        self._base_url = url
        self._explicit_token = token
        self._source = str(source or "").strip().lower()
        self._queue: queue.Queue[RustLiveEvent] = queue.Queue(maxsize=max(1024, int(capacity)))
        self._ack_timeout = max(0.05, float(ack_timeout))
        self._accepting = True
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._control_thread: threading.Thread | None = None
        self._lock = Lock()
        self._accepted = 0
        # Accepted but not confirmed on disk: (event, durable_sequence, accepting instance), held until confirmed.
        self._durability = DurabilityTracker()
        self._acked = 0
        self._rejected = 0
        self._dropped = 0
        self._refused_after_stop = 0
        self._short_acks = 0
        # Market events without an exchange time are refused here: per event type, plus the last one.
        self._missing_exchange_time: dict[str, int] = {}
        self._last_missing_time: dict[str, Any] | None = None
        self._missing_time_logged = 0.0
        # Events lost before Market Runtime, to report (``ingest.loss``): (market, code, reason, connection) ->
        # [first exchange time, last exchange time, count]. Kept until Market Runtime stored the report.
        self._losses: dict[tuple[str, str, str, str], list[int]] = {}
        # Broker connections that went down, to tell Market Runtime (``ingest.outage``): connection -> (from_ns, the
        # instruments its streams carried).
        self._outages_began: dict[str, tuple[int, set[tuple[str, str]]]] = {}
        self._loss_reports = DurabilityTracker()
        self._losses_reported = 0
        # Exchange times of the events admitted and not yet answered for good, per market: what a session owner waits
        # for before it judges a partition (``unconfirmed_before``).
        self._unconfirmed: dict[str, Counter[int]] = {}
        # The newest exchange time admitted per market: the market's own clock as its stream reports it.
        self._market_clock: dict[str, int] = {}
        self._duplicate_after_retry = 0
        # Events Market Runtime refused because their session is closed (PARTITION_CLOSED): a late or re-sent event of
        # a finished session (OpenD re-sends its last print on a new subscription), never stored and lost to nothing.
        self._closed_partition = 0
        # Open remediations of the delivery protocol, by kind: each started when its condition first
        # appears and finished when it is resolved; only the sender thread touches them.
        self._delivery_ops: dict[str, tuple[remediation.RemediationOperation, int]] = {}
        self._transport_errors = 0
        self._last_error: str | None = None
        self._last_rejection: dict[str, Any] | None = None
        # The WAL failure last recorded while events were held (recorded once per reason).
        self._wal_failed_seen: str | None = None
        self._pending = 0
        self._adapter_source = ""
        # Who fills a restart's gaps from the broker's history: told so in ``ingest.hello`` (``fills_gaps``), and
        # handed the gaps Market Runtime answers it with.
        self._gap_handler: Callable[[list[dict[str, Any]]], None] | None = None
        self._control: AdapterControlConnection | None = None
        self._generations: dict[tuple[str, str], int] = {}

    # ------------------------------------------------------------------ configuration
    def register_adapter(self, *, source: str, max_subscriptions: int | None,
                         replace_subscriptions: ReplaceSubscriptions,
                         report_subscriptions: ReportSubscriptions,
                         kinds: list[str] | None = None, stream_budget: Mapping[str, Any] | None = None) -> None:
        """Execute Market Runtime's subscription plan for `source` on an adapter-control connection
        (adapter_control.AdapterControlConnection says what the two callbacks do). The provider calls
        :meth:`subscriptions_changed` whenever its broker state moves (a login, a reconnect, a resync), and the fresh
        report is sent: a plan is never reported subscribed on the strength of having been received."""
        self._adapter_source = str(source).strip().lower()
        self._source = self._source or self._adapter_source
        self._control = AdapterControlConnection(
            source=self._adapter_source, max_subscriptions=max_subscriptions, kinds=kinds,
            replace_subscriptions=replace_subscriptions, report_subscriptions=report_subscriptions,
            url=self._url, auth_headers=self._auth_headers, on_transport_error=self._control_failed,
            stream_budget=stream_budget)

    def fill_gaps_with(self, handler: Callable[[list[dict[str, Any]]], None]) -> None:
        """This provider fills gaps from its broker's history: each new ingest connection says so, and the gaps Market
        Runtime answers (``ingest.hello.ack`` ``gaps``: a restart's; ``event.ack.batch`` ``gaps``: a late join's) go to
        `handler`."""
        self._gap_handler = handler

    def view_history_with(self, handler: Callable[[dict[str, Any]], None]) -> None:
        """Views Market Runtime holds nothing for (``adapter.history.view``) go to `handler`."""
        if self._control is not None:
            self._control.on_history_view = handler

    def report_backfill(self, reports: list[dict[str, Any]]) -> dict[str, Any]:
        """What was stored of each code's gap (``ingest.backfill``), answered once Market Runtime wrote the records."""
        return self.evidence_command("ingest.backfill", {"reports": reports})

    def set_max_subscriptions(self, max_subscriptions: int, *, stream_budget: Mapping[str, Any] | None = None) -> None:
        """The provider can carry a different number of instruments (or streams) now: told to Market Runtime on the
        control connection (a provider that registered no adapter has no plan to resize)."""
        if self._control is not None:
            self._control.set_max_subscriptions(max_subscriptions, stream_budget=stream_budget)

    def subscriptions_changed(self) -> None:
        """The provider's broker state moved: report the plan in force again."""
        if self._control is not None:
            self._control.subscriptions_changed()

    def _control_failed(self, message: str) -> None:
        with self._lock:
            self._transport_errors += 1
            self._last_error = message

    def _url(self) -> str | None:
        source = self._source or self._adapter_source
        if not source:
            return None
        return self._base_url or _runtime_url()

    def _auth_headers(self) -> dict[str, str]:
        # The credential travels in a header, never in the URL, where it ends up in logs and diagnostics.
        source = self._source or self._adapter_source
        token = self._explicit_token
        if not token:
            from service.platform.runtime_credentials import require_token

            token = require_token(f"provider:{source}")
        return {"Authorization": f"Bearer {token}"}

    def start(self) -> None:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._accepting = True
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, name="RustLiveIngress", daemon=True)
            self._thread.start()
            if self._control is not None:
                self._control_thread = threading.Thread(target=self._control.run, args=(self._stop,),
                                                        name=f"RustAdapterControl-{self._adapter_source}", daemon=True)
                self._control_thread.start()

    @property
    def available(self) -> bool:
        return True

    @property
    def native_available(self) -> bool:
        return True

    @property
    def using_reference(self) -> bool:
        return False

    def health(self) -> dict[str, Any]:
        running = bool(self._thread and self._thread.is_alive())
        return {"state": "RUNNING" if running else "STOPPED", "running": running, "native_available": True,
                "reference": False, "authority": "market_runtime", **self.stats()}

    # ------------------------------------------------------------------------ ingest
    def _refuse_missing_time(self, event: RustLiveEvent) -> bool:
        """A market event must carry the exchange's own time; the wall clock never chooses its trading date.

        Real Shioaji and Futu data has never lacked it (~8M events checked): this guards against an SDK
        renaming or reformatting the field. A reference (昨收, limits, name) is instrument data read from the broker,
        not a print: its time is when it was read (backend_clock), and its partition is named by the producer."""
        if exchange_time_ns(event) > 0 or (event.exchange_ts_ns > 0 and event.event_type in READ_TIME_EVENTS
                                            and event.time_quality == "backend_clock"):
            return False
        self.refuse_missing_time(source=event.source, market=event.market, code=event.code,
                                 event_type=event.event_type, time_quality=event.time_quality or "missing",
                                 arrival_ns=event.arrival_ns, sequence=event.sequence)
        return True

    def refuse_missing_time(self, *, source: str, market: str, code: str, event_type: str, arrival_ns: int,
                            time_quality: str = "missing", sequence: int = 0) -> None:
        """Count a market event refused for lacking the exchange's time."""
        now = time.monotonic()
        with self._lock:
            self._missing_exchange_time[event_type] = self._missing_exchange_time.get(event_type, 0) + 1
            self._last_missing_time = {"source": source, "market": market, "code": code, "event_type": event_type,
                                       "time_quality": time_quality, "arrival_ns": arrival_ns}
            self._last_error = f"market event without exchange time refused: {source}:{market}:{code} {event_type}"
            log = now - self._missing_time_logged >= MISSING_TIME_LOG_SECONDS
            if log:
                self._missing_time_logged = now
            total = sum(self._missing_exchange_time.values())
        if log:
            _log.warning("refusing %s %s:%s %s without an exchange time (%d refused so far)",
                         source, market, code, event_type, total)
        _ledger().pulse_hot_fields(DataFlowStage.INGEST_ACCEPTED, lane=event_type, symbol=code,
                                   sequence=sequence, accepted=False, error="missing_exchange_time")

    def _add_loss(self, market: str, code: str, reason: str, connection: str, from_ns: int, to_ns: int, count: int) -> None:
        """Caller holds _lock: events of one instrument lost before Market Runtime, merged into the report waiting."""
        key = (str(market).upper(), str(code).strip().upper(), reason, connection)
        entry = self._losses.get(key)
        if entry is None:
            self._losses[key] = [int(from_ns), int(to_ns), int(count)]
        else:
            entry[0], entry[1], entry[2] = min(entry[0], int(from_ns)), max(entry[1], int(to_ns)), entry[2] + int(count)

    def _lost(self, event: RustLiveEvent) -> None:
        """An event this provider could not deliver though it keeps running (its queue was full): reported to Market
        Runtime, which writes the gap into the event's partition. A market Market Runtime never stores has no
        partition to mark; a reference read from the broker is published again by its publisher."""
        from service.market.shared.session_identity_contract import never_stored

        ts = exchange_time_ns(event)
        if ts <= 0 or never_stored(event.source, event.market):
            return
        with self._lock:
            self._add_loss(event.market, event.code, LOSS_DROPPED, "ingest", ts, ts, 1)

    def report_outage(self, instruments: Iterable[tuple[str, str]], from_ns: int, to_ns: int, *, connection: str) -> None:
        """A broker connection of this process delivered nothing from ``from_ns`` to ``to_ns`` for ``instruments``
        ((market, code) its streams carried) and was reconnected without the process restarting. Market Runtime
        judges whether it touched trading and keeps it as a hole in those codes' partitions."""
        from service.market.shared.session_identity_contract import never_stored

        with self._lock:
            for market, code in instruments:
                if not never_stored(self._source or self._adapter_source, market):
                    self._add_loss(market, code, LOSS_BROKER_OUTAGE, str(connection), from_ns, to_ns, 0)

    def report_outage_began(self, instruments: Iterable[tuple[str, str]], from_ns: int, *, connection: str) -> None:
        """A broker connection of this process stopped delivering at ``from_ns`` for ``instruments``. Told to Market
        Runtime ahead of the events still queued (``ingest.outage``): it takes each stored code's gap start now, and
        once the outage's report (``report_outage``) says it touched trading, answers the gaps to fill
        (restart_backfill.py, cause ``outage``). The same connection told again before it was sent keeps its earlier
        start."""
        from service.market.shared.session_identity_contract import never_stored

        source = self._source or self._adapter_source
        kept = {(str(market).upper(), str(code).strip().upper()) for market, code in instruments if not never_stored(source, market)}
        if not kept:
            return      # not an error: nothing the connection carried is stored, so no gap can be filled
        with self._lock:
            earlier = self._outages_began.get(str(connection))
            if earlier is not None:
                from_ns, kept = min(int(from_ns), earlier[0]), kept | earlier[1]
            self._outages_began[str(connection)] = (int(from_ns), kept)

    def _track(self, event: RustLiveEvent) -> None:
        ts = exchange_time_ns(event)
        if ts <= 0:
            return
        market = str(event.market).upper()
        with self._lock:
            self._unconfirmed.setdefault(market, Counter())[ts] += 1
            self._market_clock[market] = max(self._market_clock.get(market, 0), ts)

    def _untrack(self, event: RustLiveEvent) -> None:
        ts = exchange_time_ns(event)
        if ts <= 0:
            return
        with self._lock:
            counts = self._unconfirmed.get(str(event.market).upper())
            if counts is not None:
                counts[ts] -= 1
                if counts[ts] <= 0:
                    del counts[ts]

    def unconfirmed_before(self, markets: Iterable[str], end_ns: int) -> int:
        """Events (and loss reports) of these markets with an exchange time before ``end_ns`` that Market Runtime has
        not answered for good yet: a partition ending at ``end_ns`` can still change until this is 0. Queue state,
        not a record of partitions."""
        wanted = {str(market).upper() for market in markets}
        with self._lock:
            events = sum(n for market in wanted for ts, n in (self._unconfirmed.get(market) or {}).items() if ts < end_ns)
            waiting = sum(1 for (market, *_), (first, _last, _n) in self._losses.items() if market in wanted and first < end_ns)
        held = sum(1 for report in self._loss_reports.held()
                   if str(report["market"]).upper() in wanted and int(report["from_ns"]) < end_ns)
        return events + waiting + held

    def observed_market_clock(self, *markets: str) -> int:
        """The newest exchange time (ns) this process admitted for any of ``markets``; 0 if none."""
        wanted = {str(market).upper() for market in markets}
        with self._lock:
            return max((ts for market, ts in self._market_clock.items() if not wanted or market in wanted), default=0)

    def publish(self, event: RustLiveEvent) -> bool:
        if self._refuse_missing_time(event):
            return False
        with self._lock:
            accepting = self._accepting
            # A provider egress serves exactly one source; when none was configured it binds to the first event's.
            # (market_runtime rejects another source's events under this credential -- never silently accepted.)
            if not self._source and not self._adapter_source and event.source:
                self._source = str(event.source).strip().lower()
        if not accepting:
            # not an error: the process is ending. The successor's restart gap starts at each code's own last stored
            # print, so it covers this event; reported as a loss too, it would hold the partition at gap_detected
            # after that gap was filled. Counted, and logged once when the sink closes.
            with self._lock:
                self._refused_after_stop += 1
            return False
        # Counted as unanswered before it can be sent: the sender may answer it before put_nowait returns.
        self._track(event)
        try:
            self._queue.put_nowait(event)
        except queue.Full:  # not an error: counted as dropped, last_error set, and the loss reported to Market Runtime
            self._untrack(event)
            with self._lock:
                self._dropped += 1
                self._last_error = "rust live ingress queue full"
            self._lost(event)
            return False
        with self._lock:
            self._accepted += 1
            key = (event.market, event.code)
            if event.generation > self._generations.get(key, -1):
                self._generations[key] = event.generation
        _ledger().pulse_hot_fields(DataFlowStage.INGEST_ACCEPTED, lane=event.event_type, symbol=event.code,
                                   sequence=event.sequence, accepted=True, observed_epoch_ns=event.arrival_ns)
        return True

    def stop_admission(self) -> None:
        with self._lock:
            self._accepting = False

    def close(self, *, timeout: float = 1.5) -> dict[str, Any]:
        """Drain events admitted before the callback gate closed, bounded by SLA."""
        self.stop_admission()
        deadline = time.monotonic() + max(0.0, float(timeout))
        while time.monotonic() < deadline:
            with self._lock:
                pending = self._pending + self._durability.pending() + len(self._losses) + self._loss_reports.pending()
            if self._queue.unfinished_tasks == 0 and not pending:
                break
            time.sleep(0.002)
        self._stop.set()
        for thread in (self._thread, self._control_thread):
            if thread and thread is not threading.current_thread():
                thread.join(max(0.0, deadline - time.monotonic()))
        with self._lock:
            pending = self._pending
            unconfirmed = self._durability.pending()
            refused = self._refused_after_stop
        if refused:
            _log.info("%d events came after admission stopped: part of the restart gap of this process", refused)
        remaining = self._queue.unfinished_tasks
        return {"ok": remaining == 0 and not pending and not unconfirmed, "queue_unfinished": remaining,
                "pending": pending, "durable_pending": unconfirmed, "acked": self._acked, "accepted": self._accepted}

    def stats(self) -> dict[str, Any]:
        with self._lock:
            return {
                "schema": LIVE_EVENT_SCHEMA, "accepting": self._accepting, "queue_depth": self._queue.qsize(),
                "capacity": self._queue.maxsize, "accepted": self._accepted, "acked": self._acked, "rejected": self._rejected,
                "dropped": self._dropped, "refused_after_stop": self._refused_after_stop, "duplicate_after_retry": self._duplicate_after_retry, "short_acks": self._short_acks,
                "closed_partition": self._closed_partition,
                "missing_exchange_time": dict(self._missing_exchange_time), "last_missing_time": self._last_missing_time,
                "losses_waiting": len(self._losses), "losses_held": self._loss_reports.pending(),
                "losses_reported": self._losses_reported, "instance": self._instance,
                **self._durability.stats(),
                "transport_errors": self._transport_errors, "last_error": self._last_error, "pending": self._pending,
                "last_rejection": self._last_rejection,
                **(self._control.stats() if self._control is not None else {"plans_applied": 0, "last_plan": None}),
                "role": f"provider:{self._source or self._adapter_source}",
            }

    # ----------------------------------------------------------------------- delivery remediations
    _DELIVERY_MECHANISMS = {
        "short_ack": ("provider.short_ack_resend", "ack_shorter_than_batch"),
        "wal_full": ("provider.wal_queue_full_retry", "wal_queue_full"),
    }

    def _identity(self) -> dict[str, Any]:
        return {"source": self._source or self._adapter_source or None}

    def _delivery_begin(self, kind: str, detail: Mapping[str, Any]) -> None:
        """Start the kind's remediation (its first attempt), or count one more attempt of the one already open."""
        current = self._delivery_ops.get(kind)
        if current is not None:
            self._delivery_ops[kind] = (current[0], current[1] + 1)
            return
        mechanism, trigger = self._DELIVERY_MECHANISMS[kind]
        operation = remediation.emitter().begin(component="rust_event_sink", mechanism_id=mechanism, trigger_reason=trigger,
                                                identity=self._identity(), detail=detail)
        self._delivery_ops[kind] = (operation, 1)

    def _delivery_finish(self, kind: str, outcome: str, detail: Mapping[str, Any]) -> None:
        current = self._delivery_ops.pop(kind, None)
        if current is not None:
            current[0].finish(outcome, attempt=current[1], detail=detail)

    def _record_ack(self, event: RustLiveEvent, ack: Mapping[str, Any], *, resent: bool,
                    instance: str | None = None) -> bool:
        """Record one per-event ack. False: stored and not yet reported on disk -- the event is held."""
        if bool(ack.get("accepted")):
            # `live_only` (盤前試撮, a never-stored market): applied and shown, never written -- nothing to wait for.
            # A stored event is final only once a watermark of the same Rust A process passes its durable sequence.
            if ack.get("storage") != "live_only":
                self._durability.hold(event, int(ack.get("durable_sequence") or 0), instance)
                return False
            self._confirm(event)
            with self._lock:
                self._last_error = None
            return True
        reason = str(ack.get("reason") or "Rust event rejected")[:500]
        if resent and "RejectedSequence" in reason:
            # Applied before the connection dropped; the resend is a duplicate, not a loss.
            self._untrack(event)
            with self._lock:
                self._duplicate_after_retry += 1
                self._acked += 1
                self._last_error = None
            return True
        if reason == "PARTITION_CLOSED":
            # not an error: the session was sealed by its owner; Market Runtime counts and logs the refusal
            self._untrack(event)
            with self._lock:
                self._closed_partition += 1
            return True
        self._untrack(event)
        with self._lock:
            self._rejected += 1
            self._last_error = reason
            # Lane health aggregates instruments and retains its last error even
            # after a later success. Keep the actual rejected identity separately.
            self._last_rejection = {
                "reason": reason, "source": event.source, "market": event.market, "code": event.code,
                "generation": event.generation, "sequence": event.sequence, "event_type": event.event_type,
                "event_id": event.event_id or f"{event.source}:{event.market}:{event.code}:{event.generation}:{event.event_type}:{event.sequence}",
            }
        _ledger().pulse_hot_fields(DataFlowStage.MARKET_RUNTIME_ACKED, lane=event.event_type, symbol=event.code,
                                   sequence=event.sequence, accepted=False, error=reason)
        return True

    def _confirm(self, event: RustLiveEvent) -> None:
        self._untrack(event)
        with self._lock:
            self._acked += 1
        _ledger().pulse_hot_fields(DataFlowStage.MARKET_RUNTIME_ACKED, lane=event.event_type, symbol=event.code,
                                   sequence=event.sequence, accepted=True)

    def _settle_durable(self, payload: Mapping[str, Any]) -> list[RustLiveEvent]:
        """Apply a watermark Rust A pushed: held events of that process through it are on disk and released; events
        another process accepted are returned to be sent again (their sequences mean nothing to this one)."""
        instance = payload.get("instance_id")
        committed = int(payload.get("committed") or 0)
        released, orphaned, still_held = self._durability.settle(instance, committed)
        # Loss reports are held the same way: stored once the watermark passes them, sent again to another process.
        stored, lost_again, _ = self._loss_reports.settle(instance, committed)
        with self._lock:
            self._losses_reported += len(stored)
            for report, _old in lost_again:
                self._add_loss(report["market"], report["code"], report["reason"], report["connection"],
                               report["from_ns"], report["to_ns"], report["count"])
        wal_failed = payload.get("wal_failed")
        with self._lock:
            if orphaned:
                self._last_error = f"market_runtime restarted before {len(orphaned)} events were on disk: resending"
            elif wal_failed and still_held:
                self._last_error = f"WAL failed with {still_held} events not on disk: {wal_failed}"[:500]
        if wal_failed and still_held and str(wal_failed) != self._wal_failed_seen:
            # The held events wait for another Market Runtime process (its watermark orphans them and they go again);
            # the failure is recorded once per reason here, and by Market Runtime itself.
            self._wal_failed_seen = str(wal_failed)
            record_failure(_log, f"holding {still_held} events Market Runtime cannot write",
                           RuntimeError(f"WAL_FAILED: {wal_failed}"))
        for event in released:
            self._confirm(event)
            self._queue.task_done()
        if orphaned:
            # Another Rust A process now answers; what the old one accepted is sent again.
            remediation.emitter().emit(component="rust_event_sink", mechanism_id="provider.orphan_resend",
                                       trigger_reason="runtime_instance_changed", identity=self._identity(), outcome="succeeded",
                                       detail={"events": len(orphaned), "old_instances": sorted({str(old) for _, old in orphaned}),
                                               "new_instance": instance, "action": "resend"})
        # A resent event is still one queue item: it is task_done once its new ack and watermark settle it.
        return [event for event, _ in orphaned]

    def _send_outages_began(self, websocket: Any) -> list[RustLiveEvent]:
        """Tell Market Runtime the connections that went down (``ingest.outage``), before the loss reports that end
        them. One not answered goes again on the next connection. Returns events a watermark met on the way orphaned."""
        with self._lock:
            waiting, self._outages_began = self._outages_began, {}
        orphaned: list[RustLiveEvent] = []
        told: set[str] = set()
        for connection, (from_ns, instruments) in sorted(waiting.items()):
            payload = {"connection": connection, "from_ns": from_ns,
                       "instruments": [{"market": market, "code": code} for market, code in sorted(instruments)]}
            try:
                websocket.send(json.dumps({"type": "ingest.outage", "payload": payload}))
                while self._read_reply(websocket, self._ack_timeout, orphaned).get("type") != "ingest.outage.ack":
                    continue
                told.add(connection)
            except BaseException:
                # Those not told yet go again, merged with any reported since.
                with self._lock:
                    for rest, (rest_from, rest_instruments) in [(c, item) for c, item in waiting.items() if c not in told]:
                        newer = self._outages_began.get(rest, (rest_from, rest_instruments))
                        self._outages_began[rest] = (min(rest_from, newer[0]), rest_instruments | newer[1])
                raise
        return orphaned

    def _send_losses(self, websocket: Any) -> list[RustLiveEvent]:
        """Send the loss reports waiting (``ingest.loss``). Each stored one is held until the WAL watermark passes it;
        one Market Runtime could not take now goes again later. Returns events a watermark met on the way orphaned."""
        with self._lock:
            waiting, self._losses = self._losses, {}
        if not waiting:
            return []
        reports = [{"market": market, "code": code, "reason": reason, "connection": connection,
                    "from_ns": first, "to_ns": last, "count": count}
                   for (market, code, reason, connection), (first, last, count) in sorted(waiting.items())]
        orphaned: list[RustLiveEvent] = []
        try:
            websocket.send(json.dumps({"type": "ingest.loss", "payload": {"reports": reports}}))
            while True:
                reply = self._read_reply(websocket, self._ack_timeout, orphaned)
                if reply.get("type") == "ingest.loss.ack":
                    break
        except BaseException:
            with self._lock:
                for report in reports:
                    self._add_loss(report["market"], report["code"], report["reason"], report["connection"],
                                   report["from_ns"], report["to_ns"], report["count"])
            raise
        payload = reply.get("payload") or {}
        results = payload.get("results") or []
        # The broker outages the reports kept during trading whose gaps can be filled now (market_runtime outage_gap.rs).
        gaps = list(payload.get("gaps") or [])
        if gaps and self._gap_handler is not None:
            self._gap_handler(gaps)
        for index, report in enumerate(reports):
            result = results[index] if index < len(results) and isinstance(results[index], dict) else {}
            if not result.get("accepted"):
                with self._lock:
                    self._add_loss(report["market"], report["code"], report["reason"], report["connection"],
                                   report["from_ns"], report["to_ns"], report["count"])
                    self._last_error = f"loss report not stored yet: {result.get('reason') or 'no answer'}"[:500]
            elif result.get("durable_sequence") is not None:
                self._loss_reports.hold(report, int(result["durable_sequence"]), payload.get("instance_id"))
            else:
                with self._lock:
                    self._losses_reported += 1   # nothing to store: a broker outage outside trading
        if any(not (r if isinstance(r, dict) else {}).get("accepted") for r in results) or len(results) < len(reports):
            self._stop.wait(RETRY_FULL_SECONDS)
        return orphaned

    def evidence_command(self, kind: str, payload: dict[str, Any], *, timeout: float = 10.0) -> dict[str, Any]:
        """One session-evidence command (``evidence.seal`` and the like) on this provider's role, answered once Market
        Runtime wrote the partition's file. Its own short connection: the ingest connection belongs to the sender."""
        from websockets.sync.client import connect

        url = self._url()
        if url is None:
            raise RuntimeError(f"{kind}: no Market Runtime endpoint (the sink has no source yet)")
        with connect(url, additional_headers=self._auth_headers(), proxy=None, open_timeout=2.0, close_timeout=0.1) as websocket:
            websocket.send(json.dumps({"type": kind, "payload": payload}))
            deadline = time.monotonic() + timeout
            while True:
                reply = json.loads(websocket.recv(timeout=max(0.05, deadline - time.monotonic())))
                if reply.get("type") == f"{kind}.ack":
                    return dict(reply.get("payload") or {})
                if reply.get("type") == "error":
                    raise RuntimeError(f"{kind} refused by Market Runtime: {reply.get('error')} {reply.get('detail') or ''}".strip())

    def _read_reply(self, websocket: Any, timeout: float, resend: list[RustLiveEvent]) -> dict[str, Any]:
        """The next frame that is not a watermark push (TimeoutError when none came in `timeout`). Pushes met on the
        way are applied; events they orphan are added to `resend`."""
        while True:
            reply = json.loads(websocket.recv(timeout=timeout))
            if reply.get("type") == "event.durable":
                resend.extend(self._settle_durable(reply.get("payload") or {}))
                continue
            if reply.get("type") == "error":
                raise RuntimeError(f"market_runtime refused ingest: {reply.get('error')}")
            return reply

    def _listen_for_watermark(self, websocket: Any, resend: list[RustLiveEvent], timeout: float) -> None:
        """Apply the watermark pushes that arrive within `timeout` (0: only those already received)."""
        try:
            reply = self._read_reply(websocket, timeout, resend)
        except TimeoutError:  # not an error: no further watermark pushed in this slice
            return
        raise ValueError(f"market_runtime sent {reply.get('type')!r} with no batch outstanding")

    def _next_batch(self, websocket: Any) -> list[RustLiveEvent]:
        """Up to BATCH_MAX queued events, or events a watermark orphaned. The connection is read between queue polls
        whether or not events are held: Market Runtime pushes its watermark whenever it moves, other providers' events
        moving it too, and pushes left unread stop websockets reading the socket (16 frames buffered), so the pong of
        its keepalive is never seen and the connection is closed. While events are held the read waits a slice, so
        their watermark releases them even when nothing new arrives."""
        resend: list[RustLiveEvent] = []
        while not self._stop.is_set():
            with self._lock:
                if self._losses or self._outages_began:
                    return resend   # the outage starts and loss reports go first (_run)
            held = self._durability.pending() > 0
            try:
                batch = [self._queue.get(timeout=HELD_LISTEN_SECONDS if held else 0.05)]
            except queue.Empty:  # not an error: nothing queued in this slice: read the watermark pushes, then look again
                self._listen_for_watermark(websocket, resend, HELD_LISTEN_SECONDS if held else 0)
                if resend:
                    return resend
                continue
            while len(batch) < BATCH_MAX:
                try:
                    batch.append(self._queue.get_nowait())
                except queue.Empty:  # not an error: the queue is drained
                    break
            return resend + batch
        return resend

    @staticmethod
    def _transport_trigger(exc: BaseException, opened: bool) -> str:
        """The registered trigger reason of a lost (or never opened) ingest connection."""
        if not opened:
            return "connect_failed"
        text = str(exc)
        if isinstance(exc, RuntimeError) and "refused ingest" in text:
            return "ingest_refused"
        if isinstance(exc, TimeoutError):
            return "ack_timeout"
        if isinstance(exc, (ValueError, KeyError, TypeError)):
            return "protocol_error"
        return "send_failed"

    def _run(self) -> None:
        from websockets.sync.client import connect

        pending: list[RustLiveEvent] = []
        resent = False
        delay = 0.05
        # A lost (or unopenable) ingest connection is one remediation -- started at the failure, succeeded once
        # the batch held across it is acknowledged on a new connection (or at once when nothing was held), abandoned
        # if the sink stops first. An open socket alone restored nothing.
        reconnect: remediation.RemediationOperation | None = None
        attempts = 0
        # The events pending when the connection was lost (by identity): the reconnect is over only once each has a
        # terminal answer -- accepted, a duplicate, or refused for good -- never on the first ack frame.
        held: set[int] = set()
        while not self._stop.is_set():
            url = self._url()
            if url is None:
                self._stop.wait(0.2)
                continue
            opened = False
            try:
                with connect(url, additional_headers=self._auth_headers(), proxy=None, open_timeout=2.0, close_timeout=0.1,
                             max_size=64 * 1024 * 1024) as websocket:
                    opened = True
                    delay = 0.05
                    if reconnect is not None and not held:
                        reconnect.finish("succeeded", attempt=attempts, detail={"pending_resent": 0})
                        reconnect = None
                    # The WAL watermark of this Rust A process, pushed now and whenever it moves: it releases what is
                    # held, events held across a lost connection too, and its instance id says whether they were
                    # taken by this process at all.
                    websocket.send(json.dumps({"type": "event.durable.subscribe"}))
                    # Who this process is: Market Runtime records a restart of this source's open partitions when it
                    # is another process than the one that recorded them.
                    websocket.send(json.dumps({"type": "ingest.hello", "payload": {"instance": self._instance,
                                                                                    "fills_gaps": self._gap_handler is not None}}))
                    while (hello := self._read_reply(websocket, self._ack_timeout, pending)).get("type") != "ingest.hello.ack":
                        continue
                    gaps = list((hello.get("payload") or {}).get("gaps") or [])
                    if gaps and self._gap_handler is not None:
                        self._gap_handler(gaps)
                    while not self._stop.is_set():
                        if not pending:
                            pending = self._send_outages_began(websocket)
                        if not pending:
                            pending = self._send_losses(websocket)
                        if not pending:
                            pending = self._next_batch(websocket)
                            if not pending:
                                continue
                            with self._lock:
                                self._pending = len(pending)
                        websocket.send(json.dumps({"type": "event.ingest.batch", "payload": {"events": [e.as_dict() for e in pending]}},
                                                  separators=(",", ":"), ensure_ascii=False))
                        orphaned: list[RustLiveEvent] = []
                        while True:
                            reply = self._read_reply(websocket, self._ack_timeout, orphaned)
                            if reply.get("type") == "event.ack.batch":
                                break
                        results = (reply.get("payload") or {}).get("results") or []
                        instance = (reply.get("payload") or {}).get("instance_id")
                        # A late join the batch revealed: the window from its session's open to its first print.
                        late = list((reply.get("payload") or {}).get("gaps") or [])
                        if late and self._gap_handler is not None:
                            self._gap_handler(late)
                        duplicates_before = self._duplicate_after_retry
                        retry: list[RustLiveEvent] = []
                        for event, result in zip(pending, results):
                            result = result if isinstance(result, dict) else {}
                            if not result.get("accepted") and _retryable(result):
                                retry.append(event)  # still ours: not acknowledged, not rejected, not task_done
                                continue
                            held.discard(id(event))
                            if self._record_ack(event, result, resent=resent, instance=instance):
                                self._queue.task_done()
                        if reconnect is not None and not held:
                            reconnect.finish("succeeded", attempt=attempts, detail={"answered": len(results), "instance": instance})
                            reconnect = None
                        # An ack shorter than the batch says nothing about the rest: they may or may not be applied.
                        # They are resent, as after a dropped connection, where a duplicate answers RejectedSequence
                        # and is counted as such -- recording them as rejected lost them for good.
                        unanswered = pending[len(results):]
                        retry.extend(unanswered)
                        resent = bool(unanswered) or bool(orphaned)
                        pending = orphaned + retry
                        with self._lock:
                            self._pending = len(pending)
                        duplicates = self._duplicate_after_retry - duplicates_before
                        if duplicates:
                            # Events of a resend that Market Runtime had already applied -- kept once, not lost.
                            remediation.emitter().emit(component="rust_event_sink", mechanism_id="provider.resend_duplicate",
                                                       trigger_reason="rejected_sequence_after_resend", identity=self._identity(),
                                                       outcome="succeeded", detail={"events": duplicates, "instance": instance,
                                                                                    "batch": len(results)})
                        if unanswered:
                            with self._lock:
                                self._short_acks += 1
                                self._last_error = f"market_runtime acked {len(results)} of a batch: resending {len(unanswered)}"
                            self._delivery_begin("short_ack", {"batch": len(results) + len(unanswered), "acked": len(results),
                                                               "resend": len(unanswered), "instance": instance})
                        else:
                            self._delivery_finish("short_ack", "succeeded", {"batch": len(results), "instance": instance})
                        if retry and not unanswered:
                            # Market Runtime's WAL queue was full (a disk stall): the events were NOT applied, so the
                            # same batch goes again after a pause instead of being counted as rejected and lost.
                            with self._lock:
                                self._last_error = "market_runtime WAL queue full: retrying"
                            self._delivery_begin("wal_full", {"events": len(retry), "instance": instance,
                                                              "reason": "WAL_QUEUE_FULL"})
                        elif not retry:
                            self._delivery_finish("wal_full", "succeeded", {"batch": len(results), "instance": instance})
                        if retry:
                            self._stop.wait(RETRY_FULL_SECONDS)
            except Exception as exc:
                # Every failed delivery is logged (repeats folded by record_failure); the outage is one recorded
                # provider.ingest_reconnect, begun below and ended when a batch is delivered again.
                record_failure(_log, "delivering events to Market Runtime (connecting again)", exc)
                if pending:
                    resent = True
                with self._lock:
                    self._transport_errors += 1
                    self._last_error = f"{type(exc).__name__}: {exc}"[:500]
                if reconnect is None:
                    attempts = 0
                    held = {id(event) for event in pending}
                    reconnect = remediation.emitter().begin(
                        component="rust_event_sink", mechanism_id="provider.ingest_reconnect",
                        trigger_reason=self._transport_trigger(exc, opened),
                        identity={"source": self._source or self._adapter_source or None},
                        detail={"pending": len(pending), "queued": self._queue.qsize(), "error": self._last_error})
                attempts += 1
                self._stop.wait(delay)
                delay = min(2.0, delay * 2.0)
        if reconnect is not None:
            reconnect.finish("abandoned", attempt=attempts, detail={"pending": len(pending), "held_unanswered": len(held),
                                                                    "reason": "sink stopped"})
        for kind in list(self._delivery_ops):
            self._delivery_finish(kind, "abandoned", {"pending": len(pending), "reason": "sink stopped"})
