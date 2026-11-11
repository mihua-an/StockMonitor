import { createHistoryWorkspaceLayoutController } from "../features/history/workspace_layout.js";
import { HISTORY_PANE_ROWS, HISTORY_PANE_SELECTOR, HISTORY_PANE_STORAGE_KEY, historyPaneDefaultLayout } from "../features/history/pane_defaults.js";
import { apiGet, apiGetOk } from "../core/api.js";
import { runUiTask } from "../core/ui_task.js";
import { appState } from "../core/state.js";
import { onApiOnline } from "../core/status.js";
import { replayHistoryContext } from "../core/dashboard_context.js";
import { eventFeedKey, normalizeHistoryEvents } from "../core/event_feed_format.js";
import { registerProductQuoteSearchProvider } from "../core/components/product_quote_search.js";
import { layoutStateStore } from "../core/layout_state_store.js";
import {
  mountDashboardPage,
  destroyDashboardPage,
  resizeDashboardPage,
} from "../core/dashboard_runtime.js";
import { $ } from "../core/utility.js";
import { RowSnapController } from "../core/row_snap.js";
import { bindBenchmarkOverlayControls } from "../core/benchmark_overlay_controls.js";

import { installHistoryPageHooks, historyPage, historyQueries, historyState, historyTraceObj } from "../features/history/history_state.js";
import { historyTradePageStateFresh, normalizeHistoryTradeScope } from "../features/history/trade_pager.js";
import { cancelActiveHistoryTradeRequest, getHistoryTradePageState, loadHistoryDaytradeMarkerRows, loadHistoryTradeDetailsPage } from "../features/history/trade_pages.js";
import { getHistoryStockName, historyDateStillSelected, isStockReplayProduct, normalizeHistoryClockText, setActiveHistoryTradeReview } from "../features/history/history_values.js";
import { buildReplayEventFeedViewModel, buildReplayOrderbookViewModel, buildReplayPriceFlowViewModel, buildReplayTickDetailsViewModel, buildReplayTradeDetailsViewModel, buildReplayTradeFlowViewModel, buildReplayTrendViewModel } from "../features/history/replay_view_models.js";
import { endHistoryEngineReplay, openHistoryEngine, pauseHistoryEngineReplay, seekHistoryEngine, startHistoryEngineReplay } from "../features/history/engine_controller.js";
import { bindHistoryTimelineHover, clearHistoryTimeline, showHistoryTimelinePosition } from "../features/history/timeline.js";
import { loadHistoryMarketSession, loadHistoryTxfSession } from "../features/history/market_session.js";
import { bindHistoryDatePicker, ensureHistoryDateOption, setHistoryDateValue, syncHistoryDatePicker } from "../features/history/date_picker.js";
import { renderHistoryStockList, scrollSelectedHistoryStockIntoView } from "../features/history/stock_list.js";
import { cancelReplayTechnicalNotify, notifyReplayTechnicalKeyChange, replayTechnicalService, scheduleReplayTechnicalNotify } from "../features/history/replay_technical.js";

const { getHistoryStockIndexCached, getHistoryStocksCached } = historyQueries;
const historyWorkspaceLayoutController = createHistoryWorkspaceLayoutController({
  documentRef: globalThis.document,
  windowRef: globalThis.window,
  layoutStore: layoutStateStore,
});

function setHistorySelectedCode(code) {
  const normalized = String(code || "").trim();
  historyState.selectedCode = normalized;
  replayHistoryContext.symbolStore.setSelectedSymbol(normalized);
  return normalized;
}

function syncReplayContextTimestamp(value = "") {
  replayHistoryContext.currentTimestamp.set(normalizeHistoryClockText(value) || "");
}

function invalidateReplayComponents(componentId = null) {
  const request = {
    symbol: replayHistoryContext.symbolStore.getSelectedSymbol(),
    timestamp: replayHistoryContext.currentTimestamp.get(),
  };
  if (componentId) replayHistoryContext.dataSource.invalidate(componentId, request);
  else replayHistoryContext.dataSource.invalidateAll(request);
  if (!componentId || componentId === "trendChart") scheduleReplayTechnicalNotify();
}

// The replay chart (TrendChart, replay surface) and the parts of it this page fills.
const replayChartPart = (roleName) => document.querySelector(`[data-component-slot="replayPrimary"] [data-role="${roleName}"]`);

function setHistoryEmpty(message = "尚無歷史資料") {
  setHistoryChartLoading("stock", false);
  setHistoryChartLoading("market", false);
  historyState.noQuoteMode = false;
  historyState.noQuoteName = "";
  historyState.replayCurrentTime = "";
  syncReplayContextTimestamp("");
  historyState.historyUnavailable = String(message || "");
  syncHistoryDatePicker();
  renderHistoryStockList();
  const replayDate = $("historyReplayDate");
  if (replayDate) replayDate.textContent = "----";
  clearHistoryTimeline();

  historyState.intradayEvents = [];
  invalidateReplayComponents();
}

