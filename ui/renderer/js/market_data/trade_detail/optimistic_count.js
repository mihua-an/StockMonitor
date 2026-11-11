import { tradeRowKey, tradeRowSequence } from "../../core/trade_row_order.js";

// The 成交明細 page count between two count reads, one rule for every pager (主頁, Futu): a count read answers the prints
// stored up to its snapshot watermark, and every print newer than that adds one, once. The pager state holds target,
// bootstrapReady, totalCount, totalPages and snapshotWatermark.
// The prints already known are kept by identity, at most `limit` of them (the oldest go first): every path that adds
// keys -- a live trade, a page's rows -- goes through remember(), so the map never grows past its bound. The value is
// the sequence a live trade was counted at, 0 for a row a page brought (a page's rows are inside its count).
export function createOptimisticCountTracker({ pageSize, limit = 20000 } = {}) {
  const seen = new Map();
  function remember(key, sequence) {
    seen.set(key, sequence);
    while (seen.size > limit) seen.delete(seen.keys().next().value);
  }
  return {
    apply(code, row, pagerState) {
      const target = String(code || "").trim().toUpperCase();
      if (!target || pagerState.target !== target) return false;

      // Until bootstrap/page metadata has established an authoritative base count,
      // do not invent one. Once known, every unique live trade is an O(1) increment.
      if (!pagerState.bootstrapReady && Number(pagerState.totalCount || 0) <= 0) return false;

      const sequence = Number(tradeRowSequence(row) || 0);
      if (sequence > 0 && sequence <= Number(pagerState.snapshotWatermark || 0)) return false;
      const key = tradeRowKey(row);
      if (!key || seen.has(key)) return false;
      remember(key, sequence);

      pagerState.totalCount = Math.max(0, Number(pagerState.totalCount || 0)) + 1;
      pagerState.totalPages = Math.max(1, Math.ceil(pagerState.totalCount / pageSize));
      return true;
    },
    // A count read's answer: the rows stored up to `watermark`, plus the live trades already counted beyond it.
    rebase(pagerState, { totalRows, totalPages, watermark }) {
      let newer = 0;
      for (const sequence of seen.values()) if (sequence > watermark) newer += 1;
      pagerState.totalCount = Math.max(0, Number(totalRows) || 0) + newer;
      pagerState.totalPages = Math.max(1, Number(totalPages) || 1, Math.ceil(pagerState.totalCount / pageSize));
    },
    addKnownKeys(rows) {
      for (const row of rows) {
        const key = tradeRowKey(row);
        if (key && !seen.has(key)) remember(key, 0);
      }
    },
    clear() { seen.clear(); },
    get size() { return seen.size; },
  };
}
