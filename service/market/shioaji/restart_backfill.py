"""The prints nothing recorded during a session, filled from the broker's history: a provider restart's gap
(decisions.md 盤中重啟的缺口只補空檔時段), a late join's (盤中才訂閱的商品補當天資料) and a broker-connection outage's
(券商連線自己重連的空檔記在商品層), by one path.

- A restart: when this process starts during a session its predecessor was recording, Market Runtime answers its
  ``ingest.hello`` with where each stored code's gap starts (``gaps``: the code's newest stored print, the volume
  stored at exactly that exchange time, and the cumulative volume then; Engine::gap_starts). The gap ends where this
  process's own stream takes over: the code's first live print after the start (its exchange time; never this
  machine's clock, which is not the exchange's). A code that does not print again ends at its session's close.
- A late join: a code this process subscribed once its session was trading (each subscription report states when,
  ``since_ns``). Market Runtime notices its first print and answers the ingest batch that carried it with the gap
  (``event.ack.batch`` ``gaps``, cause ``late_join``, market_runtime late_join.rs): from the session's open to that
  print, whose exchange time and cumulative volume it states. Stored when the code is on the background list, sent
  over the live lane to Rust B when it is not: Market Runtime decides, as for any event of the code.
- A broker-connection outage: a connection of this process stopped delivering and came back without the process
  restarting (the SDK reconnecting it, or a re-login). When it went down this process told Market Runtime
  (``ingest.outage``), which took each stored code's gap start then; once the outage's report (``ingest.loss``) says it
  touched the code's trading, Market Runtime answers the gap (cause ``outage``, market_runtime outage_gap.rs) with its
  end: the code's first print after the start, whose exchange time and cumulative volume it states, or none when the
  code did not print again before its session's close.

- A closed session viewed (decisions.md 收盤後看任何商品都要有資料): a view opened on a finished session of a code
  Market Runtime holds nothing of. Its whole session is fetched and sent ``view_only``: shown and folded by Rust B over
  the live lane, never written and never reported, listed or not. What a listed code keeps is the fill after its
  session's materialization (history_fill.listed_without_partition).

Only that window is fetched (``api.ticks`` RangeTime), never the day:

- a stock or a futures contract: each history print inside the window becomes a backfill trade (flags.backfill,
  backfill_cutoff_ns = the window's end) carrying its cumulative volume -- the gap's start plus the window's prints so
  far -- so Rust B places it in the volume it was missing (accum::TradeChain). At the start instant the volume Market
  Runtime already holds is skipped; at the end instant nothing is taken (the live stream holds that instant).
- an index: each history print is the index's value at that instant (every 5 s, as its live quotes) and becomes a
  backfill quote of that value, as the close's fill does (history_fill.fill_events): Rust B's features take an index
  only while its clock is ahead of the stock's last finished minute (features.rs fresh), which one bar per minute
  never is. The gap's day open / high / low are not in it (0 = not stated); the history has no amount or cumulative
  volume.

Each code is reported once with ``ingest.backfill`` after its events are stored: how many prints, their volume, the
cumulative volume the gap started from and the first live print's before its own. Market Runtime marks the code
filled only when those meet (evidence::Ledger::backfill_reported). Each fill is one recorded remediation
(provider.restart_backfill, provider.late_join_backfill).

A gap the broker's history cannot hold yet (``history_held_from``: a futures night's prints before its midnight) is
not fetched: it is reported ``after_close`` and left to the fill after the session's materialization
(history_fill.py), which folds every gap Rust B finds in the materialized session.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import date, datetime, time as dtime, timedelta
from pathlib import Path
from typing import Any, Callable, Iterable
from zoneinfo import ZoneInfo

from service.market.shared.market_trade_semantics import shioaji_tick_side
from service.market.shared.native_values import price_to_units
from service.market.shared.rust_live import RustLiveEvent
from service.platform import remediation
from service.platform.atomic_files import write_json_atomic
from service.platform.failure_record import record_failure

_log = logging.getLogger(__name__)
_TAIPEI = ZoneInfo("Asia/Taipei")
# Shioaji's history ticks carry Taipei wall time as if it were UTC.
_TAIPEI_OFFSET_NS = 8 * 3600 * 1_000_000_000

# Shioaji's published market-data query limit: 50 queries (ticks, kbars, snapshots) per 10 seconds.
QUERY_LIMIT = 50
QUERY_WINDOW_S = 10.0
# Shioaji's published limit on ticks queries during trading: 10. It states neither a period nor whether it is per
# contract, and repeated breaches suspend the IP and ID, so it is held as the strictest reading: 10 queries in all per
# day during the Taiwan day session, surviving this process's restarts (a restart is what asks for the queries).
INTRADAY_TICKS_LIMIT = 10
_INTRADAY_OPEN = dtime(8, 45)
_INTRADAY_CLOSE = dtime(13, 45)


class Pacer:
    """At most QUERY_LIMIT queries in any QUERY_WINDOW_S, across every caller of this process's login."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sent: deque[float] = deque()

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            while self._sent and now - self._sent[0] >= QUERY_WINDOW_S:
                self._sent.popleft()
            if len(self._sent) >= QUERY_LIMIT:
                time.sleep(max(0.0, QUERY_WINDOW_S - (now - self._sent[0])))
                self._sent.popleft()
            self._sent.append(time.monotonic())


