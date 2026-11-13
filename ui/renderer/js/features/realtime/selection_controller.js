// The 即時報價 page's selection controller: the product pages' loading and tabs, the selected product, the trend and
// detail targets (SelectionIntentStore), the search focus, and what an activated dashboard slot selects.
import { retainColumnSettingsEditor } from "../../core/components/column_settings_editor.js";
import { onInstrumentNamesLearned,requestInstrumentNames, resolveInstrumentDisplayName } from "../../core/instrument_names.js";
import { createRealtimeProductListController } from "./product_list_controller.js";
import { appState } from "../../core/state.js";
import { beginSelection } from "../../core/selection_latency_trace.js";
import { realtimeContext } from "../../core/dashboard_context.js";
import { selectDashboardComponent } from "../../core/dashboard_runtime.js";
import { apiGet } from "../../core/api.js";
import { readPreference, writePreference } from "../../core/preferences.js";
import { SearchFocusController } from "./search_focus_controller.js";
import { registerProductQuoteSearchProvider } from "../../core/components/product_quote_search.js";
import { suggestShioajiProducts } from "./product_search_api.js";
import { setRealtimeFocusSymbol } from "../../market_data/realtime.js";
import { enableSharedProductListScroll } from "./product_list.js";
import { publishTaiwanProductPages } from "./taiwan_product_list_store.js";
import { HOLDINGS_LEDGERS } from "./ledger_holdings.js";
import { invalidateSelectedRealtimeTrend, renderRealtimeOrderbook, renderRealtimeQuoteTable, repaintSelectedRealtimeRows, selectRealtimeCodeImmediately, setRealtimeQuoteHoldings } from "./realtime_presentation.js";
import { getSelectedRealtimeSignal, replaceSignalRows } from "./live_signals.js";
import { productListOverviewOnly, setProductListOverviewOnly, activePage, activeWatchPageId, holdingPages, overviewPage, setActiveWatchPageId, setWatchPages, watchPages, watchPagesLoadError } from "./product_pages.js";
import { activeTrendTarget, detailSymbolContext, detailTargetCode, lastStockDetailTarget, marketPanelUiState, mountingPresentation, requestAnimationFrame, searchFocusTarget, selectedStockCode, selectionIntentStore, viewResources } from "./live_page_state.js";
import { ensureStockCanonicalView, loadTxfTrendSnapshot, reconcileCanonicalViews } from "./canonical_view_owner.js";
import { renderTaiexAsPrimary, renderTaiexAsPrimaryNow, renderTxfAsPrimaryNow } from "./live_redraw.js";
import { liveTickPageState, loadLiveTickPage, resetLiveTickPageState } from "./live_view_models.js";
import { activeTxfSession, oddLotShown, recomputeFreshnessBanner, setOddLotShown, setStockFuturesSession } from "./session_state.js";
import { instrumentOf, loadProductSides, productOfInstrument, subscribeProductSides } from "./product_sides.js";

// The analysis signal row (1m/3m/5m, the K columns, 量變, the model-derived fields) and the
// monitor alert tape now arrive as PUSH, on the `signals` and `events` channels of the ordinary
// per-symbol canonical view -- see stockCanonicalViewSpec() and applyCanonicalSignalRow().
//
// No timer polls /api/latest-signals: that endpoint fans out to one Rust snapshot read per symbol
// (~83 reads every two seconds purely to refresh a projection), and the projection has its own transport.
//
// REST keeps exactly its proper jobs: the first paint, recovery after a reconnect, history, and
// an explicit user-initiated refresh. It is not a polling clock for intraday data.
// A product list's ⚙ (product_list_tools.js) edits its column profile in the shared column settings panel; the page
// holds the panel and draws the Shioaji list again when a profile is saved (the Futu list redraws itself).
export function bindProductColumnSettings() {
  const release = retainColumnSettingsEditor();
  const redraw = () => renderRealtimeQuoteTable();
  window.addEventListener("realtime-product-columns-changed", redraw);
  return () => { window.removeEventListener("realtime-product-columns-changed", redraw); release(); };
}

const WATCH_PAGE_ACTIVE_KEY = "shioajiActiveWatchPageV1";
let realtimeProductRowSnap = null;
let liveSelectionUnsubscribe = null;
let searchFocusController = null;
const realtimeProductListController = createRealtimeProductListController({
  documentRef: globalThis.document,
  enableScroll: enableSharedProductListScroll,
});

