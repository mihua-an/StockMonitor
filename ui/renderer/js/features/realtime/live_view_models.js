// The 即時報價 page's panel view models (走勢, 買賣報價, 成交明細 and its page reads, 大單流向, 價量, 事件) and the 走勢
// overlays. Every market view model leaves through withMarketRead (market_read_adapters.js).
import { resolveInstrumentDisplayName } from "../../core/instrument_names.js";
import { TRADE_DETAIL_PAGE_SIZE, createRealtimeTradeDetailController } from "../../market_data/trade_detail_controller.js";
import { createRealtimeOrderbookController } from "./orderbook_controller.js";
import { withMarketRead } from "../../core/market_read_adapters.js";
import { realtimeContext } from "../../core/dashboard_context.js";
import { apiGet } from "../../core/api.js";
import { liveEventMarkers, stockTrendEventMarkersVisible, subscribeStockTrendEventMarkers } from "../../core/event_markers.js";
import { FuturesOrderBookAdapter, StockOrderBookAdapter } from "../../core/orderbook_adapters.js";
import { bigOrderFlowWindowsFromRust } from "../../core/big_order_flow.js";
import { displayQuote } from "../../core/auction_price.js";
import { queryRealtimeLargeOrders } from "../../market_data/realtime.js";
import { txfDisplayIdentityKey } from "./txf_session_identity.js";
import { compareTradeRowsNewestFirst, tradeRowKey, tradeRowSequence } from "../../core/trade_row_order.js";
import { projectBenchmarkSeries } from "../../core/trend_overlay.js";
import { positiveMarketPrice } from "../../market_data/stock_market_summary.js";
import { modelPredictionMetrics } from "../../core/model_predictions.js";
import { tabAmplitude, trendMetrics } from "../../core/trend_metrics.js";
import { canonicalDisplayFrame, isSimtradeTick, normalizeDaemonPriceVolume, normalizeRustTradeFlow, orderbookDiffEventToken, tickVolume } from "../../market_data/realtime_market_math.js";
import { isTapePrint, largeOrderDefinition, largePrintMatcher, tapeRow } from "../../market_data/trade_detail/tape_rows.js";
import { getSelectedRealtimeSignal } from "./live_signals.js";
import { getLiveMonitorEvents, liveEventFeedViewModel } from "./live_monitor_events.js";
import { numberOrNull, positiveNumberOrNull } from "../../core/numbers.js";
import { themeColor } from "../../core/market_palette.js";
import { industryIndexStore } from "./industry_index_store.js";
import { industryIndexTrendViewModel } from "./industry_index_view_model.js";
import { technicalViewService } from "./technical_window_service.js";
import { activeTxfSession, currentTxfDisplayIdentity, equityDateListeners, equityTradingDate, futuresMonthTrendSpecs, industryIndexCanonicalViewSpec, stockFuturesSessionShown, stockCanonicalViewSpec, taiexCanonicalViewSpec, txfCanonicalViewSpec, txfIdentityMatches, txfTickMatchesDisplayWindow } from "./session_state.js";
import { activeTrendTarget, detailSymbolContext, detailTargetCode, liveMarketDataGateway, selectedStockCode, selectionIntentStore, viewResources } from "./live_page_state.js";
import { currentTaiexView, currentTxfBenchmarkView, ensureTaiexCanonicalView, ensureTxfBenchmarkView, orderbookDeltaTokens, stockViewState, txfDisplay } from "./canonical_view_owner.js";
import { invalidateLiveTrendComponents } from "./live_redraw.js";
import { watchPages } from "./product_pages.js";
import { productOfInstrument, productSides } from "./product_sides.js";
import { futuresDisplayCode, parseFuturesMonthSymbol } from "../../market_data/futures_symbol.js";
// Trend ownership is independent from the detail panels. Product selection owns
// OrderBook / TradeDetail / TradeFlow; switching between TAIEX/TXF/stock charts
// must never redirect those panels to TXFR1. TXFR1 remains Quote-only.

export const liveTradePager = createRealtimeTradeDetailController({
  apiGet,
  // One historical read boundary: FastAPI /api/trade-detail/page over HistoricalStore (the Shioaji daemon
  // serves no /v1/trade-detail/page).
  pageGet: (path, options = {}) => apiGet(path, options),
  getQuery: liveTradeQuery, getEquityDate: equityTradingDate,
  futuresIdentityMatches: identity => txfIdentityMatches(identity, activeTxfSession),
  invalidateDetails: () => realtimeContext.dataSource.invalidate("tickDetails", detailSymbolContext()),
});
export const realtimeOrderbookController = createRealtimeOrderbookController({ documentRef: globalThis.document });
export const liveTickPageState = liveTradePager.state;
export const { reset: resetLiveTickPageState, load: loadLiveTickPage, count: applyOptimisticTradePageCount } = liveTradePager;