QUERY_PACER = Pacer()


class IntradayTicksLimit(RuntimeError):
    """Today's intraday ticks queries are used up: the gap is left to the fill after the session's materialization."""


class IntradayTicksBudget:
    """The ticks queries made today during the Taiwan day session, counted in one file so a restarted provider
    continues the day's count."""

    def __init__(self, path: Path, *, clock: Callable[[], int] = time.time_ns) -> None:
        self._path = Path(path)
        self._clock = clock
        self._lock = threading.Lock()

    def _used(self, day: str) -> int:
        try:
            state = json.loads(self._path.read_text(encoding="utf-8"))
        except FileNotFoundError:  # not an error: no intraday query has been made yet
            return 0
        except (OSError, ValueError) as exc:
            # Unknown is treated as used up: a wrong guess here risks the broker suspending the ID.
            record_failure(_log, f"reading the intraday ticks count {self._path}", exc)
            return INTRADAY_TICKS_LIMIT
        return int(state.get("used") or 0) if state.get("date") == day else 0

    def take(self) -> bool:
        """Whether one more ticks query may be made now; a query allowed during the session is counted."""
        now = datetime.fromtimestamp(self._clock() / 1e9, _TAIPEI)
        if not _INTRADAY_OPEN <= now.time() <= _INTRADAY_CLOSE:
            return True
        day = now.date().isoformat()
        with self._lock:
            used = self._used(day)
            if used >= INTRADAY_TICKS_LIMIT:
                return False
            self._path.parent.mkdir(parents=True, exist_ok=True)
            write_json_atomic(self._path, {"date": day, "used": used + 1}, durable=True)
            return True


def _us(ns: int) -> int:
    """Exchange times compared to the microsecond: the stream's times come from a float conversion."""
    return (int(ns) + 500) // 1000


CAUSE_RESTART = "restart"
CAUSE_LATE_JOIN = "late_join"
CAUSE_OUTAGE = "outage"
CAUSE_CLOSED_VIEW = "closed_view"
_CLOSED_VIEW_ADMIT_S = 30.0  # how long one print of a closed session waits for room in the ingress queue
# Per cause: the remediation it is recorded as, and its trigger.
_MECHANISMS = {CAUSE_RESTART: ("provider.restart_backfill", "provider_restart"),
               CAUSE_LATE_JOIN: ("provider.late_join_backfill", "late_join"),
               CAUSE_OUTAGE: ("provider.outage_backfill", "broker_connection_outage"),
               CAUSE_CLOSED_VIEW: ("provider.closed_view_backfill", "closed_session_view")}


