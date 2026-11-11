// Per-symbol live data wiring for one workspace column. Reuses the exact
// same primitives the main product-detail page uses -- MarketDataGateway,
// StockOrderBookAdapter, createRealtimeTradeDetailController,
// realtime_market_math.js's pure helpers, trend_overlay.js's
// projectBenchmarkSeries -- so trend/orderbook/tick-details semantics stay
// identical, just re-bound to this column's own symbol instead of the main
// page's single global selection. Each column reads its own view's state (the store's) through its own
// context and data source, which is what gives per-symbol isolation: two columns never read each other's data.
import { StockOrderBookAdapter } from "../../core/orderbook_adapters.js";
import { compareTradeRowsNewestFirst, tradeRowKey } from "../../core/trade_row_order.js";
import { resolveInstrumentDisplayName } from "../../core/instrument_names.js";
import { projectBenchmarkSeries } from "../../core/trend_overlay.js";
import { createRealtimeTradeDetailController, TRADE_DETAIL_PAGE_SIZE } from "../../market_data/trade_detail_controller.js";
import { isSimtradeTick, tickVolume, tickTime, canonicalTradeSide, canonicalDisplayFrame, normalizeDaemonPriceVolume } from "../../market_data/realtime_market_math.js";
import { positiveNumberOrNull, numberOrNull } from "../../core/numbers.js";
import { withMarketRead } from "../../core/market_read_adapters.js";
import { INDEX_FUTURE_PRODUCTS, stockCanonicalViewSpec } from "../../market_data/stock_view_spec.js";
import { parseFuturesMonthSymbol, shioajiMarketOf } from "../../market_data/futures_symbol.js";
import { formatMoomooDisplaySymbol } from "../../market_data/moomoo_symbol.js";
import { displayQuote } from "../../core/auction_price.js";
import { themeColor } from "../../core/market_palette.js";

export class WorkspaceColumn {
  constructor({ code, tradingDate, futuresPartition = null, gateway, apiGet, context, benchmarkSource, eventOptions = () => ({}) }) {
    this.code = String(code || "").trim().toUpperCase();
    this.isFutu = this.code.includes(".");
    this.isFutures = !this.isFutu && shioajiMarketOf(this.code) === "FUT";
    this.eventOptions = eventOptions;
    this.context = context;
    this.gateway = gateway;
    this.benchmarkSource = benchmarkSource;
    // Frozen: the view store keys a frozen spec once (every read of this column's view goes through it).
    this.spec = Object.freeze(stockCanonicalViewSpec(this.code, tradingDate, futuresPartition));
    this.disposed = false;

    context.symbolStore.setSelectedSymbol(this.code);
    context.dataSource.setResolver("trendChart", () => this.buildTrendViewModel());
    context.dataSource.setResolver("orderbook", () => this.buildOrderbookViewModel());
    context.dataSource.setResolver("tickDetails", () => this.buildTickDetailsViewModel());
    // This column's isolation comes from owning a separate context / data source per column; its frames are ordered
    // by that data source's presentation revision.
    context.services.trendOverlays = {
      ensure: (kind) => benchmarkSource.ensure(kind === "taiex" ? "taiex" : "txf"),
      // Each benchmark arrival redraws the overlays, however late it is.
      subscribe: (listener) => benchmarkSource.subscribe?.(listener) || (() => {}),
      build: ({ kind, variant, frame } = {}) => {
        if (variant !== "stock" || !frame) return null;
        const benchmarkKind = kind === "taiex" ? "taiex" : "txf";
        return projectBenchmarkSeries({
          rawPoints: benchmarkSource.points(benchmarkKind),
          stockReference: frame.prevClose,
          benchmarkReference: benchmarkSource.referencePrice(benchmarkKind),
          strokeStyle: themeColor(benchmarkKind === "taiex" ? "--chart-benchmark-taiex" : "--chart-benchmark-txf"),
        });
      },
    };

    this.pager = createRealtimeTradeDetailController({
      apiGet,
      // The view's own identity once it has one: a futures month's contract and WAL day are Market Runtime's.
      getQuery: () => {
        const key = this.viewState()?.session_key || {};
        const { market, session } = this.spec;
        const date = String(key.trading_date || this.spec.trading_date || "").slice(0, 10);
        const actualContract = String(key.contract_code || this.code).trim().toUpperCase();
        return { target: this.code, market, session, tradingDate: date, actualContract, requestIdentityKey: `${market}|${this.code}|${date}|${session}|${actualContract}` };
      },
      getEquityDate: () => this.spec.trading_date,
      futuresIdentityMatches: () => true,
      invalidateDetails: () => this.context.dataSource.invalidate("tickDetails"),
    });
    // Each subscription has its own generation: an event the store had already queued for the previous
    // date's view lands after setTradingDate() cleared the column and must not fill it back in.
    this.viewGeneration = 1;
    this.unsubscribeView = gateway.subscribe(this.spec, (event) => this.handleEvent(event, 1));
    this.ensureBenchmark();
    if (!this.isFutu) this.pager.load({ page: 1, latest: true }).catch((error) => console.warn("[workspace column: loading the first trade page] failed", error));
  }

