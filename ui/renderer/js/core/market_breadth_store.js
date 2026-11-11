// 漲跌家數 (exchange-wide breadth): read from the TAIEX view's summary. The page that owns the view
// installs the reader and tells this module when the view changed; there is no second, separately ordered copy of
// the counts any more (the view store's sequence protocol already orders the summary it holds).
import { callListener, notifyEach } from "./listeners.js";

const fields = ["up_count", "down_count", "limit_up_count", "limit_down_count", "flat_count"];
let reader = () => null;
let last = "";
const listeners = new Set();

/** The counts in a TAIEX summary, under their canonical names. The ingress renames the index quote's
 * raise_count/fall_count to advance_count/decline_count (service/market/shioaji/callback.py). */
export function breadthFromSummary(summary = {}) {
  const values = {
    ...summary,
    up_count: summary?.up_count ?? summary?.advance_count ?? summary?.raise_count,
    down_count: summary?.down_count ?? summary?.decline_count ?? summary?.fall_count,
  };
  const out = {};
  const date = String(summary?.trading_date || summary?.exchange_date || "");
  if (date) out.trading_date = date;
  for (const field of fields) {
    const raw = values[field];
    if (raw !== null && raw !== undefined && raw !== "" && Number.isFinite(Number(raw)) && Number(raw) >= 0) out[field] = Number(raw);
  }
  return out;
}

export function setMarketBreadthReader(fn) {
  reader = typeof fn === "function" ? fn : () => null;
  return () => { if (reader === fn) reader = () => null; };
}

export function getMarketBreadth() {
  try { return breadthFromSummary(reader() || {}); } catch (error) { console.warn("[market breadth] reading the summary failed", error); return {}; }
}

/** The TAIEX view changed: listeners hear the counts when they differ from what they last heard. */
export function notifyMarketBreadthChanged() {
  const next = getMarketBreadth();
  const text = JSON.stringify(next);
  if (text === last) return;
  last = text;
  notifyEach(listeners, "market breadth: change", { ...next });
}

export function subscribeMarketBreadth(listener) {
  listeners.add(listener);
  callListener(listener, "market breadth: immediate", getMarketBreadth());
  return () => listeners.delete(listener);
}