@dataclass
class Gap:
    market: str
    code: str
    trading_date: str
    session: str
    after_ns: int
    volume_at_after: float
    total_before: float | None
    restart_from_ns: int
    restart_to_ns: int
    cause: str = CAUSE_RESTART
    # A late join: when this process subscribed the code. A closed session viewed: when it was asked for.
    since_ns: int = 0
    # A broker-connection outage: the connection and the outage's end (as its report stated them).
    connection: str = ""
    outage_to_ns: int = 0
    # The first print after the gap (exchange ns, its cumulative volume less its own): stated by Market Runtime for a
    # late join and an outage, observed on the live stream for a restart.
    next_ns: int | None = None
    next_total_before: float | None = None
    done: bool = False
    key: tuple[str, str, str, str] = field(init=False)

    def __post_init__(self) -> None:
        self.key = (self.market, self.code, self.trading_date, self.session)

    @property
    def cause_ns(self) -> int:
        """The moment that names this gap: its restart, its late subscription, or its outage's end."""
        if self.cause == CAUSE_OUTAGE:
            return self.outage_to_ns
        return self.restart_to_ns if self.cause == CAUSE_RESTART else self.since_ns

    @classmethod
    def from_wire(cls, item: dict[str, Any]) -> "Gap":
        total = item.get("total_before")
        cause = str(item.get("cause") or CAUSE_RESTART)
        if cause not in _MECHANISMS:
            raise ValueError(f"a gap of unknown cause {cause!r}")
        late = cause in (CAUSE_LATE_JOIN, CAUSE_CLOSED_VIEW)
        outage = cause == CAUSE_OUTAGE
        restart = cause == CAUSE_RESTART
        # Market Runtime states the end of a late join's gap, and of an outage's whose code printed again.
        stated_end = not restart and item.get("next_ns") is not None
        next_total = item.get("next_total_before")
        return cls(market=str(item["market"]).upper(), code=str(item["code"]).upper(), trading_date=str(item["trading_date"]),
                   session=str(item["session"]).upper(), after_ns=int(item.get("after_ns") or 0),
                   volume_at_after=float(item.get("volume_at_after") or 0.0), total_before=None if total is None else float(total),
                   restart_from_ns=int(item["restart_from_ns"]) if restart else 0,
                   restart_to_ns=int(item["restart_to_ns"]) if restart else 0,
                   cause=cause, since_ns=int(item["since_ns"]) if late else 0,
                   connection=str(item["connection"]) if outage else "", outage_to_ns=int(item["outage_to_ns"]) if outage else 0,
                   next_ns=int(item["next_ns"]) if stated_end else None,
                   next_total_before=None if not stated_end or next_total is None else float(next_total))


class HistoryUnavailable(RuntimeError):
    """The broker answered a window's query with prints of other dates only: it does not hold that date's history
    yet (seen 11-06 for a futures night in progress, under both date arguments). Nothing of it is taken."""


def on_date(ticks: Any, day: date) -> bool:
    """Whether any of a query's prints is of calendar date `day` (Taipei)."""
    return any(datetime.fromtimestamp((int(ts) - _TAIPEI_OFFSET_NS) / 1e9, _TAIPEI).date() == day for ts in ticks.ts)


def window_prints(ticks: Any, gap: Gap, end_ns: int, *, end_is_live: bool) -> list[tuple[int, float, float, int]]:
    """The history prints of the gap, oldest first: (exchange ns, price, volume, tick_type). After the start instant
    only; at it, what Market Runtime holds there is skipped first. Before the end instant when the end is a live print
    (the stream holds that instant); through the end when it is the session's close."""
    rows = []
    for ts, close, volume, tick_type in zip(ticks.ts, ticks.close, ticks.volume, ticks.tick_type):
        rows.append((int(ts) - _TAIPEI_OFFSET_NS, float(close), float(volume), int(tick_type)))
    rows.sort(key=lambda r: r[0])
    after_us, end_us = _us(gap.after_ns), _us(end_ns)
    held = gap.volume_at_after
    out = []
    for ns, price, volume, tick_type in rows:
        at = _us(ns)
        if gap.after_ns > 0 and at < after_us:
            continue
        if gap.after_ns > 0 and at == after_us and held > 1e-9:
            held -= volume
            continue
        if at > end_us or (end_is_live and at == end_us):
            continue
        if price <= 0 or volume <= 0:
            continue
        out.append((ns, price, volume, tick_type))
    return out


def closing_book(ticks: Any, end_ns: int) -> tuple[int, float, float, float, float] | None:
    """The newest best bid and ask a query's prints state up to `end_ns`: (exchange ns, bid, bid volume, ask, ask
    volume). The broker's history holds this one level only, never the other four."""
    rows = zip(ticks.ts, getattr(ticks, "bid_price", ()), getattr(ticks, "bid_volume", ()), getattr(ticks, "ask_price", ()), getattr(ticks, "ask_volume", ()))
    best = None
    for ts, bid, bid_volume, ask, ask_volume in rows:
        ns = int(ts) - _TAIPEI_OFFSET_NS
        if ns <= end_ns and (bid > 0 or ask > 0) and (best is None or ns >= best[0]):
            best = (ns, float(bid), float(bid_volume), float(ask), float(ask_volume))
    return best


