// A live view's state: applying Market Runtime's deltas (trades window, minute trend, book, price-volume ladder,
// events) to a view's state, and what that state presents (ready / empty / stale / loading). Pure: no store, no I/O.
import { upsertMinuteTrendPoint } from "./minute_trend.js";
import { compareTradeRowsNewestFirst, tradeRowKey } from "../core/trade_row_order.js";

export function clone(value) {
  if (value == null) return value;
  if (typeof structuredClone === "function") {
    try { return structuredClone(value); } catch (_error) { /* not an error: structuredClone cannot copy that value; the JSON copy below is used */ }
  }
  return JSON.parse(JSON.stringify(value));
}

export function nowIso() { return new Date().toISOString(); }

// The live table is exactly one 100-row page. Rows older than this window are
// served by the durable TradeDetail pagination endpoint, not duplicated in UI RAM.
export const UI_TRADE_WINDOW = 100;

// A print into the view's window in exchange-time order (oldest first, as Market Runtime holds it): a gap filled
// afterwards is older than the newest print and takes its place among them. The same print twice is kept once, and
// the window keeps the newest UI_TRADE_WINDOW by exchange time, not by arrival.
export function insertTrade(trades, trade) {
  const rows = Array.isArray(trades) ? trades : [];
  const key = tradeRowKey(trade);
  const kept = rows.filter((row) => tradeRowKey(row) !== key);
  let at = kept.length;
  while (at > 0 && compareTradeRowsNewestFirst(kept[at - 1], trade) < 0) at -= 1;
  kept.splice(at, 0, trade);
  return kept.length > UI_TRADE_WINDOW ? kept.slice(-UI_TRADE_WINDOW) : kept;
}

export function hasRenderableData(state) {
  if (!state || typeof state !== "object") return false;
  if (Array.isArray(state.trades) && state.trades.length) return true;
  if (Array.isArray(state.trend) && state.trend.length) return true;
  if (state.orderbook && Object.keys(state.orderbook).length) return true;
  if (state.summary && Object.keys(state.summary).length) return true;
  if (state.coverage && Object.keys(state.coverage).length) return true;
  return false;
}

export function presentationState(entry) {
  if (!entry) return "loading";
  if (entry.status === "ERROR") return "error";
  if (["RESYNC_REQUIRED", "RESYNCING"].includes(entry.status)) return "resyncing";
  if (["SUBSCRIBING", "SNAPSHOT_PENDING"].includes(entry.status)) {
    return entry.state ? "stale" : "loading";
  }
  if (["STALE", "UNSUBSCRIBED", "CACHED"].includes(entry.status)) {
    return entry.state ? "stale" : "loading";
  }
  if (entry.state) return hasRenderableData(entry.state) ? "ready" : "empty";
  return "loading";
}

// Upsert `incoming` rows into `held` (both ordered by the numeric `key`): a new array, each row whole.
function upsertRows(held, incoming, key) {
  const rows = Array.isArray(held) ? [...held] : [];
  for (const row of Array.isArray(incoming) ? incoming : []) {
    const at = Number(row?.[key]);
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (Number(rows[mid]?.[key]) < at) lo = mid + 1; else hi = mid;
    }
    if (lo < rows.length && Number(rows[lo]?.[key]) === at) rows[lo] = row; else rows.splice(lo, 0, row);
  }
  return rows;
}

function mergeFlowIncrement(held, increment) {
  const { replace: _replace, minuteSeries, largeOrders, ...fields } = increment;
  const merged = { ...held, ...fields, minuteSeries: upsertRows(held.minuteSeries, minuteSeries, "minute") };
  if (Array.isArray(largeOrders)) merged.largeOrders = largeOrders;
  return merged;
}

