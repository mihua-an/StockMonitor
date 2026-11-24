// 歷史回放 交易明細: the ledger's 當沖 pairs, read whole and narrowed here by scope, date and what was typed; and the replayed
// product's 當沖 markers.
import { pickedHistoryDate } from "./picked_date.js";
import { apiGet, apiGetOk } from "../../core/api.js";
import { userFacingMessage } from "../../core/user_action.js";
import { historyHooks, historyQueries, historyState } from "./history_state.js";

// The ledger's pairs change when a trade is imported or typed in: an answer this old is read again.
const FRESH_MS = 10000;
let tradeRequestSerial = 0;

/** Reads the pairs unless the ones shown are fresh. The newest read owns the state; an earlier one's answer is dropped. */
export async function loadHistoryTrades({ force = false } = {}) {
  const state = historyState.tradeDetails;
  if (!force && (state.loading || (state.loadedAt && Date.now() - state.loadedAt <= FRESH_MS))) return;
  const request = (tradeRequestSerial += 1);
  state.loading = true;
  historyHooks.invalidateReplayComponents("tradeDetails");
  try {
    const result = await apiGetOk("/api/history/daytrades");
    if (request !== tradeRequestSerial) return;
    Object.assign(state, { rows: Array.isArray(result.items) ? result.items : [], loading: false, loadedAt: Date.now(), error: "" });
  } catch (error) {
    console.warn("[HISTORY] trade list load failed", error);
    if (request !== tradeRequestSerial) return;
    Object.assign(state, { loading: false, error: userFacingMessage(error, "交易明細載入失敗，請稍後再試", { context: "HISTORY_TRADES_LOAD" }) });
  }
  historyHooks.invalidateReplayComponents("tradeDetails");
}

/** The rows 交易明細 shows: the typed code (its start) or name narrows 總覽 and 今日 alike. */
export function historyTradeRows() {
  const { rows, scope, query } = historyState.tradeDetails;
  const date = historyTradeDate();
  const term = query.trim().toUpperCase();
  return rows.filter((row) => (scope !== "today" || String(row.realized_date).slice(0, 10) === date)
    && (!term || String(row.code).toUpperCase().startsWith(term) || String(row.name || "").toUpperCase().includes(term)));
}

/** 今日's date: the one picked in 交易明細, else the replayed day. */
export function historyTradeDate() {
  return historyState.tradeDetails.date || pickedHistoryDate();
}

/** Every date 今日 can show: the ones with trades and the recorded days, newest first. */
export function historyTradeDates() {
  const dates = new Set([...historyState.dates, ...historyState.tradeDetails.rows.map((row) => String(row.realized_date).slice(0, 10))]);
  return [...dates].filter(Boolean).sort((a, b) => b.localeCompare(a));
}

let markerRequestSerial = 0;

export async function loadHistoryDaytradeMarkerRows(options = {}) {
  // Every call supersedes the requests before it, the cached and empty answers included.
  const request = (markerRequestSerial += 1);
  const date = pickedHistoryDate();
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
    && pickedHistoryDate() === date
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
