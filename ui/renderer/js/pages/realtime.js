// 即時報價: assembles the page's controllers (features/realtime: live_page_state, session_state, product_pages,
// live_redraw, canonical_view_owner, live_view_models, selection_controller, session_controller, startup_diagnostics)
// into the dashboard context, and mounts, resumes and disposes the page.
import { screenLayouts } from "../features/layouts/screen_layouts.js";
import { TreeWorkspace } from "../core/tree_workspace.js";
import { createComponentMetricsBinder } from "../features/realtime/component_metrics.js";
import { installSelectionScenarioRunner } from "../features/realtime/selection_scenario_runner.js";
import { realtimeContext } from "../core/dashboard_context.js";
import { dashboardWorkspace, destroyDashboardPage, mountDashboardPage, mountedDashboardComponent, resizeDashboardPage, selectDashboardComponent } from "../core/dashboard_runtime.js";
import { PaperOrderPopover } from "../features/realtime/components/paper_order_popover.js";
import { createPaperOrderEntry } from "../features/realtime/paper_order_entry.js";
import { runUiTask } from "../core/ui_task.js";
import { sourceEnabled } from "../core/source_settings.js";
import { sendRealtimeClientMetric, setRealtimeFocusSymbol, subscribeRealtimeAnalysisState, subscribeRealtimeSession, subscribeRealtimeView } from "../market_data/realtime.js";
import { disposeProductPageTabs } from "../features/realtime/product_list.js";
import { paperHoldings } from "../features/realtime/ledger_holdings.js";
import { realtimeRenderScheduler } from "../features/realtime/realtime_render_scheduler.js";
import { cancelRealtimePresentationWork, invalidateSelectedRealtimeTrend, selectRealtimeCodeImmediately } from "../features/realtime/realtime_presentation.js";
import { startMonitorEventTape } from "../features/realtime/live_monitor_events.js";
import { paperOrdersStore } from "../core/paper_orders_store.js";
import { industryIndexStore } from "../features/realtime/industry_index_store.js";
import { activeTrendTarget, liveMarketDataGateway, livePageMounted, marketPanelUiState, realtimePageVisible, requestAnimationFrame, selectedStockCode, selectionIntentStore, setLivePageMounted, setMountingPresentation, setRealtimePageShown, viewResources } from "../features/realtime/live_page_state.js";
import { connectCanonicalViewOwner, loadTxfTrendSnapshot, reconcileCanonicalViews, stockViewWarmOrSubscribed } from "../features/realtime/canonical_view_owner.js";
import { applyOptimisticTradePageCount, bindOrderbookAdaptiveLayout, buildTrendOverlaySeries, ensureTaiexOverlayData, ensureTrendOverlayData, liveTradePager, loadLiveTickPage, ownEventMarkerToggle, realtimeOrderbookController, registerLiveViewModelResolvers, technicalAnalysisService } from "../features/realtime/live_view_models.js";
import { activateDashboardComponent, applyWatchPageToRealtime, bindProductCompleteRowScroll, bindProductSelectionExtras, bindProductSides, bindSearchFocus, bindWatchPageSources, disposeSelectionBindings, loadWatchPages, publishSelectedSymbol, bindProductColumnSettings, setTrendViewMode, shioajiProductQuoteSearch, syncSelectedSymbolAdapter, toggleOddLotShown } from "../features/realtime/selection_controller.js";
import { activeTxfSession, setActiveTxfSession, startFreshnessBannerWatch, stockCanonicalViewSpec } from "../features/realtime/session_state.js";
import { bindStockFuturesSessionControl, bindTxfSessionControl, startRealtimeSessionSync, syncRealtimeSessionOwnershipFromStatus } from "../features/realtime/session_controller.js";
import { invalidateLiveTrendComponents, renderTaiexAsPrimary, renderTxfAsPrimary } from "../features/realtime/live_redraw.js";
import { startupUnitReporter } from "../features/realtime/startup_diagnostics.js";