function liveTradeQuery() {
  const target = detailTargetCode();
  if (target && target !== "TXFR1") {
    // A stock, or a futures month (CDF202611): the partition its view is bound to.
    const spec = stockCanonicalViewSpec(target);
    const viewKey = stockViewState(target).session_key || {};
    const tradingDate = String(viewKey.trading_date || spec.trading_date || "").slice(0, 10);
    const actualContract = String(viewKey.contract_code || target).trim().toUpperCase();
    return { target, market: spec.market, session: spec.session, tradingDate, actualContract,
      requestIdentityKey: `${spec.market}|${target}|${tradingDate}|${spec.session}|${actualContract}` };
  }
  const market = target === "TXFR1" ? "FUT" : "STK";
  const session = market === "FUT" ? activeTxfSession.toUpperCase() : "DAY";
  const committedTxfIdentity = market === "FUT" ? currentTxfDisplayIdentity(activeTxfSession) : null;
  const viewKey = market === "FUT" ? null : (stockViewState(target).session_key || {});
  const identity = market === "FUT" ? committedTxfIdentity
    : { ...viewKey, actual_contract: viewKey.contract_code || target };
  const tradingDate = String(identity?.trading_date || (target === "TXFR1" ? txfDisplay()?.trading_date : equityTradingDate()) || "").slice(0, 10);
  const actualContract = String(identity?.actual_contract || identity?.contract_code || (target === "TXFR1" ? txfDisplay()?.contract_code : target) || "").trim().toUpperCase();
  const requestIdentityKey = market === "FUT" ? txfDisplayIdentityKey(committedTxfIdentity || {}) : `${market}|${target}|${tradingDate}|${session}|${actualContract}`;
  return { target, market, session, tradingDate, actualContract, requestIdentityKey };
}

// 漲停/跌停 for the 成交明細 tape: Market Runtime's (the contract's official ones), or none -- never derived from 昨收.
function tapeLimitPrices(target) {
  if (!target || target === "TXFR1") return { limitUp: null, limitDown: null };
  const summary = liveMarketDataGateway.snapshot(stockCanonicalViewSpec(target))?.summary || {};
  return { limitUp: positiveNumberOrNull(summary.limit_up), limitDown: positiveNumberOrNull(summary.limit_down) };
}

function buildIndustryIndexTrendViewModel() {
  const current = industryIndexStore.snapshot();
  const spec = industryIndexCanonicalViewSpec();
  const state = spec ? (liveMarketDataGateway.snapshot(spec) || {}) : {};
  return industryIndexTrendViewModel({
    current,
    state,
    marketRead: spec ? liveMarketDataGateway.readSnapshot(spec) : null,
    frame: spec ? canonicalDisplayFrame(spec.code, state, null, selectionIntentStore.generation) : {},
  });
}

function getTaiexOverlayPoints() {
  return currentTaiexView().points;
}

export async function ensureTaiexOverlayData() {
  try {
    await ensureTaiexCanonicalView();
    return currentTaiexView();
  } catch (error) {
    console.warn("[TAIEX VIEW] canonical snapshot failed", error);
    return currentTaiexView();
  }
}

export async function ensureTrendOverlayData(kind) {
  if (kind === "taiex") return ensureTaiexOverlayData();
  if (kind === "futures") return ensureTxfBenchmarkView();
  return null;
}

export function buildTrendOverlaySeries({ kind = "", variant = "stock", frame = null, timeAxisPolicy = null } = {}) {
  if (variant !== "stock" || !frame) return null;
  const useTaiex = kind === "taiex";
  const useTxf = kind === "futures";
  if (!useTaiex && !useTxf) return null;
  // 期貨 is TXF's DAY of the stock's date (currentTxfBenchmarkView), never the 期貨走勢 tab's session.
  const raw = useTaiex ? getTaiexOverlayPoints() : currentTxfBenchmarkView().points;
  return projectBenchmarkSeries({
    rawPoints: raw,
    stockReference: frame.prevClose,
    benchmarkReference: useTaiex ? displayQuote(currentTaiexView()).reference : currentTxfBenchmarkView().reference,
    strokeStyle: themeColor(useTaiex ? "--chart-benchmark-taiex" : "--chart-benchmark-txf"),
    lineWidth: 2,
    alpha: 0.95,
    targetTimeAxisPolicy: timeAxisPolicy || undefined,
  });
}



const NO_SELECTION_TEXT = "請先在商品列表選擇商品";

