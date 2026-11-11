/** Original bounded read caches and single-flight, owned by one history feature. */
import { taipeiDateKey, taipeiParts } from "../../market_data/taipei_time.js";

export const HISTORY_TRADE_PAGE_CACHE_TTL_MS = 10000;
// Today's stored data still changes: kept 5 s while the session (08:30 pre-open to 13:35 after the close auction) runs,
// 30 s outside it. A past day never changes and is kept until evicted.
export const HISTORY_TODAY_SESSION_TTL_MS = 5000;
export const HISTORY_TODAY_OFF_SESSION_TTL_MS = 30000;
const HISTORY_TODAY_SESSION_MINUTES = Object.freeze({ start: 8 * 60 + 30, end: 13 * 60 + 35 });

export function createHistoryQueries({ apiGet }) {
const historyResponseCache = {
  stockIndexes: new Map(),
  stocks: new Map(),
  marketSessions: new Map(),
  txfSessions: new Map(),
};

// 背景預熱與使用者真正點進歷史頁可能同時發生。
// 同一份日期/股票資料只允許一個 request 在飛，後來的呼叫直接共用 Promise，
// 避免首次進頁時反而因 prewarm + foreground 打兩份一模一樣的 API。
const historyPendingRequests = {
  stockIndexes: new Map(),
  stocks: new Map(),
  marketSessions: new Map(),
  txfSessions: new Map(),
};

// Paired-trade pages are intentionally small and short-lived.
// Keep only a few recently visited pages so 2330 → 2337 → 2330 feels instant,
// without ever turning the Renderer into a full historical trade store.
const HISTORY_TRADE_PAGE_CACHE_LIMIT = 12;
const historyTradePageCache = new Map();
const historyDaytradeMarkerCache = new Map();
function tradeCacheGet(map, key) {
  const item = map.get(key);
  if (!item) return null;
  if (Date.now() - Number(item.at || 0) > HISTORY_TRADE_PAGE_CACHE_TTL_MS) { map.delete(key); return null; }
  return item.value;
}

function tradeCachePut(map, key, value) {
  map.delete(key);
  map.set(key, { at: Date.now(), value });
  while (map.size > HISTORY_TRADE_PAGE_CACHE_LIMIT) map.delete(map.keys().next().value);
  return value;
}

// A past trading day never changes; today's data does, faster during the session. "Today" and the session hours are
// Taipei's, whatever the computer's time zone.
function historyCacheTtl(dateText) {
  const now = Date.now();
  if (String(dateText || "") !== taipeiDateKey(now)) return Number.POSITIVE_INFINITY;
  const clock = taipeiParts(now);
  const minute = clock.hour * 60 + clock.minute;
  return minute >= HISTORY_TODAY_SESSION_MINUTES.start && minute <= HISTORY_TODAY_SESSION_MINUTES.end
    ? HISTORY_TODAY_SESSION_TTL_MS : HISTORY_TODAY_OFF_SESSION_TTL_MS;
}

function historyCached(map, key, dateText) {
  const item = map.get(key);
  if (!item) return null;
  const ttl = historyCacheTtl(dateText);
  if (Number.isFinite(ttl) && Date.now() - item.at > ttl) {
    map.delete(key);
    return null;
  }
  return item.value;
}

function historyCachePut(map, key, value) {
  map.set(key, { at: Date.now(), value });
  if (map.size > 12) map.delete(map.keys().next().value);
  return value;
}

async function historyCachedRequest(cacheMap, pendingMap, key, date, loader) {
  const cached = historyCached(cacheMap, key, date);
  if (cached) return cached;
  if (pendingMap.has(key)) return pendingMap.get(key);

  const pending = Promise.resolve()
    .then(loader)
    .then((value) => historyCachePut(cacheMap, key, value))
    .finally(() => pendingMap.delete(key));
  pendingMap.set(key, pending);
  return pending;
}

async function getHistoryStocksCached(date) {
  const key = String(date || "");
  return historyCachedRequest(
    historyResponseCache.stocks,
    historyPendingRequests.stocks,
    key,
    date,
    () => apiGet(`/api/history/stocks?date=${encodeURIComponent(date)}`)
  );
}

async function getHistoryStockIndexCached(date) {
  const key = String(date || "");
  return historyCachedRequest(
    historyResponseCache.stockIndexes,
    historyPendingRequests.stockIndexes,
    key,
    date,
    () => apiGet(`/api/history/stocks?date=${encodeURIComponent(date)}&summary=false`)
  );
}

async function getHistoryMarketSessionCached(date) {
  const key = String(date || "");
  return historyCachedRequest(
    historyResponseCache.marketSessions,
    historyPendingRequests.marketSessions,
    key,
    date,
    () => apiGet(`/api/history/taiex-session?date=${encodeURIComponent(date)}`)
  );
}

async function getHistoryTxfSessionCached(date) {
  const key = String(date || "");
  return historyCachedRequest(
    historyResponseCache.txfSessions,
    historyPendingRequests.txfSessions,
    key,
    date,
    () => apiGet(`/api/history/txf-session?date=${encodeURIComponent(date)}`)
  );
}


return { getHistoryStockIndexCached, getHistoryStocksCached, getHistoryMarketSessionCached, getHistoryTxfSessionCached,
  getTrade: key => tradeCacheGet(historyTradePageCache, key),
  putTrade: (key, value) => tradeCachePut(historyTradePageCache, key, value),
  getMarkers: key => tradeCacheGet(historyDaytradeMarkerCache, key),
  putMarkers: (key, value) => tradeCachePut(historyDaytradeMarkerCache, key, value),
  diagnostics: () => ({ cached: Object.fromEntries(Object.entries(historyResponseCache).map(([key,map])=>[key,map.size])),
    pending: Object.fromEntries(Object.entries(historyPendingRequests).map(([key,map])=>[key,map.size])),
    tradePages: historyTradePageCache.size, markers: historyDaytradeMarkerCache.size }),
};
}