// Where the page's panes go: 即時報價's workspace, or the 版型 editor window's (pages/layouts.js).
let liveSurfaceSelector = ".realtime-workspace";
export function setLiveSurface(selector) { liveSurfaceSelector = selector; }

// The trend's lookup box docks on 買賣報價, wherever that pane is.
function decorateLivePane(element, pane) {
  if (pane.componentIds.includes("orderbook")) {
    element.dataset.trendLookupDockTarget = "realtime-orderbook";
    element.dataset.trendLookupAlign = "left";
  } else {
    delete element.dataset.trendLookupDockTarget;
    delete element.dataset.trendLookupAlign;
  }
}

function livePanes() {
  const screens = screenLayouts();
  return { selector: liveSurfaceSelector, Workspace: TreeWorkspace,
    workspaceOptions: { initialTree: screens.active().tree, onChange: (tree) => screens.setTree(tree), decoratePane: decorateLivePane } };
}

const componentMetricsBinder = createComponentMetricsBinder({ viewResources, sendRealtimeClientMetric });
// The 模擬下單 popover a 買賣報價 price opens when no 模擬帳務 is on the page; it lives while the page does.
let paperOrderPopover = null;

// A new trade on the detail target's view advances its trade pager's page count.
connectCanonicalViewOwner({ onTradeAppended: applyOptimisticTradePageCount });

function configureLiveDashboardContext() {
  // 模擬帳務's orders (委託, 成交, 刪改), read by the 模擬帳務 component.
  realtimeContext.services.paperOrders = paperOrdersStore;
  // 模擬帳務's 未實現: the paper ledger's positions and their live prices (the 庫存 page's rule, live_position_marks.js).
  realtimeContext.services.paperHoldings = paperHoldings;
  // 模擬帳務's search box opens its 下單 panel on a stock found the way the product headers find one.
  realtimeContext.services.productSearch = shioajiProductQuoteSearch;
  realtimeContext.services.positionMarks = { subscribeView: subscribeRealtimeView, subscribeSession: subscribeRealtimeSession };
  // 分析資料重建中 over the panes whose data is Rust B's (ComponentHost, core/analysis_rebuild_notice.js).
  realtimeContext.services.analysisState = { subscribe: subscribeRealtimeAnalysisState };
  realtimeContext.services.selection = {
    // Commit the authoritative selection generation before notifying mounted
    // components. Their synchronous resolvers then read the new symbol rather
    // than briefly building a frame from the previous SelectionIntent state.
    select: (code, meta = {}) => publishSelectedSymbol(
      code,
      meta.reason || "USER_CLICK",
      meta.source || "dashboard_context",
      meta.trigger || "product_selection",
    ),
  };
  realtimeContext.services.tickDetails = {
    bootstrap: () => loadLiveTickPage({ page: 1, latest: true }),
    onPageRequest: ({ page = 1, latest = false } = {}) => loadLiveTickPage({ page, latest }),
  };
  realtimeContext.services.canonicalViews = { isWarmOrSubscribed: stockViewWarmOrSubscribed };
  realtimeContext.services.eventFeed = {
    onRowSelect: (item, options = {}) => selectRealtimeCodeImmediately(
      String(item?.code || ""), String(item?.time || ""), options.lookupMode || "crosshair"
    ).catch((error) => console.warn("[LIVE EVENT FEED] select failed", error)),
  };
  realtimeContext.services.technicalAnalysis = technicalAnalysisService();
  realtimeContext.services.trendOverlays = {
    defaultState: () => ({ average: marketPanelUiState.snapshot().showAveragePrice !== false }),
    ensure: (kind) => ensureTrendOverlayData(kind),
    build: (options) => buildTrendOverlaySeries(options),
  };
  // The 期貨走勢 tab the user chose: what its buttons show, whatever data is on screen yet.
  realtimeContext.services.futuresSession = { selected: () => activeTxfSession };
  // 買賣報價's 零股／整張: the book and 成交明細 switch between the detail stock and its 盤中零股.
  realtimeContext.services.oddLot = { toggle: toggleOddLotShown };
  realtimeContext.services.dashboard = { onComponentActivate: activateDashboardComponent };
  // A 買賣報價 price clicked: a 模擬 order at it, in 模擬帳務 when it is on the page, else in the popover.
  paperOrderPopover?.destroy();
  paperOrderPopover = new PaperOrderPopover({ store: paperOrdersStore, paperHoldings, dataSource: realtimeContext.dataSource });
  realtimeContext.services.paperOrderEntry = createPaperOrderEntry({
    selectComponent: (id) => selectDashboardComponent("realtime", id),
    mountedComponent: (id) => mountedDashboardComponent("realtime", id),
    popover: paperOrderPopover,
  });
  registerLiveViewModelResolvers();
}

