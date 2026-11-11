import { RealtimeViewStore } from "./realtime_view_store.js";
import { notifyEach } from "../core/listeners.js";
import { selectionContext, selectionMark, selectionMarkAt, selectionStage } from "../core/selection_latency_trace.js";
import { beginRemediation } from "../core/remediation.js";
import { registerRealtimeStats } from "../core/realtime_stats.js";
import { shioajiMarketOf } from "./futures_symbol.js";
// market_runtime with the viewer credential, from Electron main (no hardcoded fallback: without it the view stays offline).
const WS_URL = String(window.desktopAPI?.liveEngineConnection?.url || "");
// The page never holds the credential: Electron main attaches it to this socket's handshake.
// Who must answer on that socket and which wire protocol it must speak, from the runtime contract Electron main loaded
// (config/runtime_contract.json backend.renderer_protocol_version): checked on the first health that says it serves.
const EXPECTED_RUNTIME = window.desktopAPI?.liveEngineConnection?.expected || null;
const RECONNECT_DELAY_BASE_MS = 1000;
const RECONNECT_DELAY_MAX_MS = 15000;
const HEARTBEAT_INTERVAL_MS = 10000;
const HEARTBEAT_TIMEOUT_MS = 30000;
// No rAF/timer batch buffer: with Market Runtime's view protocol every payload is applied by RealtimeViewStore the
// moment it is parsed, and the connection state is published through `subscribeRealtimeConnectionState()`. A buffer
// here would only schedule an empty flush per view frame -- one rAF plus one timer per frame, at tick rate.
export const REALTIME_CONNECTION_STATE = Object.freeze({ CONNECTED: "CONNECTED", DISCONNECTED: "DISCONNECTED", RECONNECTING: "RECONNECTING" });

// Kept as a pure policy function so reconnect timing remains deterministic and
// testable without opening a real socket or waiting on browser timers.
export function reconnectDelayMs(failureStreak) {
  const streak = Math.max(0, Number.isFinite(Number(failureStreak)) ? Math.floor(Number(failureStreak)) : 0);
  return Math.min(RECONNECT_DELAY_MAX_MS, RECONNECT_DELAY_BASE_MS * (2 ** streak));
}

let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let heartbeatWatchdogTimer = null;
let activeConnectionId = "";
let lastHeartbeatAckAt = 0;
// When the oldest heartbeat not yet answered was sent (0: none outstanding).
let heartbeatPendingSince = 0;
// The last heartbeat sent and its reply: the reply time and the round trip (diagnostics). Any frame proves the link
// alive for the watchdog; only a health reply is a heartbeat answer.
let lastHeartbeatSentAt = 0;
let heartbeatRoundTripMs = null;
let lastWebSocketFrameAt = 0;
let connectionState = REALTIME_CONNECTION_STATE.DISCONNECTED;
let realtimeFrameParseErrors = 0;
let lastRealtimeFrameParseErrorAt = 0;
let realtimeFrameShapeErrors = 0;
let lastRealtimeFrameShapeErrorAt = 0;
let reconnectInProgress = false;
// stopRealtimeStream() ended the transport: nothing reconnects until startRealtimeStream() again.
let transportStopped = false;
// Who closed the current socket, when this side did ("" = not this renderer: Market Runtime or the network).
let closeInitiator = "";
// The last disconnects with the close code/reason and what led to them: without them a renderer disconnect
// could never be matched to the error Market Runtime logged.
const RECENT_DISCONNECT_LIMIT = 20;
const recentDisconnects = [];
// Since when the current socket is open (0: none), and how many sockets this window has lost (連線診斷).
let connectedSince = 0;
let disconnectCount = 0;
let connectionAttemptSeq = 0;
let reconnectFailureStreak = 0;
// A live socket this window did not mean to lose is one remediation -- started when it closes (or cannot be
// constructed), succeeded when a socket opens again, abandoned if the page unloads first.
let liveReconnect = null;
let liveReconnectAttempts = 0;
// Market Runtime listens while it still recovers its WAL and then answers only `health` (status "recovering"). A
// connection subscribes nothing until a health says it serves; the recovering port closes it with RECOVERED (4005)
// when recovery ends -- connect again now -- or RECOVERING (4006) had anything else been sent. Neither is a lost
// socket: the window opened subscribing at once, was refused and closed, and each start recorded a reconnect.
const CLOSE_RECOVERED = 4005;
const CLOSE_RECOVERING = 4006;
let awaitingServingHealth = false;
// The registered trigger reasons (config/remediation_registry.json, renderer.live_ws_reconnect).
const RECONNECT_TRIGGER = Object.freeze({ renderer_heartbeat_timeout: "heartbeat_timeout", renderer_error_event: "socket_error",
  remote_or_network: "remote_close" });

function beginLiveReconnect(triggerReason, detail) {
  if (liveReconnect) return;
  liveReconnectAttempts = 0;
  liveReconnect = beginRemediation({ component: "realtime_connection", mechanismId: "renderer.live_ws_reconnect", triggerReason,
    identity: { connection_id: detail.connection_id || null }, detail });
}
const connectionStateSubscribers = new Set();
let firstReceiveReported = false;
const pendingClientMetrics = new Map();
let clientMetricTimer = null;
const rendererStartedAt = performance.now();

function sendRealtimeWire(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try { socket.send(JSON.stringify(message)); return true; } catch (error) { console.warn("[realtime: sending a message] failed", error); return false; }
}

// No per-delta metric consumer: the view store's counters (stats()) and the render traces are the diagnostics. The
// metric payloads it used to build per delta were batched here and cleared unread.
const realtimeViewStore = new RealtimeViewStore({
  send: sendRealtimeWire,
});

// What the user is looking at, one per source (即時報價 shows a Shioaji and a Futu product side by side): Market
// Runtime subscribes the focused product's order book, which a product-page listing alone does not get.
const FOCUS_SOURCES = ["shioaji", "futu"];
const focusBySource = new Map(FOCUS_SOURCES.map((source) => [source, { code: "", generation: 0, requestId: "" }]));
let focusRequestSeq = 0;