function mergeDayIncrement(held, increment) {
  const { replace: _replace, fixed_k: fixedK, price_volume: priceVolume, ...fields } = increment;
  const merged = { ...held, ...fields };
  if (fixedK && typeof fixedK === "object") {
    merged.fixed_k = { ...(held.fixed_k || {}) };
    for (const [timeframe, bars] of Object.entries(fixedK)) {
      merged.fixed_k[timeframe] = upsertRows(merged.fixed_k[timeframe], bars, "start_minute");
    }
  }
  if (priceVolume && typeof priceVolume === "object") {
    const { buckets, ...pvFields } = priceVolume;
    const heldPv = held.price_volume || {};
    merged.price_volume = { ...heldPv, ...pvFields, buckets: upsertRows(heldPv.buckets, buckets, "price") };
  }
  return merged;
}

// The 價量 projection from a day increment: its fields replace, its changed rows merge by price.
function mergePriceVolumeIncrement(current = {}, increment = {}) {
  const { buckets, ...fields } = increment;
  const rows = upsertRows(Array.isArray(current.buckets) ? current.buckets : (Array.isArray(current.byPrice) ? current.byPrice : []), buckets, "price");
  return { ...current, ...fields, buckets: rows, byPrice: rows };
}

export function mergePriceVolumeProjection(current = {}, payload = {}) {
  const incoming = payload && typeof payload === "object" ? { ...payload } : {};
  const fullRows = Array.isArray(incoming.buckets)
    ? incoming.buckets
    : Array.isArray(incoming.byPrice) ? incoming.byPrice : null;
  if (fullRows) {
    // A full ladder replaces the rows: the previous projection's (possibly unbuilt) ladder is not read.
    const replaced = {};
    for (const key of Object.keys(current || {})) {
      if (key !== "buckets" && key !== "byPrice") replaced[key] = current[key];
    }
    return { ...replaced, ...incoming, buckets: fullRows, byPrice: fullRows };
  }
  const bucket = incoming.bucket && typeof incoming.bucket === "object" ? incoming.bucket : null;
  if (!bucket) return { ...current, ...incoming };
  if (!Number.isFinite(Number(bucket.price))) return { ...current, ...incoming };
  return lazyLadderProjection(current, incoming, bucket);
}

// A bucket delta arrives with every trade, but the ladder is read once per render frame. Copying the sorted ladder
// per delta made every trade O(levels) in allocation, so a delta only links itself to the previous
// projection (O(1)); the sorted array is built the first time a reader asks for `buckets`/`byPrice`, from the
// nearest projection that already has one, and kept on this projection. Nothing handed out is ever written: the
// array a reader got is never modified, a later delta builds its own. The chain is bounded -- a projection nobody
// reads (a hidden page) is materialized every LADDER_CHAIN_LIMIT deltas instead of holding them all.
const LADDER = Symbol("priceVolumeLadder");
const LADDER_CHAIN_LIMIT = 256;

function placeBucket(rows, bucket) {
  const price = Number(bucket.price);
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (Number(rows[mid]?.price || 0) < price) low = mid + 1;
    else high = mid;
  }
  if (low < rows.length && Number(rows[low]?.price) === price) rows[low] = { ...rows[low], ...bucket };
  else rows.splice(low, 0, bucket);
}

function ladderRows(projection) {
  const ladder = projection?.[LADDER];
  if (!ladder) {
    if (Array.isArray(projection?.buckets)) return projection.buckets;
    return Array.isArray(projection?.byPrice) ? projection.byPrice : [];
  }
  if (ladder.rows) return ladder.rows;
  const pending = [];
  let node = projection;
  while (node?.[LADDER] && !node[LADDER].rows) {
    pending.push(node[LADDER].bucket);
    node = node[LADDER].parent;
  }
  const rows = ladderRows(node).slice();
  for (let i = pending.length - 1; i >= 0; i -= 1) placeBucket(rows, pending[i]);
  ladder.rows = rows;
  ladder.parent = null;   // built: the earlier projections are no longer needed
  ladder.bucket = null;
  return rows;
}