function setActiveTrendCode(code, reason, source = "realtime", trigger = "trend") {
  const next = selectionIntentStore.setTrendCode(code, { reason, source, trigger });
  const market = next.trendCode === "TXF" ? "futures" : next.trendCode === "TAIEX" ? "taiex" : "stock";
  marketPanelUiState.setTrendMarket(market, {
    reason, source, trigger,
    selectedSymbol: market === "stock" ? next.trendCode : marketPanelUiState.snapshot().selectedSymbol,
  });
  return next.trendCode;
}

function persistSelectedSymbol(code, reason = "USER_CLICK", source = "realtime", trigger = "selected_symbol") {
  const next = selectionIntentStore.setSelectedSymbol(code, { reason, source, trigger });
  marketPanelUiState.setSelectedSymbol(next.selectedSymbol, { reason, source, trigger });
  return next.selectedSymbol;
}

export function publishSelectedSymbol(code, reason = "USER_CLICK", source = "realtime", trigger = "selected_symbol") {
  beginSelection(String(code || "").trim().toUpperCase(), selectedStockCode());
  const selected = persistSelectedSymbol(code, reason, source, trigger);
  // Scoped symbol store is a notification adapter only. The selection
  // authority is committed first, so synchronous subscribers cannot observe an
  // intent generation older than the symbol they are being notified about.
  realtimeContext.symbolStore.setSelectedSymbol(selected);
  return selected;
}

export function syncSelectedSymbolAdapter() {
  realtimeContext.symbolStore.setSelectedSymbol(selectedStockCode());
}

function setActiveDetailCode(code, meta = {}) {
  return selectionIntentStore.setDetailCode(code, {
    reason: meta.reason || "INTERNAL_SYNC",
    source: meta.source || "realtime",
    trigger: meta.trigger || "detail_owner",
  }).detailCode;
}

function setSearchFocusCode(code, { mode = "LIVE", reason = "INTERNAL_SYNC", source = "search_focus", trigger = "search_focus", externalGeneration = 0 } = {}) {
  return selectionIntentStore.setSearchFocus(code, { mode, reason, source, trigger, externalGeneration }).searchFocusCode;
}

function clearSearchFocusCode({ reason = "INTERNAL_SYNC", source = "search_focus", trigger = "search_clear", externalGeneration = 0 } = {}) {
  return selectionIntentStore.clearSearchFocus({ reason, source, trigger, externalGeneration }).searchFocusCode;
}

export function setTrendViewMode(mode) {
  const componentId = mode === "stock" ? "stockTrend" : mode === "futures" ? "futuresTrend" : "marketTrend";
  // Only ask the dashboard to select the component. Stamping data-trend-view here, on whatever canvas
  // happens to be in analysisPrimary -- a hard-coded slot that need not be where the trend chart lives --
  // would let a click on 加權走勢 in the top slot relabel the 個股走勢 canvas as a market view (the retired monitor.js's isRealtimeMarketTrendView() then stopped treating it
  // as a stock chart, which is why its line lost its red/green), while the slot that really switched
  // kept the previous variant's label and frame numbers. TrendChartComponent is the single writer:
  // it stamps the identity on mount and on reconfigure, which is when a surface changes variant.
  // Panes can be rearranged (pane_workspace.js), so the trend is selected wherever it is placed.
  selectDashboardComponent("realtime", componentId, { notify: false });
}

