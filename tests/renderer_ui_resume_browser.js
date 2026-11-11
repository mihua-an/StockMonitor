// Browser integration fixture: only synthetic local responses; no broker/API connection.
export async function checkResume(base, realtimeHtml, historyHtml, selectedSymbol, watchCodes = ['2344', '2330']) {
  localStorage.clear();
  localStorage.setItem('shioajiMarketPanelUiStateV1', JSON.stringify({ activeTrendMarket: 'stock', selectedSymbol }));
  const date = '2026-10-02';
  // Market Runtime's session.current, pushed on the connection (the status read carries no session).
  const display = { equity: { trading_date: date, live: false, phase: 'CLOSED' }, futures: {} };
  window.desktopAPI = {
    sourceSettings: { enabled_sources: ['shioaji'], sources: {} },
    networkManifest: { services: { test: { url: 'http://fixture.invalid' } }, routes: [['/api/', 'test']] },
    liveEngineConnection: { url: 'ws://fixture.invalid', expected: { service_id: 'market_runtime', protocol: 2 } },
    loadWatchPagesLocal: async () => ({ pages: [{ id: 'test', name: 'test', market: 'tw', codes: watchCodes, items: watchCodes.map(code => ({ code, name: `fixture${code}` })) }] }),
  };
  const originalFetch = window.fetch;
  window.fetch = async (url, options) => {
    if (String(url).startsWith('file:')) return originalFetch(url, options);
    const path = new URL(url).pathname;
    let value = { ok: true, pages: [], rows: [], points: [], events: [], dates: [], items: [], ticks: [] };
    if (path === '/api/status') value = { ok: true, broker_status: { daemon_reachable: true, shioaji_connected: true, readiness: { connected: true, market_data_ready: true } } };
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  };
  let version = 1;
  const subscriptions = new Map();
  const requests = [];
  let socket = null;
  class FixtureSocket extends EventTarget {
    static OPEN = 1; static CONNECTING = 0;
    constructor() { super(); socket = this; this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); this.reply('session.current', display); }); }
    reply(type, payload) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type, payload }) })); }
    snapshot(spec, subscription_id) {
      const price = version === 1 ? 179 : 181;
      // Market Runtime's summary as it is sent (wire.rs summary): its change / change_pct are the one 漲跌 the
      // headers show and colour by.
      const change = price - 180;
      return {
        ...spec, subscription_id, protocol_version: 1, session_key: { market: spec.market, logical_code: spec.code, trading_date: spec.trading_date, session: spec.session },
        stream_id: 'fixture', daemon_instance_id: 'fixture', watermark: version * 100, session_generation: 1,
        summary: { code: spec.code, trading_date: spec.trading_date, current: price, prev_close: 180, reference_price: 180, change, change_pct: change / 180 * 100, change_pct_unit: 'percent', open: 180, high: 182, low: 178, total_volume: 1200 },
        trend: [{ minute: 600, timestamp: `${date}T10:00:00+08:00`, price, close: price, volume: 10 }],
        trades: [{ ingest_sequence: version, datetime: `${date}T10:00:00+08:00`, price, volume: 10, trade_side: 'SELL' }],
        orderbook: { bids: [{ price: price - 0.5, volume: 20 }], asks: [{ price: price + 0.5, volume: 30 }], bid_prices: [price - 0.5], bid_volumes: [20], ask_prices: [price + 0.5], ask_volumes: [30] },
        windows: { windows: { '1': { change_pct: version }, '3': { change_pct: version + 1 }, '5': { change_pct: version + 2 } } },
        tradeflow: { sample_count: 10 * version, cumulative: { large: { buy: 50 * version, sell: 20 * version, net: 30 * version }, small: { buy: 10, sell: 5, net: 5 } }, minute_series: [{ minute: 600, time: '10:00', large: { buy: 50 * version, sell: 20 * version, net: 30 * version }, small: { buy: 10, sell: 5, net: 5 }, cumulative: { large: { buy: 50 * version, sell: 20 * version, net: 30 * version }, small: { buy: 10, sell: 5, net: 5 } } }], large_orders: [] },
        price_volume: {}, signals: {}, events: [],
      };
    }
    send(raw) {
      const message = JSON.parse(raw); requests.push(message);
      const spec = message.payload || {};
      if (message.type === 'view.subscribe') {
        const id = `fixture-${requests.length}`; subscriptions.set(id, spec);
        queueMicrotask(() => {
          this.reply('view.subscription.accepted', { request_id: spec.request_id, subscription_id: id, stream_id: 'fixture' });
          this.reply('view.snapshot', this.snapshot(spec, id));
        });
      } else if (message.type === 'focus.set') queueMicrotask(() => this.reply('focus.set.ack', { ...spec, ok: true, generation: requests.length }));
      // The window subscribes only once Market Runtime's health says it serves (realtime.js beginServing).
      else if (message.type === 'health') queueMicrotask(() => this.reply('health', { status: 'serving', service_id: 'market_runtime', protocol: 2 }));
      // A view is closed by its subscription id, or by the subscribe request that opened it (a cancel sent before the reply).
      else if (message.type === 'view.unsubscribe') {
        for (const [id, opened] of subscriptions) if (id === spec.subscription_id || (!spec.subscription_id && opened.request_id === spec.request_id)) subscriptions.delete(id);
      }
      else if (message.type === 'view.snapshot' || message.type === 'view.resync') {
        const entry = [...subscriptions].find(([id]) => id === spec.subscription_id);
        if (entry) queueMicrotask(() => this.reply('view.snapshot', { ...this.snapshot(entry[1], entry[0]), request_id: spec.request_id }));
      }
    }
    close() { this.readyState = 3; }
  }
  window.WebSocket = FixtureSocket;
  const { appState } = await import(`${base}js/core/state.js`);
  // The product row's summary is the view store's: read it through the one reader, not a page copy.
  const { productSummaryOf } = await import(`${base}js/features/realtime/product_summary_reader.js`);
  const { realtimeContext, replayHistoryContext } = await import(`${base}js/core/dashboard_context.js`);
  const { startRealtimeStream, subscribeRealtimeView } = await import(`${base}js/market_data/realtime.js`);
  const runtime = await import(`${base}js/pages/realtime.js`);
  await import(`${base}js/dashboard_components.js`);
  const dashboard = await import(`${base}js/core/dashboard_runtime.js`);
  // Empty replay views, through the data boundary like every market view (they carry a read model).
  const { withMarketRead } = await import(`${base}js/core/market_read_adapters.js`);
  for (const id of ['trendChart', 'orderbook', 'tickDetails', 'tradeFlow', 'technicalAnalysis', 'eventFeed', 'tradeDetails']) replayHistoryContext.dataSource.setResolver(id, () => withMarketRead({}));
  const { renderRealtimeQuoteTable } = await import(`${base}js/features/realtime/realtime_presentation.js`);
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => requestAnimationFrame(resolve)); };
  const main = document.querySelector('main');
  main.innerHTML = realtimeHtml;
  const size = () => { const el = main.querySelector('.realtime-workspace'); if (el) { el.style.width = '1900px'; el.style.height = '720px'; } };
  size(); startRealtimeStream();
  await runtime.initRealtimePage(); await settle();
  if (selectedSymbol) realtimeContext.symbolStore.setSelectedSymbol(selectedSymbol);
  dashboard.selectDashboardTab('realtime', 'topAuxiliary', 'tradeFlow'); await settle();
  const capture = () => ({
    selected: runtime.getLiveMarketDataDiagnostics().selectionIntent.state,
    summary: productSummaryOf('2344'),
    stock: realtimeContext.dataSource.resolve('stockTrend'),
    book: realtimeContext.dataSource.resolve('orderbook'),
    flow: realtimeContext.dataSource.resolve('tradeFlow'),
    stockPrevClose: main.querySelector('[data-role="stock-prev-close"]')?.textContent,
    stockTitle: main.querySelector('[data-pane-id="pane-default-bl1"] .quote-main-price')?.className,
    bookTitle: main.querySelector('[data-pane-id="pane-default-bl2"] [data-role="summary-price"]')?.className,
    bookPrices: [...main.querySelectorAll('[data-pane-id="pane-default-bl2"] .orderbook-price-value')].filter(el => el.textContent !== '--').map(el => ({ text: el.textContent, color: el.className })),
    flowText: main.querySelector('[data-pane-id="pane-default-br1"] [data-role="flow-content"]')?.textContent,
    productRow: main.querySelector('tr[data-realtime-code="2344"]')?.textContent,
    grid: main.querySelector('[data-role="tick-scroll"]')?.classList.contains('standard-data-grid'),
    subscribedStocks: [...subscriptions.values()].filter(spec => spec.market === 'STK').map(spec => spec.code).sort(),
  });
  const compact = record => ({ selected: record.selected.selectedSymbol, summary: { current: record.summary?.current, windows: [record.summary?.chg_1m, record.summary?.chg_3m, record.summary?.chg_5m] }, stockReference: record.stock.referencePrice ?? record.stock.reference, bookReference: record.book.prevClose, flowAvailable: record.flow.flow?.available, flowSamples: record.flow.flow?.sample_count, stockPrevClose: record.stockPrevClose, stockTitle: record.stockTitle, bookTitle: record.bookTitle, bookPrices: record.bookPrices, flowText: record.flowText?.slice(0, 160), productRow: record.productRow, grid: record.grid, subscribedStocks: record.subscribedStocks, bookMessage: record.book.message, flowMessage: record.flow.message, stockName: record.stock.displayName });
  const initial = capture();
  const cycles = [];
  for (let i = 0; i < 3; i++) {
    runtime.setRealtimePageVisible(false);
    const cache = document.createDocumentFragment(); cache.append(...main.childNodes);
    main.innerHTML = historyHtml;
    appState.currentPage = 'history';
    dashboard.mountDashboardPage({ pageId: 'history', context: replayHistoryContext });
    // Replay/other pages can evict the live cache (64 entries / five minutes).
    // Returning must restore subscriptions even when there is no cached view.
    const releases = Array.from({ length: 70 }, (_, index) => subscribeRealtimeView({ market: 'STK', code: String(5000 + index), trading_date: date, session: 'DAY', channels: ['summary'] }, () => {}));
    await Promise.resolve(); await Promise.resolve();
    releases.forEach(release => release());
    dashboard.destroyDashboardPage('history');
    version++;
    // Views outlive the page: the market moved while the page was away, and Market Runtime pushes the held
    // views' new state as a forward re-snapshot -- nothing is re-subscribed on return.
    for (const [id, spec] of subscriptions) socket.reply('view.snapshot', socket.snapshot(spec, id));
    main.replaceChildren(cache); appState.currentPage = 'realtime'; renderRealtimeQuoteTable(); runtime.resumeRealtimePage(); await settle();
    cycles.push(capture());
  }
  runtime.disposeRealtimePage();
  return { initial: compact(initial), cycles: cycles.map(compact), requests: requests.filter(message => ['workspace.replace', 'view.subscribe'].includes(message.type) && (!message.payload.code || Number(message.payload.code) < 5000 || Number.isNaN(Number(message.payload.code)))).map(message => ({ type: message.type, code: message.payload.code, codes: message.payload.codes })) };
}