  // The column's market facts are its view's state, read when drawn: it kept its own trades, book,
  // trend and summary copies merged from the same events (and never took B's minutes.upsert). Null until the view's
  // first snapshot.
  viewState() {
    return this.gateway.snapshot(this.spec);
  }

  get summary() {
    const summary = this.viewState()?.summary;
    return summary && typeof summary === "object" ? summary : {};
  }

  // The benchmark drawn over this column follows its product type: a stock's is 加權; a 個股期貨's is 台指期, 台指期／小台指's
  // 加權 and, at night when 加權 is closed, none; a US product's none.
  benchmark() {
    if (this.isFutu) return "off";
    if (!this.isFutures) return "taiex";
    if (this.spec.session === "NIGHT") return "off";
    return INDEX_FUTURE_PRODUCTS.has(parseFuturesMonthSymbol(this.code)?.category) ? "taiex" : "futures";
  }

  ensureBenchmark() {
    const benchmark = this.benchmark();
    if (benchmark === "off") return;
    this.benchmarkSource.ensure(benchmark === "taiex" ? "taiex" : "txf")
      .catch((error) => console.warn("[workspace column: loading its benchmark] failed", this.code, error));
  }

  // The session moved: a stock's column to the next trading day, a futures month's between its partitions.
  setSession({ tradingDate, futuresPartition = null }) {
    if (this.disposed || this.isFutu) return;
    const next = stockCanonicalViewSpec(this.code, String(tradingDate || "").slice(0, 10), futuresPartition);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next.trading_date)) return;
    if (next.trading_date === this.spec.trading_date && next.session === this.spec.session) return;
    if (!this.isFutures && next.trading_date < this.spec.trading_date) return;
    this.unsubscribeView?.();
    this.spec = Object.freeze(next);
    this.pager.reset(this.code);
    this.controlState = null;
    const generation = ++this.viewGeneration;
    this.unsubscribeView = this.gateway.subscribe(this.spec, event => this.handleEvent(event, generation));
    this.ensureBenchmark();
    for (const name of ["trendChart", "orderbook", "tickDetails"]) this.context.dataSource.invalidate(name);
    if (!this.isFutu) this.pager.load({ page: 1, latest: true }).catch((error) => console.warn("[workspace column: loading the first trade page] failed", error));
  }

  // A view with state carries the store's own presentation fields (status, error, stale); before its first
  // snapshot the last control event (error / gap) is all the column knows of it.
  displayFrame(state = this.viewState()) {
    return canonicalDisplayFrame(this.code, state || this.controlState || {});
  }

  refreshTrend() {
    if (!this.disposed) this.context.dataSource.invalidate("trendChart");
  }

  refreshFreshness() {
    if (this.disposed) return;
    for (const name of ["trendChart", "orderbook", "tickDetails"]) this.context.dataSource.invalidate(name);
  }

  handleEvent(event = {}, generation = this.viewGeneration) {
    if (this.disposed || generation !== this.viewGeneration) return;
    if (!["snapshot", "batch", "delta"].includes(event.type)) {
      // The canonical store owns freshness; control events must also repaint.
      this.controlState = { presentation_state: event.entry?.presentation_state,
        view_status: event.entry?.status, view_error: event.error || event.entry?.last_error };
      this.refreshFreshness();
      return;
    }
    // A snapshot replaces the view's state and a delta changes it, in the store; the column redraws only the
    // components whose channels changed (a snapshot redraws all three).
    if (event.type === "snapshot") {
      this.controlState = null;
      this.lastReference = displayQuote(this.summary || {}).reference;
      for (const name of ["trendChart", "orderbook", "tickDetails"]) this.context.dataSource.invalidate(name);
      return;
    }
    const changed = new Set(event.changedChannels || [event.changedChannel]);
    const redraw = new Set();
    if (changed.has("trend")) redraw.add("trendChart");
    if (changed.has("orderbook") || changed.has("tradeflow") || changed.has("price_volume")) redraw.add("orderbook");
    if (changed.has("trades")) redraw.add("tickDetails");
    if (changed.has("summary")) {
      redraw.add("trendChart");
      redraw.add("orderbook");
      // 成交明細 colours its prices against the reference: a summary change matters to it only when that moved.
      const reference = displayQuote(this.summary || {}).reference;
      if (reference !== this.lastReference) redraw.add("tickDetails");
      this.lastReference = reference;
    }
    for (const name of redraw) this.context.dataSource.invalidate(name);
  }

  /** 漲停/跌停: Market Runtime's (the contract's official ones), or none -- never derived from 昨收. */
  limitPrices(summary = this.summary) {
    if (this.isFutu) return { up: null, down: null };
    return { up: positiveNumberOrNull(summary?.limit_up), down: positiveNumberOrNull(summary?.limit_down) };
  }

  // Each view model reads the column's view once (a read is a lookup and a copy of the state's top level).
  buildOrderbookViewModel() {
    const state = this.viewState();
    const summary = state?.summary && typeof state.summary === "object" ? state.summary : {};
    const view = StockOrderBookAdapter.build({
      code: this.code,
      signal: summary,
      book: { ...(state?.orderbook || {}), diff_renderable: true },
      // The view's 價量 projection: Rust B's 內外盤 totals for the bar, as on the main page.
      aggregate: normalizeDaemonPriceVolume(state?.price_volume && typeof state.price_volume === "object" ? state.price_volume : {}),
      readModel: this.gateway.readSnapshot(this.spec),
    });
    const limits = this.limitPrices(summary);
    view.limitUp = view.limitUp ?? limits.up;
    view.limitDown = view.limitDown ?? limits.down;
    return { ...view, ...this.displayFrame(state) };
  }

  buildTrendViewModel() {
    const state = this.viewState();
    const summary = state?.summary && typeof state.summary === "object" ? state.summary : {};
    // The view store keeps the trend as the normalized minute series; it is read as it is.
    const points = Array.isArray(state?.trend) ? state.trend : [];
    const openPrice = numberOrNull(summary?.open);
    // 現價 (試撮 included) / 昨收: the same displayQuote() as 買賣報價 and 商品列.
    const quote = displayQuote(summary);
    const current = quote.current;
    const prevClose = quote.reference;
    const limits = this.limitPrices(summary);
    return withMarketRead({
      ...this.displayFrame(state),
      points,
      prevClose,
      openPrice,
      currentPrice: current,
      indicative: quote.indicative,
      // The header's 漲停/跌停 marking and 漲跌 (Market Runtime's); the chart-only workspace has no metric rows.
      metrics: { limitUp: limits.up, limitDown: limits.down, change: quote.change, changePct: quote.changePct },
      displayName: resolveInstrumentDisplayName(
        this.spec?.source || "shioaji", this.code, summary?.name, summary?.stock_name),
      displayCode: this.isFutu ? formatMoomooDisplaySymbol(this.code) : this.code,
      symbol: this.code,
      benchmark: this.benchmark(),
      options: { ...(this.isFutures ? { adapterType: "futures", session: this.spec.session.toLowerCase() } : { adapterType: "equity" }),
        ...this.eventOptions(this.code, points) },
    }, this.gateway.readSnapshot(this.spec));
  }

  buildTickDetailsViewModel() {
    const pagerState = this.pager.state;
    const state = this.viewState();
    const summary = state?.summary && typeof state.summary === "object" ? state.summary : {};
    const trades = Array.isArray(state?.trades) ? state.trades : [];
    // Workspace deliberately has no historical page switching. Merge the durable latest page with hot rows and keep
    // one fixed recent-100 window -- redone only when the page or the view's trades changed (both are replaced, never
    // modified), not on every summary or freshness redraw.
    let mapped = this.tickRows?.pageRows === pagerState.rows && this.tickRows?.trades === trades ? this.tickRows.mapped : null;
    if (!mapped) {
      const merged = new Map(pagerState.rows.map((row) => [tradeRowKey(row), row]));
      for (const row of trades) {
        if (isSimtradeTick(row)) continue;
        const key = tradeRowKey(row);
        merged.set(key, { ...(merged.get(key) || {}), ...row });
      }
      const rows = [...merged.values()]
        .sort(compareTradeRowsNewestFirst)
        .slice(0, TRADE_DETAIL_PAGE_SIZE);
      mapped = rows.map((tick) => ({
        time: tickTime(tick),
        price: numberOrNull(tick?.price ?? tick?.current ?? tick?.close),
        volume: Number(tickVolume(tick) || 0),
        tradeSide: canonicalTradeSide(tick),
        ingestSequence: tick?.ingest_sequence ?? tick?.ingestSequence ?? null,
      }));
      this.tickRows = { pageRows: pagerState.rows, trades, mapped };
    }
    const referencePrice = displayQuote(summary || {}).reference;
    const limits = this.limitPrices(summary);
    const frame = this.displayFrame(state);
    return withMarketRead({
      ...frame,
      availability: mapped.length ? "AVAILABLE" : "UNAVAILABLE",
      rows: mapped,
      limitUp: limits.up,
      limitDown: limits.down,
      loading: Boolean(pagerState.loading || frame.loading),
      logicalCode: this.code,
      referencePrice,
      emptyText: pagerState.loading ? "成交明細載入中…" : "等待即時成交",
    // The table reads its rows from the read model (tradesReadView): these merged, newest-first rows, as the main page
    // passes its own. Without them the model carried the view's raw trades, kept oldest first, and the newest print was
    // drawn at the bottom.
    }, this.gateway.readSnapshot(this.spec, { trades: mapped }));
  }

  dispose() {
    this.disposed = true;
    this.unsubscribeView?.();
    this.unsubscribeView = null;
    this.pager.dispose();
    this.context.destroy();
  }
}
