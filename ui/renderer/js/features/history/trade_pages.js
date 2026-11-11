// 歷史回放 交易明細: the trade-detail pages of the replayed day (overview / selected product scopes), their request
// fencing and the 當沖 marker rows (split out of pages/history.js).
import { apiGet } from "../../core/api.js";
import { replayHistoryContext } from "../../core/dashboard_context.js";
import { userFacingMessage } from "../../core/user_action.js";
import { $ } from "../../core/utility.js";
import { historyHooks, historyQueries, historyState } from "./history_state.js";
import { createHistoryTradePageState, isHistoryTradeRequestCurrent, normalizeHistoryTradeScope } from "./trade_pager.js";

export function historyTradeContextKey(scope) {
  const normalized = normalizeHistoryTradeScope(scope);
  if (normalized === "today") {
    const date = String($("historyDateSelect")?.value || historyState.selectedDate || "").slice(0, 10);
    return date ? `today:${date}` : "today:";
  }
  if (normalized === "symbol") {
    const code = String(replayHistoryContext.symbolStore.getSelectedSymbol() || historyState.selectedCode || "").trim();
    return code ? `symbol:${code}` : "symbol:";
  }
  return "overview:all";
}

export function resetHistoryTradePageState(pageState, queryKey) {
  const nextToken = Number(pageState?.requestToken || 0) + 1;
  Object.assign(pageState, createHistoryTradePageState(queryKey), { requestToken: nextToken });
  return pageState;
}

export function getHistoryTradePageState(scope = historyState.tradeDetails.scope, { syncContext = true } = {}) {
  const normalized = normalizeHistoryTradeScope(scope);
  const pageState = historyState.tradeDetails.pages[normalized];
  if (!pageState) throw new Error(`missing trade-details page state: ${normalized}`);
  if (syncContext) {
    const queryKey = historyTradeContextKey(normalized);
    if (String(pageState.queryKey || "") !== queryKey) resetHistoryTradePageState(pageState, queryKey);
  }
  return pageState;
}

export function cancelActiveHistoryTradeRequest() {
  const tradeState = historyState?.tradeDetails;
  const controller = tradeState?.activeAbortController;
  if (controller) {
    try { controller.abort(); } catch (error) { console.warn("[history trades: aborting the previous request] failed", error); }
  }
  if (tradeState) {
    tradeState.activeAbortController = null;
    tradeState.activeRequestId = "";
  }
}

export function createHistoryTradeRequestId(scope, date, code, page) {
  const tradeState = historyState.tradeDetails;
  tradeState.requestSequence = Math.max(0, Number(tradeState.requestSequence) || 0) + 1;
  const target = scope === "today" ? date : scope === "symbol" ? code : "all";
  return `history-trade:${tradeState.requestSequence}:${scope}:${target || "-"}:p${Math.max(1, Number(page) || 1)}`;
}

export async function getHistoryTradePageCached({
  scope, date, code, page, pageSize, direction = "jump", cursor = "", force = false, requestId = "", signal = null,
}) {
  const normalizedScope = normalizeHistoryTradeScope(scope);
  const targetKey = normalizedScope === "today" ? date : normalizedScope === "symbol" ? code : "all";
  const key = `${normalizedScope}|${targetKey}|${page}|${pageSize}`;
  if (!force) {
    const cached = historyQueries.getTrade(key);
    if (cached) return { ...cached, request_id: requestId, cache_hit: true };
  }

  const params = new URLSearchParams();
  params.set("scope", normalizedScope);
  if (normalizedScope === "today") params.set("date", String(date || ""));
  else if (normalizedScope === "symbol") params.set("code", String(code || ""));
  params.set("page", String(Math.max(1, Number(page) || 1)));
  params.set("page_size", String(Math.max(1, Number(pageSize) || 50)));
  params.set("direction", String(direction || "jump"));
  params.set("request_id", String(requestId || ""));
  if (cursor) params.set("cursor", String(cursor));

  // Do not coalesce different request generations. A slow response from an older
  // tab/date/symbol request must never be reusable as the active response.
  return apiGet(`/api/history/daytrades?${params.toString()}`, signal ? { signal } : {})
    .then((value) => {
      // Only a response correlated to this exact request generation is cacheable.
      // A late response is returned to the caller so the active-request gate can
      // discard it silently instead of turning a harmless race into a UI error.
      const responseScope = normalizeHistoryTradeScope(value?.scope);
      const responseDate = String(value?.date || "").slice(0, 10);
      const responseCode = String(value?.code || "").trim();
      const contractMatches = Boolean(value?.ok)
        && String(value?.request_id || "") === String(requestId || "")
        && responseScope === normalizedScope
        && (normalizedScope !== "today" || responseDate === String(date || "").slice(0, 10))
        && (normalizedScope !== "symbol" || responseCode === String(code || "").trim());
      if (contractMatches) {
        const cacheValue = { ...value };
        delete cacheValue.request_id;
        historyQueries.putTrade(key, cacheValue);
      }
      return value;
    });
}

