import { appState } from "./state.js";
import { getApiHealth } from "./api.js";
import { getRealtimeViewStats, getRealtimeFocusState, getRealtimeTransportHealth } from "./realtime_stats.js";
import { marketRenderHealthSnapshot, marketRenderLastUpdateAt, onScreenUpdate } from "./market_render_trace.js";
import { marketRenderLatencySnapshot, marketRenderDestinationLatency } from "./market_render_trace.js";
import { selectionTraceSnapshot } from "./selection_latency_trace.js";
import { tradePageTraceSnapshot } from "../market_data/trade_detail/perf_trace.js";
import { getDashboardDiagnostics } from "./dashboard_runtime.js";

// Must match ui/main/renderer_health.js's own array bound: main silently rejects a payload
// that exceeds it, so exceeding it here freezes Health's view of the renderer.
export const TELEMETRY_ARRAY_LIMIT = 64;
// Same bound main enforces (ui/main/renderer_health.js's TELEMETRY_MAX_BYTES). Duplicated across the
// IPC boundary for the same reason TELEMETRY_ARRAY_LIMIT is: the sender has to be able to tell,
// locally, whether the payload it is about to send can be accepted at all.
export const TELEMETRY_MAX_BYTES = 256 * 1024;

let stopSampling = null;
// ipcRenderer.send() is fire-and-forget, so the renderer cannot be told that main rejected a
// payload. It can, however, check the payload against the bounds main enforces -- which is exactly
// the condition whose silent violation froze Health's view of the renderer for a whole session.
/**
 * Every non-equity view is always reported, then the most suspect equity views fill the rest.
 *
 * A watch page holds ~60 STK views and a handful that matter most when a panel is wrong -- TXFR1,
 * TAIEX, the Futu view. Ranking them only by "looks unhealthy" was not enough: dozens of perfectly
 * ordinary STK views carry a `SUPERSEDED_SNAPSHOT` reject from startup, so they outranked a healthy
 * FUT view and pushed it out of the report -- which is precisely the view someone reading this
 * telemetry would be looking for.
 */
function isEquityView(view = {}) {
  return String(view?.spec?.market || "").toUpperCase() === "STK";
}

function diagnosticPriority(view = {}) {
  const state = String(view?.view_state || view?.status || "").toUpperCase();
  const unhealthy = state && state !== "LIVE" && state !== "READY" ? 2 : 0;
  const rejected = Number(view?.rejected_count || 0) > 0 ? 1 : 0;
  return unhealthy + rejected;
}

function reportedSubscriptions(all, limit) {
  const active = all.filter((view) => view.active);
  const nonEquity = active.filter((view) => !isEquityView(view));
  const equity = active.filter(isEquityView)
    .sort((left, right) => diagnosticPriority(right) - diagnosticPriority(left));
  return [...nonEquity, ...equity].slice(0, limit);
}

/** Visible components first, then the most recently updated: a stalled panel on screen is never the one cut. */
export function reportedComponents(all, limit) {
  return [...all].sort((left, right) => (Number(Boolean(right.active)) - Number(Boolean(left.active)))
    || (Number(right.updated_at || 0) - Number(left.updated_at || 0))).slice(0, limit);
}

// Detail main can live without, dropped in this order until the payload fits. `subscriptions` and
// `components` stay arrays (main requires them), emptied last.
const OPTIONAL_DETAIL = ["selection_recent", "market_destination_latency", "dashboards", "market_latency", "components", "subscriptions"];

function payloadBytes(payload) {
  try { return JSON.stringify(payload).length; } catch (_error) { /* not an error: a payload JSON cannot encode has no byte size (null) by contract */ return null; }
}

/**
 * The payload main will accept. One past main's byte bound would be rejected by main, the heartbeat would stop and
 * Health would report the renderer stale for a payload that was merely large. So optional detail is dropped
 * until it fits and the report says what was dropped (`telemetry_truncated`); the heartbeat itself always goes out.
 */
export function fitTelemetry(payload, maxBytes = TELEMETRY_MAX_BYTES) {
  const originalBytes = payloadBytes(payload);
  let fitted = payload;
  let bytes = originalBytes;
  const dropped = [];
  for (const key of OPTIONAL_DETAIL) {
    if (bytes !== null && bytes <= maxBytes) break;
    fitted = { ...fitted, [key]: Array.isArray(fitted[key]) ? [] : null };
    dropped.push(key);
    bytes = payloadBytes({ ...fitted, telemetry_truncated: dropped, telemetry_original_bytes: originalBytes });
  }
  if (bytes === null || bytes > maxBytes) {
    // Even the core does not fit (or does not serialize): a bare heartbeat that says so.
    fitted = { schema: payload.schema, sampled_at: payload.sampled_at, event_loop_delay_ms: payload.event_loop_delay_ms,
      subscription_count: payload.subscription_count, subscriptions: [], components: [] };
    dropped.splice(0, dropped.length, "all");
  }
  if (!dropped.length) return { payload, bytes, truncated: [] };
  const out = { ...fitted, telemetry_truncated: [...dropped], telemetry_original_bytes: originalBytes };
  return { payload: out, bytes: payloadBytes(out), truncated: [...dropped] };
}