let marketRuntimeRecovery = null;
function publishMarketRuntimeRecovery(recovery) {
  marketRuntimeRecovery = recovery && typeof recovery === "object" ? recovery : null;
  try { window.dispatchEvent(new CustomEvent("stock-monitor:market-runtime-recovery", { detail: marketRuntimeRecovery })); } catch (error) { console.warn("[realtime: recovery event] failed", error); }
}

function publishConnectionState(nextState, detail = {}) {
  const normalized = String(nextState || REALTIME_CONNECTION_STATE.DISCONNECTED);
  const previous = connectionState;
  connectionState = normalized;
  // The session belongs to the connection that pushed it: the next connection pushes its own.
  if (normalized !== REALTIME_CONNECTION_STATE.CONNECTED) currentSession = null;
  const payload = { state: normalized, previous, connected: normalized === REALTIME_CONNECTION_STATE.CONNECTED, ...detail };
  for (const callback of connectionStateSubscribers) { try { callback(payload); } catch (error) { console.warn("[realtime: a connection state subscriber] failed", error); } }
  try { window.dispatchEvent(new CustomEvent("stock-monitor:ws-state", { detail: payload })); } catch (error) { console.warn("[realtime: connection state event] failed", error); }
}

function clearHeartbeatTimers() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (heartbeatWatchdogTimer) { clearInterval(heartbeatWatchdogTimer); heartbeatWatchdogTimer = null; }
}

function startHeartbeat() {
  clearHeartbeatTimers();
  // A new connection has had no heartbeat answer yet.
  lastHeartbeatAckAt = 0;
  heartbeatRoundTripMs = null;
  heartbeatPendingSince = 0;
  heartbeatTimer = window.setInterval(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      lastHeartbeatSentAt = Date.now();
      socket.send(JSON.stringify({ type: "health", payload: { at: lastHeartbeatSentAt } }));
      if (!heartbeatPendingSince) heartbeatPendingSince = Date.now();
    } catch (error) { console.warn("[realtime: sending the heartbeat] failed", error); }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatWatchdogTimer = window.setInterval(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    // Client-view liveness is separate from WebSocket transport liveness. A
    // healthy heartbeat with a stalled canonical view triggers only a bounded
    // view resync; it never reconnects Shioaji or rebuilds broker subscriptions.
    realtimeViewStore.checkStaleness(Date.now());
    // Dead means a heartbeat went unanswered for HEARTBEAT_TIMEOUT_MS -- not "no frame lately": in a hidden window
    // Chromium runs these timers about once a minute, so a quiet but healthy socket would look dead and be
    // reconnected every two minutes.
    if (!heartbeatPendingSince || Date.now() - heartbeatPendingSince <= HEARTBEAT_TIMEOUT_MS) return;
    closeInitiator = "renderer_heartbeat_timeout";
    try { socket.close(4001, "heartbeat timeout"); } catch (error) { console.warn("[realtime: closing after a heartbeat timeout] failed", error); }
  }, 5000);
}

function reportClientMetric(name, durationMs, detail = null) {
  const identifiers = detail && typeof detail === "object" ? detail : {};
  const key = `${name}:${identifiers.source_lane || identifiers.stream_id || ""}:${identifiers.component || identifiers.type || ""}:${identifiers.symbol || identifiers.code || ""}`;
  const duration = Number(durationMs) || 0;
  const previous = pendingClientMetrics.get(key);
  const sampleCount = Number(previous?.payload?.count || 0) + 1;
  if (!previous && pendingClientMetrics.size >= 96) pendingClientMetrics.delete(pendingClientMetrics.keys().next().value);
  pendingClientMetrics.set(key, {
    type: "client.metric",
    payload: {
      ...identifiers,
      name,
      count: sampleCount,
      duration_ms: duration,
      detail: {
        ...identifiers,
        sample_count: sampleCount,
        duration_sum_ms: Number(previous?.payload?.detail?.duration_sum_ms || 0) + duration,
        duration_max_ms: Math.max(Number(previous?.payload?.detail?.duration_max_ms || 0), duration),
      },
    },
  });
  if (!clientMetricTimer) clientMetricTimer = window.setTimeout(flushClientMetrics, 2000);
}

// Renderer-local diagnostics stay in the renderer (readable through window.__stockMonitorClientMetrics): the
// viewer role on market_runtime has no command for them, and sending one would only be refused. What
// market_runtime measures from the UI is the delta -> apply -> paint latency below (latency.report).
const clientMetricLog = new Map();
window.__stockMonitorClientMetrics = () => Object.fromEntries(clientMetricLog);
function flushClientMetrics() {
  if (clientMetricTimer) { window.clearTimeout(clientMetricTimer); clientMetricTimer = null; }
  for (const [key, message] of pendingClientMetrics) clientMetricLog.set(key, message.payload);
  while (clientMetricLog.size > 256) clientMetricLog.delete(clientMetricLog.keys().next().value);
  pendingClientMetrics.clear();
}

// latency.report (docs/system-architecture/04): for every traced delta, when the view store applied it and when
// the next frame painted, both as epoch microseconds; market_runtime matches them to its send time by
// (symbol, sequence). Bounded and batched -- never one message per delta, and never one animation frame request per
// delta: one pending frame stamps every sample still waiting for its paint. A frame request per delta piled up
// without bound while the window was hidden (no frames run) and all ran in the first frame after show() -- the
// 1.5-3 s frame that held app:closing on a full close.
let latencySamples = [];
let latencyTimer = null;
let latencyPaintFrame = 0;
function stampLatencyPaint() {
  latencyPaintFrame = 0;
  const painted = Math.round((performance.timeOrigin + performance.now()) * 1000);
  for (const sample of latencySamples) sample.painted_us ??= painted;
}
function recordDeltaLatency(payload) {
  // trace.version is the key Market Runtime filed this delta's send under; the delta's own `sequence` is the view's
  // numbering and never matches it.
  const version = Number(payload?.trace?.version);
  if (!payload?.symbol || !Number.isSafeInteger(version)) return;
  // Bound to the connection that delivered the delta: a sample never reaches another connection's report.
  const sample = { connection: activeConnectionId, symbol: payload.symbol, version, applied_us: Math.round((performance.timeOrigin + performance.now()) * 1000) };
  if (latencySamples.length >= 512) return;
  latencySamples.push(sample);
  if (!latencyPaintFrame) latencyPaintFrame = requestAnimationFrame(stampLatencyPaint);
  if (!latencyTimer) latencyTimer = window.setTimeout(flushLatency, 1000);
}
function flushLatency() {
  latencyTimer = null;
  if (!latencySamples.length || !socket || socket.readyState !== WebSocket.OPEN) { latencySamples = []; return; }
  const samples = latencySamples.filter((sample) => sample.connection === activeConnectionId)
    .map(({ connection: _connection, ...sample }) => sample);
  latencySamples = [];
  if (!samples.length) return;
  try { socket.send(JSON.stringify({ type: "latency.report", payload: { samples } })); } catch (error) { console.warn("[realtime: sending the latency report] failed", error); }
}

