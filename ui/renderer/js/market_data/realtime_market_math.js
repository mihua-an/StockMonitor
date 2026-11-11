// Pure numeric/formatting/derivation helpers of the 即時報價 page. Every export here reads only its own parameters, calls
// other functions in this module, or calls other already-pure core/ helpers
// (imported directly below) or truly generic globals such as Number/Math/
// Date -- no module-level page state.

import { classifyTradeSideFromTick } from "../core/market_color_policy.js";
import { tradeRowDisplayTime } from "../core/trade_row_order.js";

import { numberOrNull } from "../core/numbers.js";

export function canonicalTradeSide(tick) {
  return classifyTradeSideFromTick(tick);
}

export function tickTime(tick) {
  return tradeRowDisplayTime(tick);
}

export function eventEpochMs(row = {}) {
  const direct = Date.parse(String(row?.datetime || row?.timestamp || row?.received_at || ""));
  if (Number.isFinite(direct)) return direct;
  const dateText = String(row?.exchange_date || "").trim();
  const timeText = String(row?.exchange_time || row?.time || "").trim();
  const combined = dateText && timeText ? Date.parse(`${dateText}T${timeText}`) : Number.NaN;
  return Number.isFinite(combined) ? combined : null;
}

export function isSimtradeTick(row = {}) {
  if (row?.simtrade === true || row?.simtrade === 1 || String(row?.simtrade || "").toLowerCase() === "true") return true;
  const flags = Number(row?.flags);
  return Number.isFinite(flags) && (flags & 1) === 1;
}

// A trade's size is `volume` from every producer (Rust A's tape, the stored pages, history replay).
export function tickVolume(row = {}) {
  return row?.volume ?? 0;
}

// One 五檔 update: Rust A's book carries the exchange time of the quote it is (wire.rs `book`).
export function orderbookDiffEventToken(book = {}) {
  const token = book?.exchange_ts_ns;
  return token == null || token === "" ? null : String(token);
}


// The selection generation is an explicit parameter, never read off the shared
// selectionIntentStore module state.
export function canonicalDisplayFrame(symbol, state = {}, sequence = null, generation = 0) {
  const normalized = String(symbol || "").trim().toUpperCase();
  const selectionGeneration = Number(generation || 0);
  const sessionGeneration = Number(state?.session_generation || state?.market_session_generation || 0);
  const displaySequence = Number(sequence ?? state?.watermark ?? 0) || 0;
  const presentationState = String(state?.presentation_state || "loading").toLowerCase();
  return {
    displaySymbol: normalized,
    selectionGeneration,
    sessionGeneration,
    displaySequence,
    displayEpoch: `${selectionGeneration}:${normalized}:${sessionGeneration}`,
    viewStatus: String(state?.view_status || ""),
    presentationState,
    loading: presentationState === "loading",
    stale: presentationState === "stale" || presentationState === "resyncing",
    resyncing: presentationState === "resyncing",
    viewError: state?.view_error || null,
  };
}

export function normalizeDaemonPriceVolume(projection = {}) {
  const source = projection && typeof projection === "object" ? projection : {};
  const rawRows = Array.isArray(source.buckets)
    ? source.buckets
    : Array.isArray(source.byPrice) ? source.byPrice : [];
  const byPrice = rawRows.map((row) => ({
    price: numberOrNull(row?.price),
    out: Number(row?.out ?? 0) || 0,
    in: Number(row?.in ?? 0) || 0,
    unknown: Number(row?.unknown ?? 0) || 0,
  })).filter((row) => row.price != null).sort((a, b) => a.price - b.price);
  return {
    outVol: Number(source.out_volume ?? 0) || 0,
    inVol: Number(source.in_volume ?? 0) || 0,
    currentPrice: numberOrNull(source.current_price),
    byPrice,
    sampleCount: Number(source.sample_count || 0) || 0,
    coverageState: String(source.coverage_state || "").toUpperCase(),
  };
}

export function normalizeRustTradeFlow(source = {}) {
  if (!source || typeof source !== "object") return null;
  const rawMinutes = Array.isArray(source.minuteSeries) ? source.minuteSeries : source.minute_series;
  const rawHours = Array.isArray(source.hourSeries) ? source.hourSeries : source.hour_series;
  if (!source.cumulative || !Array.isArray(rawMinutes)) return null;
  const normalizeTimed = (row = {}) => {
    const stamp = Number(row.timestamp_ms ?? row.timestampMs);
    const date = Number.isFinite(stamp) && stamp > 0 ? new Date(stamp) : null;
    // Rust timestamps carry exchange-local wall clock values in epoch-shaped
    // integers. UTC accessors prevent the browser from adding +08:00 again.
    return { ...row, time: row.time || (date ? `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}` : "--"), timestampMs: Number.isFinite(stamp) ? stamp : null };
  };
  return {
    ...source,
    available: Number(source.sample_count || source.sampleCount || 0) > 0 || rawMinutes.length > 0,
    minuteSeries: rawMinutes.map(normalizeTimed),
    hourSeries: (Array.isArray(rawHours) ? rawHours : []).map(normalizeTimed),
    largeOrders: (Array.isArray(source.largeOrders) ? source.largeOrders : source.large_orders || []).map(normalizeTimed),
    definition_version: source.definition_version || "rust-event-time-flow-v3",
  };
}