// The replay time is published to the page once per frame: the panels that show it (the chart's cut-off, 事件, the
// market panel) redraw for the newest time only, however many statuses and seeks arrived within the frame (a drag
// moves it on every pointer event).
function publishHistoryReplayTime() {
  if (historyState.replayTimeFrame !== null) return;
  historyState.replayTimeFrame = requestAnimationFrame(() => {
    historyState.replayTimeFrame = null;
    syncReplayContextTimestamp(historyState.replayCurrentTime);
  });
}

function rerenderHistoryCurrentChart() {
  invalidateReplayComponents("trendChart");
}

export async function loadHistoryIntradayEvents() {
  const date = $("historyDateSelect")?.value || "";
  if (!date) {
    historyState.intradayEvents = [];
    invalidateReplayComponents("eventFeed");
    return;
  }

  let events = [];
  try {
    const result = await apiGetOk(`/api/monitor/events?date=${encodeURIComponent(date)}&limit=5000`);
    events = normalizeHistoryEvents(result?.events);
  } catch (error) {
    console.warn("[HISTORY INFO] event load failed", error);
  }
  if (!historyDateStillSelected(date)) return;
  historyState.intradayEvents = events;
  invalidateReplayComponents("eventFeed");
  rerenderHistoryCurrentChart();
}

function selectHistoryTime(timeText) {
  const clock = normalizeHistoryClockText(timeText);
  if (!clock) return;
  pauseHistoryEngineReplay();
  const [hour, minute, second] = clock.split(":").map(Number);
  seekHistoryEngine(hour * 3600 + minute * 60 + second);
}

async function selectHistoryStock(code, options = {}) {
  const nextCode = String(code || "").trim();
  if (!nextCode) return;
  const requestGeneration = ++historyPage.productRequestGeneration;
  setHistoryStockLoading(nextCode);
  historyTraceObj.trace("PRODUCT_SELECTED", { code: nextCode, generation: requestGeneration });

  const initialTime = String(options.initialTime || "").trim();
  if (nextCode === historyState.selectedCode && historyState.replay?.code === nextCode) {
    scrollSelectedHistoryStockIntoView();
    if (initialTime) selectHistoryTime(initialTime);
    invalidateReplayComponents("eventFeed");
    invalidateReplayComponents("tradeDetails");
    setHistoryStockLoading("");
    return;
  }

  stopHistoryPlayback();
  endHistoryEngineReplay();
  cancelActiveHistoryTradeRequest();
  setHistorySelectedCode(nextCode);
  const markerPromise = loadHistoryDaytradeMarkerRows().catch((error) => console.warn("[history: loading day-trade markers] failed", error));
  const tradePagePromise = historyState.tradeDetails.scope === "symbol"
    ? loadHistoryTradeDetailsPage({ scope: "symbol" }).catch((error) => console.warn("[history: loading the symbol trade page] failed", error))
    : Promise.resolve();
  renderHistoryStockList();
  scrollSelectedHistoryStockIntoView();
  let applied;
  try {
    applied = await openHistoryProduct({ initialTime, requestGeneration });
  } catch (error) {
    if (requestGeneration === historyPage.productRequestGeneration) {
      setHistoryStockLoading("");
      setHistoryProductLoading("error", `${nextCode} 商品資料讀取失敗`);
    }
    throw error;
  }
  if (requestGeneration !== historyPage.productRequestGeneration || applied === false) return;
  await Promise.allSettled([markerPromise, tradePagePromise]);
  if (requestGeneration !== historyPage.productRequestGeneration) return;
  invalidateReplayComponents();
  setHistoryStockLoading("");
}

function syncHistoryEventMarkerToggle() {
  const tradeButton = replayChartPart("history-trade-event-toggle");
  const allButton = replayChartPart("history-all-event-toggle");
  if (tradeButton) {
    tradeButton.classList.toggle("active", Boolean(historyState.showTradeEventMarkers));
    tradeButton.setAttribute("aria-pressed", historyState.showTradeEventMarkers ? "true" : "false");
  }
  if (allButton) {
    allButton.classList.toggle("active", Boolean(historyState.showAllEventMarkers));
    allButton.setAttribute("aria-pressed", historyState.showAllEventMarkers ? "true" : "false");
  }
}

// The chart's loading veil (TrendChart's `trend-loading`): shown while the stock's or the market's history loads,
// saying which.
const historyChartLoads = { stock: "", market: "" };
function setHistoryChartLoading(kind, active, text = "歷史資料抓取中") {
  historyChartLoads[kind === "market" ? "market" : "stock"] = active ? text : "";
  const veil = replayChartPart("trend-loading");
  if (!veil) return;
  const shown = historyChartLoads.stock || historyChartLoads.market;
  veil.hidden = !shown;
  const label = veil.querySelector('[data-role="trend-loading-text"]');
  if (label && shown) label.textContent = shown;
}

function setHistoryTradeJumpLoading(active) {
  setHistoryChartLoading("stock", active, "個股歷史資料抓取中");
  setHistoryChartLoading("market", active, "大盤歷史資料抓取中");
}