// The focus is an intent this transport holds: sent when it changes and again on every (re)connect (open handler).
// Market Runtime answers each focus.set with focus.set.ack naming the request, over the same ordered socket, so there is
// nothing to time out; an ACK for an older request (or the other source) confirms nothing.
function focusMarket(source, code) {
  return source === "futu" ? (code.split(".", 1)[0] || "US") : shioajiMarketOf(code);
}

function sendFocusRequest(source) {
  const focus = focusBySource.get(source);
  focusRequestSeq += 1;
  focus.requestId = `canonical-focus-${source}-${Date.now()}-${focusRequestSeq}`;
  focus.generation = 0;
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  const code = focus.code;
  const sent = sendRealtimeWire({ type: "focus.set", payload: {
    source, market: focusMarket(source, code), code, request_id: focus.requestId,
  } });
  if (sent && code) selectionMark(code, "focus_request_sent");
  return sent;
}

function handleFocusAck(payload = {}) {
  const focus = focusBySource.get(String(payload?.source || ""));
  if (!focus || !focus.requestId || payload?.request_id !== focus.requestId) return;
  focus.generation = focusRequestSeq;
  if (focus.code) selectionMark(focus.code, "focus_ack");
}

function validMessageShape(message) {
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const rows = value => Array.isArray(value) && value.every(object);
  if (!object(message) || typeof message.type !== "string" || !message.type) return false;
  if (message.payload !== undefined && !object(message.payload)) return false;
  const payload = message.payload || {};
  for (const key of ["session_key", "trace", "selection_timing"]) {
    if (payload[key] !== undefined && !object(payload[key])) return false;
  }
  if (payload.items !== undefined && !rows(payload.items)) return false;
  if (payload.channels !== undefined && (!Array.isArray(payload.channels) || !payload.channels.every(x => typeof x === "string"))) return false;
  for (const key of ["protocol", "generation", "frame_seq"]) {
    if (message[key] !== undefined && (typeof message[key] !== "number" || !Number.isFinite(message[key]))) return false;
  }
  // Only shapes this socket can actually receive: Market Runtime never emits market.futures.frame /
  // market.quotes.delta / market.signals.delta_batch / market.signal.delta (the FastAPI hub's vocabulary),
  // so there is no arm for them.
  switch (message.type) {
    case "view.delta.batch": return rows(payload.items);
    default: return true;
  }
}

async function decodeFrame(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  if (data?.arrayBuffer) return new TextDecoder().decode(new Uint8Array(await data.arrayBuffer()));
  throw new TypeError("unsupported live-engine frame");
}

function normalizeCanonicalPayload(payload = {}) {
  const symbolParts = String(payload.symbol || "").split(":");
  const code = String(payload.code || payload.session_key?.logical_code || symbolParts.at(-1) || "").toUpperCase();
  const state = payload.state && typeof payload.state === "object" ? payload.state : null;
  const minuteTrend = state?.minute_trend && !Array.isArray(state.minute_trend)
    ? Object.values(state.minute_trend) : state?.minute_trend;
  const priceLevels = state?.price_levels && !Array.isArray(state.price_levels)
    ? Object.entries(state.price_levels).map(([price, volume]) => ({ price: Number(price), volume })) : state?.price_levels;
  return {
    ...payload,
    ...(state ? {
      summary: state.summary || {}, trend: minuteTrend || [], trades: state.recent_trades || [],
      orderbook: { bids: state.bids || [], asks: state.asks || [] },
      price_volume: { buckets: priceLevels || [], byPrice: priceLevels || [] },
    } : {}),
    watermark: Number(payload.watermark ?? payload.sequence ?? 0),
    sequence: Number(payload.sequence ?? payload.watermark ?? 0),
    session_generation: Number(payload.session_generation ?? payload.generation ?? 0),
    // A missing session is left missing, never defaulted. "DAY" is only the WAL session for
    // shioaji STK/IDX: shioaji FUT and every Futu instrument are written under FULL. Fabricating
    // "DAY" here named a state key that can never exist, and it is the value both identity gates
    // (handleSnapshot/handleDelta below) compare against -- an invented session either rejects a
    // legitimate snapshot or, worse, makes a foreign one look like a match. Consumers already
    // fall back to the spec's session (see canonicalReadModel), which does know the source.
    session_key: payload.session_key || {
      market: payload.market || "STK", logical_code: code, contract_code: payload.contract_code || code,
      ...(payload.session ? { session: String(payload.session) } : {}),
      trading_date: payload.trading_date || "",
    },
  };
}

function normalizeCanonicalDelta(payload = {}) {
  const normalized = normalizeCanonicalPayload(payload);
  const variants = (normalized.payload || normalized.data) && typeof (normalized.payload || normalized.data) === "object"
    ? (normalized.payload || normalized.data) : {};
  const [variant, value] = Object.entries(variants)[0] || [];
  const projection = {
    Quote: ["summary.updated", value], Trade: ["trade.append", value],
    OrderBook: ["orderbook.latest", value], MinuteBar: ["trend.upsert", value],
  }[variant];
  const canonicalType = {
    "quote.replace": "summary.updated", "orderbook.replace": "orderbook.latest", "minute.upsert": "trend.upsert",
  }[normalized.delta_type] || normalized.delta_type;
  return projection ? { ...normalized, delta_type: canonicalType || projection[0], payload: projection[1] } : { ...normalized, delta_type: canonicalType };
}

