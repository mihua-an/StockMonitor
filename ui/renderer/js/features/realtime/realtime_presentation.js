// 即時報價頁 (data-page="realtime"): the Shioaji product-list adapter, the selection entry point, the stock-trend
// cache the WS view stream fills, and the coalesced invalidation of the page's trend / orderbook components.
//
// Moved here from pages/monitor.js (the old 監控總覽頁). There is no REST
// trend loader (/api/intraday-chart): the stock trend comes only from the Market Runtime
// canonical view (its snapshot carries `trend`, deltas upsert points).
import { appState } from "../../core/state.js";
import { realtimeContext } from "../../core/dashboard_context.js";
import { mountedDashboardComponent } from "../../core/dashboard_runtime.js";
import { withProductRead } from "../../core/market_read_adapters.js";
import { pinTrendLookupAtTime, showTrendCrosshairAtTime } from "../../core/trend/index.js";
import { mergeStockMarketSummary } from "../../market_data/stock_market_summary.js";
import { publishTaiwanProductListView } from "./taiwan_product_list_store.js";
import { instrumentOf, productChoice, productOfInstrument, setProductChoice, sidePickerOf } from "./product_sides.js";
import { productSummaryOf } from "./product_summary_reader.js";
import { industryIndexStore } from "./industry_index_store.js";


let realtimeTrendInvalidateRaf = 0;

let realtimeTrendPendingInvalidate = null;

const realtimePaintFrames = new Set();

// Product rows change one instrument at a time -- a quote, a summary, an analysis row -- often dozens per frame on a
// busy market. Every caller hands its dirty codes to updateRealtimeQuoteRows, which repaints once per frame, and a
// repaint re-merges only the dirty rows. Re-merging the whole list for each one-symbol update, synchronously inside
// the WebSocket batch handler, held the renderer's main thread for 13.5 s of 15 (畫面卡頓, 資料套用停滯).
let pendingRowCodes = null;
let pendingRowArrivalUs = null;
let rowFrame = 0;
const mergedRowCache = new Map();  // code -> { item, row }: the last merged row and the watch item it came from

// A stock picked on the Shioaji product list: the selection, and its industry's index becomes the current 產業指數
// (BACKLOG 1v). Only a product-list pick does this; a search or an event row selects without moving the 產業指數.
function selectRealtimeProductRow(code) {
  void industryIndexStore.followStock(code);
  // The row's product as it shows now: its stock, or its futures month.
  return selectRealtimeCodeImmediately(instrumentOf(code));
}

// A row's side picker: "spot", or "m<i>" -- the i-th listed month of its futures. The product is then selected as it
// shows (a product already selected moves with it: bindProductSides).
function pickRealtimeProductSide(code, pick) {
  const month = /^m(\d+)$/.exec(pick);
  // 現 keeps the month last looked at, which its 「期」 hint goes back to.
  setProductChoice(code, month ? "fut" : "spot", month ? Number(month[1]) : productChoice(code).month);
  return selectRealtimeProductRow(code);
}

function requestRealtimePaint(callback) {
  const id = window.requestAnimationFrame(time => { realtimePaintFrames.delete(id); callback(time); });
  realtimePaintFrames.add(id);
  return id;
}

// The existing cache remains renderer-owned; only presentation work is cancelled.
export function cancelRealtimePresentationWork() {
  for (const frame of realtimePaintFrames) window.cancelAnimationFrame(frame);
  realtimePaintFrames.clear(); realtimeTrendInvalidateRaf = 0; realtimeTrendPendingInvalidate = null;
  rowFrame = 0; pendingRowCodes = null; pendingRowArrivalUs = null;
}

function scheduleRealtimeTrendInvalidate(request = {}) {
  realtimeTrendPendingInvalidate = { ...(request || {}) };
  if (realtimeTrendInvalidateRaf) return;

  realtimeTrendInvalidateRaf = requestRealtimePaint(() => {
    realtimeTrendInvalidateRaf = 0;
    const next = realtimeTrendPendingInvalidate || {};
    realtimeTrendPendingInvalidate = null;
    invalidateRealtimeTrendComponents(next);
  });
}

function invalidateRealtimeTrendComponents(request = {}) {
  for (const componentId of ["trendChart", "stockTrend"]) {
    if (realtimeContext.dataSource.listenerCount(componentId) > 0) {
      realtimeContext.dataSource.invalidate(componentId, request);
    }
  }
}

function shioajiProductListBody() {
  return document.querySelector('[data-role="product-list-body"][data-provider="shioaji"]');
}

export async function selectRealtimeCodeImmediately(nextCode, lookupTime = "", lookupMode = "") {
  const normalizedCode = String(nextCode || "").trim();
  if (!normalizedCode) return;

  // 點選商品 / 即時盤中資訊列時立即切換，不等待下一輪 polling。
  // This is the only fan-out edge. Do not invalidate OrderBook/TradeDetail/
  // Trend again here: scoped component subscriptions already run during this
  // call, and the page controller starts a cold durable repair exactly once.
  // The selected row's class is the quote table's too: the page's selection
  // listener asks it to patch the rows (repaintSelectedRealtimeRows).
  const selectSymbol = realtimeContext.services?.selection?.select;
  if (typeof selectSymbol === "function") selectSymbol(normalizedCode, { source: "realtime_product_list" });
  else realtimeContext.symbolStore.setSelectedSymbol(normalizedCode);

  if (lookupTime) {
    // 個股走勢's own canvas, wherever its pane is; absent when the feature is not showing.
    const canvas = mountedDashboardComponent("realtime", "stockTrend")?.canvas || null;
    if (lookupMode === "lookup") {
      pinTrendLookupAtTime(canvas, lookupTime);
    } else if (lookupMode === "crosshair") {
      showTrendCrosshairAtTime(canvas, lookupTime);
    }
  }
}