function mountLivePagePresentation() {
  if (livePageMounted) return;
  viewResources.activate(); liveTradePager.activate(); setLivePageMounted(true);
  componentMetricsBinder.bind();
  configureLiveDashboardContext();
  installSelectionScenarioRunner({
    select: code => publishSelectedSymbol(code, "BENCHMARK", "selection_scenario", "scenario_runner"),
    cacheProbe: code => Boolean(liveMarketDataGateway.snapshot(stockCanonicalViewSpec(code))),
  });
  setMountingPresentation(true);
  try {
    mountDashboardPage({
      pageId: "realtime", root: document, context: realtimeContext,
      panes: livePanes(),
    });
  } finally { setMountingPresentation(false); }
  viewResources.own(screenLayouts().subscribe((screen) => dashboardWorkspace("realtime")?.show(screen.tree)));
  bindProductCompleteRowScroll();
  bindWatchPageSources(); bindProductSides(); viewResources.own(bindProductColumnSettings()); bindProductSelectionExtras(); bindTxfSessionControl(); bindStockFuturesSessionControl(); bindOrderbookAdaptiveLayout(); bindSearchFocus();
}

// TAIEX / TXF hydration runs beside the selected stock's first paint, never in front of it.
function startAuxiliaryMarkets(mountToken) {
  // Each load's failure is its own record; the panels are redrawn once both have settled either way.
  const auxiliaryStartup = Promise.all([
    runUiTask("REALTIME_STARTUP_TAIEX_OVERLAY", () => ensureTaiexOverlayData()),
    runUiTask("REALTIME_STARTUP_TXF_TREND", () => loadTxfTrendSnapshot(activeTxfSession)),
  ]);
  const startupSelected = String(selectedStockCode() || "").trim().toUpperCase();
  setRealtimeFocusSymbol(startupSelected, { force: true });
  void runUiTask("REALTIME_STARTUP_MARKET_PANELS", async () => {
    await auxiliaryStartup;
    if (!viewResources.current(mountToken)) return;
    // The 期貨走勢 and 加權走勢 panels exist whether or not they are the PRIMARY chart, so both are
    // invalidated once their startup data has landed. Only redrawing the primary target left the
    // other panel showing whatever it managed to draw before its reference/series arrived.
    invalidateLiveTrendComponents({ symbol: "TXFR1", session: activeTxfSession }, ["futuresTrend"]);
    invalidateLiveTrendComponents({ symbol: "TAIEX" }, ["marketTrend"]);
    if (activeTrendTarget() === "TXF") renderTxfAsPrimary();
    else if (activeTrendTarget() === "TAIEX") renderTaiexAsPrimary();
  });
}