function handleMessage(event) {
  if (typeof event?.data === "string") return handleDecodedMessage(event.data);
  void decodeFrame(event?.data).then(handleDecodedMessage).catch(() => {
    realtimeFrameParseErrors += 1;
    lastRealtimeFrameParseErrorAt = Date.now();
    reportClientMetric("REALTIME_FRAME_PARSE_ERROR", 0, { total: realtimeFrameParseErrors });
  });
}

// This handler is fed by exactly ONE socket: WS_URL above, the Market Runtime live engine.
// Market Runtime's wire vocabulary is view.*, adapter.*, durable.*, health, error, event.ack,
// focus.set.ack, daemon.shutdown.ack and workspace.replace.ack -- see
// native/market_runtime/src/bin/market_runtime_daemon.rs. Branches that claimed types it does not
// emit (`account.positions.changed`, `signal.event`) were removed earlier for the same reason the
// batch buffer went: wiring that looks connected and is not is worse than an obvious gap. The
// monitor alert tape those branches pretended to feed is now a real `events` channel on each
// symbol's own canonical view.
// One frame parsed and shape-checked. null = dropped (counted and reported, never thrown).
function parseFrame(rawFrame) {
  let message;
  try { message = JSON.parse(rawFrame); }
  catch (_error) {
    // Malformed frames still just drop -- recovery policy is unchanged.
    // reportClientMetric() already coalesces by key and flushes on a timer
    // (see its own aggregation above), so this cannot flood the socket or
    // the console even if malformed frames arrive repeatedly; the local
    // counter/timestamp make the failure visible through the existing
    // getRealtimeTransportHealth() diagnostics owner without a new
    // subsystem.
    realtimeFrameParseErrors += 1;
    lastRealtimeFrameParseErrorAt = Date.now();
    reportClientMetric("REALTIME_FRAME_PARSE_ERROR", 0, { total: realtimeFrameParseErrors });
    return null;
  }
  if (message?.type === "view.snapshot" && message.payload == null) message.payload = {};
  if (message?.request_id != null && message?.payload && message.payload.request_id == null) {
    message.payload.request_id = message.request_id;
  }
  if (!validMessageShape(message)) {
    realtimeFrameShapeErrors += 1;
    lastRealtimeFrameShapeErrorAt = Date.now();
    reportClientMetric("REALTIME_FRAME_SHAPE_ERROR", 0, { total: realtimeFrameShapeErrors });
    return null;
  }
  return message;
}

// The selection-latency trace of a requested snapshot and the transport trace stamped on every payload.
function stampReceiveTrace(message, receiveStarted) {
  if (message.type === "view.snapshot") {
    message.payload = normalizeCanonicalPayload(message.payload || {});
    const payload = message.payload || {}, code = payload.session_key?.logical_code;
    const trace = selectionContext(code);
    if (trace?.requests.includes(payload.request_id)) {
      const channel = payload.channels?.join(",") || "snapshot";
      selectionMarkAt(code, "renderer_payload_received", receiveStarted, trace);
      selectionMark(code, "renderer_parse_completed", trace);
      selectionStage(code, `${channel}:renderer_parse_ms`, performance.now() - receiveStarted, trace);
      if (payload.selection_timing) trace.stages[`${channel}:backend`] = payload.selection_timing;
    }
  }
  if (message.payload && typeof message.payload === 'object') {
    message.payload.trace = {...(message.payload.trace || {}), ...(message.transport_trace || {}), renderer_receive_ms:Date.now()};
    if (Array.isArray(message.payload.items)) for (const delta of message.payload.items) {
      delta.trace={...(delta.trace || {}),...(message.transport_trace || {}),renderer_receive_ms:Date.now()};
    }
  }
}

function notifyListeners(listeners, payload, label) {
  notifyEach(listeners, label, payload);
}

// One decoded message to its owner: the view store, a pending command, or a channel's listeners.
function dispatchMessage(message, type) {
  // Futu live data arrives only through the Market Runtime view protocol below;
  // there is no separate Futu frame dispatch on this socket.
  if (type === "view.subscription.accepted") {
    realtimeViewStore.handleAccepted(message.payload || {});
  } else if (type === "view.snapshot") {
    const applyStarted = performance.now();
    realtimeViewStore.handleSnapshot(message.payload || {});
    const payload = message.payload || {}, code = payload.session_key?.logical_code, trace = selectionContext(code);
    if (trace?.requests.includes(payload.request_id)) {
      selectionStage(code, `${payload.channels?.join(",")}:state_apply_ms`, performance.now() - applyStarted, trace);
      selectionMark(code, "renderer_state_applied", trace);
    }
  } else if (type === "view.replay_diff") {
    realtimeViewStore.handleReplayDiff(message.payload || {});
  } else if (type === "view.delta") {
    realtimeViewStore.handleDelta(normalizeCanonicalDelta(message.payload || {}));
    recordDeltaLatency(message.payload);
  } else if (type === "view.delta.batch") {
    // One drain of Market Runtime's queue for this connection. Every item is still sequence-checked
    // individually; the store notifies each view once per batch instead of once per delta.
    const items = Array.isArray(message.payload?.items) ? message.payload.items : [];
    realtimeViewStore.handleDeltaBatch({ items: items.map((item) => normalizeCanonicalDelta(item || {})) });
    for (const item of items) recordDeltaLatency(item);
  } else if (type === "view.subscription.error") {
    realtimeViewStore.handleError(message.payload || {});
  } else if (type === "error" && message.request_id) {
    // A command refused outright (e.g. a subscribe without a symbol) answers with a top-level error carrying the
    // request_id; ignoring it left the view loading until the ~55 s timeout.
    realtimeViewStore.handleError({ request_id: message.request_id, error: message.error || "error" });
  } else if (type === "error") {
    console.warn("[MARKET RUNTIME] command refused", message.error, message.command || "");
  } else if (type === "view.resync_required") {
    realtimeViewStore.handleServerResync(message.payload || {});
  } else if (type === "events.snapshot") {
    // The tape this window holds (requested on (re)connect, or sent by Market Runtime at a rollover).
    notifyListeners(eventTapeSnapshotListeners, message.payload || {}, "EVENT TAPE snapshot");
  } else if (type === "session.current") {
    // Pushed by Market Runtime on every connection: the session this window shows.
    publishRealtimeSession(message.payload || {});
  } else if (type === "analysis.state") {
    publishAnalysisState(message.payload || {});
  } else if (type === "events.tape") {
    notifyListeners(eventTapeListeners, message.payload || {}, "EVENT TAPE");
  } else if (type === "flow.large_orders.result") {
    settleLargeOrderQuery(message.payload || {});
  } else if (type === "replay.opened" || type === "replay.control.ack" || type === "replay.closed") {
    settleReplayRequest(message.request_id ?? message.payload?.request_id, message.payload || {});
  } else if (type === "replay.status") {
    notifyListeners(replayStatusListeners, message.payload || {}, "REPLAY status");
  } else if (type === "session.rollover") {
    // Market Runtime moved to a new session (the 08:30 / 14:50 pre-open, Futu's venue midnight): what is
    // session-keyed rebinds on this notice, not on a status poll. Its view re-snapshots follow.
    if (message.payload?.session) publishRealtimeSession(message.payload.session);
    notifyListeners(sessionRolloverListeners, message.payload || {}, "SESSION ROLLOVER");
  } else if (type === "focus.set.ack") {
    handleFocusAck(message.payload);
  } else if (type === "health") {
    lastHeartbeatAckAt = Date.now();
    if (lastHeartbeatSentAt) heartbeatRoundTripMs = lastHeartbeatAckAt - lastHeartbeatSentAt;
    if (message.payload?.status === "recovering") publishMarketRuntimeRecovery(message.payload?.recovery || {});
    else if (awaitingServingHealth) {
      const problem = servingIdentityProblem(message.payload);
      if (problem) refuseIncompatibleRuntime(problem, message.payload);
      else beginServing();
    }
  }

}