export function applyWatchPageToRealtime() {
  // No page chosen yet (loadWatchPages applies it once it has): an empty page here would clear the saved selection.
  if (!activeWatchPageId) return;
  const page = activePage();
  const codes = Array.isArray(page?.codes) ? page.codes.map(String) : [];
  // The page's products (and the detail target) are declared to the canonical view owner; it subscribes what is
  // missing and releases what left. Selection changes priority only; it never defines which symbols stay hot.
  reconcileCanonicalViews("WATCH_PAGE");
  const signalMap = appState.signalsByCode;
  const pageMeta = new Map((Array.isArray(page?.items) ? page.items : []).map((item) => [String(item.code || ""), item]));
  appState.watchlistItems = codes.map((code, index) => {
    const signal = signalMap.get(code) || {};
    const meta = pageMeta.get(code) || {};
    return {
      sort_order: index + 1,
      enabled: true,
      code,
      // The page item's name is the catalog's, joined when the pages were read; the catalog's cached name wins.
      name: resolveInstrumentDisplayName("shioaji", code, meta.name, signal.name),
      market: signal.market || meta.market || "",
      industry_name: meta.industry_name || "",
      type: meta.type || "",
    };
  });
  // A product that left the page takes its analysis row with it. Otherwise the row outlives the
  // subscription that fed it: nothing refreshes it, nothing removes it, and it keeps counting as
  // "has a signal" for 尚無訊號 while being invisible on every page.
  // The rows' instruments (a product's stock or chosen futures month) are what the analysis rows are keyed by.
  const pageCodes = new Set(codes.map((code) => instrumentOf(String(code || "").trim().toUpperCase())));
  const departed = [...appState.signalsByCode.keys()]
    .map((code) => String(code || "").trim().toUpperCase())
    .filter((code) => code && code !== "TXFR1" && !pageCodes.has(code));
  if (departed.length) replaceSignalRows({ removedCodes: departed, render: false });

  const selectedCode = String(selectedStockCode()).trim();
  const selectedStillVisible = selectedCode && (codes.includes(productOfInstrument(selectedCode)) || selectedCode === searchFocusTarget());

  // A selection that left the page is cleared here; loading the product pages then selects the page's first
  // product (selectFirstProductIfNone), never a product from an earlier list.
  if (!selectedStillVisible && selectedCode) {
    publishSelectedSymbol("", "RESTORE_STATE", "watch_page_reconcile", "watch_page_clear");
    // Product/watch-page refresh may clear an invalid stock selection, but it must
    // never reset the user's TAIEX/FUTURES trend market choice.
    if (!["TAIEX", "TXF"].includes(activeTrendTarget())) setTrendViewMode("stock");
  }

  setRealtimeQuoteHoldings(!productListOverviewOnly && holdingPages.has(activeWatchPageId) ? page.items : null);
  renderRealtimeQuoteTable();
  // Product rows are fed by the coalesced market.quotes.delta lane. Full
  // canonical trades/trend/orderbook subscriptions belong only to visible
  // detail panels, never every symbol in the watch page.
  if (activeTrendTarget() === "TAIEX") renderTaiexAsPrimary();
  else invalidateSelectedRealtimeTrend();
  renderRealtimeOrderbook(getSelectedRealtimeSignal());
  renderWatchPageTabs();
  realtimeContext.dataSource.invalidate("eventFeed", { symbol: selectedStockCode() });
}

// The tabs are the product list component's to draw (it may be mounted later, when its pane tab is opened): the page
// only publishes them.
function renderWatchPageTabs() {
  publishTaiwanProductPages({
    systemPages: [...holdingPages.values()],
    overview: overviewPage(),
    pages: watchPages.filter((page) => String(page?.market || "tw").toLowerCase() !== "us"),
    activePageId: activeWatchPageId,
    onSelect: (key) => {
      setActiveWatchPageId(key);
      writePreference(WATCH_PAGE_ACTIVE_KEY, activeWatchPageId, { context: "watch page" });
      applyWatchPageToRealtime();
    },
    loadError: watchPagesLoadError,
    overviewOnly: productListOverviewOnly,
    onOverviewOnly: (on) => { setProductListOverviewOnly(on); applyWatchPageToRealtime(); },
  });
}

