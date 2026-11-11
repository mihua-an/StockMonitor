// 歷史回放: the view models the replay dashboard's components read -- Market Runtime's replay for the order book, ticks,
// 價量, flow and trend (engine_replay.js), the recorded event tape and the trade details (split out of pages/history.js).
import { replayHistoryContext } from "../../core/dashboard_context.js";
import { normalizeHistoryEvents } from "../../core/event_feed_format.js";
import { withMarketRead } from "../../core/market_read_adapters.js";
import { pairNetAtPrice } from "../../core/trade_costs.js";
import { $ } from "../../core/utility.js";
import { recordedEventsAtReplayTime } from "./history_event_markers.js";
import { historyPage, historyState } from "./history_state.js";
import { normalizeHistoryTradeScope } from "./trade_pager.js";
import { activeHistoryTradeForCurrent, getHistoryStockName, historyTradeEntryPrice, historyTradeReplayStatus } from "./history_values.js";
import { historyEngineTrendViewModel } from "./engine_controller.js";
import { getHistoryTradePageState } from "./trade_pages.js";

/** The open replay of the selected product, or null. */
function openReplay() {
  return historyPage.engine?.active ? historyPage.engine : null;
}

// What a panel says while there is no replay to read: why there is none, or that one is being opened.
function replayWaitText() {
  if (historyState.replayUnavailable) return historyState.replayUnavailable;
  return historyState.selectedCode ? "回放載入中" : "請選擇商品";
}

// Through the data boundary like every market view model (withMarketRead): with no replay there is no read to name.
function unavailable(extra = {}) {
  const code = String(historyState.selectedCode || "");
  return withMarketRead({ availability: "UNAVAILABLE", message: replayWaitText(), emptyText: replayWaitText(), code, logicalCode: code, ...extra });
}

// 五檔: the replay's book, with the 當沖 under review's entry price as the reference and its P&L at the replay price.
export function buildReplayOrderbookViewModel() {
  const engine = openReplay();
  if (!engine) {
    const code = String(historyState.selectedCode || "");
    return unavailable({ displayLabel: code || "----", titlePrimary: getHistoryStockName(code) || code || "----", titleSecondary: code,
      showDepthTotals: false, priceVolumeEmptyText: replayWaitText() });
  }
  const view = engine.orderbookViewModel({ displayName: getHistoryStockName(historyState.selectedCode) });
  const pair = activeHistoryTradeForCurrent();
  return pair ? withTradeReview(view, pair, historyTradeReplayStatus(pair).inside) : view;
}

/** A replay's 五檔 reviewing `pair`: its entry price is the reference, and its P&L at the replay price, actual and as
 * if closed now (`inside`: the replay time is inside its holding). 歷史回放's trade review and 帳務's 配對回放. */
export function withTradeReview(view, pair, inside) {
  const entryPrice = historyTradeEntryPrice(pair);
  const estimated = pairNetAtPrice(pair, Number(view.lastPrice));
  const actual = Number(pair?.profit);
  return {
    ...view,
    priceReference: Number.isFinite(entryPrice) ? entryPrice : view.priceReference,
    reviewPnl: {
      active: true,
      inside: Boolean(inside),
      actual: Number.isFinite(actual) ? actual : null,
      estimated: Number.isFinite(Number(estimated)) ? Number(estimated) : null,
    },
  };
}

export function buildReplayTradeFlowViewModel() {
  const engine = openReplay();
  return engine ? engine.tradeFlowViewModel() : unavailable({ flow: { available: false, sample_count: 0 } });
}

export function buildReplayPriceFlowViewModel() {
  const engine = openReplay();
  return engine ? engine.priceFlowViewModel() : unavailable({ priceVolume: {} });
}

export function buildReplayTickDetailsViewModel() {
  const engine = openReplay();
  return engine ? engine.tickDetailsViewModel() : unavailable({ rows: [] });
}

export function buildReplayTrendViewModel() {
  if (openReplay()) return historyEngineTrendViewModel();
  const code = String(historyState.selectedCode || "");
  return unavailable({ displayName: getHistoryStockName(code) || code || "--", displayCode: code, points: [], currentPrice: null,
    prevClose: null, openPrice: null, metrics: {}, options: { adapterType: "replay" }, emptyOverlayText: replayWaitText() });
}

// While the engine replay runs, the replayed stock's events are the ones Rust B re-derives from the replay (as live
// does); the other stocks keep the day's recorded tape, gated at the replay time. The rows are the same array until the
// recorded part crosses the time or B's events change, so a seek that changes neither redraws nothing of the list.
let replayRows = null;

// B's event records are the same when each has the same id and revision (Market Runtime replaces a record only by a
// higher revision); every seek's view carries them as a new array.
function sameRecords(held, events) {
  if (held === events) return true;
  if (!Array.isArray(held) || !Array.isArray(events) || held.length !== events.length) return false;
  return held.every((record, index) => record?.event_id === events[index]?.event_id && record?.revision === events[index]?.revision);
}

export function replayEventRows() {
  const recorded = recordedEventsAtReplayTime();
  const live = historyPage.engine?.active ? historyPage.engine : null;
  if (!live) return recorded;
  const code = String(live.code || historyState.selectedCode || "").trim().toUpperCase();
  const events = live.state()?.events;
  if (replayRows?.recorded !== recorded || replayRows.code !== code || !sameRecords(replayRows.events, events)) {
    const derived = normalizeHistoryEvents(events || []);
    const rows = [...recorded.filter((event) => String(event?.code || "").trim().toUpperCase() !== code), ...derived]
      .sort((a, b) => String(b.time || "").localeCompare(String(a.time || "")));
    replayRows = { recorded, code, events, rows };
  }
  return replayRows.rows;
}

export function buildReplayEventFeedViewModel() {
  return {
    availability: "AVAILABLE",
    rows: replayEventRows(),
    dates: Array.isArray(historyState.dates) ? historyState.dates : [],
    activeDate: String($("historyDateSelect")?.value || historyState.selectedDate || "").slice(0, 10),
    selectedSymbol: historyState.selectedCode,
    selectedName: getHistoryStockName(historyState.selectedCode),
    selectedEventKey: historyState.selectedEventKey,
    emptyText: historyState.intradayEvents.length ? "" : "此日期尚無歷史盤中資訊",
  };
}

export function buildReplayTradeDetailsViewModel() {
  const tradeState = historyState.tradeDetails;
  const scope = normalizeHistoryTradeScope(tradeState.scope);
  const pageState = getHistoryTradePageState(scope);
  return {
    availability: pageState.loading || pageState.rows.length ? "AVAILABLE" : "UNAVAILABLE",
    rows: Array.isArray(pageState.rows) ? pageState.rows : [],
    scope,
    page: pageState.page,
    pageSize: tradeState.pageSize,
    totalCount: pageState.totalCount,
    totalPages: pageState.totalPages,
    hasPrev: pageState.hasPrev,
    hasNext: pageState.hasNext,
    prevCursor: pageState.prevCursor,
    nextCursor: pageState.nextCursor,
    loading: pageState.loading,
    selectedDate: String($("historyDateSelect")?.value || historyState.selectedDate || "").slice(0, 10),
    selectedSymbol: replayHistoryContext.symbolStore.getSelectedSymbol() || historyState.selectedCode,
    selectedName: getHistoryStockName(replayHistoryContext.symbolStore.getSelectedSymbol() || historyState.selectedCode),
    selectedTradeId: historyState.selectedDaytradeId,
    emptyText: pageState.error || "",
  };
}