/** Why the serving health is not the Market Runtime this renderer speaks to ("" when it is). */
export function servingIdentityProblem(payload, expected = EXPECTED_RUNTIME) {
  if (!expected?.service_id || !Number.isInteger(expected?.protocol)) return "the expected runtime identity is not configured";
  if (payload?.service_id !== expected.service_id) return `service ${JSON.stringify(payload?.service_id ?? null)} is not ${expected.service_id}`;
  if (payload?.protocol !== expected.protocol) return `protocol ${JSON.stringify(payload?.protocol ?? null)} is not ${expected.protocol}`;
  return "";
}

// An incompatible runtime stays incompatible until one side is updated: the transport stops (no reconnect loop that
// would subscribe against the wrong protocol) and the fault is recorded with what answered.
function refuseIncompatibleRuntime(problem, payload) {
  awaitingServingHealth = false;
  console.error("[realtime] Market Runtime is not compatible with this renderer; not subscribing", {
    problem, expected: EXPECTED_RUNTIME, service_id: payload?.service_id ?? null, protocol: payload?.protocol ?? null,
    instance_id: payload?.instance_id ?? null, connection_id: activeConnectionId });
  stopRealtimeStream(`protocol_fault: ${problem}`);
}

// The first health of this connection that says Market Runtime serves: the window is connected and subscribes.
function beginServing() {
  awaitingServingHealth = false;
  publishConnectionState(REALTIME_CONNECTION_STATE.CONNECTED, { connection_id: activeConnectionId });
  realtimeViewStore.onConnected(activeConnectionId);
  sendDesiredWorkspace();
  sendDesiredEventTape();
  for (const [source, focus] of focusBySource) if (focus.code) sendFocusRequest(source);
}

function handleDecodedMessage(rawFrame) {
  const receiveStarted = performance.now();
  lastWebSocketFrameAt = Date.now();
  heartbeatPendingSince = 0;
  const message = parseFrame(rawFrame);
  if (!message) return;
  stampReceiveTrace(message, receiveStarted);
  if (!firstReceiveReported) {
    firstReceiveReported = true;
    reportClientMetric("electron_first_ws_receive", performance.now());
  }

  const type = String(message.type || "");
  // Market Runtime answers while it is still recovering its WAL: it refuses with RECOVERING and its
  // progress, then closes; the reconnect loop keeps trying. The status bar shows the progress instead of 未連線.
  if (type === "error" && message.error === "RECOVERING") {
    publishMarketRuntimeRecovery(message.payload?.recovery || {});
    return;
  }
  if (marketRuntimeRecovery && type !== "error" && message.payload?.status !== "recovering") publishMarketRuntimeRecovery(null);
  dispatchMessage(message, type);
  reportClientMetric("renderer_receive", performance.now() - receiveStarted, { type });
}