export async function loadWatchPages({ startupFastPath = false } = {}) {
  const mountToken = viewResources.token();
  if (!viewResources.current(mountToken)) return null;
  try {
    const data = window.desktopAPI?.loadWatchPagesLocal
      ? await window.desktopAPI.loadWatchPagesLocal()
      : await apiGet("/api/watch-pages");
    if (!viewResources.current(mountToken)) return null;
    if (data && data.ok === false) throw new Error(data.error || "讀取商品頁失敗");
    const pages = Array.isArray(data?.pages) ? data.pages : [];
    // Every page's products are named from the catalog, not only the shown page's: a product on another page, opened
    // from the header's code box while 實際庫存 was shown, was headed by its code (台積電 as "2330", 10-19).
    requestInstrumentNames("shioaji", pages.filter((page) => String(page?.market || "tw").toLowerCase() !== "us")
      .flatMap((page) => (Array.isArray(page?.items) ? page.items : []).map((item) => item?.code)));
    setWatchPages(pages, "");
  } catch (error) {
    console.warn("[WATCH PAGES]", error);
    if (!viewResources.current(mountToken)) return null;
    setWatchPages([], String(error?.message || error || "讀取商品頁失敗"));
  }
  await Promise.all(HOLDINGS_LEDGERS.map(async (ledger) => {
    try {
      const pages = await ledger.refresh();
      if (viewResources.current(mountToken)) holdingPages.set(ledger.pageIds.tw, pages.tw);
    } catch (error) {
      console.warn(`[${ledger.ledger.toUpperCase()} HOLDINGS] initial load failed`, error);
      if (viewResources.current(mountToken)) holdingPages.set(ledger.pageIds.tw, ledger.pages().tw);
    }
  }));
  if (!viewResources.current(mountToken)) return null;
  const saved = readPreference(WATCH_PAGE_ACTIVE_KEY, { context: "watch page" }) || "";
  setActiveWatchPageId(saved === "overview" || holdingPages.has(saved) || watchPages.some((page) => String(page?.market || "tw").toLowerCase() !== "us" && String(page.id) === saved)
    ? (saved || "overview")
    : "overview");
  // Local watch pages are sufficient for first paint. Daemon-backed numeric
  // enrichment is intentionally detached from this function's completion so a
  // busy daemon can never stretch the first-paint startup units.
  applyWatchPageToRealtime();
  selectFirstProductIfNone();
  // The rows' numbers are their views' (productSummaryOf): each paints when its snapshot arrives. There is no
  // summary copy to load or "enrich" on a timer.
  return { overviewCodes: overviewPage().codes };
}

// Opening the product pages with nothing selected (first launch, or the saved product left the page) selects the
// active page's first product, so the detail panels open on it (user 10-13). A saved selection still on the page is
// kept. An empty page leaves the panels on their prompt (NO_SELECTION_TEXT).
function selectFirstProductIfNone() {
  if (selectedStockCode()) return;
  const first = instrumentOf(String(activePage()?.codes?.[0] || "").trim().toUpperCase());
  if (first) publishSelectedSymbol(first, "INITIAL_MOUNT", "watch_page_load", "default_first_product");
}

// Each product's sides and months (GET /api/subscriptions). Until they are read every row is its stock.
export async function refreshProductSides() {
  try {
    await loadProductSides();
  } catch (error) {
    console.warn("[product sides: reading GET /api/subscriptions] failed", error);
  }
}

// A product's side or month changed (its row's 現／月份 button), or every product's were read again: the rows'
// views follow, the rows repaint, and a selected product moves to the instrument it shows now.
export function bindProductSides() {
  viewResources.own(subscribeProductSides(() => {
    reconcileCanonicalViews("PRODUCT_SIDES");
    renderRealtimeQuoteTable();
    const selected = String(selectedStockCode() || "").trim().toUpperCase();
    const product = productOfInstrument(selected);
    const shows = instrumentOf(product);
    if (selected && shows !== selected && (activePage()?.codes || []).includes(product)) {
      publishSelectedSymbol(shows, "USER_CLICK", "product_sides", "product_side_changed");
    }
  }));
  void refreshProductSides();
}

// What changes the product pages while the page is mounted: an edit saved in the watch-page editor window, a catalog
// revision, the holdings ledgers. (The list's ✎ that opens the editor is the product list component's.)
export function bindWatchPageSources() {
  // The pages and the 訂閱偏好 are saved together: each product's sides and months are read again with them.
  viewResources.own(window.desktopAPI?.onWatchPagesChanged?.(() => { loadWatchPages(); void refreshProductSides(); }) || (() => {}));
  // Another catalog revision: the pages' names and types are read again (watch_page_store.js joins them on read).
  viewResources.own(window.desktopAPI?.onProductCatalogChanged?.(() => loadWatchPages()) || (() => {}));
  // A name the catalog answered for the shown product (a searched code): its header and order book redraw.
  viewResources.own(onInstrumentNamesLearned((code) => {
    if (code === String(selectedStockCode() || "").trim().toUpperCase()) realtimeContext.dataSource.invalidateAll({ symbol: code });
  }));
  for (const ledger of HOLDINGS_LEDGERS) {
    const id = ledger.pageIds.tw;
    const applyHoldings = (pages) => {
      const previous = (holdingPages.get(id)?.codes || []).join("|");
      holdingPages.set(id, pages.tw);
      if (previous === (pages.tw.codes || []).join("|")) {
        // Same stocks, new 持股／成本 (a trade added to an existing holding): only the 即時持倉 columns change.
        if (activeWatchPageId === id) {
          setRealtimeQuoteHoldings(pages.tw.items);
          renderRealtimeQuoteTable();
        }
        return;
      }
      applyWatchPageToRealtime();
    };
    viewResources.own(ledger.subscribe(applyHoldings));
    // The holdings store keeps the last positions it read (its stream stops while nobody listens and reopens with
    // this subscription, re-reading a newer revision): what it holds is applied now, not the holdings the page left with.
    if (ledger.pages().loadedAt) applyHoldings(ledger.pages());
  }
}