export async function initRealtimePage({ startupFastPath = false, reportStartupUnit = null } = {}) {
  setRealtimePageShown(true);
  viewResources.activate();
  const mountToken = viewResources.token();
  liveTradePager.activate();
  const { report, runUnit } = startupUnitReporter({ startupFastPath, reportStartupUnit, mountToken });
  // Trend market/session are persistent presentation state.  Initial
  // mount restores the user's last explicit choice; status/WS/render cycles may
  // never silently reset FUTURES back to TAIEX.
  const restoredUi = marketPanelUiState.snapshot();
  setActiveTxfSession(restoredUi.futuresSession);
  selectionIntentStore.restoreFromPanelState(restoredUi, { source: "mount", trigger: "initial_restore" });
  // 產業指數 starts on the restored stock's index when none was chosen yet (使用者 10-22).
  if (selectedStockCode()) void industryIndexStore.followStartupStock(selectedStockCode());
  syncSelectedSymbolAdapter();
  setTrendViewMode(activeTrendTarget() === "TXF" ? "futures" : activeTrendTarget() === "TAIEX" ? "market" : "stock");
  await runUnit("dashboard_components", "建立 Dashboard component graph", async () => {
    mountLivePagePresentation();
  }, "Dashboard 元件與事件完成");
  if (!viewResources.current(mountToken)) return { ok: false, cancelled: true };
  if (!sourceEnabled("shioaji")) {
    await report("taiwan_products", "skipped", "Shioaji 來源未啟用");
    return { ok: true, disabled: true, source: "shioaji" };
  }
  startRealtimeSessionSync();
  viewResources.own(startFreshnessBannerWatch());
  ownEventMarkerToggle();
  // The 事件列表 tape: declared once, held by the transport across reconnects and rollovers.
  startMonitorEventTape();
  if (startupFastPath) {
    // /api/status contains broad runtime/model/recorder diagnostics and can take
    // seconds on a cold Windows start. Session ownership is useful enrichment,
    // not a prerequisite for showing the monitor shell, so reconcile it after
    // first paint instead of blocking first-paint startup units.
    void syncRealtimeSessionOwnershipFromStatus().then(() => {
      if (!viewResources.current(mountToken)) return;
      if (activeTrendTarget() === "TXF") renderTxfAsPrimary();
    }).catch((error) => console.warn("[realtime: rendering TXF after the session sync] failed", error));
  } else {
    await syncRealtimeSessionOwnershipFromStatus();
  }
  // Canonical views are the live-data boundary.  Create them before optional
  // watch-page/cache hydration so a cold local read cannot leave the monitor
  // mounted with stale trades, book, or trend data and zero WS subscriptions.
  if (!viewResources.current(mountToken)) return { ok: false, cancelled: true };
  const earlySelected = String(selectedStockCode() || "").trim().toUpperCase();
  reconcileCanonicalViews("PAGE_START");
  setRealtimeFocusSymbol(earlySelected);
  // Watch pages are local and cheap. TAIEX/TXF hydration can legitimately take
  // longer on a cold restart, so never make the selected stock's OrderBook and
  // TradeDetail first paint wait behind those auxiliary markets.
  const watchStartup = await runUnit(
    "taiwan_products",
    "讀取 watch_pages 與台股商品頁設定",
    () => loadWatchPages({ startupFastPath }),
    (result) => `${result?.overviewCodes?.length || 0} 檔商品`,
  );

  if (!viewResources.current(mountToken)) return { ok: false, cancelled: true };
  // The rows' numbers come from their Market Runtime views as each snapshot arrives; there is no product cache to read.
  // The step stays declared so the startup progress lists it honestly.
  if (!viewResources.current(mountToken)) return { ok: false, cancelled: true };

  startAuxiliaryMarkets(mountToken);
  // The first paint of every mounted panel (成交明細 included: it was invalidated twice).
  realtimeContext.dataSource.invalidateAll({ symbol: selectedStockCode() });
  if (activeTrendTarget() === "TXF") renderTxfAsPrimary();
  else if (activeTrendTarget() === "TAIEX") renderTaiexAsPrimary();
  else invalidateSelectedRealtimeTrend();
}