function connect() {
  if (transportStopped) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  if (reconnectInProgress) return;
  reconnectInProgress = true;
  connectionAttemptSeq += 1;
  const attempt = connectionAttemptSeq;
  if (liveReconnect) liveReconnectAttempts += 1;
  activeConnectionId = `renderer-${Date.now()}-${attempt}`;
  const connectionId = activeConnectionId;
  let openedAt = 0;
  publishConnectionState(REALTIME_CONNECTION_STATE.RECONNECTING, { attempt });
  reportClientMetric("CLIENT_WS_CONNECT_START", performance.now() - rendererStartedAt, { attempt, elapsed_ms_from_renderer_start: performance.now() - rendererStartedAt });
  let candidate;
  if (!WS_URL) { reconnectInProgress = false; publishConnectionState(REALTIME_CONNECTION_STATE.DISCONNECTED, { attempt, error: "live engine unavailable" }); return; }
  try { candidate = new WebSocket(WS_URL); candidate.binaryType = "arraybuffer"; }
  catch (error) {
    reconnectInProgress = false;
    console.warn("[realtime: constructing the live socket] failed", { connection_id: connectionId }, error);
    beginLiveReconnect("construct_failed", { connection_id: connectionId, error: String(error?.message || error) });
    publishConnectionState(REALTIME_CONNECTION_STATE.DISCONNECTED, { attempt });
    scheduleReconnect();
    return;
  }
  socket = candidate;

  candidate.addEventListener("open", () => {
    if (candidate !== socket) return;
    reconnectInProgress = false;
    reconnectFailureStreak = 0;
    closeInitiator = "";
    openedAt = Date.now();
    connectedSince = openedAt;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (liveReconnect) {
      liveReconnect.finish("succeeded", { attempt: liveReconnectAttempts, detail: { connection_id: connectionId } });
      liveReconnect = null;
    }
    startHeartbeat();
    lastHeartbeatSentAt = Date.now();
    awaitingServingHealth = true;
    sendRealtimeWire({ type: "health", payload: { connection_id: activeConnectionId } });
  });
  candidate.addEventListener("message", handleMessage);
  candidate.addEventListener("close", (event) => {
    if (candidate !== socket) return;
    const closedAt = Date.now();
    const record = {
      connection_id: connectionId, at: new Date(closedAt).toISOString(),
      code: Number(event?.code ?? 0), reason: String(event?.reason || ""), was_clean: Boolean(event?.wasClean),
      // 1006 with no initiator here = the socket died under us (Market Runtime ended the session or the TCP broke).
      initiator: closeInitiator || "remote_or_network",
      opened: openedAt > 0, connected_ms: openedAt ? closedAt - openedAt : 0,
      ms_since_last_frame: lastWebSocketFrameAt ? closedAt - lastWebSocketFrameAt : null,
      buffered_amount: Number(candidate.bufferedAmount || 0),
    };
    recentDisconnects.push(record);
    if (recentDisconnects.length > RECENT_DISCONNECT_LIMIT) recentDisconnects.shift();
    connectedSince = 0;
    // Market Runtime's recovery handoff (RECOVERED / RECOVERING) is not a lost connection: only an unexpected close of
    // an opened socket counts as a disconnect (連線診斷 marks any as a warning).
    const recoveryHandoff = record.code === CLOSE_RECOVERED || record.code === CLOSE_RECOVERING;
    if (record.opened && !recoveryHandoff) disconnectCount += 1;
    awaitingServingHealth = false;
    if (recoveryHandoff) {
      // Market Runtime finished (or is still in) its recovery: connect again, at once after RECOVERED.
      if (record.code === CLOSE_RECOVERED) reconnectFailureStreak = 0;
    } else {
      beginLiveReconnect(RECONNECT_TRIGGER[record.initiator] || "remote_close", { connection_id: connectionId, code: record.code,
        reason: record.reason, initiator: record.initiator, opened: record.opened, connected_ms: record.connected_ms,
        ms_since_last_frame: record.ms_since_last_frame });
    }
    closeInitiator = "";
    clearHeartbeatTimers();
    socket = null;
    reconnectInProgress = false;
    realtimeViewStore.onDisconnected();
    for (const focus of focusBySource.values()) focus.generation = 0;
    // The lost connection's latency samples are its own; the next connection reports only what it delivered.
    latencySamples = [];
    reportClientMetric("WEBSOCKET_DISCONNECT", 0, { attempt, connection_id: connectionId, code: record.code,
      reason: record.reason, initiator: record.initiator, ms_since_last_frame: record.ms_since_last_frame });
    publishConnectionState(REALTIME_CONNECTION_STATE.DISCONNECTED, { attempt });
    scheduleReconnect();
  });
  candidate.addEventListener("error", () => {
    if (candidate === socket && !closeInitiator) closeInitiator = "renderer_error_event";
    try { candidate.close(); } catch (error) { console.warn("[realtime: closing the socket after an error] failed", error); }
  });
}

function scheduleReconnect() {
  if (transportStopped || reconnectTimer || reconnectInProgress || (socket && socket.readyState === WebSocket.OPEN)) return;
  const delay = reconnectDelayMs(reconnectFailureStreak);
  reconnectFailureStreak += 1;
  reportClientMetric("WEBSOCKET_RECONNECT", 0, { next_attempt: connectionAttemptSeq + 1, delay_ms: delay });
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

export function subscribeRealtimeConnectionState(callback) {
  if (typeof callback !== "function") return () => {};
  connectionStateSubscribers.add(callback);
  callback({ state: connectionState, previous: connectionState, connected: connectionState === REALTIME_CONNECTION_STATE.CONNECTED });
  return () => connectionStateSubscribers.delete(callback);
}

export function getRealtimeConnectionState() { return connectionState; }
export function requestRealtimeReconnect() { if (connectionState !== REALTIME_CONNECTION_STATE.CONNECTED) connect(); }

// A dotted code (US.AAPL, CC.BTCUSD) is a Futu product, any other a Shioaji one; clearing ("") names its source.
export function setRealtimeFocusSymbol(code, { force = false, source = "" } = {}) {
  const normalized = String(code || "").trim().toUpperCase();
  const owner = source || (normalized.includes(".") ? "futu" : "shioaji");
  const focus = focusBySource.get(owner);
  if (!focus) throw new Error(`unknown focus source ${owner}`);
  if (!force && normalized === focus.code && (focus.generation || !normalized)) return focus.generation;
  const had = focus.code;
  focus.code = normalized;
  if (!normalized) {
    focus.generation = 0;
    focus.requestId = "";
    if (had) sendFocusRequest(owner);
    return 0;
  }
  sendFocusRequest(owner);
  return focus.generation;
}

export function getRealtimeFocusState() {
  return Object.fromEntries([...focusBySource].map(([source, focus]) => [source, { ...focus }]));
}

// Feature stores (one-way dependency: they import this module) publish their
// own diagnostics here instead of this module importing them.
const transportDiagnostics = new Map();
// One session bucket's large orders, asked of Rust B through Market Runtime (B9). B holds every large print of the
// day (also across its restarts); the flow projection only carries the newest few hundred.
const LARGE_ORDER_QUERY_TIMEOUT_MS = 5000;
const pendingLargeOrderQueries = new Map();
let largeOrderQuerySeq = 0;

function settleLargeOrderQuery(payload) {
  const pending = pendingLargeOrderQueries.get(String(payload.request_id || ""));
  if (!pending) return;
  pendingLargeOrderQueries.delete(String(payload.request_id));
  clearTimeout(pending.timer);
  pending.resolve(payload);
}

export function queryRealtimeLargeOrders(spec = {}, { fromMinute, toMinute, limit = 1000, side = "ALL" } = {}) {
  const requestId = `large-orders-${Date.now()}-${++largeOrderQuerySeq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingLargeOrderQueries.delete(requestId);
      resolve({ ok: false, reason: "TIMEOUT", rows: [] });
    }, LARGE_ORDER_QUERY_TIMEOUT_MS);
    pendingLargeOrderQueries.set(requestId, { resolve, timer });
    const sent = sendRealtimeWire({ type: "flow.large_orders", payload: {
      request_id: requestId, source: spec.source, market: spec.market, code: spec.code,
      trading_date: spec.trading_date || undefined, session: spec.session || undefined,
      from_minute: fromMinute, to_minute: toMinute, limit,
      // Chosen by Rust B before the limit: the newest N of that side, not the newest N filtered here.
      side: String(side || "ALL").toUpperCase(),
    } });
    if (!sent) settleLargeOrderQuery({ request_id: requestId, ok: false, reason: "DISCONNECTED", rows: [] });
  });
}

// 歷史回放: Market Runtime plays a recorded partition through the live engine; these are its commands.
// The replay belongs to this connection: a reconnect ends it, and the page opens it again.
const REPLAY_REQUEST_TIMEOUT_MS = 30000;
const pendingReplayRequests = new Map();
const replayStatusListeners = new Set();
const sessionRolloverListeners = new Set();
let replayRequestSeq = 0;

function settleReplayRequest(requestId, payload) {
  const pending = pendingReplayRequests.get(String(requestId || ""));
  if (!pending) return;
  pendingReplayRequests.delete(String(requestId));
  clearTimeout(pending.timer);
  pending.resolve(payload);
}

function replayRequest(type, payload) {
  const requestId = `replay-${Date.now()}-${++replayRequestSeq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingReplayRequests.delete(requestId);
      resolve({ ok: false, error: "TIMEOUT" });
    }, REPLAY_REQUEST_TIMEOUT_MS);
    pendingReplayRequests.set(requestId, { resolve, timer });
    if (!sendRealtimeWire({ type, request_id: requestId, payload })) settleReplayRequest(requestId, { ok: false, error: "DISCONNECTED" });
  });
}