// The view's trades as the page reads them. The view state is immutable, so the result is kept until the view's
// trades array is replaced, and each trade's page row is built once and reused by the next array: a frame read it
// three times, and every read copied all 100 trades.
const selectedTickRows = new WeakMap();
let selectedTicksCache = { target: "", trades: null, rows: [] };
function selectedTicks() {
  // TXFR1 intentionally runs Quote-only like TAIEX; Quote snapshots are not
  // transaction details. Legacy historical trade data stays on disk but is not
  // presented as a live subscribed lane.
  const target = detailTargetCode();
  if (!target || target === "TXFR1") return [];
  const trades = stockViewState(target).trades;
  if (selectedTicksCache.target === target && selectedTicksCache.trades === trades) return selectedTicksCache.rows;
  const rows = (Array.isArray(trades) ? trades : []).filter((tick) => !isSimtradeTick(tick)).map((tick) => {
    const known = tick && typeof tick === "object" ? selectedTickRows.get(tick) : null;
    if (known?.target === target) return known.row;
    const row = { ...tick, code: target, volume: tickVolume(tick), trade_origin: tick?.trade_origin || "LIVE_CALLBACK" };
    if (tick && typeof tick === "object") selectedTickRows.set(tick, { target, row });
    return row;
  });
  selectedTicksCache = { target, trades, rows };
  return rows;
}

function selectedFlowTicks() {
  // Restart hydration arrives through the durable TradeDetail page before new
  // live callbacks. Merge it with the hot stream so TradeFlow never falls back
  // to an empty panel merely because the App was reopened after market close.
  const merged = new Map();
  const isGenuineTrade = (row) => positiveNumberOrNull(row?.price ?? row?.current ?? row?.close) != null && Number(tickVolume(row) || 0) > 0;
  for (const row of liveTickPageState.rows || []) if (isGenuineTrade(row)) merged.set(tradeRowKey(row), row);
  for (const row of selectedTicks()) if (isGenuineTrade(row)) merged.set(tradeRowKey(row), { ...(merged.get(tradeRowKey(row)) || {}), ...row });
  return [...merged.values()];
}

function selectedDaemonPriceVolume() {
  const target = detailTargetCode();
  if (!target) return normalizeDaemonPriceVolume({});
  const state = target === "TXFR1"
    ? liveMarketDataGateway.snapshot(txfCanonicalViewSpec(activeTxfSession))
    : liveMarketDataGateway.snapshot(stockCanonicalViewSpec(target));
  // The view's projection only: no second, cached context copy to prefer between.
  return normalizeDaemonPriceVolume(state?.price_volume && typeof state.price_volume === "object" ? state.price_volume : {});
}

function updateOrderbookAdaptiveLayout() {
  return realtimeOrderbookController.update();
}

export function bindOrderbookAdaptiveLayout() {
  return realtimeOrderbookController.bind();
}

function renderOrderbookRatios() {
  realtimeContext.dataSource.invalidate("orderbook", detailSymbolContext());
  updateOrderbookAdaptiveLayout();
}

function buildLiveOrderbookViewModel() {
  const target = detailTargetCode();
  const aggregate = selectedDaemonPriceVolume();
  if (!target) return withMarketRead({ availability: "UNAVAILABLE", message: NO_SELECTION_TEXT, showDepthTotals: true, priceVolumeEmptyText: "等待逐價內外盤資料", ...canonicalDisplayFrame("", {}, null, selectionIntentStore.generation) });
  if (target === "TXFR1") {
    const state = liveMarketDataGateway.snapshot(txfCanonicalViewSpec(activeTxfSession)) || {};
    // The header and the book come from the same canonical view as the read model: an empty tick made the
    // header fall back to Rust B's ladder price, which lags A's quote.
    const summary = state.summary && typeof state.summary === "object" ? state.summary : {};
    const tick = summary;
    const book = { ...(state.orderbook && typeof state.orderbook === "object" ? state.orderbook : {}), diff_renderable: true };
    return { ...FuturesOrderBookAdapter.build({ tick, book, aggregate, readModel: liveMarketDataGateway.readSnapshot({...txfCanonicalViewSpec(activeTxfSession), selectionGeneration:selectionIntentStore.generation}) }), ...canonicalDisplayFrame(target, state, null, selectionIntentStore.generation) };
  }
  const state = liveMarketDataGateway.snapshot(stockCanonicalViewSpec(target)) || {};
  const canonicalSummary = state?.summary && typeof state.summary === "object" ? state.summary : {};
  // The view's book as Market Runtime holds it -- an empty book is empty (no REST context book, no "keep the
  // previous levels"). A level flashes only for a book that came by delta.
  const canonicalBook = state?.orderbook && typeof state.orderbook === "object" ? state.orderbook : {};
  const deltaToken = orderbookDeltaTokens.get(target) || null;
  const selectedBook = { ...canonicalBook, code: target, diff_event_token: deltaToken,
    diff_renderable: Boolean(deltaToken) && deltaToken === orderbookDiffEventToken(canonicalBook) };
  const view = StockOrderBookAdapter.build({
    code: target,
    // Canonical summary owns current/previous-close/change for all selected
    // stock surfaces.  The legacy signal remains only a metadata fallback;
    // otherwise a stale zero pct_chg could overwrite the live 3.55% value
    // while the trend and product list already show the new session quote.
    signal: { ...(getSelectedRealtimeSignal() || {}), ...canonicalSummary },
    book: selectedBook,
    readModel: liveMarketDataGateway.readSnapshot({...stockCanonicalViewSpec(target), selectionGeneration:selectionIntentStore.generation}),
    aggregate,
  });
  return { ...view, ...canonicalDisplayFrame(target, state, null, selectionIntentStore.generation) };
}

