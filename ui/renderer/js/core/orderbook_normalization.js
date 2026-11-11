import { numberOrNull as finiteNumber } from "./numbers.js";
export const ORDERBOOK_LEVEL_STATE = Object.freeze({
  PRICE: "PRICE",
  MARKET: "MARKET",
  EMPTY: "EMPTY",
});

function positiveOrZero(value) {
  const number = finiteNumber(value);
  return number != null && number >= 0 ? number : 0;
}

// Missing broker aggregates are not zero. Only fall back to quantities from
// this same book snapshot; trade-side cumulative volume is unrelated to depth.
export function resolveOrderBookDepthTotal(explicitTotal, levels = []) {
  const supplied = finiteNumber(explicitTotal);
  if (supplied != null && supplied >= 0) return supplied;
  return (Array.isArray(levels) ? levels : []).reduce(
    (total, level) => total + positiveOrZero(level?.volume), 0,
  );
}

/**
 * Normalize one book level before it reaches the shared renderer. A level is Market Runtime's
 * { price, volume } (native/market_runtime/src/wire.rs book()); null is an absent level (padding).
 *
 * PRICE  : positive executable quote price.
 * MARKET : Shioaji's depth uses price 0 with a positive queue quantity for a market-order queue.
 * EMPTY  : absent / unquoted level.
 */
export function normalizeOrderBookLevel(raw, {
  provider = "generic",
  delta = null,
} = {}) {
  if (raw != null && (typeof raw !== "object" || Array.isArray(raw))) {
    console.warn("[orderbook] level refused: not a { price, volume } object", raw);
    raw = null;
  }
  const price = finiteNumber(raw?.price);
  const volume = positiveOrZero(raw?.volume);
  const shioajiMarketSentinel = String(provider) === "shioaji" && price === 0 && volume > 0;
  const state = price != null && price > 0
    ? ORDERBOOK_LEVEL_STATE.PRICE
    : shioajiMarketSentinel
      ? ORDERBOOK_LEVEL_STATE.MARKET
      : ORDERBOOK_LEVEL_STATE.EMPTY;

  return {
    price: state === ORDERBOOK_LEVEL_STATE.PRICE ? price : null,
    volume: state === ORDERBOOK_LEVEL_STATE.EMPTY ? 0 : volume,
    delta: finiteNumber(delta),
    quoteState: state,
  };
}

export function normalizeParallelOrderBookLevels(prices = [], volumes = [], deltas = [], {
  provider = "generic",
  maxDepth = 10,
} = {}) {
  const p = Array.isArray(prices) ? prices : [];
  const v = Array.isArray(volumes) ? volumes : [];
  const d = Array.isArray(deltas) ? deltas : [];
  const count = Math.min(Math.max(p.length, v.length, d.length), Math.max(1, Number(maxDepth) || 10));
  return Array.from({ length: count }, (_, index) => normalizeOrderBookLevel(
    { price: p[index], volume: v[index] },
    { provider, delta: d[index] },
  ));
}

export function normalizeProviderOrderBook(rawBook = {}, {
  provider = "generic",
  minDepth = 5,
  maxDepth = 10,
} = {}) {
  const source = rawBook && typeof rawBook === "object" ? rawBook : {};
  const rawBids = Array.isArray(source.Bid) ? source.Bid : [];
  const rawAsks = Array.isArray(source.Ask) ? source.Ask : [];
  const upper = Math.max(1, Math.min(10, Number(maxDepth) || 10));
  const lower = Math.max(1, Math.min(upper, Number(minDepth) || 5));
  const bidSource = rawBids.slice(0, upper).map((row) => normalizeOrderBookLevel(row, { provider }));
  const askSource = rawAsks.slice(0, upper).map((row) => normalizeOrderBookLevel(row, { provider }));
  // Provider payloads can contain fixed-size trailing placeholders. Raw array
  // length is therefore not the same thing as executable depth (crypto is a
  // common example). Use the last meaningful quoted level as the depth source.
  // Missing tail rows are padded only for presentation after this decision.
  const meaningfulDepth = (levels) => {
    let last = 0;
    levels.forEach((level, index) => {
      if (level?.quoteState !== ORDERBOOK_LEVEL_STATE.EMPTY) last = index + 1;
    });
    return last;
  };
  const validBidDepth = meaningfulDepth(bidSource);
  const validAskDepth = meaningfulDepth(askSource);
  const availableDepth = Math.max(validBidDepth, validAskDepth);
  const displayDepth = Math.max(lower, Math.min(upper, availableDepth || lower));
  const pad = (levels) => Array.from({ length: displayDepth }, (_, index) => levels[index] || normalizeOrderBookLevel(null, { provider }));
  return {
    bidLevels: pad(bidSource),
    askLevels: pad(askSource),
    rawBidDepth: rawBids.length,
    rawAskDepth: rawAsks.length,
    validBidDepth,
    validAskDepth,
    availableDepth: Math.min(upper, availableDepth),
    displayDepth,
    hasQuote: availableDepth > 0,
  };
}

// The one input shape: { outside_volume, inside_volume, neutral_volume, unknown_volume, session_date, sample_count,
// last_trade_time } (the Futu focused view builds it from Market Runtime's tradeflow).
export function normalizeTradeSideSummary(summary = {}) {
  const outsideVolume = positiveOrZero(summary.outside_volume);
  const insideVolume = positiveOrZero(summary.inside_volume);
  const neutralVolume = positiveOrZero(summary.neutral_volume);
  const unknownVolume = positiveOrZero(summary.unknown_volume);
  const directedVolume = outsideVolume + insideVolume;
  return {
    sessionDate: String(summary.session_date ?? ""),
    sampleCount: Math.max(0, Number(summary.sample_count ?? 0) || 0),
    outsideVolume,
    insideVolume,
    neutralVolume,
    unknownVolume,
    directedVolume,
    outsideRatioPct: directedVolume > 0 ? outsideVolume / directedVolume * 100 : 50,
    lastTradeTime: String(summary.last_trade_time ?? ""),
  };
}
