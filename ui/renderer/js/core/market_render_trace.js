import { selectionComponentPaint } from "./selection_latency_trace.js";
// Bounded local tracing. rAF is a scheduling/frame boundary, NOT proof that a
// pixel was observed by a person. Epoch timestamps are used only with the
// ingress epoch arrival; performance.now() remains reserved for work duration.
const groups = new Map(), pending = new WeakMap(), laneWindows = new Map();
// Which component / product each traced host last showed. Kept here rather than as data-* attributes on the host:
// those were three attribute writes on the component's root per update. Disconnected hosts are dropped when the
// health snapshot reads the map.
const tracedHosts = new Map();
// Per UI DESTINATION, not just per lane. `stock_tick` reaches the product row, the trade table
// and the trend, and those are different amounts of work -- one merged number cannot say which
// one is slow, which is the question this measurement exists to answer.
const destinationWindows = new Map();
const MAX_GROUPS = 64, MAX_SAMPLES = 512, MAX_LANE_SAMPLES = 256, REPORT_MS = 1000;

function sourceLane(component, read, vm) {
  // SOURCE FIRST, always, before an explicit `trace.source_lane`: otherwise a Futu view carrying
  // `source_lane: "stock_tick"` would be counted in the Shioaji lane on the caller's word alone. A measurement module must refuse that itself rather than rely on
  // every present caller happening not to do it.
  if (String(read?.identity?.source || vm?.provider || "").toLowerCase() !== "shioaji") return null;
  if (component === "orderbook") return "stock_bidask";
  // The product row is a Tick destination like the other two. It was missing, so the one UI surface
  // every symbol updates into was the one with no latency measurement at all.
  if (component === "trades" || component === "trend" || component === "product_list") return "stock_tick";
  return null;
}

//: Which wire channel's arrival a component is allowed to be measured against. Nothing else.
const CHANNEL_OF_COMPONENT = { orderbook: "orderbook", trades: "trades", trend: "trend" };

/**
 * Arrival of the event this component actually rendered, in epoch MICROseconds -- or null.
 *
 * Strict by design. Every softer rule here produced a wrong number under the right name:
 *
 *   * a view-level `trace.arrival_ns` is the arrival of the last event of ANY channel, so a BidAsk
 *     was measured against whichever Tick landed in between;
 *   * `read.time.receivedTime` is the SUMMARY's arrival, i.e. a quote, so it is Tick time wearing
 *     a different label.
 *
 * A component whose own channel has no arrival is therefore NOT SAMPLED. A gap is honest; a
 * plausible wrong number is not.
 */
function arrivalMicrosFor(component, read, vm) {
  const channel = CHANNEL_OF_COMPONENT[component];
  if (channel) {
    const micros = Number(read?.sourceDetails?.channelArrivalUs?.[channel]);
    return Number.isFinite(micros) && micros > 0 ? micros : null;
  }
  // The product row renders many symbols' merged rows and has no channel of its own, so the caller
  // that knows which tick dirtied it supplies that tick's arrival explicitly.
  if (component === "product_list") {
    const micros = Number(vm?.trace?.arrival_us);
    return Number.isFinite(micros) && micros > 0 ? micros : null;
  }
  return null;
}

/** Per-destination window: how long from THIS event's callback arrival to THIS surface updating. */
function observeDestination(lane, component, latencyMs) {
  if (!lane || !component || !Number.isFinite(latencyMs)) return;
  const key = `${lane}:${component}`;
  if (!destinationWindows.has(key)) destinationWindows.set(key, []);
  const values = destinationWindows.get(key);
  values.push(latencyMs);
  if (values.length > MAX_LANE_SAMPLES) values.shift();
}

// An epoch nanosecond value is ~1.8e18, well past Number.MAX_SAFE_INTEGER (9.0e15), so `ns / 1e6`
// on a Number has already lost precision before any subtraction. Latency is therefore computed by
// subtracting in ONE integer unit (microseconds, via BigInt) and scaling the small difference down.
// Epoch sanity floor: 2000-01-01, which rejects a relative or zeroed clock.
const EPOCH_FLOOR_MICROS = 946684800000000n;

function arrivalEpochMicros(micros) {
  const value = Number(micros);
  if (!Number.isFinite(value) || value <= 0) return null;
  // Epoch microseconds are ~1.79e15, inside JS's safe-integer range, so this is exact. Epoch
  // NANOseconds are ~1.79e18 and are not: a JSON number that large has already been rounded by
  // JSON.parse before any consumer sees it, and no BigInt work afterwards recovers the low bits.
  // That is why the wire carries `channel_arrival_us` -- see channel_arrival_wire() in the daemon.
  const exact = BigInt(Math.round(value));
  return exact >= EPOCH_FLOOR_MICROS ? exact : null;
}