/** Open a recorded partition for replay (paused; at `atNs` when given). Resolves to {ok, replay_id, status} or {ok:false, error}. */
export function openRealtimeReplay({ source, market = "STK", code, tradingDate, session = "DAY" }, { atNs = null, speed = null } = {}) {
  return replayRequest("replay.open", { source, market, code, trading_date: tradingDate, session,
    ...(atNs != null ? { at_ns: String(atNs) } : {}), ...(speed ? { speed } : {}) });
}

/** action: "play" | "pause" | "seek" (with atNs) | "speed" (with speed: 1, 2, 5 or 10). */
export function controlRealtimeReplay(replayId, action, { atNs = null, speed = null } = {}) {
  return replayRequest("replay.control", { replay_id: replayId, action,
    ...(atNs != null ? { at_ns: String(atNs) } : {}), ...(speed ? { speed } : {}) });
}

export function closeRealtimeReplay(replayId) {
  return replayId ? replayRequest("replay.close", { replay_id: replayId }) : Promise.resolve({ ok: true, closed: false });
}

/** Position / playing / speed of the open replay, pushed by Market Runtime about every 250 ms. */
export function subscribeRealtimeReplayStatus(callback) {
  replayStatusListeners.add(callback);
  return () => replayStatusListeners.delete(callback);
}

const eventTapeListeners = new Set();

/** 事件列表: the tape this window wants. Held here like the focus and the workspace: sent now if the socket is open
 * and again on every (re)connect; Market Runtime answers with `events.snapshot` -- and sends one by itself at a session
 * rollover -- then pushes new and revised events as `events.tape`, so the page never re-subscribes to learn the date.
 * Snapshots reach onRealtimeEventTapeSnapshot listeners. */
let desiredEventTape = null;
function sendDesiredEventTape() {
  if (!desiredEventTape) return false;
  return sendRealtimeWire({ type: "events.subscribe", payload: { ...desiredEventTape, request_id: `events-${Date.now()}` } });
}
export function setRealtimeEventTape({ market = "STK", session = "DAY", limit = 600 } = {}) {
  desiredEventTape = { market, session, limit };
  return sendDesiredEventTape();
}
const eventTapeSnapshotListeners = new Set();
export function onRealtimeEventTapeSnapshot(callback) {
  if (typeof callback !== "function") return () => {};
  eventTapeSnapshotListeners.add(callback);
  return () => eventTapeSnapshotListeners.delete(callback);
}

export function onRealtimeEventTape(callback) {
  if (typeof callback !== "function") return () => {};
  eventTapeListeners.add(callback);
  return () => eventTapeListeners.delete(callback);
}

// The session Market Runtime pushed on this connection, or with its last rollover ({equity: {trading_date, ...},
// taiex, cutoffs}); null while disconnected. A subscriber gets the current one at once (when there is one) and every
// later one -- nothing to read, so nothing to retry.
let currentSession = null;
const sessionListeners = new Set();
function publishRealtimeSession(session) {
  currentSession = session;
  notifyListeners(sessionListeners, session, "SESSION");
}
export function subscribeRealtimeSession(callback) {
  if (typeof callback !== "function") return () => {};
  sessionListeners.add(callback);
  if (currentSession) {
    try { callback(currentSession); } catch (error) { console.warn("[realtime: a session subscriber] failed", error); }
  }
  return () => sessionListeners.delete(callback);
}

// Rust B's rebuild progress as Market Runtime measures it ({state, progress, cursor, head, catch_up_from}): pushed on
// every connection, at each B report while B catches up and when its state changes (server/analysis_state.rs).
// The screens that show B's blocks draw 分析資料重建中 from it (core/analysis_rebuild_notice.js).
let currentAnalysisState = null;
const analysisStateListeners = new Set();
function publishAnalysisState(state) {
  currentAnalysisState = state;
  notifyListeners(analysisStateListeners, state, "ANALYSIS STATE");
}
export function subscribeRealtimeAnalysisState(callback) {
  if (typeof callback !== "function") return () => {};
  analysisStateListeners.add(callback);
  if (currentAnalysisState) {
    try { callback(currentAnalysisState); } catch (error) { console.warn("[realtime: an analysis state subscriber] failed", error); }
  }
  return () => analysisStateListeners.delete(callback);
}

