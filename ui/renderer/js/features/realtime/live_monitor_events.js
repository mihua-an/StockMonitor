// 即時報價頁's event tape (事件列表 and the 個股走勢 event markers). Keep ONE module URL for this file: importing it with a
// query string makes Chromium instantiate a second copy with its own tape, so the visible EventFeed reads the other.
//
// The tape has one owner, Market Runtime. Its `events.snapshot` says what to show:
//   presentation CURRENT  -- the snapshot's `events` (the current session's; empty during the pre-open and on a
//                            quiet open -- the previous day's events are not shown);
//   presentation ARCHIVE  -- the event file of exactly `presentation_trading_date` (B's archive, /api/monitor/events):
//                            the current day, after a restart dropped A's cache outside the live session.
// New and revised events are pushed as `events.tape`; a push of `current_trading_date` is the current session (the
// first one after a pre-open moves the tape off the archive day). The snapshot is re-sent on every reconnect and by
// Market Runtime itself at a rollover, so this module neither re-subscribes nor searches dates, and B's events carry
// a market-local minute, so nothing is quarantined by clock time any more.
import { eventFeedKey, normalizeMonitorEvent } from "../../core/event_feed_format.js";
import { realtimeContext } from "../../core/dashboard_context.js";
import { apiGet } from "../../core/api.js";
import { sendRealtimeClientMetric, setRealtimeEventTape, onRealtimeEventTape, onRealtimeEventTapeSnapshot } from "../../market_data/realtime.js";

const LIVE_MONITOR_EVENT_LIMIT = 600;

let liveMonitorEvents = [];
// What the tape shows now: the session Market Runtime calls current, the date the rows belong to, and where they came
// from. `generation` fences an archive read against a newer snapshot.
let tape = { currentDate: "", shownDate: "", presentation: "", generation: 0 };

export function getLiveMonitorEvents() {
  return [...liveMonitorEvents];
}

/** Whether the tape shown could be read: null when it could, else why not -- an unavailable archive is never
 * shown as a day without events. */
export function liveMonitorEventsUnavailable() {
  return tape.unavailable || null;
}

/** 即時資訊's view model: the tape as it stands, for the page's panel and its detached window alike. */
export function liveEventFeedViewModel({ watchPages = [], selectedSymbol = "", selectedName = "" } = {}) {
  const unavailable = liveMonitorEventsUnavailable();
  return {
    availability: unavailable ? "UNAVAILABLE" : "AVAILABLE",
    rows: getLiveMonitorEvents(),
    watchPages, selectedSymbol, selectedName,
    emptyText: unavailable ? `此日事件資料不可用（${unavailable}）` : "目前沒有符合此商品頁的即時資訊",
  };
}

/** The page declares the tape once; the transport keeps it across reconnects. */
export function startMonitorEventTape() {
  setRealtimeEventTape({ market: "STK", session: "DAY", limit: LIVE_MONITOR_EVENT_LIMIT });
}

function visibleEvents(events) {
  return (Array.isArray(events) ? events : []).map(normalizeMonitorEvent).filter((event) => event && !event.revoked);
}

function publish(source) {
  sendRealtimeClientMetric("realtime_event_display_counts", 0, {
    displayed_count: liveMonitorEvents.length, trading_date: tape.shownDate, current_trading_date: tape.currentDate,
    presentation: tape.presentation, source, session: "DAY",
  });
  invalidateMonitorEventConsumers();
}

export async function applyEventTapeSnapshot(payload = {}) {
  const generation = ++tape.generation;
  const currentDate = String(payload.current_trading_date || payload.trading_date || "").slice(0, 10);
  const presentation = String(payload.presentation || "CURRENT").toUpperCase();
  const shownDate = String(payload.presentation_trading_date || currentDate).slice(0, 10);
  tape = { ...tape, currentDate, presentation };
  if (presentation !== "ARCHIVE") {
    tape.shownDate = currentDate;
    tape.unavailable = null;
    // A snapshot is the whole tape, cut together with the subscription: it replaces what was shown.
    liveMonitorEvents = mergeMonitorEvents([], visibleEvents(payload.events));
    publish("TAPE_SNAPSHOT");
    return;
  }
  let rows = [];
  let unavailable = null;
  try {
    const archive = await apiGet(`/api/monitor/events?date=${encodeURIComponent(shownDate)}&limit=${LIVE_MONITOR_EVENT_LIMIT}`);
    // The answer is the archive of the day asked for, and says so itself: ok, the date it is of, and its coverage.
    // Anything less -- a refusal, another day, an answer missing a field, a coverage this page does not know -- is
    // unavailable, never an empty list read as a day with no events. A PARTIAL archive (damaged lines) shows what it
    // has and says it is not all of the day.
    const answeredDate = String(archive?.trading_date || archive?.date || "").slice(0, 10);
    const coverage = String(archive?.coverage || "").toUpperCase();
    if (archive?.ok === false) unavailable = String(archive?.error || archive?.reason || "REFUSED");
    else if (archive?.ok !== true) unavailable = "CONTRACT_NO_OK";
    else if (!answeredDate) unavailable = "CONTRACT_NO_DATE";
    else if (answeredDate !== shownDate) unavailable = `ANSWERED_${answeredDate}`;
    else if (coverage === "COMPLETE") rows = visibleEvents(archive?.events);
    else if (coverage === "PARTIAL") { rows = visibleEvents(archive?.events); unavailable = "PARTIAL"; }
    else unavailable = coverage === "MISSING" || coverage === "UNAVAILABLE" ? coverage : `CONTRACT_COVERAGE_${coverage || "NONE"}`;
    if (unavailable) console.warn("[MONITOR EVENTS] archive not available", shownDate, unavailable);
  } catch (error) {
    unavailable = "READ_FAILED";
    console.warn("[MONITOR EVENTS] archive read failed", shownDate, error);
  }
  // A newer snapshot, or the first push of the current session, moved the tape on while the archive was read.
  if (generation !== tape.generation || tape.presentation !== "ARCHIVE") return;
  tape.shownDate = shownDate;
  tape.unavailable = unavailable;
  liveMonitorEvents = mergeMonitorEvents([], rows);
  publish("EVENT_ARCHIVE");
}