const historyProductQuoteSearch = {
  async suggest(text) {
    const query = String(text || "").trim().toUpperCase();
    return (Array.isArray(historyState.stocks) ? historyState.stocks : [])
      .map((item) => ({ code: String(item?.code || "").toUpperCase(), name: String(item?.name || getHistoryStockName(item?.code) || "") }))
      .filter((item) => item.code && (item.code.startsWith(query) || item.name.toUpperCase().includes(query)))
      .slice(0, 12);
  },
  async submit(item) {
    const code = String(item?.code || "").trim().toUpperCase();
    const listed = (Array.isArray(historyState.stocks) ? historyState.stocks : []).some((row) => String(row?.code || "").toUpperCase() === code);
    if (!listed) return { ok: false, message: "這一天沒有這檔商品的回放資料" };
    await selectHistoryStock(code);
    return { ok: true };
  },
};

// 歷史回放 through Market Runtime: 播放 plays the recorded day through the live engine and Rust B, so
// prints appear at their own exchange times and the panels show what the live page showed. Moving the slider (or
// « ‹ › » ↺, another stock or date) ends it and returns to browsing; 播放 starts it again from there. A day without a
// recorded partition keeps the summary playback below.

// The 加權 / 期貨 benchmark overlay toolbar of the replay trend.
function bindHistoryBenchmarkOverlay() {
  const benchmarkHost = replayChartPart("trend-overlay-toolbar");
  historyPage.benchmarkOverlayControls?.destroy?.();
  historyPage.benchmarkOverlayControls = null;
  if (benchmarkHost) {
    historyPage.benchmarkOverlayControls = bindBenchmarkOverlayControls(benchmarkHost, {
      initialState: { taiex: true, futures: false },
      onSelect: (kind) => {
        rerenderHistoryCurrentChart();
        const date = String(historyState.selectedDate || $("historyDateSelect")?.value || "").slice(0, 10);
        if (kind === "taiex" && !historyState.marketSession) void runUiTask("HISTORY_TAIEX_SESSION", () => loadHistoryMarketSession(date));
        if (kind === "futures" && !historyState.txfSession) void runUiTask("HISTORY_TXF_SESSION", () => loadHistoryTxfSession(date));
      },
    });
  }
}

// 交易時段事件 / 整個盤中事件: closing the first closes the second; opening the second opens the first.
function bindHistoryEventMarkerToggles() {
  const tradeEventToggle = replayChartPart("history-trade-event-toggle");
  const allEventToggle = replayChartPart("history-all-event-toggle");
  tradeEventToggle?.addEventListener("click", () => {
    const next = !historyState.showTradeEventMarkers;
    historyState.showTradeEventMarkers = next;
    // 關閉交易時段事件時，整個盤中事件也必須一起關閉。
    if (!next) historyState.showAllEventMarkers = false;
    syncHistoryEventMarkerToggle();
    rerenderHistoryCurrentChart();
  });

  allEventToggle?.addEventListener("click", () => {
    const next = !historyState.showAllEventMarkers;
    historyState.showAllEventMarkers = next;
    // 開啟整個盤中事件時，交易時段事件必然包含在內。
    if (next) historyState.showTradeEventMarkers = true;
    syncHistoryEventMarkerToggle();
    rerenderHistoryCurrentChart();
  });
}

// Another date or product ends the replay and starts over at that selection.
function bindHistorySelection(dateSelect, stockList) {
  dateSelect?.addEventListener("change", () => {
    endHistoryEngineReplay();
    stopHistoryPlayback();
    setActiveHistoryTradeReview(null);
    historyState.replayAnchorTime = "";
    historyState.replayAnchorDate = "";
    historyState.replayAnchorCode = "";
    historyState.selectedEventKey = "";
    const date = String(dateSelect.value || "");
    void runUiTask("HISTORY_DATE_SWITCH", async () => {
      await loadHistoryStocks();
      invalidateReplayComponents("eventFeed");
      invalidateReplayComponents("tradeDetails");
    }, { fallback: "切換日期失敗，請稍後再試", show: (text) => setHistoryProductLoading("error", text), isCurrent: () => historyDateStillSelected(date) });
  });

  stockList?.addEventListener("click", (event) => {
    const item = event.target.closest("[data-history-code]");
    if (!item || !stockList.contains(item)) return;
    setActiveHistoryTradeReview(null);
    historyState.selectedEventKey = "";
    void runUiTask("HISTORY_STOCK_SELECT", () => selectHistoryStock(item.dataset.historyCode));
  });
}