function tradeFlowViewSpec(target) {
  return target === "TXFR1" ? txfCanonicalViewSpec(activeTxfSession) : stockCanonicalViewSpec(target);
}

function canonicalLiveTradeFlow(target, state = target ? (liveMarketDataGateway.snapshot(tradeFlowViewSpec(target)) || {}) : {}) {
  if (!target) return null;
  const liveFlow = normalizeRustTradeFlow(state.tradeflow || {});
  // B publishes the recent windows (with their large/small flow) as their own block.
  if (liveFlow) liveFlow.windows = bigOrderFlowWindowsFromRust(state.windows);
  return liveFlow;
}

function buildLiveTradeFlowViewModel() {
  // Exactly one presentation authority: the Market Daemon canonical view.
  // Choosing between canonical and realtime-context projections by sample count
  // allowed the visible flow to alternate as the two async lanes refreshed.
  const target = detailTargetCode();
  const viewState = target ? (liveMarketDataGateway.snapshot(tradeFlowViewSpec(target)) || {}) : {};
  const authoritative = canonicalLiveTradeFlow(target, viewState);
  // Large/Small has exactly one owner: Market Daemon LargeOrderPolicy. Never
  // rebuild a second renderer-side definition from raw Tick volume.
  const targetLabel = target === "TXFR1" ? "台指期" : (target || "所選商品");
  const flow = authoritative?.available
    ? authoritative
    : { ...(authoritative || {}), available: false, sample_count: 0,
      message: target ? `等待 ${targetLabel} Market Daemon 大單投影` : NO_SELECTION_TEXT };
  return {
    availability: flow.available ? "AVAILABLE" : "UNAVAILABLE",
    message: flow.message || "等待 Market Daemon 大單投影",
    flow,
    scopeLabel: `${targetLabel} 當日交易時段`,
    logicalCode: target,
    notePrefix: "Canonical LargeOrderPolicy",
    // The immutable view-state objects `flow` was derived from: the component skips rebuilding when they are unchanged.
    flowSource: [viewState.tradeflow, viewState.windows],
    // 價量: one session bucket's complete large-order list, asked of Rust B (the flow only carries the newest 300).
    queryLargeOrders: target ? (window) => queryRealtimeLargeOrders(tradeFlowViewSpec(target), window) : null,
    // Which partition an answer belongs to: TXFR1's 日盤/夜盤 (and a new trading day) keep the same code.
    largeOrderIdentity: target ? (() => { const spec = tradeFlowViewSpec(target); return `${spec.market}|${spec.code}|${spec.trading_date || ""}|${spec.session || ""}`; })() : "",
    // The view's presentation state (loading / stale) and identity, as on 五檔 and 成交明細. Frames are
    // ordered by the data source's presentation revision.
    ...canonicalDisplayFrame(target, viewState, null, selectionIntentStore.generation),
  };
}

// 價量: the selected instrument's price_volume as Rust B sent it (buckets with their flow arrays and
// flow_fields), plus the current and reference prices for marking rows. One authority: the canonical view.
function buildLivePriceFlowViewModel() {
  const target = detailTargetCode();
  if (!target) return { availability: "UNAVAILABLE", message: NO_SELECTION_TEXT, priceVolume: {} };
  const spec = tradeFlowViewSpec(target);
  const state = liveMarketDataGateway.snapshot(spec) || {};
  const summary = state.summary && typeof state.summary === "object" ? state.summary : {};
  const priceVolume = state.price_volume && typeof state.price_volume === "object" ? state.price_volume : {};
  const label = target === "TXFR1" ? "台指期" : target;
  const price = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null);
  return {
    availability: Array.isArray(priceVolume.buckets) && priceVolume.buckets.length ? "AVAILABLE" : "UNAVAILABLE",
    message: `等待 ${label} 逐價大小單資料`,
    code: target,
    identity: `${spec.market}|${spec.code}|${spec.trading_date || ""}|${spec.session || ""}`,
    priceVolume,
    currentPrice: price(summary.current ?? priceVolume.current_price),
    referencePrice: displayQuote(summary).reference,
  };
}

