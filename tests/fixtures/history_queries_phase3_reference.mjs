/** Original bounded read caches and single-flight, owned by one history feature. */
export function createHistoryQueries({ apiGet }) {
const historyResponseCache = {
  stocks: new Map(),
  marketSessions: new Map(),
  txfSessions: new Map(),
};

// 背景預熱與使用者真正點進歷史頁可能同時發生。
// 同一份日期/股票資料只允許一個 request 在飛，後來的呼叫直接共用 Promise，
// 避免首次進頁時反而因 prewarm + foreground 打兩份一模一樣的 API。
const historyPendingRequests = {
  stocks: new Map(),
  marketSessions: new Map(),
  txfSessions: new Map(),
};

// Paired-trade pages are intentionally small and short-lived.
// Keep only a few recently visited pages so 2330 → 2337 → 2330 feels instant,
// without ever turning the Renderer into a full historical trade store.
const HISTORY_TRADE_PAGE_CACHE_TTL_MS = 10000;
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

function historyCacheTtl(dateText) {
  const today = new Date();
  const todayText = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  if (String(dateText || "") !== todayText) return Number.POSITIVE_INFINITY;
  const minute = today.getHours() * 60 + today.getMinutes();
  return minute >= 8 * 60 + 30 && minute <= 13 * 60 + 35 ? 5000 : 30000;
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


return { getHistoryStocksCached, getHistoryMarketSessionCached, getHistoryTxfSessionCached,
  getTrade: key => tradeCacheGet(historyTradePageCache, key),
  putTrade: (key, value) => tradeCachePut(historyTradePageCache, key, value),
  getMarkers: key => tradeCacheGet(historyDaytradeMarkerCache, key),
  putMarkers: (key, value) => tradeCachePut(historyDaytradeMarkerCache, key, value),
  diagnostics: () => ({ cached: Object.fromEntries(Object.entries(historyResponseCache).map(([key,map])=>[key,map.size])),
    pending: Object.fromEntries(Object.entries(historyPendingRequests).map(([key,map])=>[key,map.size])),
    tradePages: historyTradePageCache.size, markers: historyDaytradeMarkerCache.size }),
};
}
