import { numberOrNull, positiveNumberOrNull } from "./numbers.js";
/**
 * 試撮 (call-auction) price shown in place of 現價, marked "#".
 *
 * Market Runtime's summary says an instrument is in a call auction -- 盤前試撮, an intraday 緩漲緩跌 halt or the
 * 13:25 closing auction -- with status "simtrade" (stocks) or "simulated" (a futures quote), and carries the
 * auction's indicative price. Until the next real print that price is what 現價 shows, as "#2475.00".
 */
export const AUCTION_PRICE_MARK = "#";

export function auctionPrice(summary = {}) {
  const status = String(summary?.status || "").trim().toLowerCase();
  if (status !== "simtrade" && status !== "simulated") return null;
  return positiveNumberOrNull(summary?.indicative_price);
}

/**
 * The ONE 現價 / 參考價 / 漲跌 / 漲跌幅 of a Market Runtime summary, for every surface that shows them (個股走勢,
 * 買賣報價, 商品列, workspace columns). Market Runtime computes 漲跌 once (state.rs `change`: the shown price -- the
 * indicative one during an auction -- against the reference); this reads it and subtracts nothing, so no two panels can
 * show two values for the same #180.50.
 */
export function displayQuote(summary = {}) {
  const indicative = auctionPrice(summary);
  return {
    current: indicative ?? positiveNumberOrNull(summary?.current),
    indicative: indicative != null,
    reference: positiveNumberOrNull(summary?.reference_price),
    change: numberOrNull(summary?.change),
    changePct: numberOrNull(summary?.change_pct),
  };
}

export function priceText(value, { indicative = false, digits = 2 } = {}) {
  const number = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(number)) return "--";
  return `${indicative ? AUCTION_PRICE_MARK : ""}${number.toFixed(digits)}`;
}
