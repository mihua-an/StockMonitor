import { isUsableInstrumentName, resolveInstrumentDisplayName } from "../core/instrument_names.js";
import { numberOrNull } from "../core/numbers.js";

export function positiveMarketPrice(value) {
  const number = numberOrNull(value);
  return number != null && number > 0 ? number : null;
}

// The market facts of a stock row. Market Runtime's ProductMarketSummary is their one source (D01-06): a watch item or
// an analysis row that carries one of these names never supplies it -- not as a fallback, not by being spread last --
// so no session phase needs its own rule for which of them wins.
const MARKET_FIELDS = Object.freeze([
  "prev_close", "reference_price", "reference_source", "current", "last_price", "price", "close", "open", "high", "low",
  "day_high", "day_low", "total_volume", "volume", "total_amount", "average", "avg_price", "change", "change_pct",
  "price_chg", "pct_chg", "indicative_price", "status", "limit_up", "limit_down", "amplitude", "prev_volume",
]);

function withoutMarketFields(row) {
  const out = { ...row };
  for (const key of MARKET_FIELDS) delete out[key];
  return out;
}

/**
 * One renderer-side stock row, joined by owner: the market facts (昨收, 現價, 開高低, 量, 漲跌) are Market Runtime's
 * ProductMarketSummary as it is, the analysis fields (model predictions, 量變) the live signal row's, and the name and
 * market the watch item's (Market Runtime's reference name when the watch page has none).
 */
export function mergeStockMarketSummary({ watchItem = {}, productSummary = {}, liveSignal = {} } = {}) {
  const watch = watchItem && typeof watchItem === "object" ? watchItem : {};
  const summary = productSummary && typeof productSummary === "object" ? productSummary : {};
  const live = liveSignal && typeof liveSignal === "object" ? liveSignal : {};
  const merged = { ...withoutMarketFields(watch), ...withoutMarketFields(live), ...summary };
  // The day range under the names the rows read.
  const high = positiveMarketPrice(summary.high), low = positiveMarketPrice(summary.low);
  if (high != null) merged.day_high = high;
  if (low != null) merged.day_low = low;
  // 均價 is Market Runtime's running average (summary `average`), under the name the 均價 column reads.
  const average = positiveMarketPrice(summary.average);
  if (average != null) merged.avg_price = average;

  // Rust B's rolling windows ride on the product summary (canonical_view_owner windowSummaryFields): a coherent
  // snapshot, so a signal row's zero/null for the same window never replaces it.
  if (summary.short_change_source === "NATIVE_ROLLING_WINDOW") {
    for (const minutes of [1, 3, 5]) {
      merged[`chg_${minutes}m`] = numberOrNull(summary[`chg_${minutes}m`]);
      merged[`price_${minutes}m_ago`] = numberOrNull(summary[`price_${minutes}m_ago`]);
      merged[`price_change_${minutes}m`] = merged[`chg_${minutes}m`];
      merged[`change_${minutes}m`] = merged[`chg_${minutes}m`];
      merged[`k_${minutes}m`] = numberOrNull(summary[`k_${minutes}m`]);
    }
  }
  if (summary.volume_baseline_source) {
    for (const key of ["baseline_date", "baseline_minute", "baseline_volume",
      "volume_diff_vs_baseline", "volume_ratio_vs_baseline",
      "volume_change_pct_vs_baseline"]) {
      merged[key] = summary[key] ?? null;
    }
  }

  // The watch page / catalog name is the authority, then Market Runtime's reference name; an analysis row's `name`
  // is no product name (it can be the code itself).
  const nameCode = String(merged.code || watch.code || summary.code || live.code || "");
  const resolvedName = resolveInstrumentDisplayName(
    "shioaji", nameCode, watch.name, watch.stock_name, summary.name, summary.stock_name);
  merged.name = resolvedName === nameCode && !isUsableInstrumentName("shioaji", nameCode, resolvedName) ? "" : resolvedName;
  merged.market = watch.market || summary.market || "";
  return merged;
}

/** Merge a canonical summary delta without letting null/empty partial fields erase
 * a valid durable ProductMarketSummary value. */
export function mergeCanonicalStockSummary(existing = {}, incoming = {}, code = "") {
  const result = { ...(existing && typeof existing === "object" ? existing : {}) };
  const positivePriceFields = new Set([
    "prev_close", "reference_price", "current", "last_price", "price",
    "open", "high", "day_high", "low", "day_low",
  ]);
  for (const [key, value] of Object.entries(incoming && typeof incoming === "object" ? incoming : {})) {
    if (value === null || value === undefined || value === "") continue;
    if (positivePriceFields.has(key) && positiveMarketPrice(value) == null) continue;
    result[key] = value;
  }
  if (code) result.code = String(code).trim().toUpperCase();
  return mergeStockMarketSummary({ productSummary: result });
}