// A row is one product; its numbers are those of the side and month it shows (product_sides.js): the stock's, or a
// futures month's. The row keeps the product's code and name.
function realtimeMergedRow(item, signalMap, instrument) {
  const code = String(item?.code || "");
  const source = mergeStockMarketSummary({
    watchItem: item || {},
    productSummary: productSummaryOf(instrument),
    liveSignal: signalMap.get(instrument) || {},
  });
  // Product summaries are the same-trading-date durable read model and remain
  // valid across daemon replacement or a temporary broker wait. Connectivity
  // belongs to the status indicator; it must never destructively blank accepted
  // market facts. The session boundary is handled when Market Runtime moves the
  // equity session (session_controller.js applyRealtimeSession), not here.
  return withProductRead({
    ...source,
    code,
    side_picker: sidePickerOf(code),
  }, "shioaji");
}

export function updateRealtimeQuoteRows(changedCodes, { arrivalUs = null } = {}) {
  if (!changedCodes || !changedCodes.size) return;
  pendingRowCodes ||= new Set();
  for (const code of changedCodes) pendingRowCodes.add(String(code || ""));
  // Latency lineage keeps the OLDEST arrival this repaint answers for, so coalescing never hides waiting time.
  if (arrivalUs != null && (pendingRowArrivalUs == null || arrivalUs < pendingRowArrivalUs)) pendingRowArrivalUs = arrivalUs;
  if (rowFrame) return;
  rowFrame = requestRealtimePaint(() => {
    rowFrame = 0;
    const codes = pendingRowCodes;
    const arrival = pendingRowArrivalUs;
    pendingRowCodes = null;
    pendingRowArrivalUs = null;
    const body = shioajiProductListBody();
    if (!body || !codes?.size || body.dataset.productMarket === "us") return;
    renderRealtimeQuoteTable({ changedCodes: codes, arrivalUs: arrival });
  });
}

// The 實際庫存 page's positions (即時持倉): set by the page controller while that page is the active one.
let realtimeQuoteHoldings = null;
export function setRealtimeQuoteHoldings(items) {
  realtimeQuoteHoldings = Array.isArray(items) ? items : null;
}

// The selection the table was last handed: the row that loses it on the next selection.
let paintedSelectedCode = "";

/** A new selection: the quote table, the only writer of the rows' selected class, patches the old and new rows. */
export function repaintSelectedRealtimeRows(nextCode) {
  updateRealtimeQuoteRows(new Set([paintedSelectedCode, productOfInstrument(nextCode || "")].filter(Boolean)));
}

export function renderRealtimeQuoteTable({ changedCodes = null, topologyChanged = false, arrivalUs = null } = {}) {
  const body = shioajiProductListBody();
  // This function is now the Shioaji data adapter only. The mounted
  // UnifiedProductListComponent is the sole table DOM writer.
  // The Taiwan background bootstrap continues while 商品列表-A is visible.
  // It may update cache/state, but it does not own the mounted US table DOM.
  // A full render (no changedCodes) re-merges every row; a row repaint re-merges only the dirty ones and reuses the
  // rest, exactly the rows the table patch would leave untouched anyway.
  const signalsByCode = () => appState.signalsByCode;
  if (!changedCodes) mergedRowCache.clear();
  const rows = appState.watchlistItems.map((item) => {
    const code = String(item?.code || "");
    const instrument = instrumentOf(code);
    const cached = mergedRowCache.get(code);
    if (changedCodes && cached && cached.item === item && cached.instrument === instrument && !changedCodes.has(code)) return cached.row;
    const row = realtimeMergedRow(item, signalsByCode(), instrument);
    mergedRowCache.set(code, { item, instrument, row });
    return row;
  });
  // The selection is an instrument (a futures month when a row shows its futures); the row is its product.
  paintedSelectedCode = productOfInstrument(realtimeContext.symbolStore.getSelectedSymbol() || "");
  publishTaiwanProductListView({
    rows,
    // The callback arrival of the tick that dirtied these rows, when the caller knows it. It is
    // telemetry lineage only and never affects what is displayed.
    // Only the arrival, in epoch microseconds. The lane is DERIVED by sourceLane() from the
    // source; a label supplied here would be taken on the caller's word, which is how a Futu row
    // could be counted in the Shioaji lane.
    trace: arrivalUs == null ? null : { arrival_us: arrivalUs },
    selectedCode: paintedSelectedCode,
    emptyText: "尚無自選商品",
    onSelect: selectRealtimeProductRow,
    onPick: pickRealtimeProductSide,
    changedCodes,
    topologyChanged,
    holdings: realtimeQuoteHoldings,
  });
}

export function invalidateSelectedRealtimeTrend() {
  const symbol = String(realtimeContext.symbolStore.getSelectedSymbol() || "").trim().toUpperCase();
  scheduleRealtimeTrendInvalidate({ symbol, reason: "SELECTED_SUMMARY_CHANGED" });
}

export function renderRealtimeOrderbook(_signal) {
  // 五檔 Presentation 由共享 OrderBookComponent 擁有。
  realtimeContext.dataSource.invalidate("orderbook", { symbol: realtimeContext.symbolStore.getSelectedSymbol() });
}