// The time bar, « ‹ › », 播放 and ↺: each moves Market Runtime's replay, and the page shows where it then stands. While the
// bar is held its thumb follows the pointer and every second it passes is a seek (only the newest one waits).
function bindHistoryTimeline() {
  const range = $("historyTimeRange");
  const playBtn = $("historyPlayBtn");
  const resetBtn = $("historyResetBtn");
  const hold = (held) => { historyState.dragging = held; };
  bindHistoryTimelineHover();
  range?.addEventListener("pointerdown", () => hold(true));
  for (const name of ["pointerup", "pointercancel", "lostpointercapture", "change"]) range?.addEventListener(name, () => hold(false));
  range?.addEventListener("input", () => {
    pauseHistoryEngineReplay();
    const second = Number(range.value) || 0;
    showHistoryTimelinePosition(second);
    seekHistoryEngine(second);
  });

  // « ‹ › »: the replay time 30 / 5 seconds back or forward, held inside the day's bar -- a seek like the bar's own.
  for (const button of document.querySelectorAll("[data-history-shift]")) {
    button.addEventListener("click", () => {
      if (!range || range.disabled) return;
      stopHistoryPlayback();
      const second = Math.min(Number(range.max) || 0, Math.max(Number(range.min) || 0,
        (Number(range.value) || 0) + Number(button.dataset.historyShift)));
      showHistoryTimelinePosition(second);
      seekHistoryEngine(second);
    });
  }

  playBtn?.addEventListener("click", () => {
    if (historyState.playing) {
      stopHistoryPlayback();
    } else {
      startHistoryPlayback();
    }
  });

  resetBtn?.addEventListener("click", () => {
    stopHistoryPlayback();
    const currentDate = String($("historyDateSelect")?.value || "");
    const currentCode = String(historyState.selectedCode || "");
    const anchorMatches = historyState.replayAnchorTime
      && historyState.replayAnchorDate === currentDate
      && historyState.replayAnchorCode === currentCode;
    if (anchorMatches) {
      selectHistoryTime(historyState.replayAnchorTime);
      return;
    }
    if (range && !range.disabled) seekHistoryEngine(Number(range.min) || 0);
  });
}

function bindHistorySpeedButtons() {
  document.querySelectorAll("[data-history-speed]").forEach((button) => {
    button.addEventListener("click", () => {
      const speed = Number(button.dataset.historySpeed) || 1;
      historyState.speed = speed;
      if (historyPage.engine?.active) void runUiTask("HISTORY_ENGINE_SPEED", () => historyPage.engine.setSpeed(speed));
      syncReplayContextTimestamp(historyState.replayCurrentTime);
      document.querySelectorAll("[data-history-speed]").forEach((item) => {
        item.classList.toggle("is-active", item === button);
      });
    });
  });
}

export function bindHistoryEvents() {
  historyPage.visit += 1;
  historyPage.dateLoad = null;
  historyTraceObj.reset(); historyTraceObj.trace("HISTORY_PAGE_OPEN");
  historyPage.unregisterProductQuoteSearch?.();
  historyPage.unregisterProductQuoteSearch = registerProductQuoteSearchProvider("history", historyProductQuoteSearch);
  configureReplayDashboardContext();
  replayHistoryContext.symbolStore.setSelectedSymbol(historyState.selectedCode || "");
  syncReplayContextTimestamp(historyState.replayCurrentTime || "");
  mountDashboardPage({
    pageId: "history",
    root: document,
    context: replayHistoryContext,
    panes: {
      selector: HISTORY_PANE_SELECTOR, storageKey: HISTORY_PANE_STORAGE_KEY, defaultLayout: historyPaneDefaultLayout,
      rows: HISTORY_PANE_ROWS, fixedTabs: true,
    },
  });

  const dateSelect = $("historyDateSelect");
  const stockList = $("historyStockList");

  historyPage.stockRowSnap?.destroy?.();
  historyPage.stockRowSnap = new RowSnapController({
    viewport: stockList,
    rowSelector: ".history-stock-item",
    rowHeightVar: "--row-height-history-product",
  }).mount();

  historyWorkspaceLayoutController.bind();
  bindHistoryDatePicker();
  syncHistoryEventMarkerToggle();

  bindHistoryBenchmarkOverlay();
  bindHistoryEventMarkerToggles();
  bindHistorySelection(dateSelect, stockList);
  bindHistoryTimeline();
  bindHistorySpeedButtons();
}

// One read. When FastAPI is down the page shows the failure and loads again the moment FastAPI is back (onApiOnline),
// instead of three timed retries.
async function fetchHistoryDates() {
  const result = await apiGet("/api/history/dates");
  if (!Array.isArray(result?.dates)) throw new Error("歷史日期回應格式錯誤");
  return result;
}

// The navigation that mounted the page does not wait for this read (page_mount.js): the page may be left, or mounted
// again, before the dates answer. An answer for an earlier visit draws nothing and opens no day.
export function refreshHistoryPage() {
  const load = loadHistoryDates(historyPage.visit);
  historyPage.dateLoad = load;
  return load;
}

