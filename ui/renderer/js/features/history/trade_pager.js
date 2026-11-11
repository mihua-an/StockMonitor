/** State and request identity policies for historical TradeDetail paging. */
import { HISTORY_TRADE_PAGE_CACHE_TTL_MS } from "./queries.js";

export function normalizeHistoryTradeScope(scope = "overview") {
  const value = String(scope || "overview").trim().toLowerCase();
  return value === "today" || value === "symbol" ? value : "overview";
}

export function createHistoryTradePageState(queryKey = "") {
  return {
    queryKey, rows: [], page: 1, totalCount: 0, totalPages: 1,
    hasPrev: false, hasNext: false, prevCursor: "", nextCursor: "",
    loading: false, loaded: false, loadedAt: 0, error: "", requestToken: 0,
  };
}

export function createHistoryTradePagerState() {
  return {
    scope: "overview", pageSize: 50, requestSequence: 0,
    activeRequestId: "", activeAbortController: null,
    pages: {
      overview: createHistoryTradePageState("overview:all"),
      today: createHistoryTradePageState(""),
      symbol: createHistoryTradePageState(""),
    },
  };
}

export function isHistoryTradeRequestCurrent(requestId, activeRequestId, token, currentToken) {
  return String(requestId || "") === String(activeRequestId || "") && Number(token) === Number(currentToken);
}

export function historyTradePageStateFresh(pageState, now = Date.now(), ttlMs = HISTORY_TRADE_PAGE_CACHE_TTL_MS) {
  return Boolean(pageState?.loaded) && (now - Number(pageState?.loadedAt || 0) <= ttlMs);
}