// The event list feeds 即時資訊 AND the 個股走勢 event markers (core/event_markers.js liveEventMarkers).
// Coalesced to one rebuild per task. 個股走勢 only marks its own symbol's events, so `codes` (the symbols whose events
// changed) skips its rebuild when the shown stock is not among them; without `codes` both consumers rebuild.
let monitorEventConsumersPending = null;

function invalidateMonitorEventConsumers(codes = null) {
  const shown = String(realtimeContext.dataSource.lastValues?.get("stockTrend")?.symbol || "").trim().toUpperCase();
  const trend = !codes || !shown || codes.has(shown);
  if (monitorEventConsumersPending) {
    monitorEventConsumersPending.trend ||= trend;
    return;
  }
  monitorEventConsumersPending = { trend };
  queueMicrotask(() => {
    const pending = monitorEventConsumersPending;
    monitorEventConsumersPending = null;
    const symbol = realtimeContext.symbolStore.getSelectedSymbol();
    realtimeContext.dataSource.invalidate("eventFeed", { symbol });
    if (pending.trend) realtimeContext.dataSource.invalidate("stockTrend", { symbol });
  });
}

// An event is never modified once normalized (a revision is a new object), so its key and its sort time are derived
// once per event: each push merged and re-sorted the whole tape (up to 600) building both strings per comparison.
const eventKeys = new WeakMap();
const eventTimes = new WeakMap();
function monitorEventKey(event) {
  if (event && typeof event === "object" && eventKeys.has(event)) return eventKeys.get(event);
  const key = eventFeedKey(event);
  if (event && typeof event === "object") eventKeys.set(event, key);
  return key;
}
function monitorEventTime(event) {
  if (event && typeof event === "object" && eventTimes.has(event)) return eventTimes.get(event);
  const time = `${String(event?.date || event?.trading_date || "").slice(0, 10)} ${String(event?.time || "")}`;
  if (event && typeof event === "object") eventTimes.set(event, time);
  return time;
}
// String.prototype.localeCompare with the default locale, as one collator (localeCompare sets one up per call).
const EVENT_TIME_ORDER = new Intl.Collator();

// Compared on the merged tape, not the incoming events: events older than the tape's window change nothing.
function monitorEventsDiffer(previous, next) {
  if (previous.length !== next.length) return true;
  return next.some((event, index) => event !== previous[index]
    && (monitorEventKey(event) !== monitorEventKey(previous[index]) || JSON.stringify(event) !== JSON.stringify(previous[index])));
}

// Ordered by EVENT time, newest first -- never by arrival; a newer copy of the same event_id (a revision) replaces it.
function mergeMonitorEvents(existing, incoming) {
  const byKey = new Map();
  for (const event of existing) byKey.set(monitorEventKey(event), event);
  for (const event of incoming) byKey.set(monitorEventKey(event), event);
  return [...byKey.values()]
    .sort((a, b) => EVENT_TIME_ORDER.compare(monitorEventTime(b), monitorEventTime(a)))
    .slice(0, LIVE_MONITOR_EVENT_LIMIT);
}

/** `events.tape`: new and revised events. Only the current session's apply; a revoked event withdraws its alert. */
export function applyEventTapePush(payload = {}) {
  const pushDate = String(payload.trading_date || "").slice(0, 10);
  if (!pushDate || pushDate !== tape.currentDate) return;
  const normalized = (Array.isArray(payload.events) ? payload.events : []).map(normalizeMonitorEvent).filter(Boolean);
  if (tape.presentation === "ARCHIVE") {
    // The current session's first event: the tape leaves the archive for good. An archive of another day goes; an
    // archive of this same day (a restart outside the live session dropped Market Runtime's events) is what the
    // pushes add to: clearing it would show only the re-sent events, and the rest would come back one push at a
    // time, each washed as new.
    const sameDay = tape.shownDate === tape.currentDate;
    tape = { ...tape, presentation: "CURRENT", shownDate: tape.currentDate, generation: tape.generation + 1 };
    if (!sameDay) liveMonitorEvents = [];
  }
  const revoked = new Set(normalized.filter((event) => event.revoked && event.event_id).map((event) => String(event.event_id)));
  const kept = revoked.size ? liveMonitorEvents.filter((event) => !revoked.has(String(event?.event_id || ""))) : liveMonitorEvents;
  const merged = mergeMonitorEvents(kept, normalized.filter((event) => !event.revoked));
  const changed = kept !== liveMonitorEvents || monitorEventsDiffer(liveMonitorEvents, merged);
  liveMonitorEvents = merged;
  if (!changed) return;
  sendRealtimeClientMetric("realtime_event_display_counts", 0, {
    displayed_count: liveMonitorEvents.length, trading_date: tape.shownDate, presentation: tape.presentation, source: "LIVE_PUSH", session: "DAY",
  });
  invalidateMonitorEventConsumers(new Set(normalized.map((event) => String(event?.code || "").trim().toUpperCase())));
}

onRealtimeEventTapeSnapshot((payload) => { void applyEventTapeSnapshot(payload); });
onRealtimeEventTape((payload) => applyEventTapePush(payload));