async function loadHistoryDates(visit) {
  const current = () => visit === historyPage.visit;
  stopHistoryPlayback();
  // 若背景預熱已經拿到全歷史當沖，不要因為第一次切頁又把 cache 標成失效。
  // 真正資料更新仍可由 force refresh / 下一次帳務刷新覆蓋。
  historyState.replayAnchorTime = "";
  historyState.replayAnchorDate = "";
  historyState.replayAnchorCode = "";
  historyState.selectedEventKey = "";
  historyState.replayCurrentTime = "";
  syncReplayContextTimestamp("");
  historyState.noQuoteMode = false;
  historyState.noQuoteName = "";
  historyState.showTradeEventMarkers = true;
  historyState.showAllEventMarkers = true;
  syncHistoryEventMarkerToggle();
  historyPage.benchmarkOverlayControls?.select?.("taiex");

  const dateSelect = $("historyDateSelect");

  const applyDatesAndLoad = async (dates) => {
    if (!current()) return false;
    historyState.dates = Array.isArray(dates) ? dates : [];
    if (!historyState.dates.length) {
      setHistoryEmpty("找不到歷史 parquet");
      return false;
    }
    const preferredDate = historyState.selectedDate && historyState.dates.includes(historyState.selectedDate)
      ? historyState.selectedDate
      : historyState.dates[0];
    if (dateSelect) setHistoryDateValue(preferredDate);
    await loadHistoryStocks();
    return true;
  };

  try {
    // 從其他頁切回歷史資料時，先用模組記憶體中的日期/session
    // 立即重建畫面；再背景確認日期清單。首次進入才需要等待 /history/dates。
    if (historyState.dates.length) {
      await applyDatesAndLoad(historyState.dates);
      fetchHistoryDates().then((result) => {
        const fresh = Array.isArray(result?.dates) ? result.dates : [];
        if (!fresh.length || !current()) return;
        historyState.dates = fresh;
        syncHistoryDatePicker();
      }).catch((error) => console.warn("[history: refreshing the date list] failed", error));
      return;
    }

    const result = await fetchHistoryDates();
    await applyDatesAndLoad(result?.dates);
  } catch (error) {
    console.error("[HISTORY] init failed:", error);
    if (!current()) return;
    setHistoryEmpty("歷史資料載入失敗");
    historyPage.reloadOnApiOnline?.();
    historyPage.reloadOnApiOnline = onApiOnline(() => {
      historyPage.reloadOnApiOnline = null;
      if (appState.currentPage === "history") void runUiTask("HISTORY_RELOAD_ON_API_ONLINE", () => refreshHistoryPage());
    });
  }
}

// The product list's state, drawn over the list (history.css): a spinner while a day's products load, the reason at
// the list's foot when a read failed, nothing once they are in.
function setHistoryProductLoading(state, message = "") {
  const status = $("historyProductLoadStatus");
  const text = $("historyProductLoadText");
  const list = $("historyStockList");
  if (!status || !text) return;
  status.dataset.state = state;
  text.textContent = state === "ready" ? "" : message;
  list?.setAttribute("aria-busy", state === "loading" ? "true" : "false");
}

// The stock being opened (its replay data loading) spins at its row's edge; "" when none is. The list draws the mark
// from historyState.loadingCode (stock_list.js), so the page only sets the state.
function setHistoryStockLoading(code) {
  historyState.loadingCode = String(code || "");
  renderHistoryStockList();
}

// 在使用者第一次真正點進歷史頁之前，先於背景把最近交易日
// 最常用的四份資料放進模組 cache。失敗完全不影響正常頁面流程。
export async function openHistoryReplay(options = {}) {
  const date = String(options?.date || "").slice(0, 10);
  const code = String(options?.code || "");
  const name = String(options?.name || "");
  const time = String(options?.time || "").trim();
  const autoplay = Boolean(options?.autoplay);
  // The visit's date list and the day it opens come first (the navigation that mounted the page did not wait for
  // them): the replay asked for here then replaces that day, never the other way round.
  const visit = historyPage.visit;
  await historyPage.dateLoad;
  if (visit !== historyPage.visit) return false;
  const dateSelect = $("historyDateSelect");

  if (!dateSelect || !date || !code) return false;

  stopHistoryPlayback();
  ensureHistoryDateOption(date);
  setHistoryDateValue(date);
  setHistorySelectedCode(code);

  await loadHistoryStocks({
    targetCode: code,
    targetName: name,
    initialTime: time,
  });

  if (autoplay && historyState.replay) {
    startHistoryPlayback();
  }
  return true;
}

export function disposeHistoryPage() {
  historyWorkspaceLayoutController.dispose();
  cancelReplayTechnicalNotify();
  historyPage.engine?.dispose();
  historyPage.engine = null;
  historyPage.unregisterProductQuoteSearch?.();
  historyPage.unregisterProductQuoteSearch = null;
  cancelActiveHistoryTradeRequest();
  stopHistoryPlayback();
  historyPage.stockRowSnap?.destroy?.();
  historyPage.stockRowSnap = null;
  historyPage.benchmarkOverlayControls?.destroy?.();
  historyPage.benchmarkOverlayControls = null;
  // The product load in flight is fenced out, so nothing is loading any more: a row must not spin on the next visit.
  historyPage.productRequestGeneration += 1;
  historyState.loadingCode = "";
  historyPage.datePickerCleanup?.();
  // A load that failed while FastAPI was down waits for it to come back; leaving the page ends that wait.
  historyPage.reloadOnApiOnline?.();
  historyPage.reloadOnApiOnline = null;
  // The visit's date list is fenced out too: its answer is dropped and a replay waiting for it opens nothing.
  historyPage.visit += 1;
  historyPage.dateLoad = null;
  destroyDashboardPage("history");
  if (historyState.replayTimeFrame !== null) {
    cancelAnimationFrame(historyState.replayTimeFrame);
    historyState.replayTimeFrame = null;
  }
  historyState.replay = null;
  historyState.dragging = false;
}