function buildLiveTrendViewModel(request = {}) {
  const requestedVariant = String(request?.variant || "auto");
  const targetVariant = requestedVariant === "auto"
    ? (activeTrendTarget() === "TAIEX" ? "market" : activeTrendTarget() === "TXF" ? "futures" : "stock")
    : requestedVariant;
  // The exchange-wide breadth row (上漲/下跌/漲停/跌停/平盤) is not part of these view models: every Shioaji trend
  // surface writes it from the breadth store's subscription alone (TrendChartComponent._subscribeLive). Only 產業指數,
  // whose row shows its own index's counts, carries breadth in its view model (industry_index_view_model.js).
  if (targetVariant === "market") return withMarketRead(marketTrendViewModel());
  if (targetVariant === "futures") return withMarketRead(futuresTrendViewModel());
  return withMarketRead(stockTrendViewModel());
}

// 加權走勢: the TAIEX canonical view.
function marketTrendViewModel() {
  const payload = currentTaiexView();
  const state = liveMarketDataGateway.snapshot(taiexCanonicalViewSpec()) || {};
  const marketRead = liveMarketDataGateway.readSnapshot(taiexCanonicalViewSpec());
  const points = payload.points;
  const reference = displayQuote(payload).reference;
  const current = numberOrNull(payload.current ?? payload.price);
  const high = numberOrNull(payload.high ?? payload.day_high);
  const low = numberOrNull(payload.low ?? payload.day_low);
  return {
    marketRead,
    points,
    prevClose: reference,
    openPrice: numberOrNull(payload.open),
    currentPrice: current,
    displayName: "加權指數",
    displayCode: "TAIEX",
    symbol: "TAIEX",
    // 昨收 最高 漲幅 / 開盤 最低 振幅 under the chart.
    stockInfo: { prevClose: reference, open: numberOrNull(payload.open), high, low },
    metrics: {
      limitUp: null,
      limitDown: null,
      ...trendMetrics({ change: payload.change, changePct: payload.change_pct, amplitude: state.summary?.amplitude }),
      // 目前無使用，之後要刪除（加權走勢沒有 N分上漲／N分下跌 列，加權指數沒有模型預測）
      // predictionNotes: {},
    },
    ...canonicalDisplayFrame("TAIEX", state, null, selectionIntentStore.generation),
    options: { adapterType: "taiex" },
  };
}

// 期貨走勢: the active TXF tab.
function futuresTrendViewModel() {
  // The active tab composed from its partitions' views (txfDisplay): always this tab's own axis.
  const snapshot = txfDisplay() || {};
  const state = liveMarketDataGateway.snapshot(txfCanonicalViewSpec(activeTxfSession)) || {};
  const marketRead = liveMarketDataGateway.readSnapshot(txfCanonicalViewSpec(activeTxfSession));
  // txfDisplay carries Market Runtime's comparison price (displayQuote().reference) of the tab's partitions.
  const reference = { price: snapshot.reference_price ?? null, source: snapshot.reference_source ?? null };
  const rawPoints = Array.isArray(snapshot.points) ? snapshot.points : [];
  // A FUT partition is one business session (日盤 reads its DAY, 夜盤 its NIGHT): after the close, Market Runtime's
  // summary of that partition is the session's last price and its 漲跌.
  const current = positiveNumberOrNull(snapshot.current);
  // Without a real TAIFEX reference this is not yet a valid futures chart.
  // Wait instead of drawing once with a fabricated midpoint and rescaling.
  const points = reference.price != null ? rawPoints : [];
  // The chart reads its points from the read model's trend channel (trendReadView), and the TXF view is the whole
  // FULL partition: 夜盤 drew last night's 00:00-05:00 beside tonight's, and an empty 日盤 view model still drew
  // from it. The channel carries exactly the points this tab shows.
  // The row under the chart reads 開盤 / 最高 / 最低 from the quote channel (productQuoteReadView), which is the
  // tab's last partition only: 全日 in the evening is tomorrow's 日盤, not opened yet. The channel carries the tab's
  // own session(s) as txfDisplay composed them.
  const high = positiveNumberOrNull(snapshot.high), low = positiveNumberOrNull(snapshot.low);
  const channels = marketRead?.channels;
  const sessionMarketRead = channels?.trend ? { ...marketRead, channels: { ...channels,
    trend: { ...channels.trend, data: points },
    ...(channels.quote ? { quote: { ...channels.quote, data: { ...(channels.quote.data || {}),
      openPrice: positiveNumberOrNull(snapshot.open), dayHigh: high, dayLow: low } } } : {}),
  } } : marketRead;
  return {
    marketRead: sessionMarketRead,
    points,
    referencePrice: reference.price,
    referenceSource: reference.source,
    referenceType: "futures_reference",
    prevClose: reference.price,
    openPrice: positiveNumberOrNull(snapshot.open),
    symbol: "TXFR1",
    ...canonicalDisplayFrame("TXFR1", state, null, selectionIntentStore.generation),
    displayName: "台指期",
    displayCode: snapshot.contract_code || "TXFR1",
    currentPrice: current,
    // 試撮: the header marks the indicative price "#".
    indicative: Boolean(snapshot.indicative),
    metrics: {
      limitUp: null, limitDown: null,
      // 振幅 is the tab's own range against its reference. 漲跌 is Market Runtime's for the price it shows.
      ...trendMetrics({ change: snapshot.change, changePct: snapshot.change_pct, amplitude: tabAmplitude({ reference: reference.price, high, low }) }),
      // 目前無使用，之後要刪除（期貨走勢的 N分上漲／N分下跌 列已移除 2026-10-16；台指期沒有模型預測）
      // predictionNotes: {},
    },
    contractCode: snapshot.contract_code || null,
    session: activeTxfSession,
    options: {
      adapterType: "futures",
      session: activeTxfSession,
      referenceSource: reference.source,
    },
    emptyOverlayText: reference.price == null ? "等待 Shioaji 台指期參考價" : "等待 TXFR1 走勢資料",
  };
}