def query_spans(start_ns: int, end_ns: int) -> list[tuple[date, str, str]]:
    """The RangeTime queries covering [start, end]: (calendar date, time_start, time_end), one per Taipei calendar
    date the window touches (a range is times of one day; a night session crosses midnight)."""
    start = datetime.fromtimestamp(start_ns / 1_000_000_000, _TAIPEI)
    end = datetime.fromtimestamp(end_ns / 1_000_000_000, _TAIPEI)
    spans = []
    day = start.date()
    while day <= end.date():
        lo = start if day == start.date() else datetime.combine(day, datetime.min.time(), _TAIPEI)
        hi = end if day == end.date() else datetime.combine(day, datetime.max.time(), _TAIPEI)
        # Whole seconds around the window: the prints are cut to it exactly afterwards.
        hi_ceil = hi.replace(microsecond=0) + (timedelta(seconds=1) if hi.microsecond else timedelta())
        spans.append((day, lo.strftime("%H:%M:%S"), min(hi_ceil, datetime.combine(day, datetime.max.time(), _TAIPEI)).strftime("%H:%M:%S")))
        day += timedelta(days=1)
    return spans


class RestartBackfill:
    """The gaps of one provider restart, filled on one worker thread as each code's end becomes known."""

    def __init__(self, *, fetch: Callable[[Gap, date, str, str], Any], query_dates: Callable[[Gap, date], list[date]],
                 publish: Callable[[RustLiveEvent], bool],
                 next_sequence: Callable[[str], int], admission_lock: Any, generation: Callable[[], int], scale: int,
                 report: Callable[[list[dict[str, Any]]], dict[str, Any]], session_open_ns: Callable[[Gap], int],
                 session_end_ns: Callable[[Gap], int], stored: Callable[[str, int], bool],
                 history_held_from: Callable[[Gap], int], ticks_budget: IntradayTicksBudget,
                 clock: Callable[[], int] = time.time_ns, prev_close: Callable[[Gap], float | None] = lambda gap: None,
                 closing_state: Callable[[Gap], Any] = lambda gap: None, cache: Any = None) -> None:
        self._fetch = fetch
        self._prev_close = prev_close
        self._closing_state = closing_state
        self._cache = cache
        self._ticks_budget = ticks_budget
        self._history_held_from = history_held_from
        self._query_dates = query_dates
        self._publish = publish
        self._next_sequence = next_sequence
        self._admission_lock = admission_lock
        self._generation = generation
        self._scale = scale
        self._report = report
        self._session_open_ns = session_open_ns
        self._session_end_ns = session_end_ns
        self._stored = stored
        self._clock = clock
        self._gaps: dict[tuple[str, str], list[Gap]] = {}
        self._cond = threading.Condition()
        self._stopping = False
        self._thread: threading.Thread | None = None
        self.stats = {"requested": 0, "filled": 0, "failed": 0, "deferred": 0, "prints": 0, "queries": 0, "superseded": 0}

    # ------------------------------------------------------------------ inputs
    def requested(self, items: Iterable[dict[str, Any]]) -> None:
        """Market Runtime's gaps for this process: a restart's (``ingest.hello.ack``), a late join's
        (``event.ack.batch``)."""
        gaps = []
        for item in items:
            try:
                gaps.append(Gap.from_wire(item))
            except (KeyError, TypeError, ValueError) as exc:
                self.stats["failed"] += 1
                record_failure(_log, f"reading a gap Market Runtime named ({item!r:.200})", exc)
        if not gaps:
            return
        with self._cond:
            for gap in gaps:
                self._gaps.setdefault((gap.market, gap.code), []).append(gap)
            self.stats["requested"] += len(gaps)
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._run, name="ShioajiRestartBackfill", daemon=True)
                self._thread.start()
            self._cond.notify_all()

    def observe(self, market: str, code: str, exchange_ns: int, total_volume: float | None, volume: float | None) -> None:
        """A live print (or a TXF/index quote): the first after a pending gap's start ends that gap. A closed session
        view still waiting for its close is dropped instead: the live stream is that partition's source now, and what
        it missed before its first print is Market Runtime's late join to name."""
        if not self._gaps:
            return
        with self._cond:
            for gap in self._gaps.get((market, code), ()):
                if gap.done or gap.next_ns is not None or exchange_ns <= gap.after_ns:
                    continue
                if gap.cause == CAUSE_CLOSED_VIEW:
                    # Only a print of that partition: a view of a past session is not this stream's.
                    if not self._session_open_ns(gap) <= exchange_ns <= self._session_end_ns(gap):
                        continue
                    gap.done = True
                    self.stats["superseded"] += 1
                    continue
                gap.next_ns = int(exchange_ns)
                # A quote that traded nothing of its own (volume 0) states the total before it as it is.
                if total_volume is not None and volume is not None and total_volume > 0 and volume >= 0:
                    gap.next_total_before = float(total_volume) - float(volume)
                self._cond.notify_all()

    def stop(self) -> None:
        with self._cond:
            self._stopping = True
            self._cond.notify_all()
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(5.0)

    def pending(self) -> int:
        with self._cond:
            return sum(1 for gaps in self._gaps.values() for gap in gaps if not gap.done)

    # ------------------------------------------------------------------ worker
    def _ready(self) -> tuple[Gap | None, float | None]:
        """The next gap whose end is known (its first live print, or its session's close passed), and else how long
        until the soonest close."""
        now = self._clock()
        soonest = None
        for gaps in self._gaps.values():
            for gap in gaps:
                if gap.done:
                    continue
                if gap.next_ns is not None:
                    return gap, None
                close = self._session_end_ns(gap)
                if now >= close:
                    return gap, None
                soonest = close if soonest is None else min(soonest, close)
        return None, None if soonest is None else max(0.0, (soonest - now) / 1e9)

    def _run(self) -> None:
        while True:
            with self._cond:
                while True:
                    if self._stopping:
                        return
                    gap, wait = self._ready()
                    if gap is not None:
                        break
                    self._cond.wait(wait)
                end_ns = gap.next_ns if gap.next_ns is not None else self._session_end_ns(gap)
                end_is_live = gap.next_ns is not None
            self._fill(gap, end_ns, end_is_live)
            with self._cond:
                gap.done = True
                self._gaps[(gap.market, gap.code)] = [g for g in self._gaps.get((gap.market, gap.code), []) if not g.done]
                if not self._gaps[(gap.market, gap.code)]:
                    del self._gaps[(gap.market, gap.code)]

    def _fill(self, gap: Gap, end_ns: int, end_is_live: bool) -> None:
        start_ns = gap.after_ns if gap.after_ns > 0 else self._session_open_ns(gap)
        mechanism, trigger = _MECHANISMS[gap.cause]
        detail = {"from": datetime.fromtimestamp(start_ns / 1e9, _TAIPEI).isoformat(timespec="milliseconds"),
                  "to": datetime.fromtimestamp(end_ns / 1e9, _TAIPEI).isoformat(timespec="milliseconds"),
                  "end": "first_live_print" if end_is_live else "session_close"}
        if gap.cause == CAUSE_LATE_JOIN:
            detail["subscribed"] = datetime.fromtimestamp(gap.since_ns / 1e9, _TAIPEI).isoformat(timespec="milliseconds")
        if gap.cause == CAUSE_OUTAGE:
            detail["connection"] = gap.connection
            detail["outage_end"] = datetime.fromtimestamp(gap.outage_to_ns / 1e9, _TAIPEI).isoformat(timespec="milliseconds")
        operation = remediation.emitter().begin(
            component="restart_backfill", mechanism_id=mechanism, trigger_reason=trigger,
            identity={"source": "shioaji", "market": gap.market, "code": gap.code, "session": gap.session, "trading_date": gap.trading_date},
            detail=detail)
        report = {"market": gap.market, "code": gap.code, "trading_date": gap.trading_date, "session": gap.session, "cause": gap.cause,
                  "restart_to_ns": gap.restart_to_ns, "end": "first_live_print" if end_is_live else "session_close",
                  "total_before": gap.total_before, "next_total_before": gap.next_total_before if end_is_live else None}
        if gap.cause == CAUSE_OUTAGE:
            # The outage the fill answers (evidence.rs OutageFill: its connection and end).
            report.update({"connection": gap.connection, "outage_to_ns": gap.outage_to_ns})
        held_from = self._history_held_from(gap)
        if self._clock() < held_from:
            # Asked now, the broker answers another session's prints (HistoryUnavailable): the gap is the close's fill's.
            reason = (f"the broker's history holds this session's prints from "
                      f"{datetime.fromtimestamp(held_from / 1e9, _TAIPEI).isoformat(timespec='seconds')}; filled after the close")
            self._leave_to_close(gap, operation, report, reason, {"reason": "history_not_held_yet", "held_from": held_from})
            return
        try:
            prints: list[tuple[int, float, float, int]] = []
            fetched, raw_first, raw_last, used = 0, None, None, []
            book = None
            viewed = gap.cause == CAUSE_CLOSED_VIEW
            cached = self._cache.load(gap) if viewed and self._cache is not None else None
            if cached is not None:
                prints, book = list(cached.prints), cached.book
            # A code with no stored print yet: its gap runs from its session's open.
            for day, time_start, time_end in () if cached is not None else query_spans(start_ns, end_ns):
                # The broker's date argument is not always the calendar date (a futures night): each candidate is
                # tried until one returns prints that fall inside the window by their own exchange time; prints of
                # any other day are never taken.
                answered_other_dates = False
                for query_date in self._query_dates(gap, day):
                    if not self._ticks_budget.take():
                        raise IntradayTicksLimit(f"the day's {INTRADAY_TICKS_LIMIT} intraday ticks queries are used")
                    QUERY_PACER.wait()
                    self.stats["queries"] += 1
                    ticks = self._fetch(gap, query_date, time_start, time_end)
                    stamps = list(ticks.ts or [])
                    fetched += len(stamps)
                    if stamps:
                        raw_first = min(stamps) if raw_first is None else min(raw_first, min(stamps))
                        raw_last = max(stamps) if raw_last is None else max(raw_last, max(stamps))
                    kept = window_prints(ticks, gap, end_ns, end_is_live=end_is_live)
                    used.append({"date": query_date.isoformat(), "fetched": len(stamps), "kept": len(kept)})
                    if kept:
                        prints.extend(kept)
                        answered_other_dates = False
                        quoted = closing_book(ticks, end_ns)
                        book = quoted if book is None or (quoted and quoted[0] >= book[0]) else book
                        break
                    if stamps and not on_date(ticks, day):
                        answered_other_dates = True
                    elif stamps or not answered_other_dates:
                        answered_other_dates = False
                        break
                if answered_other_dates:
                    raise HistoryUnavailable(f"the broker's tick history holds no {day.isoformat()} prints yet "
                                             f"(answered other dates: {used})")
            prints.sort(key=lambda r: r[0])
            # What the history does not hold: the exchange's closing state, read once for this view (closing_state_source.py).
            if cached is not None:
                closing, prev_close = cached.closing, cached.prev_close
            else:
                closing = self._closing_state(gap) if viewed and gap.market == "STK" else None
                prev_close = closing.prev_close if closing is not None and closing.prev_close is not None else (self._prev_close(gap) if viewed else None)
            if closing is not None:
                self._publish_closing_reference(gap, closing, start_ns, end_ns)
            published, volume = self._publish_prints(gap, prints, end_ns, stated_prev_close=None if closing is not None and closing.prev_close is not None else prev_close)
            if gap.cause == CAUSE_CLOSED_VIEW and gap.market != "IDX":
                last_ns = max([p[0] for p in prints], default=start_ns)
                if closing is not None and (closing.bids or closing.asks):
                    self._publish_closing_book(gap, last_ns, closing.bids, closing.asks, end_ns)
                elif book is not None:
                    self._publish_closing_book(gap, book[0], [(book[1], book[2])], [(book[3], book[4])], end_ns)
            # Nothing fetched is nothing learned: an empty answer may be a session the broker does not hold yet.
            if viewed and cached is None and prints and self._cache is not None:
                self._cache.save(gap, prints=prints, book=book, closing=closing, prev_close=prev_close)
            last_ns = max([p[0] for p in prints], default=0)
            while not self._stopping and last_ns and gap.cause != CAUSE_CLOSED_VIEW and not self._stored(gap.market, last_ns + 1):
                with self._cond:
                    self._cond.wait(0.2)
            answer = self._report_fill(gap, [{**report, "outcome": "stored", "prints": published, "volume": volume,
                                              "history_last_ns": None if raw_last is None else int(raw_last) - _TAIPEI_OFFSET_NS}])
            self.stats["filled"] += 1
            self.stats["prints"] += published
            # What the broker returned against what the window kept: a window that keeps none of many prints says
            # the broker's times were read wrong, not that nothing traded.
            operation.finish("succeeded", detail={"prints": published, "volume": volume, "known": answer.get("known"), "fetched": fetched,
                                                  "raw_first_ts": raw_first, "raw_last_ts": raw_last, "queries": used, "after_ns": gap.after_ns,
                                                  "end_ns": end_ns, "total_before": gap.total_before,
                                                  "next_total_before": report["next_total_before"]})
        except IntradayTicksLimit as exc:  # not an error: the close's fill takes the gap, recorded as abandoned
            self._leave_to_close(gap, operation, report, f"{exc}; filled after the close", {"reason": "intraday_ticks_limit"})
        except Exception as exc:
            self.stats["failed"] += 1
            record_failure(_log, f"filling the {gap.cause} gap of {gap.market}:{gap.code}", exc)
            operation.finish("failed", detail={"error": f"{type(exc).__name__}: {exc}"[:300]})
            try:
                self._report_fill(gap, [{**report, "outcome": "failed", "reason": f"{type(exc).__name__}: {exc}"[:300]}])
            except Exception as report_exc:
                record_failure(_log, f"reporting the failed {gap.cause} fill of {gap.market}:{gap.code}", report_exc)

    def _report_fill(self, gap: Gap, reports: list[dict[str, Any]]) -> dict[str, Any]:
        """Market Runtime's answer to a fill's report. A closed session viewed stores nothing, so it has none to give."""
        return {} if gap.cause == CAUSE_CLOSED_VIEW else self._report(reports)

    def _leave_to_close(self, gap: Gap, operation: Any, report: dict[str, Any], reason: str, detail: dict[str, Any]) -> None:
        """Reports the gap ``after_close``: the fill after the session's materialization takes it."""
        _log.info("not filling the %s gap of %s:%s now: %s", gap.cause, gap.market, gap.code, reason)
        self.stats["deferred"] += 1
        operation.finish("abandoned", detail=detail)
        try:
            self._report_fill(gap, [{**report, "outcome": "after_close", "reason": reason}])
        except Exception as exc:
            record_failure(_log, f"reporting the {gap.cause} gap of {gap.market}:{gap.code} left to the close's fill", exc)

    def _publish_prints(self, gap: Gap, prints: list[tuple[int, float, float, int]], end_ns: int, *, stated_prev_close: float | None = None) -> tuple[int, float]:
        flags: dict[str, Any] = {"backfill": True, "backfill_cutoff_ns": int(end_ns)}
        if gap.cause == CAUSE_CLOSED_VIEW:
            flags["view_only"] = True
        # The history has no 昨收: a closed session viewed states it on its first event, as a live print does.
        stated = {} if stated_prev_close is None else {"stated_prev_close": price_to_units(stated_prev_close, scale=self._scale)}
        if gap.market == "IDX":
            for number, (ns, price, _size, _tick_type) in enumerate(prints):
                self._send(gap, "quote", ns, {"current": price_to_units(price, scale=self._scale), "open": 0, "high": 0, "low": 0,
                           "total_volume": 0.0, "total_amount": 0.0, "status": "live", "average": 0, "volume": 0.0,
                           "amount": 0.0, **({} if number else stated)}, flags)
            return len(prints), 0.0
        total = gap.total_before
        volume = 0.0
        for number, (ns, price, size, tick_type) in enumerate(prints, start=1):
            volume += size
            data = {"price": price_to_units(price, scale=self._scale), "volume": size,
                    "side": shioaji_tick_side(tick_type), "trade_id": f"bf{gap.cause_ns}:{number}",
                    "simtrade": False, **({} if number > 1 else stated)}
            if total is not None:
                data["total_volume"] = total + volume
            self._send(gap, "trade", ns, data, flags)
        return len(prints), volume

    def _publish_closing_reference(self, gap: Gap, closing: Any, start_ns: int, end_ns: int) -> None:
        """A closed session viewed: the 昨收 and limits the exchange states, before its prints as a live session's."""
        units = lambda price: None if price is None else price_to_units(price, scale=self._scale)
        self._send(gap, "reference", start_ns, {"prev_close": units(closing.prev_close), "limit_up": units(closing.limit_up), "limit_down": units(closing.limit_down)},
                   {"backfill": True, "backfill_cutoff_ns": int(end_ns), "view_only": True})

    def _publish_closing_book(self, gap: Gap, ns: int, bids: list[tuple[float, float]], asks: list[tuple[float, float]], end_ns: int) -> None:
        """A closed session viewed: the book at its close, as many levels as its source states."""
        side = lambda levels: [{"price": price_to_units(price, scale=self._scale), "volume": volume} for price, volume in levels if price > 0]
        self._send(gap, "orderbook", ns, {"bids": side(bids), "asks": side(asks), "simtrade": False},
                   {"backfill": True, "backfill_cutoff_ns": int(end_ns), "view_only": True})

    def _send(self, gap: Gap, kind: str, exchange_ns: int, data: dict[str, Any], flags: dict[str, Any]) -> None:
        # The stream's own sequence space: Market Runtime fences each code's events by it.
        with self._admission_lock:
            event = RustLiveEvent(
                source="shioaji", market=gap.market, code=gap.code, generation=max(0, int(self._generation())),
                sequence=self._next_sequence(gap.code if gap.code != "TAIEX" else "IX0001"), event_type=kind,
                exchange_ts_ns=int(exchange_ns), arrival_ns=time.time_ns(), data=data, flags=flags)
            admitted = self._publish(event)
        # A whole session is far more than the ingress queue holds (100,849 prints of TXF on 11-06): it waits for room.
        deadline = time.monotonic() + _CLOSED_VIEW_ADMIT_S
        while admitted is not True and gap.cause == CAUSE_CLOSED_VIEW and not self._stopping and time.monotonic() < deadline:
            with self._cond:
                self._cond.wait(0.05)
            with self._admission_lock:
                admitted = self._publish(event)
        if admitted is not True:
            raise RuntimeError(f"Market Runtime's ingress did not admit a backfill {kind} at {exchange_ns}")