// The product is not among the date's recordings (a 當沖 of a stock that was not watched that day): its panels say so and
// the market stays at the requested time.
function renderHistoryNoQuoteState(options = {}) {
  const date = String(options.date || $("historyDateSelect")?.value || "").slice(0, 10);
  const code = String(options.code || historyState.selectedCode || "");
  const name = String(options.name || getHistoryStockName(code) || "");
  const time = normalizeHistoryClockText(options.time)
    || normalizeHistoryClockText(historyState.marketSession?.end_time) || "13:30:00";

  endHistoryEngineReplay();
  notifyReplayTechnicalKeyChange();
  setHistorySelectedCode(code);
  historyState.noQuoteMode = true;
  historyState.noQuoteName = name;
  historyState.replayUnavailable = "這一天沒有這檔商品的報價";
  updateHistoryTimeLabel(time);

  const replayDate = $("historyReplayDate");
  if (replayDate) replayDate.textContent = date || "----";
  clearHistoryTimeline();
  renderHistoryStockList();
  invalidateReplayComponents();
}

// 大盤、事件、當沖明細都不阻塞「先把個股畫出來」：
// 一個 Promise.all 會被最慢的大盤歷史 API 綁住，首次進歷史頁會整頁等數秒。
function startHistoryDayPreloads(date) {
  return [
    loadHistoryMarketSession(date).catch((error) => console.warn("[HISTORY] market preload failed", error)),
    loadHistoryTxfSession(date).catch((error) => console.warn("[HISTORY] TXF preload failed", error)),
    loadHistoryIntradayEvents().catch((error) => console.warn("[HISTORY] intraday events load failed", error)),
  ];
}

// The sidebar becomes interactive after the small identity index arrives.
// Durable daily-K summaries hydrate rows independently; a late response may
// update the same date but can never change the selected product or replay.
function hydrateHistoryStockSummaries(date, requestGeneration) {
  return getHistoryStocksCached(date).then((summaryResult) => {
    if (date !== String(historyState.selectedDate || "").slice(0, 10)) return;
    const summaries = new Map((Array.isArray(summaryResult?.stocks) ? summaryResult.stocks : [])
      .map((item) => [String(item?.code || "").toUpperCase(), item]));
    historyState.stocks = historyState.stocks.map((item) => ({
      ...item,
      ...(summaries.get(String(item?.code || "").toUpperCase()) || {}),
    }));
    renderHistoryStockList();
    scrollSelectedHistoryStockIntoView();
    if (requestGeneration === historyPage.productRequestGeneration) {
      setHistoryProductLoading("ready");
    }
  }).catch((error) => {
    console.warn("[HISTORY] product summary load failed", error);
    if (requestGeneration === historyPage.productRequestGeneration) {
      setHistoryProductLoading("error", "價格摘要讀取失敗");
    }
  });
}

// The trade-detail page and the 當沖 markers reload when the date / product they belong to changed.
function reloadHistoryTradeLanes({ dateChanged, codeChanged }) {
  const activeTradeScope = normalizeHistoryTradeScope(historyState.tradeDetails.scope);
  const activeTradePage = getHistoryTradePageState(activeTradeScope);
  const tradeContextChanged = (activeTradeScope === "today" && dateChanged) || (activeTradeScope === "symbol" && codeChanged);
  const shouldReloadTradePage = tradeContextChanged || !historyTradePageStateFresh(activeTradePage);
  return [
    shouldReloadTradePage
      ? loadHistoryTradeDetailsPage({ scope: activeTradeScope, reset: tradeContextChanged })
        .catch((error) => console.warn("[HISTORY] trade details load failed", error))
      : Promise.resolve(),
    (dateChanged || codeChanged || !historyState.daytradeMarkerRows.length)
      ? loadHistoryDaytradeMarkerRows().catch((error) => console.warn("[HISTORY] daytrade markers load failed", error))
      : Promise.resolve(),
  ];
}

// The product index of one date; null when a newer request superseded it.
async function readHistoryStockIndex(date, requestGeneration) {
  historyTraceObj.trace("PRODUCT_LIST_REQUEST", { date });
  let result;
  try {
    result = await getHistoryStockIndexCached(date);
  } catch (error) {
    if (requestGeneration === historyPage.productRequestGeneration) {
      setHistoryProductLoading("error", "商品清單讀取失敗");
    }
    throw error;
  }
  historyTraceObj.trace("PRODUCT_INDEX_RESPONSE", { date, count: Number(result?.count) || 0, backend_ms: Number(result?.timing?.product_index_total_ms) || 0 });
  return requestGeneration === historyPage.productRequestGeneration ? result : null;
}

