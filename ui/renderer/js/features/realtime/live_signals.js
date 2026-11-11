// 即時報價頁's analysis rows (appState.signalsByCode) and their coverage diagnostics.
//
// One authority: an instrument's row is the `signals` block of its own canonical view -- the view
// snapshot (subscribe, resync, rollover) or a `signals.frame` delta. Market Runtime sends the instrument's WHOLE
// merged signals object in both (projection.rs merge_signals), and the view store already orders them per
// instrument, so a row is REPLACED by the newest one, never merged into. The other writers are gone: the global
// `signals.snapshot` read at start/reconnect (a second copy that needed write-serial fencing against the pushes and
// field-by-field "keep the previous value" rules), and the startup cache read from output/latest_signals.json, a
// file nothing has written since the producer moved to B.
import { appState } from "../../core/state.js";
import { realtimeContext } from "../../core/dashboard_context.js";
import { mergeStockMarketSummary } from "../../market_data/stock_market_summary.js";
import { productSummaryOf } from "./product_summary_reader.js";

// Signal-coverage diagnostics, computed ON DEMAND -- never stored, never rendered as a summary. There is deliberately
// no 訊號數量 / 尚無訊號 / 全域更新時間 readout (the ids once written for it existed in no markup); realtime.js folds
// getRealtimeSignalCoverage() into its diagnostics, and a product with no analysis row shows "--" in its own cells.
// "Missing" is a readiness statement, not a failure. newest_update_time is the EXCHANGE clock, not local arrival.

/** Products on the active watch page for which no analysis row is currently held. */
export function derivedMissingCodes() {
  const withSignal = new Set();
  for (const code of appState.signalsByCode.keys()) if (code) withSignal.add(String(code).trim().toUpperCase());
  const missing = [];
  for (const item of appState.watchlistItems) {
    const code = String(item?.code || "").trim().toUpperCase();
    if (code && !withSignal.has(code)) missing.push(code);
  }
  return missing;
}

export function latestSignalStamp() {
  let newest = "";
  for (const signal of appState.signalsByCode.values()) {
    const stamp = String(signal?.update_time || "").trim();
    // Exchange clock, "HH:MM:SS" -- lexical order is chronological order within a session.
    if (/^\d{2}:\d{2}:\d{2}$/.test(stamp) && stamp > newest) newest = stamp;
  }
  return newest;
}

export function getRealtimeSignalCoverage() {
  const missing = derivedMissingCodes();
  return {
    page_products: appState.watchlistItems.length,
    signal_rows: appState.signalsByCode.size,
    missing_count: missing.length,
    missing_codes: missing.slice(0, 20),
    newest_update_time: latestSignalStamp() || null,
    authority: "analysis_projection",
  };
}

/**
 * Replace (or remove) whole analysis rows. `rows` are `{ code, fields }` with `fields` from signalRowFields(); a
 * code in `removedCodes` has no row any more (its view says so, it left the page, or the session rolled over).
 * Only the store is written: the returned dirty codes are a changed channel of the event that carried them, and
 * that event's fan-out (canonical_view_owner.js) redraws the product rows and detail panels once for all channels.
 */
export function replaceSignalRows({ rows = [], removedCodes = [] } = {}) {
  // The rows are kept by code: a one-symbol update replaces one entry (it rebuilt the whole map and array).
  const signalMap = appState.signalsByCode;
  const dirtyCodes = new Set();

  for (const { code: rawCode, fields } of rows || []) {
    const code = String(rawCode || "");
    if (!code) continue;
    signalMap.set(code, { ...(fields || {}), code });
    dirtyCodes.add(code);
  }
  for (const code of removedCodes || []) {
    const normalized = String(code || "");
    signalMap.delete(normalized);
    dirtyCodes.add(normalized);
  }

  return dirtyCodes;
}

export function getSelectedRealtimeSignal() {
  const selected = String(realtimeContext.symbolStore.getSelectedSymbol() || "").trim().toUpperCase();
  if (!selected) return null;

  const signal = appState.signalsByCode.get(selected);
  const watchItem = appState.watchlistItems.find((item) => String(item.code || "").trim().toUpperCase() === selected);
  const viewSummary = productSummaryOf(selected);
  const summary = Object.keys(viewSummary).length ? viewSummary : null;

  if (!signal && !watchItem && !summary) return null;

  return {
    ...mergeStockMarketSummary({
      watchItem: watchItem || {},
      productSummary: summary || {},
      liveSignal: signal || {},
    }),
    code: selected,
  };
}
