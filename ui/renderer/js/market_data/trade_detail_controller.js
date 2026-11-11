import { createLiveTradePager, TRADE_DETAIL_PAGE_SIZE } from "./live_trade_pager.js";

/**
 * Realtime TradeDetail ownership boundary. The page supplies canonical query
 * and paint callbacks; durable paging, cancellation and recovery remain in
 * the single existing pager instance.
 */
export function createRealtimeTradeDetailController(options = {}) {
  const pager = createLiveTradePager(options);
  return Object.assign(pager, {
    pageSize: TRADE_DETAIL_PAGE_SIZE,
    responsibility: "realtime-trade-detail",
  });
}

export { TRADE_DETAIL_PAGE_SIZE };