export function bindProductSelectionExtras() {
  liveSelectionUnsubscribe?.();
  liveSelectionUnsubscribe = realtimeContext.symbolStore.subscribe((value) => {
    const code = String(value || "").trim().toUpperCase();
    // Another product: 個股走勢's 日／夜／全 starts again from the session trading now.
    if (code !== String(selectedStockCode() || "").trim().toUpperCase()) setStockFuturesSession(null);
    beginSelection(code, selectedStockCode());
    // LiveSelectedSymbolStore is now an event/fan-out adapter. Any external
    // component selection is first ingested into SelectionIntentStore so every
    // renderer read sees one generationed owner, including an explicit clear.
    persistSelectedSymbol(code, "USER_CLICK", "selected_symbol_store", "symbol_store_sync");
    // Whoever selected (a product-list click, a search, an event row), the quote table patches the selected rows.
    repaintSelectedRealtimeRows(code);
    setActiveDetailCode(code || lastStockDetailTarget() || "", { source: "selected_symbol_store", trigger: "detail_sync" });
    const nextDetailTarget = detailTargetCode();
    if (liveTickPageState.target !== nextDetailTarget) resetLiveTickPageState(nextDetailTarget);
    if (searchFocusController) {
      searchFocusController.syncActiveSymbol(code);
    }
    ensureStockCanonicalView(code);
    setRealtimeFocusSymbol(code);
    if (!code) {
      const request = detailSymbolContext();
      realtimeContext.dataSource.invalidate("orderbook", request);
      realtimeContext.dataSource.invalidate("tickDetails", request);
      realtimeContext.dataSource.invalidate("tradeFlow", request);
      realtimeContext.dataSource.invalidate("priceFlow", request);
      return;
    }

    // 選股的唯一 canonical owner 是 LiveSelectedSymbolStore。
    // Page controller 只更新頁面級 context / locked regions；五檔、走勢、大單由 ComponentHost 訂閱 store 後自行刷新。
    // Selecting a stock is an explicit product-level navigation intent. Keep
    // the chart identity aligned with the selected product instead of leaving
    // the main chart owned by the previous TAIEX/TXF tab, which made the stock
    // trend appear missing after switching symbols.
    setActiveTrendCode(code, "USER_CLICK", "selected_symbol_store", "symbol_selection");
    setTrendViewMode("stock");
    // persistSelectedSymbol() already ran at the start of this listener. The
    // mounted components subscribe to symbolStore and have each refreshed once.
    // Re-invalidating here rebuilt the 100-row TradeDetail and OrderBook twice.
    // AI/context enrichment is not a first-paint dependency. The periodic
    // refresh below will update it; forcing one FastAPI request on every click
    // saturated the control plane and delayed unrelated pagination requests.
    // Product-list selection can reach this listener without going through
    // selectRealtimeCodeImmediately(). If the Canonical snapshot is still cold,
    // it contains no intraday points; load the durable chart once so the stock
    // trend is never left as an empty canvas despite the API having data.
    // A freshly-selected symbol's own subscription starts out
    // loading/ready, never inheriting the previous symbol's stale/resyncing
    // state -- recompute immediately instead of waiting for the next
    // freshness-banner tick so a symbol switch cannot leave a stale banner
    // up (or a real one hidden) for up to 2s.
    recomputeFreshnessBanner();
  });
}

// 買賣報價's 零股／整張 (docs/decisions.md 零股行情的顯示): 買賣報價 and 成交明細 switch to the detail stock's 盤中零股
// (or back). Its view is held from then on -- Market Runtime keeps it subscribed for the day -- and 成交明細's pages are
// of the market it shows now.
export function toggleOddLotShown() {
  setOddLotShown(!oddLotShown);
  reconcileCanonicalViews("ODD_LOT");
  const target = detailTargetCode();
  resetLiveTickPageState(target);
  const request = detailSymbolContext();
  realtimeContext.dataSource.invalidate("orderbook", request);
  realtimeContext.dataSource.invalidate("tickDetails", request);
  return target ? loadLiveTickPage({ page: 1, latest: true }) : Promise.resolve(null);
}