let lastTelemetry = { sampling: false, sampled_at: null, payload_bytes: null, within_bounds: null, reason: "", truncated: [] };
// The last 2 s window's frames, kept for 連線診斷 畫面繪製 (same window, no IPC). No frame in the window -- the page
// is hidden, so requestAnimationFrame does not run -- reports fps null, never 0.
let paintStats = null;
const PAINT_PROBE_MS = 1000;

export function rendererPaintStats() {
  return paintStats ? { ...paintStats, last_update_at: marketRenderLastUpdateAt() } : null;
}

export function rendererTelemetryDiagnostics() {
  return { ...lastTelemetry, sampling: Boolean(stopSampling) };
}

const percentile = (values, q) => {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * q))] || 0;
};

function observeEntries(type, onEntries, options) {
  if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes?.includes(type)) return null;
  try {
    const observer = new PerformanceObserver((list) => onEntries(list.getEntries()));
    observer.observe(options);
    return observer;
  } catch (error) {
    // An entry type this Chromium lists but refuses to observe: that metric is reported as empty, said once here.
    console.warn(`[RENDERER HEALTH] ${type} observer unavailable`, error);
    return null;
  }
}

// A frame at least this long is recorded on its own, not only counted in the sample window: it holds the window's
// live socket unread (Market Runtime drops a viewer that has not read for 5 s).
const LONG_FRAME_RECORD_MS = 1000;
const LONG_FRAME_SCRIPTS = 8;