// 個股走勢: the selected stock.
function stockTrendViewModel() {
  // Same symbol as 買賣報價 / 成交明細 / 大單流向: the selection, or before any click the detail target -- the stock
  // trend must not stay empty on reopen while the other three panels show the fallback symbol.
  const fallbackDetail = detailTargetCode();
  const code = String(selectedStockCode() || (fallbackDetail !== "TXFR1" ? fallbackDetail : "") || "").trim().toUpperCase();
  // A futures month (a stock's 個股期貨, 台指期／小台指): its own partition on the futures time axis, headed by its
  // product, overlaid with what its product compares to (decisions.md 商品的現貨／期貨與月份).
  const futuresMonth = parseFuturesMonthSymbol(code);
  const product = futuresMonth ? productOfInstrument(code) : code;
  const indexFuture = Boolean(futuresMonth) && !productSides(product).spot;
  // 台指期／小台指 draw the 日／夜／全 chosen (the session trading now until one is chosen); a 個股期貨 its one session.
  const futuresSession = !futuresMonth ? "" : indexFuture ? stockFuturesSessionShown() : stockCanonicalViewSpec(code).session.toLowerCase();
  // One owned copy: every snapshot() structuredClones the whole view (trend + 100 trades).
  const canonicalState = code ? (liveMarketDataGateway.snapshot(stockCanonicalViewSpec(code)) || {}) : {};
  const canonicalSummary = canonicalState.summary || {};
  const marketRead = code ? liveMarketDataGateway.readSnapshot(stockCanonicalViewSpec(code)) : null;
  const signal = getSelectedRealtimeSignal() || {};
  // Already the minute series (see currentTaiexView): read as the view holds it. 台指期／小台指: the chosen session's
  // partitions, oldest first (全日: the night before, then the day).
  const points = indexFuture
    ? futuresMonthTrendSpecs(code, futuresSession).flatMap((spec) => liveMarketDataGateway.snapshot(spec)?.trend || [])
    : (Array.isArray(canonicalState.trend) ? canonicalState.trend : []);
  // 現價 (試撮 included) / 參考價 / 漲跌: the same displayQuote() as 買賣報價 and 商品列 -- Market Runtime's.
  const quote = displayQuote(canonicalSummary);
  const reference = quote.reference;
  const currentPrice = quote.current;
  const high = positiveMarketPrice(canonicalSummary.high ?? canonicalSummary.day_high)
    ?? positiveMarketPrice(signal.high ?? signal.day_high);
  const low = positiveMarketPrice(canonicalSummary.low ?? canonicalSummary.day_low)
    ?? positiveMarketPrice(signal.low ?? signal.day_low);
  const amplitude = numberOrNull(canonicalSummary.amplitude);
  // 漲停/跌停: the official ones (Market Runtime's summary), or none -- never derived from 昨收.
  const limitUp = positiveMarketPrice(canonicalSummary.limit_up ?? signal.limit_up);
  const limitDown = positiveMarketPrice(canonicalSummary.limit_down ?? signal.limit_down);
  const predictions = modelPredictionMetrics(canonicalState.signals);
  // The chart reads its points from the read model's trend channel: an index future's carries the session's.
  const channels = marketRead?.channels;
  const sessionMarketRead = indexFuture && channels?.trend
    ? { ...marketRead, channels: { ...channels, trend: { ...channels.trend, data: points } } } : marketRead;
  return {
    marketRead: sessionMarketRead,
    points,
    symbol: code,
    ...canonicalDisplayFrame(code, canonicalState, null, selectionIntentStore.generation),
    // 個股走勢's 日／夜／全: only for 台指期／小台指.
    futuresSessionControl: indexFuture ? { active: futuresSession } : null,
    displayName: resolveInstrumentDisplayName("shioaji", code, canonicalSummary.name,
      canonicalSummary.stock_name, signal.name, signal.stock_name) || (code ? "個股" : NO_SELECTION_TEXT),
    displayCode: futuresDisplayCode(code),
    // The overlay is the product type's, not a switch: a stock and 台指期／小台指 compare to 加權 (none at night: 加權
    // does not trade), a 個股期貨 to 台指期's DAY.
    benchmark: !futuresMonth ? "taiex" : futuresSession === "night" ? "off" : indexFuture ? "taiex" : "futures",
    currentPrice,
    indicative: quote.indicative,
    prevClose: reference,
    referencePrice: reference,
    openPrice: positiveMarketPrice(canonicalSummary.open) ?? positiveMarketPrice(signal.open),
    metrics: {
      limitUp,
      limitDown,
      change: quote.change,
      changePct: quote.changePct,
      amplitude,
      // Model predictions come only from the validated model_predictions on this symbol's signals
      // channel, one cell per horizon it carries; 1 minute is not a model prediction horizon.
      ...predictions.metrics,
      predictionNotes: predictions.notes,
    },
    options: { ...(futuresMonth ? { adapterType: "futures", session: futuresSession } : { adapterType: "equity" }),
      referenceSource: canonicalSummary.reference_source || signal.reference_source || "stock_canonical_summary",
      // 盤中事件 of this stock on its own line (the 歷史回放 marker vocabulary), switched by the chart's toggle.
      eventMarkers: stockTrendEventMarkersVisible() ? liveEventMarkers(getLiveMonitorEvents(), { code, points }) : [],
      eventMarkersVisible: stockTrendEventMarkersVisible() },
  };
}