function lazyLadderProjection(current, incoming, bucket) {
  const merged = {};
  for (const key of Object.keys(current || {})) {
    if (key !== "buckets" && key !== "byPrice") merged[key] = current[key];
  }
  for (const [key, value] of Object.entries(incoming)) {
    if (key !== "bucket" && key !== "buckets" && key !== "byPrice") merged[key] = value;
  }
  const depth = current?.[LADDER] && !current[LADDER].rows ? current[LADDER].depth + 1 : 1;
  Object.defineProperty(merged, LADDER, { value: { parent: current, bucket, rows: null, depth }, enumerable: false });
  const read = { get: () => ladderRows(merged), enumerable: true, configurable: false };
  Object.defineProperty(merged, "buckets", read);
  Object.defineProperty(merged, "byPrice", read);
  if (depth >= LADDER_CHAIN_LIMIT) ladderRows(merged);
  return merged;
}

// Matches Market Runtime's own SymbolState::EVENT_CAPACITY.
export const UI_EVENT_WINDOW = 200;

// The view state is immutable: every applied delta yields a NEW top-level object whose changed channels are new
// values, and nothing already handed out is ever written to. Readers therefore get the state itself, never a copy.
// A structuredClone of the whole state (every trade, the trend, the price ladder) on every read, three times per
// 五檔/價量 render, took 40% of the main thread on a live feed (實際持倉 成交明細 一秒一跳, 資料套用延遲 high).
export function applyDeltaToState(current, delta) {
  const state = { ...(current || {}) };
  const type = String(delta?.delta_type || "");
  // Per-projection arrival stamps ride on EVERY delta, and each frame carries the whole current
  // set rather than an increment, so this is a replace.
  //
  // Without it the renderer kept the snapshot's stamps forever: every later delta carried a fresh
  // arrival, the state held the first one, and the measured "latency" therefore grew with uptime
  // instead of describing the event that was actually rendered. The state boundary is the only
  // place this can happen -- the read model is rebuilt from `state`, not from the delta.
  if (delta?.channel_arrival_us && typeof delta.channel_arrival_us === "object") {
    state.channel_arrival_us = delta.channel_arrival_us;
  }
  // WebSocket JSON already owns this payload. Copy only at the mutable state
  // boundary instead of deep-cloning every live delta on the renderer hot path.
  const payload = delta?.payload;
  if (type === "summary.updated") {
    state.summary = { ...(state.summary || {}), ...(payload || {}) };
  } else if (type === "trade.append") {
    state.trades = insertTrade(state.trades, payload);
  } else if (type === "trade.frame" || type === "quote.frame") {
    const frame = payload && typeof payload === "object" ? payload : {};
    if (frame.summary) state.summary = { ...(state.summary || {}), ...frame.summary };
    if (frame.trade) state.trades = insertTrade(state.trades, frame.trade);
    if (frame.price_volume) state.price_volume = mergePriceVolumeProjection(state.price_volume || {}, frame.price_volume);
    if (frame.tradeflow) state.tradeflow = frame.tradeflow;
    if (frame.trend?.point) state.trend = upsertMinuteTrendPoint(Array.isArray(state.trend) ? state.trend : [], frame.trend.point);
  } else if (type === "trend.append" || type === "trend.upsert" || type === "trend.updated") {
    state.trend = upsertMinuteTrendPoint(Array.isArray(state.trend) ? state.trend : [], payload || {});
  } else if (type === "signals.frame") {
    // The analysis projection's per-symbol row. Merged, not replaced: Market Runtime sends only
    // the fields it recomputed, and a field it left out means "no new value", never "clear it".
    // Without this arm the row only ever arrived on a full snapshot -- every signals delta was
    // silently dropped here, so a consumer reading the view (rather than the raw frame) saw the
    // first value and then nothing for the rest of the session.
    const frame = payload && typeof payload === "object" ? payload : {};
    if (frame.signals && typeof frame.signals === "object") {
      const merged = { ...(state.signals || {}) };
      for (const [field, value] of Object.entries(frame.signals)) {
        if (value !== null && value !== undefined) merged[field] = value;
      }
      // Same rule as Market Runtime's merge: 量變 is one fact with the minute it describes. Naming a new comparison
      // minute replaces the pair, so its null percentage is a real clear -- skipping it kept the previous minute's
      // percentage under the new minute.
      if (frame.signals.volume_compare_minute != null) {
        merged.volume_change_pct = frame.signals.volume_change_pct ?? null;
      }
      state.signals = merged;
    }
  } else if (type === "event.frame") {
    // Append-only alert tape, bounded here as well as in Rust: a renderer that outlives many
    // sessions must not accumulate one unboundedly just because the daemon caps its own copy.
    const frame = payload && typeof payload === "object" ? payload : {};
    if (frame.event) {
      state.events = [...(Array.isArray(state.events) ? state.events : []), frame.event]
        .slice(-UI_EVENT_WINDOW);
    }
  } else if (type === "minutes.upsert") {
    // Rust B's minutes (FINALIZED / revised) plus A's overlay of the forming minute. A revision replaces the
    // minute it names; nothing is appended blindly.
    const points = Array.isArray(payload?.points) ? payload.points : [];
    let trend = payload?.replace ? [] : (Array.isArray(state.trend) ? state.trend : []);
    for (const point of points) trend = upsertMinuteTrendPoint(trend, point || {});
    if (payload?.current && typeof payload.current === "object") trend = upsertMinuteTrendPoint(trend, payload.current);
    state.trend = trend;
  } else if (type === "windows.updated") {
    state.windows = payload || {};
  } else if (type === "day.updated") {
    // Rust B's day block: whole, or (`replace: false`) only what changed -- its K bars by start minute and its
    // ladder rows by price merge into what is held (Market Runtime merges the same increment, projection.rs).
    const increment = payload?.replace === false && state.day && typeof state.day === "object";
    state.day = increment ? mergeDayIncrement(state.day, payload) : (payload || {});
    if (payload?.price_volume) {
      state.price_volume = increment
        ? mergePriceVolumeIncrement(state.price_volume || {}, payload.price_volume)
        : mergePriceVolumeProjection(state.price_volume || {}, payload.price_volume);
    }
  } else if (type === "events.upsert") {
    const incoming = Array.isArray(payload?.events) ? payload.events : [];
    const byId = new Map((payload?.replace ? [] : (Array.isArray(state.events) ? state.events : [])).map((e) => [e?.event_id ?? JSON.stringify(e), e]));
    for (const event of incoming) byId.set(event?.event_id ?? JSON.stringify(event), event);
    state.events = [...byId.values()].slice(-UI_EVENT_WINDOW);
  } else if (type === "meta.updated") {
    state.meta = { ...(state.meta || {}), ...(payload || {}) };
  } else if (type === "orderbook.latest") {
    state.orderbook = payload || {};
  } else if (type === "tradeflow.updated") {
    // Whole, or (`replace: false`) only what changed: its minutes by minute; a large-order list it leaves out is unchanged.
    state.tradeflow = payload?.replace === false && state.tradeflow && typeof state.tradeflow === "object"
      ? mergeFlowIncrement(state.tradeflow, payload)
      : (payload || {});
  } else if (type === "price_volume.updated") {
    state.price_volume = mergePriceVolumeProjection(state.price_volume || {}, payload || {});
  } else if (type === "session.coverage.updated") {
    state.coverage = { ...(state.coverage || {}), ...(payload || {}) };
  } else if (type === "session.completed") {
    state.state = "COMPLETE";
    state.coverage = { ...(state.coverage || {}), ...(payload || {}), state: "COMPLETE" };
  } else if (type === "stream.reset" || type === "snapshot.required") {
    state.resync_required = true;
  }
  return state;
}