def fetch_windows(fetch: Callable[[Gap, date, str, str], Any], query_dates: Callable[[Gap, date], list[date]],
                  session_open_ns: Callable[[Gap], int], items: list[dict[str, Any]], *,
                  ticks_budget: IntradayTicksBudget) -> list[dict[str, Any]]:
    """The prints of a closed session's gaps from the broker's history, nothing published (``/v1/history/fill-gaps``;
    scripts/fill_history_gaps.py writes them as fills and has Rust B fold the session again). Each item names a code
    and its windows (history_gaps.rs: after_ns, volume_at_after, total_before, end_ns, end_is_live); each window comes
    back with its prints (exchange ns, price, volume, tick_type), oldest first, and what the queries returned, or why
    it could not be filled. The same cut as a live fill: only prints inside the window by their own exchange time."""
    results = []
    for item in items:
        windows_out = []
        for window in item.get("windows") or []:
            gap = Gap(market=str(item["market"]).upper(), code=str(item["code"]).upper(), trading_date=str(item["trading_date"]),
                      session=str(item["session"]).upper(), after_ns=int(window.get("after_ns") or 0),
                      volume_at_after=float(window.get("volume_at_after") or 0.0),
                      total_before=None if window.get("total_before") is None else float(window["total_before"]),
                      restart_from_ns=0, restart_to_ns=0)
            end_ns = int(window["end_ns"])
            end_is_live = bool(window.get("end_is_live", True))
            start_ns = gap.after_ns if gap.after_ns > 0 else session_open_ns(gap)
            used: list[dict[str, Any]] = []
            prints: list[tuple[int, float, float, int]] = []
            try:
                for day, time_start, time_end in query_spans(start_ns, end_ns):
                    answered_other_dates = False
                    for query_date in query_dates(gap, day):
                        if not ticks_budget.take():
                            raise IntradayTicksLimit(f"the day's {INTRADAY_TICKS_LIMIT} intraday ticks queries are used")
                        QUERY_PACER.wait()
                        ticks = fetch(gap, query_date, time_start, time_end)
                        stamps = list(ticks.ts or [])
                        kept = window_prints(ticks, gap, end_ns, end_is_live=end_is_live)
                        used.append({"date": query_date.isoformat(), "fetched": len(stamps), "kept": len(kept)})
                        if kept:
                            prints.extend(kept)
                            answered_other_dates = False
                            break
                        if stamps and not on_date(ticks, day):
                            answered_other_dates = True
                        elif stamps or not answered_other_dates:
                            answered_other_dates = False
                            break
                    if answered_other_dates:
                        raise HistoryUnavailable(f"the broker's tick history holds no {day.isoformat()} prints (answered other dates: {used})")
                prints.sort(key=lambda r: r[0])
                windows_out.append({**window, "prints": [list(p) for p in prints], "queries": used})
            except Exception as exc:
                record_failure(_log, f"fetching the history of {gap.market}:{gap.code} for a closed session's gap", exc)
                windows_out.append({**window, "error": f"{type(exc).__name__}: {exc}"[:300], "queries": used})
        results.append({"market": item["market"], "code": item["code"], "trading_date": item["trading_date"], "session": item["session"],
                        "windows": windows_out})
    return results