// The chart's 盤中事件 toggle redraws the stock trend at once (markers on/off). Owned by the page's scope (init and
// resume), so a disposed page holds no listener.
export function ownEventMarkerToggle() {
  viewResources.own(subscribeStockTrendEventMarkers(
    () => invalidateLiveTrendComponents({ symbol: selectedStockCode() }, ["trendChart", "stockTrend"])));
}

function buildLiveEventFeedViewModel() {
  return liveEventFeedViewModel({ watchPages, selectedSymbol: selectedStockCode(),
    selectedName: resolveInstrumentDisplayName("shioaji", selectedStockCode(), getSelectedRealtimeSignal()?.name) });
}


function buildLiveTickDetailsViewModel() {
  return withMarketRead(liveTickDetailsViewModel());
}

function liveTickDetailsViewModel() {
  const target = detailTargetCode();
  if (liveTickPageState.target !== target) {
    resetLiveTickPageState(target);
  }
  // Large-order badges use the same sole authority as the TradeFlow panel so
  // their threshold cannot flicker between two products or projections.
  const largeOrderFlow = canonicalLiveTradeFlow(target);
  const isLargeRow = largePrintMatcher(largeOrderFlow);
  // Market Runtime's comparison price (displayQuote().reference): the one baseline every price on the tape is
  // coloured against.
  const referencePrice = target === "TXFR1"
    ? (txfDisplay()?.reference_price ?? null)
    : displayQuote(liveMarketDataGateway.snapshot(stockCanonicalViewSpec(target))?.summary || {}).reference;

  const page = Math.max(1, Number(liveTickPageState.page) || 1);
  let selected = [];
  if (page === 1) {
    // Live hot-cache and durable Page1 share one row contract.  Hot rows win on
    // duplicate identity so the newest Tick fields appear instantly.
    const merged = new Map();
    const txfIdentity = target === "TXFR1" ? currentTxfDisplayIdentity(activeTxfSession) : null;
    for (const row of liveTickPageState.rows) {
      if (txfIdentity && !txfTickMatchesDisplayWindow(row, txfIdentity)) continue;
      if (isTapePrint(row)) merged.set(tradeRowKey(row), row);
    }
    for (const row of selectedTicks()) {
      if (txfIdentity && !txfTickMatchesDisplayWindow(row, txfIdentity)) continue;
      if (!isTapePrint(row)) continue;
      const key = tradeRowKey(row);
      const durable = merged.get(key) || {};
      // Hot WebSocket rows own the newest trade fields, while the durable
      // projection supplies the durable Tick identity while hot WebSocket rows own the newest Tick fields.
      merged.set(key, { ...durable, ...row });
    }
    selected = [...merged.values()].sort(compareTradeRowsNewestFirst).slice(0, TRADE_DETAIL_PAGE_SIZE);
  } else {
    const txfIdentity = target === "TXFR1" ? currentTxfDisplayIdentity(activeTxfSession) : null;
    selected = liveTickPageState.rows.filter((row) => (
      !isSimtradeTick(row) && (!txfIdentity || txfTickMatchesDisplayWindow(row, txfIdentity))
    )).slice(0, TRADE_DETAIL_PAGE_SIZE);
  }
  const rows = selected.map((tick) => tapeRow(tick, isLargeRow(tick)));
  const liveNewest = Math.max(...selectedTicks().map((row) => Number(tradeRowSequence(row) || 0)), 0);
  const canonicalFrame = canonicalDisplayFrame(target, target === "TXFR1"
    ? (liveMarketDataGateway.snapshot(txfCanonicalViewSpec(activeTxfSession)) || {})
    : (liveMarketDataGateway.snapshot(stockCanonicalViewSpec(target)) || {}), liveNewest, selectionIntentStore.generation);
  return {
    availability: rows.length ? "AVAILABLE" : "UNAVAILABLE", rows, referencePrice, ...tapeLimitPrices(target),
    referenceSource: target === "TXFR1" ? (txfDisplay()?.reference_source || null) : "prev_close",
    emptyText: !target ? NO_SELECTION_TEXT : "等待即時成交",
    marketRead: liveMarketDataGateway.readSnapshot({... (target === "TXFR1" ? txfCanonicalViewSpec(activeTxfSession) : stockCanonicalViewSpec(target)), selectionGeneration:selectionIntentStore.generation}, {trades:rows}),
    page, pageSize: TRADE_DETAIL_PAGE_SIZE, totalCount: liveTickPageState.bootstrapReady ? liveTickPageState.totalCount : rows.length,
    totalPages: liveTickPageState.totalPages || 1, snapshotWatermark: liveTickPageState.snapshotWatermark || liveNewest,
    ...canonicalFrame,
    // Durable-page loading and canonical snapshot loading are independent.
    // Either may still be catching up, while existing rows remain visible.
    loading: Boolean(liveTickPageState.loading || canonicalFrame.loading), logicalCode: target,
    largeOrderDefinition: largeOrderDefinition(largeOrderFlow),
    source: page === 1 ? "live_hot_cache+trade_detail_materialized" : "trade_detail_materialized",
  };
}