export async function refreshRealtimePage() {
  const mountToken = viewResources.token();
  if (!viewResources.current(mountToken)) return;
  await Promise.all([loadWatchPages(), ensureTaiexOverlayData()]);
  if (!viewResources.current(mountToken)) return;
  // 大單流向 and 價量 come only from the canonical view (snapshot + deltas): the realtime-context REST fill and
  // its Python TradeFlowEngine -- a second large-order definition that flashed different numbers -- are gone.
  if (activeTrendTarget() === "TAIEX") renderTaiexAsPrimary();
  else if (activeTrendTarget() === "TXF") {
    await loadTxfTrendSnapshot(activeTxfSession);
    if (viewResources.current(mountToken)) renderTxfAsPrimary();
  }
  else invalidateLiveTrendComponents({ symbol: selectedStockCode() }, ["stockTrend"]);
}

export function resumeRealtimePage() {
  setRealtimePageShown(true);
  syncSelectedSymbolAdapter();
  mountLivePagePresentation();
  if (!sourceEnabled("shioaji")) return;
  // The canonical views were kept while the page was away, and so was the session sync that dates them.
  // The watch pages may have been edited meanwhile (their change notice was the page's): read again.
  applyWatchPageToRealtime();
  void runUiTask("REALTIME_RESUME_WATCH_PAGES", () => loadWatchPages());
  startRealtimeSessionSync();
  viewResources.own(startFreshnessBannerWatch());
  ownEventMarkerToggle();
  void runUiTask("REALTIME_RESUME_SESSION_SYNC", () => syncRealtimeSessionOwnershipFromStatus());
  const symbol = selectedStockCode();
  setRealtimeFocusSymbol(symbol);
  // While hidden the page drew nothing (its invalidations are gated on visibility): every panel catches up once.
  realtimeContext.dataSource.invalidateAll({ symbol, reason: "PAGE_RESUME_MOUNT" });
  if (activeTrendTarget() === "TXF") renderTxfAsPrimary();
  else if (activeTrendTarget() === "TAIEX") renderTaiexAsPrimary();
  else invalidateSelectedRealtimeTrend();
  requestAnimationFrame(() => resizeDashboardPage("realtime"));
}

/** The live page's dashboard is mounted in the current DOM (app.js: re-selecting 即時報價 must not rebuild it). */
export function isRealtimePageMounted() {
  return livePageMounted && realtimePageVisible;
}

export function setRealtimePageVisible(visible) {
  if (!visible) disposeRealtimePage({ retainSelection: true });
  else setRealtimePageShown(true);
}

export function disposeRealtimePage({ retainSelection = false } = {}) {
  setRealtimePageShown(false);
  setLivePageMounted(false);
  // The canonical views and the workspace demand are NOT released: they belong to the window, not to the page.
  // Only presentation goes.
  viewResources.dispose();
  // The session sync stays: the canonical views it dates outlive the page, so a rollover while the page is
  // away must still move them -- it only touches presentation while the page is visible.
  cancelRealtimePresentationWork();
  setRealtimeFocusSymbol("");
  disposeProductPageTabs(document.querySelector('[data-role="product-list-pages"][data-provider="shioaji"]'));
  liveTradePager.dispose();
  disposeSelectionBindings({ retainSelection });
  realtimeRenderScheduler.cancel("shioaji-live-trend");
  realtimeRenderScheduler.cancel("shioaji-selected-realtime-detail");
  ["trendChart", "marketTrend", "futuresTrend", "stockTrend", "tickDetails", "orderbook", "tradeFlow", "priceFlow"]
    .forEach((id) => realtimeRenderScheduler.cancel(`shioaji-component:${id}`));
  realtimeOrderbookController.dispose();
  realtimeContext.services.trendOverlays = null;
  realtimeContext.services.futuresSession = null;
  realtimeContext.services.oddLot = null;
  realtimeContext.services.paperOrderEntry = null;
  paperOrderPopover?.destroy();
  paperOrderPopover = null;
  destroyDashboardPage("realtime");
}

export function resizeRealtimePage() { resizeDashboardPage("realtime"); }

export { getLiveMarketDataDiagnostics } from "../features/realtime/startup_diagnostics.js";