/** Exact millisecond latency from an arrival (microseconds) to an epoch-millisecond stamp. */
function latencyMs(arrivalMicros, epochMs) {
  if (arrivalMicros == null || !Number.isFinite(Number(epochMs))) return null;
  return Number(BigInt(Math.round(Number(epochMs))) * 1000n - arrivalMicros) / 1000;
}

function percentile(values, q) {
  if (!values.length) return null;
  const rows = [...values].sort((a, b) => a - b);
  return rows[Math.min(rows.length - 1, Math.max(0, Math.ceil(rows.length * q) - 1))];
}

function summarize(values) {
  return { latest_ms: values.at(-1) ?? null, p50_ms: percentile(values, .50),
    p95_ms: percentile(values, .95), p99_ms: percentile(values, .99),
    max_ms: values.length ? Math.max(...values) : null, window_samples: values.length };
}

function observeLane(lane, phase, latencyMs, sample) {
  if (!lane || !Number.isFinite(latencyMs)) return;
  if (!laneWindows.has(lane)) laneWindows.set(lane, { update: [], frame: [], count: 0, lastReport: 0 });
  const state = laneWindows.get(lane), values = state[phase];
  values.push(latencyMs); if (values.length > MAX_LANE_SAMPLES) values.shift();
  if (phase === "frame") state.count += 1;
  const now = Date.now();
  if (phase !== "frame" || now - state.lastReport < REPORT_MS) return;
  state.lastReport = now;
  const update = summarize(state.update), frame = summarize(state.frame);
  globalThis.window?.dispatchEvent?.(new CustomEvent("stock-monitor:market-render-latency", { detail: {
    source_lane: lane, stream_id: `realtime-lane:${lane}`, sequence: sample.sequence ?? null,
    arrival_us: sample.arrival_us, sample_count: state.count,
    update_latest_ms: update.latest_ms, update_p50_ms: update.p50_ms,
    update_p95_ms: update.p95_ms, update_p99_ms: update.p99_ms, update_max_ms: update.max_ms,
    frame_latest_ms: frame.latest_ms, frame_p50_ms: frame.p50_ms,
    frame_p95_ms: frame.p95_ms, frame_p99_ms: frame.p99_ms, frame_max_ms: frame.max_ms,
    window_samples: frame.window_samples,
  } }));
}

// Who wants to know that a market component just changed what it shows (the paint probe of renderer_runtime_health).
const screenUpdateListeners = new Set();
export function onScreenUpdate(listener) {
  screenUpdateListeners.add(listener);
  return () => screenUpdateListeners.delete(listener);
}

export function componentUpdated(component, vm = {}, host) {
  if (!host) return;
  for (const listener of screenUpdateListeners) {
    try { listener(); } catch (error) { console.error("[market render trace] screen update listener failed", error); }
  }
  const read = vm.marketRead || {}, revision = read.revision || {}, identity = read.identity || {};
  const code = identity.code || vm.displaySymbol || vm.logicalCode || vm.code || vm.symbol || "";
  const channel = read.channels?.[component];
  const hasData = component === "trades" ? Boolean(vm.rows?.length)
    : component === "trend" ? Boolean(vm.points?.length)
    : component === "orderbook" ? channel?.state === "available"
    : component === "tradeflow" ? Boolean(vm.flow && Object.keys(vm.flow).length) : false;
  if (hasData) selectionComponentPaint(code, component, host);
  if (component === "orderbook" && vm.priceVolumeRows?.length) selectionComponentPaint(code, "price_volume", host);
  const key = `${identity.source || vm.provider || "unknown"}:${component}:${code}`;
  if (!groups.has(key)) {
    if (groups.size >= MAX_GROUPS) groups.delete(groups.keys().next().value);
    groups.set(key, {component, code, updated:0, boundaries:0, superseded:0, samples:[]});
  }
  const group = groups.get(key), componentEpochMs = Date.now();
  const arrivalUs = arrivalMicrosFor(component, read, vm);
  const arrivalMicros = arrivalEpochMicros(arrivalUs);
  const arrivalEpochMs = arrivalMicros == null ? null : Number(arrivalMicros) / 1000;
  const lane = sourceLane(component, read, vm);
  const sample = {source:identity.source || vm.provider || null, source_lane:lane,
    market:identity.market || null, code, contract:identity.contractCode || null,
    trading_date:read.session?.tradingDate || vm.tradingDate || null,
    session:read.session?.name || vm.session || null,
    daemon_instance_id:revision.daemonInstanceId || null,
    session_generation:revision.sessionGeneration ?? vm.sessionGeneration ?? null,
    selection_generation:revision.selectionGeneration ?? vm.selectionGeneration ?? null,
    trace_id:vm.traceId || read.traceId || null, stream_id:revision.streamId || vm.stream_id || null,
    sequence:revision.sequence ?? vm.displaySequence ?? null,
    view_stream_id:revision.streamId || null,
    view_daemon_instance_id:revision.daemonInstanceId || null,
    view_session_generation:revision.sessionGeneration ?? null,
    ...(read.sourceDetails?.trace || {}), ...(vm.trace || {}),
    arrival_us:arrivalUs, arrival_epoch_ms:arrivalEpochMs, arrival_epoch_micros:arrivalMicros,
    component_updated_ms:componentEpochMs, component_updated_epoch_ms:componentEpochMs,
    arrival_to_component_ms:latencyMs(arrivalMicros, componentEpochMs)};
  if (sample.arrival_to_component_ms != null) {
    observeLane(lane, "update", sample.arrival_to_component_ms, sample);
    observeDestination(lane, component, sample.arrival_to_component_ms);
  }
  group.updated++; group.samples.push(sample); if (group.samples.length > MAX_SAMPLES) group.samples.shift();
  tracedHosts.set(host, { code, component });
  const previous = pending.get(host);
  if (previous) { previous.group.superseded++; previous.sample = sample; previous.group = group; return; }
  const item = {sample, group}; pending.set(host, item);
  requestAnimationFrame(() => {
    pending.delete(host);
    if (!host.isConnected) return;
    const frameEpochMs = Date.now();
    item.sample.frame_boundary_ms = frameEpochMs;
    item.sample.frame_boundary_epoch_ms = frameEpochMs;
    item.sample.arrival_to_frame_boundary_ms = latencyMs(item.sample.arrival_epoch_micros, frameEpochMs);
    item.group.boundaries++;
    item.group.latestFrame = item.sample;
    if (item.sample.arrival_to_frame_boundary_ms != null) {
      observeLane(item.sample.source_lane, "frame", item.sample.arrival_to_frame_boundary_ms, item.sample);
    }
  });
}