// The App's own file a script came from ("js/core/status.js"), without the renderer-assets snapshot path before it.
const scriptFile = (url) => String(url || "").replace(/^.*?\/renderer-assets\/[^/]+\//, "").replace(/^.*\/ui\/renderer\//, "");

/** One long animation frame as the error-log record: when, how long, how much was style/layout and rendering, and
 *  the scripts that ran in it (longest first) -- a long task's own attribution names only the window. */
export function longFrameRecord(entry, { timeOrigin, page, visibility }) {
  const start = Number(entry.startTime || 0), duration = Number(entry.duration || 0), end = start + duration;
  const since = (mark) => (Number(mark) > 0 ? Math.round(end - Number(mark)) : 0);
  const scripts = [...(entry.scripts || [])].sort((a, b) => Number(b.duration || 0) - Number(a.duration || 0));
  return {
    duration_ms: Math.round(duration), started_at: new Date(timeOrigin + start).toISOString(), page, visibility,
    blocking_ms: Math.round(Number(entry.blockingDuration || 0)),
    render_ms: since(entry.renderStart), style_layout_ms: since(entry.styleAndLayoutStart),
    scripts: scripts.slice(0, LONG_FRAME_SCRIPTS).map((s) => ({
      invoker: String(s.invoker || ""), invoker_type: String(s.invokerType || ""),
      source: `${scriptFile(s.sourceURL)}${s.sourceFunctionName ? ` ${s.sourceFunctionName}` : ""}${Number(s.sourceCharPosition) >= 0 ? `@${s.sourceCharPosition}` : ""}`,
      duration_ms: Math.round(Number(s.duration || 0)), forced_layout_ms: Math.round(Number(s.forcedStyleAndLayoutDuration || 0)),
      pause_ms: Math.round(Number(s.pauseDuration || 0)),
    })),
    scripts_total: scripts.length,
  };
}

// Long tasks, input delay / event durations, layout shifts and frame intervals, accumulated between samples.
// drain() hands over what accumulated since the last drain and starts afresh.
function createPerformanceCollectors(now) {
  let acc = { longTasks: [], inputDelays: [], eventDurations: [], layoutShiftScore: 0, layoutShiftCount: 0,
    inputLayoutShiftScore: 0, inputLayoutShiftCount: 0, frameIntervals: [], slowFrames: 0 };
  const observers = [
    observeEntries("longtask", (entries) => {
      for (const entry of entries) acc.longTasks.push(Number(entry.duration || 0));
    }, { entryTypes: ["longtask"] }),
    observeEntries("long-animation-frame", (entries) => {
      for (const entry of entries) {
        if (Number(entry.duration || 0) < LONG_FRAME_RECORD_MS) continue;
        console.warn("[RENDERER LONG FRAME]", longFrameRecord(entry, {
          timeOrigin: performance.timeOrigin, page: location.pathname.split("/").pop(), visibility: document.visibilityState }));
      }
    }, { type: "long-animation-frame" }),
    observeEntries("event", (entries) => {
      for (const entry of entries) {
        const delay = Number(entry.processingStart || 0) - Number(entry.startTime || 0);
        if (Number.isFinite(delay) && delay >= 0) acc.inputDelays.push(delay);
        if (Number.isFinite(entry.duration) && entry.duration >= 0) acc.eventDurations.push(Number(entry.duration));
      }
    }, { type: "event", buffered: true, durationThreshold: 16 }),
    observeEntries("layout-shift", (entries) => {
      for (const entry of entries) {
        if (entry.hadRecentInput) {
          acc.inputLayoutShiftScore += Number(entry.value || 0);
          acc.inputLayoutShiftCount += 1;
        } else {
          acc.layoutShiftScore += Number(entry.value || 0);
          acc.layoutShiftCount += 1;
        }
      }
    }, { type: "layout-shift", buffered: true }),
  ];
  // Frames are measured only while the screen is being updated: a market component's update arms the probe, which
  // follows the frames for PAINT_PROBE_MS after the last update and then stops. A probe running all the time made
  // Chromium produce a frame every vsync with nothing to draw (idle CPU), and measured the browser's frame rate
  // rather than the App's screen updates. No update in a window = no frames = idle (fps null, idle true).
  let frameToken = 0, lastFrameAt = null, lastUpdateAt = -Infinity;
  const frameSample = (timestamp) => {
    frameToken = 0;
    if (lastFrameAt !== null) {
      const interval = Math.max(0, Number(timestamp) - lastFrameAt);
      if (interval > 0 && interval < 1000) {
        acc.frameIntervals.push(interval);
        if (interval > 34) acc.slowFrames += 1;
        if (acc.frameIntervals.length > 600) acc.frameIntervals.shift();
      }
    }
    lastFrameAt = Number(timestamp);
    if (now() - lastUpdateAt < PAINT_PROBE_MS) frameToken = requestAnimationFrame(frameSample);
    else lastFrameAt = null;
  };
  const stopListening = onScreenUpdate(() => {
    lastUpdateAt = now();
    if (!frameToken && typeof requestAnimationFrame === "function") frameToken = requestAnimationFrame(frameSample);
  });
  return {
    drain() {
      const drained = acc;
      acc = { longTasks: [], inputDelays: [], eventDurations: [], layoutShiftScore: 0, layoutShiftCount: 0,
        inputLayoutShiftScore: 0, inputLayoutShiftCount: 0, frameIntervals: [], slowFrames: 0 };
      return drained;
    },
    stop() {
      stopListening();
      if (frameToken) cancelAnimationFrame(frameToken);
      for (const observer of observers) observer?.disconnect?.();
    },
  };
}

function paintStatsOf({ frameIntervals, slowFrames }) {
  const frameMean = frameIntervals.length ? frameIntervals.reduce((a, b) => a + b, 0) / frameIntervals.length : 0;
  return { sampled_at: Date.now(), visible: document.visibilityState !== "hidden", frames: frameIntervals.length,
    idle: frameIntervals.length === 0,
    fps: frameMean > 0 ? 1000 / frameMean : null, slow_frames: slowFrames,
    frame_interval_p50_ms: frameIntervals.length ? percentile(frameIntervals, 0.5) : null,
    frame_interval_p95_ms: frameIntervals.length ? percentile(frameIntervals, 0.95) : null,
    frame_interval_p99_ms: frameIntervals.length ? percentile(frameIntervals, 0.99) : null };
}

function performanceFigures(eventLoopSamples, w) {
  const memory = globalThis.performance?.memory;
  return {
    event_loop_delay_p95_ms: percentile(eventLoopSamples, 0.95),
    event_loop_delay_p99_ms: percentile(eventLoopSamples, 0.99),
    event_loop_delay_max_ms: Math.max(0, ...eventLoopSamples),
    long_task_count: w.longTasks.length,
    long_task_p95_ms: percentile(w.longTasks, 0.95),
    long_task_max_ms: Math.max(0, ...w.longTasks),
    input_event_count: w.inputDelays.length,
    input_delay_p95_ms: percentile(w.inputDelays, 0.95),
    input_delay_p99_ms: percentile(w.inputDelays, 0.99),
    event_duration_p95_ms: percentile(w.eventDurations, 0.95),
    event_duration_p99_ms: percentile(w.eventDurations, 0.99),
    frame_interval_p95_ms: percentile(w.frameIntervals, 0.95),
    frame_interval_p99_ms: percentile(w.frameIntervals, 0.99),
    frame_interval_max_ms: Math.max(0, ...w.frameIntervals),
    slow_frame_count: w.slowFrames,
    layout_shift_score: w.layoutShiftScore,
    layout_shift_count: w.layoutShiftCount,
    input_layout_shift_score: w.inputLayoutShiftScore,
    input_layout_shift_count: w.inputLayoutShiftCount,
    heap_used_mb: memory ? Number(memory.usedJSHeapSize || 0) / 1048576 : null,
  };
}

function runtimeHealthPayload(eventLoopDelay, eventLoopSamples, drained) {
  const views = getRealtimeViewStats();
  return { schema: "renderer-runtime-health-v1", sampled_at: Date.now(),
    event_loop_delay_ms: eventLoopDelay,
    performance: performanceFigures(eventLoopSamples, drained),
    active_page: appState.currentPage, visible: document.visibilityState !== "hidden",
    focus: getRealtimeFocusState(), transport: getRealtimeTransportHealth(), api: getApiHealth(),
    subscription_count: views.client_subscription_count,
    // Bounded, but no longer "whichever 64 happen to come first". A watch page has ~60 STK views
    // and a handful that matter most when something is wrong -- TXFR1, TAIEX, the Futu view --
    // and those were exactly the ones the plain slice dropped, leaving a stalled panel invisible
    // to Health and to anyone reading this telemetry. Report the unhealthy and the non-equity
    // views first; `subscription_count` above still states the true total.
    subscriptions: reportedSubscriptions(views.subscriptions, TELEMETRY_ARRAY_LIMIT),
    // Bounded like `subscriptions` above: main rejects a payload whose arrays exceed
    // TELEMETRY_ARRAY_LIMIT, and a real watch page has more rendered components than that.
    // Unbounded here meant every report was dropped once the page had actual state.
    components: reportedComponents(marketRenderHealthSnapshot(), TELEMETRY_ARRAY_LIMIT),
    market_latency: marketRenderLatencySnapshot(),
    // Per UI destination (product row / trade table / trend / orderbook), from the callback
    // arrival of the event that caused the update. No animation frame in this path.
    market_destination_latency: marketRenderDestinationLatency(),
    // Developer traces: the newest selections (with Rust A's selection_timing) and 成交明細 pages (latency_ms,
    // parts_opened from the backend).
    selection_recent: selectionTraceSnapshot().rows.slice(-8), trade_pages_recent: tradePageTraceSnapshot(),
    dashboards: getDashboardDiagnostics() };
}

// Read existing diagnostics at 0.5 Hz; never transport or reapply market events.
export function startRendererRuntimeHealth({ report = window.desktopAPI?.reportRendererHealth,
  intervalMs = 2000, schedule = setInterval, cancel = clearInterval, now = () => performance.now() } = {}) {
  if (stopSampling || typeof report !== "function") return stopSampling;
  let previous = now();
  const eventLoopSamples = [];
  const collectors = createPerformanceCollectors(now);
  let lastReportFailure = "";
  const sample = () => {
    const current = now();
    const eventLoopDelay = Math.max(0, current - previous - intervalMs);
    eventLoopSamples.push(eventLoopDelay);
    if (eventLoopSamples.length > 60) eventLoopSamples.shift();
    const drained = collectors.drain();
    paintStats = paintStatsOf(drained);
    const payload = runtimeHealthPayload(eventLoopDelay, eventLoopSamples, drained);
    previous = current;
    const fitted = fitTelemetry(payload);
    const reason = fitted.truncated.length ? `truncated:${fitted.truncated.join(",")}` : "";
    lastTelemetry = { sampling: true, sampled_at: Date.now(), payload_bytes: fitted.bytes,
      within_bounds: !fitted.truncated.length, reason, truncated: fitted.truncated };
    try {
      report(fitted.payload);
      lastReportFailure = "";
    } catch (error) {
      // Main may already be closing; any other refusal is logged once per distinct reason.
      // not an error: a repeat of the refusal logged just before adds nothing to the record.
      const failure = String(error?.message || error);
      if (failure !== lastReportFailure) console.warn("[RENDERER HEALTH] report failed", failure);
      lastReportFailure = failure;
    }
  };
  const timer = schedule(sample, intervalMs);
  stopSampling = () => { cancel(timer); collectors.stop(); stopSampling = null; };
  return stopSampling;
}