export async function loadHistoryTradeDetailsPage(options = {}) {
  const tradeState = historyState.tradeDetails;
  const scope = normalizeHistoryTradeScope(options.scope ?? tradeState.scope);
  tradeState.scope = scope;
  const date = String($("historyDateSelect")?.value || historyState.selectedDate || "").slice(0, 10);
  const code = String(replayHistoryContext.symbolStore.getSelectedSymbol() || historyState.selectedCode || "").trim();
  const pageState = getHistoryTradePageState(scope);
  const missingContext = (scope === "today" && !date) || (scope === "symbol" && !code);
  if (missingContext) {
    cancelActiveHistoryTradeRequest();
    resetHistoryTradePageState(pageState, historyTradeContextKey(scope));
    pageState.loaded = true;
    pageState.loadedAt = Date.now();
    historyHooks.invalidateReplayComponents("tradeDetails");
    return;
  }

  const hardReset = Boolean(options.reset);
  if (hardReset) resetHistoryTradePageState(pageState, historyTradeContextKey(scope));
  const page = Math.max(1, Number(hardReset ? 1 : options.page ?? pageState.page) || 1);
  const direction = hardReset ? "first" : String(options.direction || "jump");
  const cursor = hardReset ? "" : String(options.cursor || "");
  if (hardReset) pageState.rows = [];

  // One active trade-details request at a time. Abort is an optimization; requestId
  // is the correctness boundary in case an already-resolved response still arrives.
  cancelActiveHistoryTradeRequest();
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const requestId = createHistoryTradeRequestId(scope, date, code, page);
  tradeState.activeRequestId = requestId;
  tradeState.activeAbortController = controller;

  pageState.loading = true;
  pageState.error = "";
  const token = ++pageState.requestToken;
  historyHooks.invalidateReplayComponents("tradeDetails");

  try {
    const result = await getHistoryTradePageCached({
      scope, date, code, page, pageSize: tradeState.pageSize, direction, cursor, force: Boolean(options.force),
      requestId, signal: controller?.signal || null,
    });
    if (!isHistoryTradeRequestCurrent(requestId, tradeState.activeRequestId, token, pageState.requestToken)) return;
    if (!result?.ok) throw new Error(result?.error || "交易明細載入失敗");
    const responseRequestId = String(result?.request_id || "");
    if (!responseRequestId) throw new Error("交易明細後端版本不同步，請重新啟動程式");
    if (responseRequestId !== requestId) return;
    if (normalizeHistoryTradeScope(result?.scope) !== scope) throw new Error("交易明細查詢 scope 回應不一致（可能為後端版本不一致）");
    if (scope === "today" && String(result?.date || "").slice(0, 10) !== date) throw new Error("交易明細日期回應不一致");
    if (scope === "symbol" && String(result?.code || "").trim() !== code) throw new Error("交易明細股號回應不一致");
    const rows = Array.isArray(result.items) ? result.items : [];
    if (scope === "today" && rows.some((row) => String(row?.realized_date || "").slice(0, 10) !== date)) throw new Error("交易明細日期資料污染");
    if (scope === "symbol" && rows.some((row) => String(row?.code || "").trim() !== code)) throw new Error("交易明細個股資料污染");
    Object.assign(pageState, {
      queryKey: historyTradeContextKey(scope),
      rows,
      page: Math.max(1, Number(result.page) || 1),
      totalCount: Math.max(0, Number(result.total_count) || 0),
      totalPages: Math.max(1, Number(result.total_pages) || 1),
      hasPrev: Boolean(result.has_prev),
      hasNext: Boolean(result.has_next),
      prevCursor: String(result.prev_cursor || ""),
      nextCursor: String(result.next_cursor || ""),
      loading: false,
      loaded: true,
      loadedAt: Date.now(),
      error: "",
    });
  } catch (error) {
    const aborted = String(error?.name || "") === "AbortError";
    // not an error: an aborted or superseded read; the newer read owns the page state.
    if (aborted || !isHistoryTradeRequestCurrent(requestId, tradeState.activeRequestId, token, pageState.requestToken)) return;
    console.warn("[HISTORY DAYTRADE] paged load failed", error);
    Object.assign(pageState, { rows: [], loading: false, loaded: true, loadedAt: Date.now(), error: userFacingMessage(error, "交易明細載入失敗，請稍後再試", { context: "HISTORY_TRADES_LOAD" }) });
  } finally {
    if (requestId === tradeState.activeRequestId) {
      tradeState.activeAbortController = null;
      tradeState.activeRequestId = "";
    }
  }
  historyHooks.invalidateReplayComponents("tradeDetails");
}

let markerRequestSerial = 0;

export async function loadHistoryDaytradeMarkerRows(options = {}) {
  // Every call supersedes the requests before it, the cached and empty answers included.
  const request = (markerRequestSerial += 1);
  const date = String($("historyDateSelect")?.value || historyState.selectedDate || "").slice(0, 10);
  const code = String(historyState.selectedCode || "").trim();
  if (!date || !code) {
    historyState.daytradeMarkerRows = [];
    historyHooks.rerenderHistoryCurrentChart();
    return;
  }
  const key = `${date}|${code}`;
  const cached = options.force ? null : historyQueries.getMarkers(key);
  if (cached) {
    historyState.daytradeMarkerRows = Array.isArray(cached?.items) ? cached.items : [];
    historyHooks.rerenderHistoryCurrentChart();
    return;
  }
  // Only the newest request for the date/symbol on screen may change the markers -- its answer and its failure alike
  // (an earlier request that fails late must not clear the markers the current one has drawn).
  const current = () => request === markerRequestSerial
    && String($("historyDateSelect")?.value || historyState.selectedDate || "").slice(0, 10) === date
    && String(historyState.selectedCode || "").trim() === code;
  try {
    const result = await apiGet(`/api/history/daytrade-markers?date=${encodeURIComponent(date)}&code=${encodeURIComponent(code)}`);
    historyQueries.putMarkers(key, result);
    if (!current()) return;
    historyState.daytradeMarkerRows = Array.isArray(result?.items) ? result.items : [];
  } catch (error) {
    console.warn(`[HISTORY DAYTRADE MARKERS] load failed (${key})`, error);
    if (!current()) return;
    historyState.daytradeMarkerRows = [];
  }
  historyHooks.rerenderHistoryCurrentChart();
}