function syncFallbackDetailTargetAfterTrendChange() {
  const target = detailTargetCode();
  if (liveTickPageState.target === target) return Promise.resolve(null);
  resetLiveTickPageState(target);
  const request = detailSymbolContext();
  realtimeContext.dataSource.invalidate("orderbook", request);
  realtimeContext.dataSource.invalidate("tickDetails", request);
  realtimeContext.dataSource.invalidate("tradeFlow", request);
  realtimeContext.dataSource.invalidate("priceFlow", request);
  // Page 1 is the live snapshot (nothing is read for it); opening it also asks once, in the background, how many
  // pages the target's trades fill. Skipping it for stocks left their page count at 1 for good.
  return target ? loadLiveTickPage({ page: 1, latest: true }) : Promise.resolve(null);
}

// A dashboard slot became active: the trend target and detail owner follow it (a restored slot is not a selection).
export async function activateDashboardComponent({ componentId } = {}) {
  // Restoring a slot is not a user selection. Keep the existing intent owner.
  if (mountingPresentation || !viewResources.active) return;
  const mountToken = viewResources.token();
  const id = String(componentId || "");
  if (["productList", "productListA"].includes(id)) {
    // ComponentHost replaces the table shell when switching broker pages.
    // Rebind complete-row geometry to the newly mounted wrapper so both
    // lists retain one-wheel-one-row and never expose a clipped last row.
    requestAnimationFrame(() => bindProductCompleteRowScroll());
  }
  if (id === "marketTrend") {
    setActiveTrendCode("TAIEX", "USER_CLICK", "dashboard_tabs", "market_component");
    syncFallbackDetailTargetAfterTrendChange();
    setTrendViewMode("market");
    renderTaiexAsPrimaryNow();
  } else if (id === "futuresTrend") {
    setActiveTrendCode("TXF", "USER_CLICK", "dashboard_tabs", "futures_component");
    // Futures chart selection must not steal the stock detail-panel owner.
    syncFallbackDetailTargetAfterTrendChange();
    setTrendViewMode("futures");
    renderTxfAsPrimaryNow();
    await loadTxfTrendSnapshot(activeTxfSession);
    if (!viewResources.current(mountToken)) return;
    if (activeTrendTarget() === "TXF") renderTxfAsPrimaryNow();
  } else if (["stockTrend"].includes(id)) {
    const selected = String(selectedStockCode() || "").trim().toUpperCase();
    const code = selected && !["TXF", "TXFR1", "TAIEX"].includes(selected) ? selected : lastStockDetailTarget();
    if (code) {
      publishSelectedSymbol(code, "USER_CLICK", "dashboard_tabs", "stock_component");
      setActiveDetailCode(code, { source: "dashboard_tabs", trigger: "stock_component_detail" });
      setActiveTrendCode(code, "USER_CLICK", "dashboard_tabs", "stock_component");
      resetLiveTickPageState(code);
      ensureStockCanonicalView(code);
    }
    setTrendViewMode("stock");
    invalidateSelectedRealtimeTrend();
    if (code) {
      await loadLiveTickPage({ page: 1, latest: true });
      if (!viewResources.current(mountToken)) return;
      realtimeContext.dataSource.invalidate("orderbook", { symbol: code });
      realtimeContext.dataSource.invalidate("tickDetails", { symbol: code });
      realtimeContext.dataSource.invalidate("tradeFlow", { symbol: code });
      realtimeContext.dataSource.invalidate("priceFlow", { symbol: code });
    }
  }
  if (["marketTrend", "futuresTrend", "stockTrend"].includes(id)) {
    realtimeContext.dataSource.invalidate(id, {
      symbol: selectedStockCode(),
      variant: id === "marketTrend" ? "market" : id === "futuresTrend" ? "futures" : "stock",
    });
  }
}

export function bindProductCompleteRowScroll() {
  const productScroll = realtimeProductListController.bind();
  realtimeProductRowSnap = productScroll.rowSnap;
}

