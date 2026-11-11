// Offline render benchmark, run inside an Electron window by run.cjs. The real 即時報價 page is mounted against a
// fixture WebSocket that answers every view.subscribe with a full-day snapshot and then pushes view.delta.batch
// frames at an opening-burst rate. Nothing reaches a broker, Market Runtime or any API.
export async function runBench(base, realtimeHtml, options) {
  const { codes: codeCount = 83, selected = "2330", seconds = 20, warmupSeconds = 3,
    watchRate = 300, selectedTradeRate = 30, selectedBookRate = 20, batchMs = 25 } = options || {};
  localStorage.clear();
  localStorage.setItem("shioajiMarketPanelUiStateV1", JSON.stringify({ activeTrendMarket: "stock", selectedSymbol: selected }));
  const date = "2026-10-14";
  const codes = [selected, ...Array.from({ length: codeCount - 1 }, (_, i) => String(1101 + i * 7))];
  // Market Runtime's session.current, pushed on the connection (the status read carries no session).
  const display = { equity: { trading_date: date, live: true, session: "DAY", phase: "LIVE" }, futures: {} };
  window.desktopAPI = {
    sourceSettings: { enabled_sources: ["shioaji"], sources: {} },
    networkManifest: { services: { test: { url: "http://fixture.invalid" } }, routes: [["/api/", "test"]] },
    liveEngineConnection: { url: "ws://fixture.invalid", expected: { service_id: "market_runtime", protocol: 2 } },
    loadWatchPagesLocal: async () => ({ pages: [{ id: "bench", name: "bench", market: "tw", codes, items: codes.map((code) => ({ code, name: `bench${code}` })) }] }),
  };
  const originalFetch = window.fetch;
  window.fetch = async (url, init) => {
    if (String(url).startsWith("file:")) return originalFetch(url, init);
    const path = new URL(url).pathname;
    let value = { ok: true, pages: [], rows: [], points: [], events: [], dates: [], items: [], ticks: [] };
    if (path === "/api/status") value = { ok: true, broker_status: { daemon_reachable: true, shioaji_connected: true, readiness: { connected: true, market_data_ready: true } } };
    return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
  };

  // Deterministic pseudo-random stream: every run of the same options sends the same frames.
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const iso = (minute, second = 0) => `${date}T${String(9 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:${String(second).padStart(2, "0")}+08:00`;
  const START_MINUTE = 180; // 12:00: a long trend is already on screen
  const market = new Map(codes.map((code, i) => [code, { price: 50 + i * 3, volume: 100000, seq: 0, trades: 0 }]));
  const quoteOf = (code) => { if (!market.has(code)) market.set(code, { price: 100, volume: 100000, seq: 0, trades: 0 }); return market.get(code); };
  const tick = (code) => (quoteOf(code).price >= 100 ? 0.5 : 0.05);

  function snapshotFor(spec, subscriptionId) {
    const m = quoteOf(spec.code);
    const trend = Array.from({ length: START_MINUTE + 1 }, (_, minute) => {
      const price = Number((m.price * (1 + Math.sin(minute / 17) * 0.01)).toFixed(2));
      return { minute_timestamp: iso(minute), timestamp: iso(minute), price, close: price, average_price: m.price,
        minute_volume: 100 + (minute % 13) * 20, total_volume: (minute + 1) * 300, ingest_sequence: minute + 1 };
    });
    const trades = Array.from({ length: 100 }, (_, i) => ({ ingest_sequence: i + 1, datetime: iso(START_MINUTE, i % 60), price: m.price,
      volume: 1 + (i % 9), trade_side: i % 2 ? "BUY" : "SELL", is_large: i % 17 === 0 }));
    const step = tick(spec.code);
    const ladder = Array.from({ length: 40 }, (_, i) => ({ price: Number((m.price + (i - 20) * step).toFixed(2)), out: 100 + i * 5, in: 80 + i * 3, unknown: 0 }));
    const minuteSeries = Array.from({ length: START_MINUTE + 1 }, (_, minute) => ({ minute, timestamp_ms: Date.UTC(2026, 9, 14, 9, minute),
      large: { buy: minute * 3, sell: minute * 2, net: minute }, small: { buy: minute, sell: minute, net: 0 } }));
    return {
      ...spec, subscription_id: subscriptionId, protocol_version: 1,
      session_key: { market: spec.market, logical_code: spec.code, trading_date: spec.trading_date, session: spec.session },
      stream_id: "bench", daemon_instance_id: "bench", watermark: 0, session_generation: 1,
      summary: { code: spec.code, trading_date: date, current: m.price, close: m.price, prev_close: m.price, reference_price: m.price,
        open: m.price, high: m.price * 1.02, low: m.price * 0.98, total_volume: m.volume, total_amount: m.volume * m.price },
      trend, trades,
      orderbook: { bids: Array.from({ length: 5 }, (_, i) => ({ price: m.price - (i + 1) * step, volume: 10 + i })),
        asks: Array.from({ length: 5 }, (_, i) => ({ price: m.price + (i + 1) * step, volume: 12 + i })) },
      windows: { windows: { 1: { change_pct: 0.1 }, 3: { change_pct: 0.2 }, 5: { change_pct: 0.3 } } },
      tradeflow: { sample_count: 1000, cumulative: { large: { buy: 500, sell: 300, net: 200 }, small: { buy: 100, sell: 90, net: 10 } }, minute_series: minuteSeries, large_orders: [] },
      price_volume: { buckets: ladder, out_volume: 5000, in_volume: 4000, current_price: m.price, sample_count: 1000 },
      signals: {}, events: [],
    };
  }

  const subscriptions = new Map(); // subscription_id -> { spec, seq }
  let socket = null;
  const sentTypes = {};
  class FixtureSocket extends EventTarget {
    static OPEN = 1; static CONNECTING = 0;
    constructor() { super(); socket = this; this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); this.reply("session.current", display); }); }
    reply(type, payload) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type, payload }) })); }
    send(raw) {
      const message = JSON.parse(raw);
      sentTypes[message.type] = (sentTypes[message.type] || 0) + 1;
      const spec = message.payload || {};
      if (message.type === "view.subscribe") {
        const id = `bench-${subscriptions.size + 1}-${spec.code}`;
        subscriptions.set(id, { spec, seq: 0 });
        queueMicrotask(() => {
          this.reply("view.subscription.accepted", { request_id: spec.request_id, subscription_id: id, stream_id: "bench" });
          this.reply("view.snapshot", snapshotFor(spec, id));
        });
      } else if (message.type === "focus.set") queueMicrotask(() => this.reply("focus.set.ack", { ...spec, ok: true, generation: 1 }));
      // A view is closed by its subscription id, or by the subscribe request that opened it (a cancel sent before the reply).
      else if (message.type === "view.unsubscribe") {
        for (const [id, opened] of subscriptions) if (id === spec.subscription_id || (!spec.subscription_id && opened.spec.request_id === spec.request_id)) subscriptions.delete(id);
      }
      else if (message.type === "view.snapshot" || message.type === "view.resync") {
        const entry = subscriptions.get(spec.subscription_id);
        if (entry) { entry.seq = 0; queueMicrotask(() => this.reply("view.snapshot", { ...snapshotFor(entry.spec, spec.subscription_id), request_id: spec.request_id })); }
      } else if (message.type === "health") queueMicrotask(() => this.reply("health", { status: "serving", service_id: "market_runtime", protocol: 2 }));
    }
    close() { this.readyState = 3; }
  }
  window.WebSocket = FixtureSocket;

  let minuteNow = START_MINUTE, secondNow = 0;
  const ladders = new Map();   // code -> Map(price -> bucket), what Rust B accumulates
  const flows = new Map();     // code -> minute series
  const tradedSincePublish = new Set();
  const bookOf = (m, step) => {
    const bids = Array.from({ length: 5 }, (_, i) => ({ price: Number((m.price - (i + 1) * step).toFixed(2)), volume: 5 + Math.floor(rand() * 50) }));
    const asks = Array.from({ length: 5 }, (_, i) => ({ price: Number((m.price + (i + 1) * step).toFixed(2)), volume: 5 + Math.floor(rand() * 50) }));
    return { bids, asks, bid_prices: bids.map((l) => l.price), bid_volumes: bids.map((l) => l.volume), ask_prices: asks.map((l) => l.price),
      ask_volumes: asks.map((l) => l.volume), diff_bid_vol: bids.map(() => Math.floor(rand() * 7) - 3), diff_ask_vol: asks.map(() => Math.floor(rand() * 7) - 3),
      exchange_ts_ns: String(Date.now() * 1e6), arrival_ns: String(Date.now() * 1e6) };
  };
  // What Market Runtime sends per Shioaji Tick (server.rs state_frame) and per BidAsk.
  function tradeDelta(code, withBook) {
    const m = quoteOf(code);
    const step = tick(code);
    m.price = Number(Math.max(step, m.price + (rand() < 0.5 ? -step : step) * (rand() < 0.3 ? 1 : 0)).toFixed(2));
    const volume = 1 + Math.floor(rand() * 20);
    m.volume += volume; m.trades += 1;
    const side = rand() < 0.5 ? "BUY" : "SELL";
    const nowUs = Date.now() * 1000;
    const arrivals = { summary: nowUs, trades: nowUs, orderbook: m.bookUs || nowUs, trend: nowUs, resolution: "epoch_microseconds" };
    const ladder = ladders.get(code) || new Map(); ladders.set(code, ladder);
    const bucket = ladder.get(m.price) || { price: m.price, out: 0, in: 0, unknown: 0 };
    if (side === "BUY") bucket.out += volume; else bucket.in += volume;
    ladder.set(m.price, bucket);
    tradedSincePublish.add(code);
    const trade = { sequence: m.trades, ingest_sequence: 1000 + m.trades, durable_sequence: 1000 + m.trades, exchange_ts_ns: String(nowUs * 1000),
      price: m.price, volume, side, tick_type: side === "BUY" ? 1 : 2, simtrade: false, trade_id: `${code}-${m.trades}`, minute: minuteNow,
      datetime: iso(minuteNow, Math.floor(secondNow)) };
    const frames = [{ delta_type: "trade.frame", channels: ["summary", "trend", "trades"], channel_arrival_us: arrivals,
      trace: { backend_received_us: nowUs, a_received_us: nowUs },
      payload: {
        summary: { code, current: m.price, close: m.price, total_volume: m.volume, high: m.price * 1.02, low: m.price * 0.98, last_trade_at: trade.datetime },
        trade,
        trend: { point: { minute_timestamp: iso(minuteNow), timestamp: iso(minuteNow), price: m.price, close: m.price, average_price: m.price,
          total_volume: m.volume, ingest_sequence: 10000 + m.trades } },
      } }];
    if (withBook) {
      m.bookUs = nowUs;
      frames.push({ delta_type: "orderbook.latest", channels: ["orderbook"], channel_arrival_us: { ...arrivals, orderbook: nowUs }, payload: bookOf(m, step) });
    }
    return frames;
  }
  // Rust B's 250 ms publication for every symbol that traded since the last one (accum.rs day/flow/windows blocks).
  function projectionDeltas(code) {
    const m = quoteOf(code);
    const ladder = [...(ladders.get(code) || new Map()).values()].sort((a, b) => a.price - b.price);
    const series = flows.get(code) || Array.from({ length: START_MINUTE + 1 }, (_, minute) => ({ minute, timestamp_ms: Date.UTC(2026, 9, 14, 9, minute),
      large: { buy: minute * 3, sell: minute * 2, net: minute }, small: { buy: minute, sell: minute, net: 0 } }));
    flows.set(code, series);
    const last = series.at(-1);
    if (last.minute !== minuteNow) series.push({ minute: minuteNow, timestamp_ms: Date.UTC(2026, 9, 14, 9, minuteNow), large: { buy: 0, sell: 0, net: 0 }, small: { buy: 0, sell: 0, net: 0 } });
    series.at(-1).small.buy += 1; series.at(-1).small.net += 1;
    return [
      { delta_type: "day.updated", channels: ["day", "price_volume"], payload: { open: m.price, high: m.price * 1.02, low: m.price * 0.98,
        price_volume: { buckets: ladder, byPrice: ladder, complete: true, current_price: m.price, out_volume: m.volume / 2, in_volume: m.volume / 2, sample_count: m.trades } } },
      { delta_type: "tradeflow.updated", channels: ["tradeflow"], payload: { sample_count: m.trades,
        cumulative: { large: { buy: 500, sell: 300, net: 200 }, small: { buy: m.trades, sell: 90, net: m.trades - 90 } }, minute_series: series.map((row) => ({ ...row })), large_orders: [] } },
      { delta_type: "windows.updated", channels: ["windows"], payload: { windows: { 1: { change_pct: rand() }, 3: { change_pct: rand() }, 5: { change_pct: rand() } } } },
    ];
  }
  function itemsFor(code, frames) {
    const items = [];
    for (const [id, entry] of subscriptions) {
      if (entry.spec.code !== code) continue;
      for (const frame of frames) {
        entry.seq += 1;
        items.push({ ...frame, subscription_id: id, sequence: entry.seq, stream_id: "bench", daemon_instance_id: "bench", session_generation: 1,
          session_key: { market: entry.spec.market, logical_code: code, trading_date: entry.spec.trading_date, session: entry.spec.session } });
      }
    }
    return items;
  }

  const { startRealtimeStream, getRealtimeViewStats } = await import(`${base}js/market_data/realtime.js`);
  const runtime = await import(`${base}js/pages/realtime.js`);
  await import(`${base}js/dashboard_components.js`);
  const trace = await import(`${base}js/core/market_render_trace.js`);
  const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((resolve) => requestAnimationFrame(resolve)); };
  if (options?.noAnimations) {
    const style = document.createElement("style");
    style.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; }";
    document.head.appendChild(style);
  }
  if (options?.extraCss) {
    const style = document.createElement("style");
    style.textContent = options.extraCss;
    document.head.appendChild(style);
  }
  if (options?.noTrend) {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function getContext(...args) {
      return this.closest?.(".trend-chart, [data-role='trend-canvas']") || this.dataset?.trendView ? null : original.apply(this, args);
    };
  }
  const main = document.querySelector("main");
  main.innerHTML = realtimeHtml;
  const workspace = main.querySelector(".realtime-workspace");
  if (workspace) { workspace.style.width = "1900px"; workspace.style.height = "940px"; }
  startRealtimeStream();
  await runtime.initRealtimePage();
  for (let i = 0; i < 100 && subscriptions.size < codes.length; i++) await settle(3);
  console.log(`[bench] subscriptions ${subscriptions.size} ${JSON.stringify(sentTypes)} socket=${Boolean(socket)}`);
  await settle(20);

  // Frame intervals and long tasks during the measured window only.
  let measuring = false;
  const frameIntervals = [];
  let lastFrame = 0;
  const frameLoop = (t) => { if (measuring && lastFrame) frameIntervals.push(t - lastFrame); lastFrame = t; requestAnimationFrame(frameLoop); };
  requestAnimationFrame(frameLoop);
  const longTasks = [];
  new PerformanceObserver((list) => { if (measuring) for (const entry of list.getEntries()) longTasks.push(entry.duration); }).observe({ entryTypes: ["longtask"] });

  // Every batch is dispatched synchronously; its JS cost (store apply + whatever the page does synchronously on
  // receipt) is timed directly. Work deferred to rAF shows in the frame intervals and the CPU total.
  const dispatchCost = [];
  let sent = 0;
  let carryWatch = 0, carryTrade = 0, carryBook = 0, sinceProjection = 0;
  const others = codes.slice(1);
  function sendBatch() {
    carryWatch += watchRate * batchMs / 1000;
    carryTrade += selectedTradeRate * batchMs / 1000;
    carryBook += selectedBookRate * batchMs / 1000;
    const items = [];
    while (carryTrade >= 1) { carryTrade -= 1; const book = carryBook >= 1; if (book) carryBook -= 1; items.push(...itemsFor(selected, tradeDelta(selected, book))); }
    while (carryWatch >= 1) { carryWatch -= 1; const code = others[Math.floor(rand() * others.length)]; items.push(...itemsFor(code, tradeDelta(code, false))); }
    sinceProjection += batchMs;
    if (sinceProjection >= 250) {
      sinceProjection = 0;
      for (const code of tradedSincePublish) items.push(...itemsFor(code, projectionDeltas(code)));
      tradedSincePublish.clear();
    }
    secondNow += batchMs / 1000; if (secondNow >= 60) { secondNow = 0; minuteNow += 1; }
    secondNow = Math.floor(secondNow * 1000) / 1000;
    if (!items.length) return;
    sent += items.length;
    const started = performance.now();
    socket.reply("view.delta.batch", { items });
    if (measuring) dispatchCost.push(performance.now() - started);
  }

  const runFor = (ms) => new Promise((resolve) => {
    const end = performance.now() + ms;
    const step = () => { sendBatch(); if (performance.now() < end) setTimeout(step, batchMs); else resolve(); };
    step();
  });
  await runFor(warmupSeconds * 1000);
  if (globalThis.gc) globalThis.gc();
  const heapBefore = performance.memory?.usedJSHeapSize || 0;
  const sentBefore = sent;
  measuring = true;
  console.timeStamp("bench-measure-start");
  console.log("[bench] measure-start");
  const wallStart = performance.now();
  await runFor(seconds * 1000);
  const wallMs = performance.now() - wallStart;
  console.timeStamp("bench-measure-end");
  console.log("[bench] measure-end");
  measuring = false;
  await settle(4);
  const heapAfter = performance.memory?.usedJSHeapSize || 0;

  const q = (values, p) => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b); return Number(s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)].toFixed(2)); };
  const latency = trace.marketRenderDestinationLatency();
  const dom = {
    product_rows: main.querySelectorAll("tr[data-realtime-code]").length,
    selected_row: main.querySelector(`tr[data-realtime-code="${selected}"]`)?.textContent?.slice(0, 80) || "",
    tick_rows: main.querySelectorAll('[data-role="tick-body"] tr').length,
    book_rows: main.querySelectorAll("[data-orderbook-level]").length,
    book_text: main.querySelector("[data-orderbook-level]")?.textContent?.slice(0, 60) || "",
    subscribed: [...subscriptions.values()].map((e) => `${e.spec.market}:${e.spec.code}:${(e.spec.channels || []).join("+")}:${e.spec.source || ""}`).filter((v, i, a) => a.indexOf(v) === i).slice(0, 4),
    trend_canvas: main.querySelectorAll("canvas").length,
    store: (() => { const st = getRealtimeViewStats() || {}; const m = st.metrics || st; return Object.fromEntries(Object.entries(m).filter(([k, v]) => typeof v === "number" && v)); })(),
    components: [...main.querySelectorAll("[data-component-id]")].map((el) => el.dataset.componentId),
    // Each component's box on the page (run.cjs --paint gives each paint to the box holding its middle).
    component_boxes: [...main.querySelectorAll("[data-component-id]")].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.dataset.componentId, x: r.left, y: r.top, w: r.width, h: r.height };
    }).filter((box) => box.w > 0 && box.h > 0),
    trace_groups: trace.marketRenderTraceSnapshot().map((g) => { const x = g.samples.at(-1) || {}; return `${g.component}:${g.code}:${g.updated}:src=${x.source}:lane=${x.source_lane}:arr=${x.arrival_us}`; }).slice(0, 8),
  };
  return {
    deltas_per_second: Number(((sent - sentBefore) / (wallMs / 1000)).toFixed(1)),
    subscriptions: subscriptions.size,
    dispatch_ms: { p50: q(dispatchCost, 0.5), p95: q(dispatchCost, 0.95), p99: q(dispatchCost, 0.99), total: Number(dispatchCost.reduce((a, b) => a + b, 0).toFixed(1)) },
    frame_interval_ms: { p50: q(frameIntervals, 0.5), p95: q(frameIntervals, 0.95), p99: q(frameIntervals, 0.99), count: frameIntervals.length },
    long_tasks: { count: longTasks.length, total_ms: Number(longTasks.reduce((a, b) => a + b, 0).toFixed(1)), max_ms: longTasks.length ? Number(Math.max(...longTasks).toFixed(1)) : 0 },
    heap_growth_mb: Number(((heapAfter - heapBefore) / 1048576).toFixed(2)),
    latency: Object.fromEntries(Object.entries(latency).map(([key, value]) => [key, { p50: value.p50_ms, p95: value.p95_ms, p99: value.p99_ms, n: value.sample_count }])),
    wall_ms: Math.round(wallMs), dom,
  };
}