export function marketRenderTraceSnapshot() {
  return [...groups.values()].map(({latestFrame, ...group}) => ({...group, samples:group.samples.map(sample => ({...sample}))}));
}

// Sample only the latest existing trace, never copy the full per-frame tape.
export function marketRenderHealthSnapshot() {
  const visible = [];
  for (const [host, shown] of tracedHosts) {
    if (!host.isConnected) { tracedHosts.delete(host); continue; }
    if (host.getClientRects().length > 0) visible.push(shown);
  }
  return [...groups.values()].map(group => {
    const sample = group.samples.at(-1) || {};
    // A pending update must not erase the last completed frame, or an unrelated
    // previous session frame make the new session appear rendered.
    const previous = group.latestFrame;
    const frame = previous && ["daemon_instance_id", "session_generation", "selection_generation", "stream_id",
      "view_stream_id", "view_daemon_instance_id", "view_session_generation"]
      .every(key => previous[key] === sample[key]) ? previous : {};
    return { component: group.component, code: group.code,
      active: visible.some(shown => shown.code === group.code && shown.component === group.component),
      updated_count: group.updated, frame_count: group.boundaries,
      updated_at: sample.component_updated_epoch_ms || 0,
      frame_at: frame.frame_boundary_epoch_ms || 0,
      frame_arrival_us: frame.arrival_us ?? null,
      rendered_sequence: frame.sequence ?? null,
      view_stream_id: sample.view_stream_id,
      view_daemon_instance_id: sample.view_daemon_instance_id,
      view_session_generation: sample.view_session_generation,
      selection_generation: sample.selection_generation,
      sequence: sample.sequence, stream_id: sample.stream_id,
      daemon_instance_id: sample.daemon_instance_id,
      session_generation: sample.session_generation, source: sample.source };
  });
}

// The newest DOM update of any traced component (連線診斷: whether the 資料套用 → 畫面繪製 link moves). Reads the trace groups only, no DOM query.
export function marketRenderLastUpdateAt() {
  let latest = 0;
  for (const group of groups.values()) latest = Math.max(latest, Number(group.samples.at(-1)?.component_updated_epoch_ms) || 0);
  return latest || null;
}

export function marketRenderLatencySnapshot() {
  return Object.fromEntries([...laneWindows].map(([lane, state]) => [lane, {
    source_lane:lane, sample_count:state.count, update:summarize(state.update), frame:summarize(state.frame),
  }]));
}

/**
 * "Backend callback arrival -> this UI surface finished updating", per destination.
 *
 * `update` above merges every destination of a lane into one number; this keeps them apart, which
 * is the only way to say whether the product row, the trade table or the trend is the slow one.
 *
 * requestAnimationFrame is NOT in this path. The `frame` window in marketRenderLatencySnapshot()
 * measures to a scheduling boundary and is kept for other diagnostics; it is not a render latency
 * and must not be reported as one.
 */
export function marketRenderDestinationLatency() {
  return Object.fromEntries([...destinationWindows].map(([key, values]) => {
    const [lane, component] = key.split(":");
    return [key, { source_lane: lane, component,
      clock: "callback_arrival_epoch_us -> component_updated_epoch_ms",
      resolution: "microsecond arrival, millisecond latency",
      sample_count: values.length, ...summarize(values) }];
  }));
}