export function bindSearchFocus() {
  const mountToken = viewResources.token();
  searchFocusController?.destroy?.();
  searchFocusController = new SearchFocusController({
    onIntent: async (item, { generation } = {}) => {
      const code = String(item?.code || "").trim().toUpperCase();
      if (!code) return;
      // Phase A is immediate and latest-intent-owned.
      // Heavy hydration may finish later, but activeSymbol/input/widgets switch now.
      setSearchFocusCode(code, { reason: "USER_CLICK", source: "search_focus", trigger: "search_intent", externalGeneration: generation || 0 });
      publishSelectedSymbol(code, "USER_CLICK", "search_focus", `search_intent_${generation || 0}`);
      setActiveTrendCode(code, "USER_CLICK", "search_focus", `search_intent_${generation || 0}`);
      setTrendViewMode("stock");
      ensureStockCanonicalView(code);
      realtimeContext.dataSource.invalidateAll({ symbol: code, searchFocus: true, phase: "intent", generation });
    },
    onSelect: async (item, { generation } = {}) => {
      const code = String(item?.code || "").trim().toUpperCase();
      if (!code || code !== searchFocusTarget()) return;
      // A search pick is always the live view: selection is local, and the canonical view supplies its data.
      selectionIntentStore.setSearchFocusMode("LIVE", { reason: "USER_CLICK", source: "search_focus", trigger: "search_ready", externalGeneration: generation || 0 });
      setRealtimeFocusSymbol(code);
      realtimeContext.dataSource.invalidateAll({ symbol: code, searchFocus: true, mode: "LIVE", phase: "ready", generation });
    },
    onClear: async () => {
      const previous = searchFocusTarget();
      clearSearchFocusCode({ reason: "USER_CLICK", source: "search_focus", trigger: "search_clear" });
      const selected = String(selectedStockCode() || "");
      const permanent = activePage().codes?.map(String)?.includes(selected);
      if (selected && selected === previous && !permanent) {
        publishSelectedSymbol("", "USER_CLICK", "search_focus", "search_clear");
        setRealtimeFocusSymbol("");
        ensureStockCanonicalView("");
        setActiveTrendCode("TAIEX", "USER_CLICK", "search_focus", "search_clear");
        setTrendViewMode("market");
        renderTaiexAsPrimary();
        realtimeContext.dataSource.invalidateAll({ symbol: "" });
      }
    },
  });
  if (searchFocusTarget()) {
    void searchFocusController.select({ code: searchFocusTarget() }).catch((error) => console.warn("[realtime: restoring the search focus] failed", error));
  }
  viewResources.own(registerProductQuoteSearchProvider("shioaji", shioajiProductQuoteSearch));
}

export const shioajiProductQuoteSearch = {
  async suggest(text, { signal } = {}) {
    // Watch-page products first, then the rest of the security master.
    return suggestShioajiProducts(text, { signal, listed: new Set(overviewPage().items.map((item) => String(item?.code || "").toUpperCase())) });
  },
  async submit(item) {
    const code = String(item?.code || "").trim().toUpperCase();
    if (!code) return { ok: false, message: "請輸入代號" };
    if (overviewPage().codes.map((value) => String(value).toUpperCase()).includes(code)) {
      await selectRealtimeCodeImmediately(code);
      return { ok: true };
    }
    if (!searchFocusController) return { ok: false, message: "查詢尚未就緒" };
    // The header's name is the catalog's: only the code is passed on, picked from a suggestion or typed with Enter.
    requestInstrumentNames("shioaji", [code]);
    await searchFocusController.select({ code });
    return { ok: true };
  },
};

// The page's selection bindings, released when the page is disposed: the product list's row geometry, the search focus
// (kept as the selection when the page is only hidden) and the symbol-store listener.
export function disposeSelectionBindings({ retainSelection = false } = {}) {
  realtimeProductRowSnap?.destroy?.();
  realtimeProductRowSnap = null;
  if (searchFocusController) {
    searchFocusController.clear({ notify: false }).catch((error) => console.warn("[realtime: clearing the search focus] failed", error));
    searchFocusController.destroy();
    searchFocusController = null;
    if (!retainSelection) clearSearchFocusCode({ reason: "INTERNAL_SYNC", source: "dispose", trigger: "page_dispose" });
  }
  liveSelectionUnsubscribe?.();
  liveSelectionUnsubscribe = null;
  realtimeProductListController.dispose();
}