async function loadHistoryStocks(options = {}) {
  const requestGeneration = ++historyPage.productRequestGeneration;
  const dateSelect = $("historyDateSelect");
  const date = String(dateSelect?.value || "").slice(0, 10);
  const requestedCode = String(options.targetCode || "");
  const requestedName = String(options.targetName || "");
  const initialTime = String(options.initialTime || "").trim();
  const previousDate = String(historyState.selectedDate || "").slice(0, 10);
  const previousCode = String(historyState.selectedCode || "");

  if (!date) {
    setHistoryEmpty();
    return;
  }
  historyState.selectedDate = date;
  setHistoryProductLoading("loading", "讀取商品中");
  syncHistoryDatePicker();
  setHistoryChartLoading("market", true, "大盤歷史資料抓取中");
  const replayDate = $("historyReplayDate");
  if (replayDate) replayDate.textContent = date;

  const background = startHistoryDayPreloads(date);
  const result = await readHistoryStockIndex(date, requestGeneration);
  if (!result) return;
  historyState.stocks = (Array.isArray(result?.stocks) ? result.stocks : []).filter(isStockReplayProduct);
  historyState.historyUnavailable = "";
  setHistoryProductLoading("loading", "讀取價格中");
  background.push(hydrateHistoryStockSummaries(date, requestGeneration));

  const requestedExists = requestedCode && historyState.stocks.some((item) => String(item?.code || "") === requestedCode);
  const currentExists = historyState.stocks.some((item) => String(item?.code || "") === String(historyState.selectedCode || ""));
  if (requestedCode) {
    setHistorySelectedCode(requestedCode);
  } else if (!currentExists) {
    setHistorySelectedCode(String(historyState.stocks[0]?.code || ""));
  }
  const defaultCode = String(historyState.selectedCode || "");
  background.push(...reloadHistoryTradeLanes({ dateChanged: previousDate !== date, codeChanged: previousCode !== defaultCode }));
  historyTraceObj.trace("PRODUCT_LIST_RENDER_START", { count: historyState.stocks.length });
  renderHistoryStockList();
  historyTraceObj.trace("PRODUCT_LIST_RENDER_END", { count: historyState.stocks.length });
  invalidateReplayComponents("eventFeed");
  invalidateReplayComponents("tradeDetails");
  scrollSelectedHistoryStockIntoView();

  // 點歷史當沖時，交易日期可能存在，但該檔當天沒有被監控，因此
  // history/stocks 會找不到 requestedCode。這時仍切到該日期並保留大盤，
  // 個股走勢明確顯示「無報價」，而不是偷偷跳去當天第一檔股票。
  if ((requestedCode && !requestedExists) || !historyState.stocks.length || !defaultCode) {
    renderHistoryNoQuoteState({ date, code: requestedCode, name: requestedName, time: initialTime });
    await Promise.allSettled(background);
    return;
  }

  historyState.noQuoteMode = false;
  historyState.noQuoteName = "";
  await openHistoryProduct({ initialTime, requestGeneration });
}

// Open the selected product's replay (at `initialTime`, else its first print). Resolves false when a newer selection
// took over or there is no replay; the panels then say why (replay_view_models.js).
async function openHistoryProduct(options = {}) {
  const requestGeneration = Number(options.requestGeneration || historyPage.productRequestGeneration);
  const date = String($("historyDateSelect")?.value || "").slice(0, 10);
  const code = String(historyState.selectedCode || "");
  if (!date || !code) {
    setHistoryEmpty();
    return false;
  }
  historyState.noQuoteMode = false;
  historyState.noQuoteName = "";
  historyState.replay = null;
  clearHistoryTimeline();
  notifyReplayTechnicalKeyChange();
  invalidateReplayComponents();
  const replayDate = $("historyReplayDate");
  if (replayDate) replayDate.textContent = date;
  renderHistoryStockList();

  setHistoryChartLoading("stock", true, "個股回放載入中");
  historyTraceObj.trace("REPLAY_OPEN_START", { date, code, generation: requestGeneration });
  let opened = false;
  try {
    opened = await openHistoryEngine(normalizeHistoryClockText(options.initialTime));
  } finally {
    if (requestGeneration === historyPage.productRequestGeneration) setHistoryChartLoading("stock", false);
  }
  historyTraceObj.trace("REPLAY_OPEN_END", { date, code, generation: requestGeneration, opened });
  if (requestGeneration !== historyPage.productRequestGeneration) return false;
  return opened;
}

// The replay time moved (Market Runtime's status): the market panel, the events and the page context follow it.
function updateHistoryTimeLabel(clock) {
  historyState.replayCurrentTime = clock;
  publishHistoryReplayTime();
}

function startHistoryPlayback() {
  void runUiTask("HISTORY_ENGINE_REPLAY_START", () => startHistoryEngineReplay());
}

function stopHistoryPlayback() {
  pauseHistoryEngineReplay();
  historyState.playing = false;
  updatePlayButton();
}

function updatePlayButton() {
  const button = $("historyPlayBtn");
  if (!button) return;
  const text = historyState.playing ? "暫停" : "播放";
  if (button.textContent !== text) button.textContent = text;
}

async function handleReplayEventRowSelect(item) {
  const code = String(item?.code || "").trim();
  if (!code) return;
  setActiveHistoryTradeReview(null);
  historyState.selectedEventKey = eventFeedKey(item);
  await selectHistoryStock(code, { name: String(item?.name || ""), initialTime: String(item?.time || "") });
  invalidateReplayComponents("eventFeed");
  rerenderHistoryCurrentChart();
}