// 技術分析: the selected stock's minute trend and Rust B's fixed K bars (the `day` channel), on a view of their own
// so the product rows' shared stock view keeps its channel set.
export function technicalAnalysisService() {
  return technicalViewService({
    gateway: liveMarketDataGateway,
    baseSpec: (code) => stockCanonicalViewSpec(code),
    sessionDate: (code) => stockCanonicalViewSpec(code).trading_date || "",
    onKeyChange(listener) {
      equityDateListeners.add(listener);
      return () => equityDateListeners.delete(listener);
    },
  });
}

export function registerLiveViewModelResolvers() {
  realtimeContext.dataSource.setResolver("orderbook", buildLiveOrderbookViewModel);
  realtimeContext.dataSource.setResolver("tradeFlow", buildLiveTradeFlowViewModel);
  realtimeContext.dataSource.setResolver("priceFlow", buildLivePriceFlowViewModel);
  realtimeContext.dataSource.setResolver("trendChart", buildLiveTrendViewModel);
  realtimeContext.dataSource.setResolver("marketTrend", (request) => buildLiveTrendViewModel({ ...request, variant: "market" }));
  realtimeContext.dataSource.setResolver("futuresTrend", (request) => buildLiveTrendViewModel({ ...request, variant: "futures" }));
  realtimeContext.dataSource.setResolver("stockTrend", (request) => buildLiveTrendViewModel({ ...request, variant: "stock" }));
  realtimeContext.dataSource.setResolver("industryIndexTrend", buildIndustryIndexTrendViewModel);
  realtimeContext.dataSource.setResolver("eventFeed", buildLiveEventFeedViewModel);
  realtimeContext.dataSource.setResolver("tickDetails", buildLiveTickDetailsViewModel);
}