// Called with {rolled, cleared, session} whenever Market Runtime rolls a session over (see the session.rollover branch).
export function subscribeRealtimeSessionRollover(callback) {
  if (typeof callback !== "function") return () => {};
  sessionRolloverListeners.add(callback);
  return () => sessionRolloverListeners.delete(callback);
}
export function registerRealtimeDiagnostics(name, provider) { transportDiagnostics.set(String(name), provider); }
export function subscribeRealtimeView(spec, callback, options = {}) { return realtimeViewStore.subscribe(spec, callback, options); }
export function getRealtimeViewSnapshot(spec) { return realtimeViewStore.snapshot(spec); }
// Clone-free read for list rows. See RealtimeViewStore.select(): `project` receives the LIVE view
// state and must only read from it.
export function selectRealtimeView(spec, project) { return realtimeViewStore.select(spec, project); }
export function getRealtimeViewStats() { return realtimeViewStore.stats(); }
export function getRealtimeTransportHealth() {
  return { connected: connectionState === REALTIME_CONNECTION_STATE.CONNECTED,
    connection_id: activeConnectionId, last_frame_at: lastWebSocketFrameAt,
    connected_at: connectedSince || null, disconnect_count: disconnectCount,
    // 目前無使用，之後要刪除: last_heartbeat_at, heartbeat_round_trip_ms (連線診斷 no longer shows them, user 10-19).
    // last_heartbeat_at: lastHeartbeatAckAt || null,
    // heartbeat_round_trip_ms: heartbeatRoundTripMs,
    recent_disconnects: recentDisconnects.slice(),
    frame_parse_errors: realtimeFrameParseErrors, last_frame_parse_error_at: lastRealtimeFrameParseErrorAt || null,
    frame_shape_errors: realtimeFrameShapeErrors, last_frame_shape_error_at: lastRealtimeFrameShapeErrorAt || null,
    ...Object.fromEntries([...transportDiagnostics].map(([name, provider]) => [name, provider()])) };
}
// The workspace this window wants hot. The transport owns it like the focus: it is sent now if the socket is open
// and again on every (re)connect, so no caller retries on a timer.
let desiredWorkspace = null;
function sendDesiredWorkspace() {
  if (desiredWorkspace === null) return false;
  return sendRealtimeWire({ type: "workspace.replace", payload: { codes: desiredWorkspace, symbols: desiredWorkspace } });
}
export function replaceRealtimeWorkspace(codes = []) {
  desiredWorkspace = [...new Set(codes.map((code) => String(code || "").trim().toUpperCase()).filter(Boolean))];
  return sendDesiredWorkspace();
}

// Takes no callback: there is no batch. Connection state is `subscribeRealtimeConnectionState()`
// and market data is `subscribeRealtimeView()`.
export function startRealtimeStream() { transportStopped = false; connect(); }

// Every request still waiting on the transport ends with it: its timeout cleared, its wait for a connection
// released, and its caller answered -- none outlives a stopped stream.
function settlePendingRequests(reason) {
  for (const [map, answer] of [[pendingLargeOrderQueries, { ok: false, reason, rows: [] }],
    [pendingReplayRequests, { ok: false, error: reason }]]) {
    for (const pending of map.values()) {
      clearTimeout(pending.timer);
      pending.stopWaiting?.();
      pending.resolve(answer);
    }
    map.clear();
  }
}

/** End the live transport: no reconnect, every timer and pending request ended, the socket closed with 1000
 * (no reconnect/heartbeat/metric timer outlives the page). */
export function stopRealtimeStream(reason = "client_stop") {
  transportStopped = true;
  settlePendingRequests("STOPPED");
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  clearHeartbeatTimers();
  // The last local metrics are kept (written to the renderer's log now); the latency samples belong to the closing
  // connection and go with it.
  flushClientMetrics();
  if (latencyTimer) clearTimeout(latencyTimer);
  latencyTimer = null;
  latencySamples = [];
  if (liveReconnect) {
    liveReconnect.finish("abandoned", { attempt: liveReconnectAttempts, detail: { reason } });
    liveReconnect = null;
  }
  const current = socket;
  socket = null;
  reconnectInProgress = false;
  if (current) {
    closeInitiator = "renderer_stop";
    try { current.close(1000, String(reason).slice(0, 100)); } catch (error) { console.warn("[realtime: closing the socket] failed", error); }
  }
  realtimeViewStore.onDisconnected();
  publishConnectionState(REALTIME_CONNECTION_STATE.DISCONNECTED, { reason });
}
// The App is closing (Electron main, before it asks Health to stop the backend): the socket stops here rather than
// reconnecting to a Market Runtime stopped by design -- each close recorded a reconnect no page lived to finish.
globalThis.window?.desktopAPI?.onAppClosing?.(() => stopRealtimeStream("app_closing"));
export function notifyBackendReadyForRealtime() { if (connectionState !== REALTIME_CONNECTION_STATE.CONNECTED) connect(); }
export function sendRealtimeClientMetric(name, durationMs, detail = null) { reportClientMetric(name, durationMs, detail); }

// First meaningful render: the monitor actually holding an applied analysis row, which is what the
// user sees as "the product list has numbers in it". It fires from the path that produces the state,
// so it needs no batch boundary to hang off. Idempotent -- only the first call reports.
let firstMeaningfulRenderReported = false;
export function reportFirstMeaningfulRender(detail = null) {
  if (firstMeaningfulRenderReported) return false;
  firstMeaningfulRenderReported = true;
  reportClientMetric("first_meaningful_render", performance.now() - rendererStartedAt, detail);
  return true;
}

// Core diagnostics read these through core/realtime_stats.js (core never imports this feature).
registerRealtimeStats({ viewStats: getRealtimeViewStats, focusState: getRealtimeFocusState, transportHealth: getRealtimeTransportHealth,
  session: () => currentSession });
