// The canonical live view of one product: the identity every screen (主頁、工作區、分離視窗) subscribes with. The channel
// list is part of a view's identity, so screens that build it separately subscribe the same product twice and Market
// Runtime sends its data twice; this is the one builder.
import { futuCanonicalViewSpec } from "./moomoo_symbol.js";
import { shioajiMarketOf } from "./futures_symbol.js";

const FUTU_MARKETS = new Set(["US", "HK", "SH", "SZ", "CC"]);

// "signals" is the analysis projection's row lane; it rides this same view (one transport, one sequence space, one
// session identity). The alerts are not a view channel: the 事件列表 tape is Market Runtime's events.subscribe.
// 台指期／小台指 are products, not instruments: only their months can be subscribed (service/market/reference/
// futures_contracts.py INDEX_FUTURES). Their bare code reaches here while a product's months are not read yet.
export const INDEX_FUTURE_PRODUCTS = new Set(["TXF", "MXF"]);

const TAIWAN_STOCK_CHANNELS = Object.freeze(["summary", "trend", "trades", "orderbook", "tradeflow", "price_volume", "signals"]);
// TXFR1 is Quote-only: the channels of the 期貨 tabs' own view (session_state.js txfCanonicalViewSpec).
const TXF_QUOTE_CHANNELS = Object.freeze(["summary", "trend"]);

/**
 * A product's view spec. A Futu code ("US.AAPL") is Futu's view (source futu, the partition Market Runtime holds now);
 * a futures month ("CDF202611", "TXF202611": a 個股期貨 or 台指期／小台指 month) is its FUT view of `futuresPartition`
 * ({trading_date, session}: the DAY or NIGHT partition the caller's futures session authority names), and so is
 * TXFR1, 台指期's Quote; a Taiwan stock
 * is the STK DAY view of `tradingDate`. An empty date means the authority is not ready, and such a view is never
 * subscribed.
 */
export function stockCanonicalViewSpec(code, tradingDate, futuresPartition = null) {
  const normalized = String(code || "").trim().toUpperCase();
  const prefix = normalized.includes(".") ? normalized.split(".", 1)[0] : "";
  if (FUTU_MARKETS.has(prefix)) return futuCanonicalViewSpec(normalized);
  if (shioajiMarketOf(normalized) === "FUT") {
    return {
      market: "FUT",
      code: normalized,
      trading_date: String(futuresPartition?.trading_date || "").slice(0, 10),
      session: String(futuresPartition?.session || "DAY").toUpperCase(),
      channels: normalized === "TXFR1" ? TXF_QUOTE_CHANNELS : TAIWAN_STOCK_CHANNELS,
    };
  }
  return {
    market: "STK",
    code: normalized,
    trading_date: INDEX_FUTURE_PRODUCTS.has(normalized) ? "" : String(tradingDate || "").slice(0, 10),
    session: "DAY",
    channels: TAIWAN_STOCK_CHANNELS,
  };
}

// A Taiwan stock's 盤中零股 (Market Runtime's market ODD: its own book and prints, docs/decisions.md 零股行情的顯示):
// what 買賣報價 and 成交明細 show of it. No analysis folds it, so it has no trend, flow or 價量.
const ODD_LOT_CHANNELS = Object.freeze(["summary", "trades", "orderbook"]);

/** The 盤中零股 view of a Taiwan stock on `tradingDate` (the stock's own DAY date); none of a futures month or a Futu code. */
export function oddLotViewSpec(code, tradingDate) {
  return { market: "ODD", code: String(code || "").trim().toUpperCase(), trading_date: String(tradingDate || "").slice(0, 10),
    session: "DAY", channels: ODD_LOT_CHANNELS };
}

/** Whether `code` is a Taiwan stock, the only product with a 盤中零股. */
export function hasOddLots(code) {
  const normalized = String(code || "").trim().toUpperCase();
  const prefix = normalized.includes(".") ? normalized.split(".", 1)[0] : "";
  return Boolean(normalized) && !FUTU_MARKETS.has(prefix) && shioajiMarketOf(normalized) === "STK" && !INDEX_FUTURE_PRODUCTS.has(normalized);
}

const BENCHMARK_CHANNELS = Object.freeze(["summary", "trend"]);

/**
 * A benchmark drawn over a Taiwan stock's trend: "taiex" is the 加權 IDX view, "txf" is TXF's DAY partition of the same
 * trading date (a NIGHT never overlaps the stock's day session). Same channels as the 加權 card and the 期貨 日盤 tab,
 * so each is one view wherever it is subscribed.
 */
export function benchmarkViewSpec(kind, tradingDate) {
  const txf = kind === "txf";
  return {
    market: txf ? "FUT" : "IDX",
    code: txf ? "TXFR1" : "TAIEX",
    trading_date: String(tradingDate || "").slice(0, 10),
    session: "DAY",
    channels: BENCHMARK_CHANNELS,
  };
}