async function handleReplayEventDateSelect(dateText) {
  const date = String(dateText || "").slice(0, 10);
  const dateSelect = $("historyDateSelect");
  if (!date || !dateSelect || date === String(dateSelect.value || "")) return;
  stopHistoryPlayback();
  cancelActiveHistoryTradeRequest();
  setActiveHistoryTradeReview(null);
  historyState.replayAnchorTime = ""; historyState.replayAnchorDate = ""; historyState.replayAnchorCode = ""; historyState.selectedEventKey = "";
  setHistoryDateValue(date);
  await loadHistoryStocks();
  invalidateReplayComponents("eventFeed");
  invalidateReplayComponents("tradeDetails");
}

async function handleReplayTradeScopeChange(scope) {
  const normalized = normalizeHistoryTradeScope(scope);
  cancelActiveHistoryTradeRequest();
  historyState.tradeDetails.scope = normalized;
  const pageState = getHistoryTradePageState(normalized);
  invalidateReplayComponents("tradeDetails");
  if (!historyTradePageStateFresh(pageState)) {
    await loadHistoryTradeDetailsPage({
      scope: normalized,
      page: Math.max(1, Number(pageState.page) || 1),
      direction: pageState.loaded ? "jump" : "first",
    });
  }
}

async function handleReplayTradePageRequest(request = {}) {
  const scope = normalizeHistoryTradeScope(historyState.tradeDetails.scope);
  await loadHistoryTradeDetailsPage({
    scope,
    page: Math.max(1, Number(request?.page) || 1),
    direction: String(request?.direction || "jump"),
    cursor: String(request?.cursor || ""),
  });
}

async function handleReplayTradeDetailSelect(item) {
  const rowDate = String(item?.realized_date || "").slice(0, 10);
  const code = String(item?.code || "").trim();
  const name = String(item?.name || "");
  const entry = String(item?.entry_ref || "");
  if (!rowDate || !code) return;
  const dateSelect = $("historyDateSelect");
  if (!dateSelect) return;
  setActiveHistoryTradeReview(item);
  historyState.selectedDaytradeId = String(item?.id ?? "");
  historyState.selectedEventKey = "";
  historyState.replayAnchorTime = entry; historyState.replayAnchorDate = rowDate; historyState.replayAnchorCode = code;
  stopHistoryPlayback(); setHistoryTradeJumpLoading(true);
  try {
    const previousDate = String(dateSelect.value || "");
    ensureHistoryDateOption(rowDate);
    const codeExistsToday = historyState.stocks.some((stock) => String(stock?.code || "") === code);
    if (previousDate !== rowDate || !codeExistsToday) {
      setHistoryDateValue(rowDate); setHistorySelectedCode(code);
      await loadHistoryStocks({ targetCode: code, targetName: name, initialTime: entry });
    } else {
      await selectHistoryStock(code, { name, initialTime: entry });
    }
    renderHistoryStockList(); scrollSelectedHistoryStockIntoView(); invalidateReplayComponents("eventFeed"); invalidateReplayComponents("tradeDetails"); rerenderHistoryCurrentChart();
  } finally {
    setHistoryTradeJumpLoading(false); setHistoryChartLoading("stock", false);
    if (historyState.marketDate === rowDate && historyState.marketSession) setHistoryChartLoading("market", false);
  }
}

function configureReplayDashboardContext() {
  replayHistoryContext.services.eventFeed = {
    onRowSelect: (item) => handleReplayEventRowSelect(item).catch((error) => console.error("[HISTORY EVENT FEED] row select failed:", error)),
    onDateSelect: (date) => handleReplayEventDateSelect(date).catch((error) => console.error("[HISTORY EVENT FEED] date select failed:", error)),
  };
  replayHistoryContext.services.tradeDetails = {
    onRowSelect: (item) => handleReplayTradeDetailSelect(item).catch((error) => console.error("[HISTORY TRADE DETAILS] row select failed:", error)),
    onScopeChange: (scope) => handleReplayTradeScopeChange(scope).catch((error) => console.error("[HISTORY TRADE DETAILS] scope change failed:", error)),
    onPageRequest: (request) => handleReplayTradePageRequest(request).catch((error) => console.error("[HISTORY TRADE DETAILS] page request failed:", error)),
  };
  replayHistoryContext.services.technicalAnalysis = replayTechnicalService;
  // Every market panel shows Market Runtime's replay view (the live page's models), or why there is none.
  replayHistoryContext.dataSource.setResolver("orderbook", buildReplayOrderbookViewModel);
  replayHistoryContext.dataSource.setResolver("tradeFlow", buildReplayTradeFlowViewModel);
  replayHistoryContext.dataSource.setResolver("priceFlow", buildReplayPriceFlowViewModel);
  replayHistoryContext.dataSource.setResolver("trendChart", buildReplayTrendViewModel);
  replayHistoryContext.dataSource.setResolver("eventFeed", () => buildReplayEventFeedViewModel());
  replayHistoryContext.dataSource.setResolver("tickDetails", buildReplayTickDetailsViewModel);
  replayHistoryContext.dataSource.setResolver("tradeDetails", () => buildReplayTradeDetailsViewModel());
}

export function resizeHistoryDashboard() {
  resizeDashboardPage("history");
}

// The functions split-out modules call back into.
installHistoryPageHooks({ invalidateReplayComponents, rerenderHistoryCurrentChart, updateHistoryTimeLabel, updatePlayButton, setHistoryChartLoading });
