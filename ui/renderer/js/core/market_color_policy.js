import { numberOrNull, positiveNumberOrNull } from "./numbers.js";
// Canonical market color semantics.
// Price color is determined only by absolute price vs authoritative reference.
// Aggressor-side color is a separate semantic used for trade volume/flow.

export const MARKET_PRICE_COLOR_TOKEN = Object.freeze({
  POSITIVE: "POSITIVE",
  NEGATIVE: "NEGATIVE",
  FLAT: "FLAT",
  UNKNOWN: "UNKNOWN",
});

export const TRADE_SIDE = Object.freeze({
  BUY: "BUY",
  SELL: "SELL",
  NEUTRAL: "NEUTRAL",
  UNKNOWN: "UNKNOWN",
});

const positiveFinite = positiveNumberOrNull;

export const MarketPriceColorPolicy = Object.freeze({
  classify(price, referencePrice) {
    const value = positiveFinite(price);
    const reference = positiveFinite(referencePrice);
    if (value == null || reference == null) return MARKET_PRICE_COLOR_TOKEN.UNKNOWN;
    if (value > reference) return MARKET_PRICE_COLOR_TOKEN.POSITIVE;
    if (value < reference) return MARKET_PRICE_COLOR_TOKEN.NEGATIVE;
    return MARKET_PRICE_COLOR_TOKEN.FLAT;
  },

  cssClass(price, referencePrice) {
    switch (this.classify(price, referencePrice)) {
      case MARKET_PRICE_COLOR_TOKEN.POSITIVE: return "price-up";
      case MARKET_PRICE_COLOR_TOKEN.NEGATIVE: return "price-down";
      case MARKET_PRICE_COLOR_TOKEN.FLAT: return "price-flat";
      default: return "price-flat";
    }
  },
});

/** A signed figure's colour class (a change, a profit, an account amount): above 0 up, below 0 down, 0 or missing flat. */
export function signedValueClass(value) {
  const number = numberOrNull(value);
  if (number === null || number === 0) return "price-flat";
  return number > 0 ? "price-up" : "price-down";
}

function normalizeSide(value) {
  const text = String(value ?? "").trim().toUpperCase();
  if (["BUY", "OUT", "ACTIVE_BUY", "AGGRESSOR_BUY"].includes(text)) return TRADE_SIDE.BUY;
  if (["SELL", "IN", "ACTIVE_SELL", "AGGRESSOR_SELL"].includes(text)) return TRADE_SIDE.SELL;
  if (["NEUTRAL", "FLAT"].includes(text)) return TRADE_SIDE.NEUTRAL;
  return TRADE_SIDE.UNKNOWN;
}

export function classifyTradeSideFromTick(tick = {}) {
  const explicit = normalizeSide(tick?.trade_side ?? tick?.tradeSide ?? tick?.side);
  if (explicit !== TRADE_SIDE.UNKNOWN) return explicit;
  // /api/trade-detail/page rows never carry a trade_side/side string, only the
  // numeric Shioaji tick_type (1=aggressor buy, 2=aggressor sell).
  const tickType = Number(tick?.tick_type ?? tick?.tickType);
  if (tickType === 1) return TRADE_SIDE.BUY;
  if (tickType === 2) return TRADE_SIDE.SELL;
  return TRADE_SIDE.UNKNOWN;
}

export const TradeSideColorPolicy = Object.freeze({
  normalize: normalizeSide,

  classify(side) {
    return normalizeSide(side);
  },

  cssClass(side) {
    switch (normalizeSide(side)) {
      case TRADE_SIDE.BUY: return "price-up";
      case TRADE_SIDE.SELL: return "price-down";
      default: return "price-flat";
    }
  },

  volumeCssClass(side) {
    switch (normalizeSide(side)) {
      case TRADE_SIDE.BUY: return "tick-details-volume-buy";
      case TRADE_SIDE.SELL: return "tick-details-volume-sell";
      case TRADE_SIDE.UNKNOWN: return "tick-details-volume-unknown";
      default: return "tick-details-volume-neutral";
    }
  },
});
