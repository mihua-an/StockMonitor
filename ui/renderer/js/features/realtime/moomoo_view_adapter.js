// Projects RealtimeViewStore's merged view state (Market Runtime's snapshot/
// delta shape: summary/trend/trades/orderbook/windows/...) into the Futu product-row
// fields the product list reads (regular_* quote facts, average price, and Rust B's
// rolling windows). Market Runtime and Rust B are the only sources; nothing here is
// computed, accumulated or reconciled against any daemon REST read.

import { signalRowFields } from "./signal_row.js";
import { numberOrNull } from "../../core/numbers.js";
import { windowSummaryFields } from "../../market_data/rolling_window_fields.js";

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

// The analysis projection's per-symbol row (the view's `signals` channel) goes through the one field projection the
// Shioaji rows use too (signal_row.js); the rolling windows (the `windows` channel) through the one window reading
// they use (rolling_window_fields.js).
/**
 * Product-row live fields of one view state: Market Runtime's regular_* quote
 * facts and average price, and Rust B's 1/3/5-minute (and longer) windows.
 */
export function viewStateToMoomooProductFields(state = {}) {
  const summary = state?.summary || {};
  const fields = { ...(signalRowFields(state?.signals) || {}) };
  const current = nonNegative(summary.current);
  if (current !== null) {
    fields.regular_current = current;
    fields.last_price = current;
  }
  const prev = nonNegative(summary.prev_close);
  if (prev !== null) fields.prev_close_price = prev;
  // The comparison price every list reads (displayQuote().reference): Market Runtime's, on the Futu rows as on the others.
  const reference = nonNegative(summary.reference_price);
  if (reference !== null) fields.reference_price = reference;
  // 漲跌 / 漲幅: Market Runtime's, never derived from the two prices here (D01-04).
  fields.change = numberOrNull(summary.change);
  fields.change_pct = numberOrNull(summary.change_pct);
  fields.amplitude = numberOrNull(summary.amplitude);
  for (const [target, source] of [["open", "open"], ["high", "high"], ["low", "low"]]) {
    const value = nonNegative(summary[source]);
    if (value !== null) { fields[`regular_${target}`] = value; fields[`${target}_price`] = value; }
  }
  // A missing total (null / "") is no volume, never 0.
  const totalVolume = numberOrNull(summary.total_volume);
  if (totalVolume !== null) {
    fields.regular_volume = totalVolume;
    fields.volume = totalVolume;
  }
  const trend = Array.isArray(state?.trend) ? state.trend : [];
  const last = trend.length ? trend[trend.length - 1] : null;
  const average = nonNegative(last?.average_price ?? last?.average);
  if (average !== null) { fields.regular_avg_price = average; fields.avg_price = average; }
  // 1m／3m／5m (and the other windows): Rust B's, as on the Shioaji rows -- never computed here. B's windows are
  // authoritative over the signal row for the same fields.
  Object.assign(fields, windowSummaryFields(state?.windows || {}));
  return fields;
}
