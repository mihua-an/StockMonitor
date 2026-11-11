const { makeTempDir } = require("./support/temp_dirs.cjs");
// The trend surfaces' header cells in a real Chromium (run with Electron): every write to the surface is recorded by a
// MutationObserver and attributed to its cell (data-role / data-metric) and aspect (text, class, aria-pressed).
//   * 即時報價 個股走勢: a frame writes no exchange breadth cell and never the 盤中事件 switch; the breadth store writes
//     each breadth cell once per change; a horizon change in settings writes nothing until the frame it asks for; a
//     real click on 盤中事件 changes the switch once, through the marker store.
//   * 歷史回放 (replay surface) and Futu 個股走勢 (the wrapper over the shared surface): no cell aspect is written twice in
//     one frame, and a frame equal to the last one writes nothing.
// TREND_HEADER_SCREENSHOT=<path.png> saves a picture of the three surfaces.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-trend-header-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const fail = (message) => { throw new Error(message); };
  const { TrendChartComponent } = await import(`${base}js/core/components/trend_chart_component.js`);
  const { setMarketBreadthReader, notifyMarketBreadthChanged } = await import(`${base}js/core/market_breadth_store.js`);
  const { setTrendFooterHorizons } = await import(`${base}js/core/trend_footer_horizons.js`);
  const { stockTrendEventMarkersVisible } = await import(`${base}js/core/event_markers.js`);
  const { withMarketRead } = await import(`${base}js/core/market_read_adapters.js`);
  const { MoomooTrendComponent } = await import(`${base}js/features/realtime/components/moomoo_components.js`);

  // Which cell aspects a step wrote, with how many times each.
  function recorder(host) {
    const records = [];
    const cellIds = new Map();
    const observer = new MutationObserver((list) => records.push(...list));
    observer.observe(host, { subtree: true, childList: true, characterData: true, attributes: true });
    return (step) => {
      step();
      records.push(...observer.takeRecords());
      const writes = new Map();
      for (const record of records.splice(0)) {
        const node = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        const cell = node?.closest?.("[data-role],[data-metric]");
        if (!cell || !host.contains(cell)) continue;
        // Several nodes share a role (the four prediction labels, a control's buttons): each node is its own entry -- the
        // element an attribute was set on, or the cell whose text changed.
        const written = record.type === "attributes" ? node : cell;
        if (!cellIds.has(written)) cellIds.set(written, cellIds.size + 1);
        const name = cell.dataset.role ? `role:${cell.dataset.role}` : `metric:${cell.dataset.metric}`;
        const key = `${name}#${cellIds.get(written)}/${record.type === "attributes" ? record.attributeName : "text"}`;
        writes.set(key, (writes.get(key) || 0) + 1);
      }
      return writes;
    };
  }
  // A class change is one record per token (setStateClasses swaps price-flat for price-up as two toggles), so the class
  // aspect is not held to one record; text and every other attribute are.
  const twice = (writes) => [...writes].filter(([key, count]) => count > 1 && !key.endsWith("/class")).map(([key]) => key);
  const matching = (writes, pattern) => [...writes].filter(([key]) => pattern.test(key));

  setMarketBreadthReader(() => ({ trading_date: "2026-11-03", up_count: 411, down_count: 391, limit_up_count: 7, limit_down_count: 3, flat_count: 72 }));
  notifyMarketBreadthChanged();
  setTrendFooterHorizons([3, 5]);

  const main = document.querySelector("main");
  main.innerHTML = `<div style="display:flex;gap:6px;width:1500px;height:440px">
    <div id="stockPane" style="flex:0 0 490px;height:100%;display:flex;flex-direction:column"></div>
    <div id="replayPane" style="flex:0 0 490px;height:100%;display:flex;flex-direction:column"></div>
    <div id="futuPane" style="flex:0 0 490px;height:100%;display:flex;flex-direction:column"></div></div>`;
  const invalidations = [];
  const context = (mode) => ({
    mode, services: {},
    dataSource: { subscribe: () => () => {}, invalidate: (key) => invalidations.push(key) },
    symbolStore: { getSelectedSymbol: () => "2330", subscribe: () => () => {} },
    currentTimestamp: { subscribe: () => () => {} },
  });
  const start = Date.parse("2026-11-03T09:00:00+08:00");
  const points = Array.from({ length: 120 }, (_, i) => ({ time: new Date(start + (i + 1) * 60000).toISOString(), price: 1090 + Math.sin(i / 9) * 8, volume: 10 }));
  const stockVm = (revision, extra = {}) => withMarketRead({
    presentationRevision: revision, points, displayName: "台積電", displayCode: "2330", symbol: "2330", currentPrice: 1105, prevClose: 1090,
    stockInfo: { open: 1092, high: 1110, low: 1088, prevClose: 1090 },
    metrics: { limitUp: 1199, limitDown: 981, change: 15, changePct: 1.38, amplitude: 2.02, up3m: 0.58, down3m: 0.42, up5m: 0.55, down5m: 0.45,
      up10m: 0.6, down10m: 0.4, up15m: 0.7, down15m: 0.3 },
    ...extra,
  });

  // --- 即時報價 個股走勢 ------------------------------------------------------------------------------------------------
  const stockHost = document.getElementById("stockPane");
  const stock = new TrendChartComponent({ dataKey: "stockTrend", variant: "stock" });
  stock.mount({ host: stockHost, context: context("live"), hydrate: false, slotId: "ui-stock" });
  const stockStep = recorder(stockHost);
  let writes = stockStep(() => stock.update(stockVm(1)));
  if (twice(writes).length) fail(`個股走勢 first frame wrote a cell twice: ${twice(writes)}`);
  for (let revision = 2; revision <= 4; revision += 1) {
    const vmBreadth = { trading_date: "2026-11-03", up_count: revision, down_count: revision, limit_up_count: revision, limit_down_count: revision, flat_count: revision };
    writes = stockStep(() => stock.update(stockVm(revision, { currentPrice: 1105 + revision, breadth: vmBreadth })));
    if (twice(writes).length) fail(`個股走勢 frame ${revision} wrote a cell twice: ${twice(writes)}`);
    if (matching(writes, /breadth-/).length) fail(`a frame wrote the exchange breadth: ${matching(writes, /breadth-/)}`);
    if (matching(writes, /event-marker-toggle/).length) fail(`a frame wrote the 盤中事件 switch: ${matching(writes, /event-marker-toggle/)}`);
  }
  writes = stockStep(() => stock.update(stockVm(5, { currentPrice: 1109 })));
  if (writes.size) fail(`an unchanged 個股走勢 frame wrote: ${[...writes.keys()]}`);
  const counts = () => ["breadth-up", "breadth-down", "breadth-limit-up", "breadth-limit-down", "breadth-flat"]
    .map((role) => stockHost.querySelector(`[data-role="${role}"]`).textContent).join(",");
  if (counts() !== "411,391,7,3,72") fail(`the store's counts stay: ${counts()}`);
  writes = stockStep(() => {
    setMarketBreadthReader(() => ({ trading_date: "2026-11-03", up_count: 412, down_count: 390, limit_up_count: 8, limit_down_count: 4, flat_count: 71 }));
    notifyMarketBreadthChanged();
  });
  if (matching(writes, /breadth-/).length !== 5 || twice(writes).length) fail(`a store change writes each breadth cell once: ${[...writes]}`);
  if (counts() !== "412,390,8,4,71") fail(`store counts: ${counts()}`);

  const before = invalidations.length;
  writes = stockStep(() => setTrendFooterHorizons([10, 15]));
  if (writes.size) fail(`a horizon change wrote cells itself: ${[...writes.keys()]}`);
  if (invalidations.slice(before).join() !== "stockTrend") fail(`a horizon change asks for one frame: ${invalidations.slice(before)}`);
  writes = stockStep(() => stock.update(stockVm(6, { currentPrice: 1109 })));
  if (twice(writes).length) fail(`the redraw wrote a cell twice: ${twice(writes)}`);
  const labels = [...stockHost.querySelectorAll('[data-role="prediction-label"]')].map((node) => node.textContent).join();
  if (labels !== "10,10,15,15") fail(`labels after the redraw: ${labels}`);
  const directions = [...stockHost.querySelectorAll('[data-role="prediction-name"] .direction-glyph')].map((node) => node.dataset.direction).join();
  if (directions !== "up,down,up,down") fail(`the glyphs after the redraw: ${directions}`);

  const button = stock._controlRole("event-marker-toggle");
  const visible = stockTrendEventMarkersVisible();
  writes = stockStep(() => button.click());
  if (stockTrendEventMarkersVisible() === visible) fail("the click changed the marker store");
  if (button.classList.contains("active") === visible || button.getAttribute("aria-pressed") !== String(!visible)) fail("the switch follows the store");
  const toggleWrites = matching(writes, /event-marker-toggle/);
  if (toggleWrites.length !== 2 || toggleWrites.some(([, count]) => count !== 1)) fail(`one click: class and aria-pressed once each: ${toggleWrites}`);
  writes = stockStep(() => stock.update(stockVm(7, { currentPrice: 1109 })));
  if (writes.size) fail(`an unchanged frame after the click wrote: ${[...writes.keys()]}`);
  button.click(); // back to where it was

  // --- 歷史回放 -----------------------------------------------------------------------------------------------------
  const replayHost = document.getElementById("replayPane");
  const replay = new TrendChartComponent({ dataKey: "trendChart", variant: "auto" });
  replay.mount({ host: replayHost, context: context("replay"), hydrate: false, slotId: "ui-replay" });
  const replayStep = recorder(replayHost);
  for (let revision = 1; revision <= 3; revision += 1) {
    writes = replayStep(() => replay.update(stockVm(revision, { currentPrice: 1100 + revision })));
    if (twice(writes).length) fail(`歷史回放 frame ${revision} wrote a cell twice: ${twice(writes)}`);
  }
  writes = replayStep(() => replay.update(stockVm(4, { currentPrice: 1103 })));
  if (writes.size) fail(`an unchanged 歷史回放 frame wrote: ${[...writes.keys()]}`);
  if (replayHost.querySelector('[data-role="breadth-up"]')) fail("歷史回放 has no exchange breadth row");

  // --- Futu 個股走勢 ------------------------------------------------------------------------------------------------
  const futuHost = document.getElementById("futuPane");
  const futu = new MoomooTrendComponent();
  futu.mount({ host: futuHost });
  const futuStep = recorder(futuHost);
  const date = new Date().toLocaleDateString("sv-SE", { timeZone: "America/New_York" });
  const rows = Array.from({ length: 60 }, (_, i) => ({ trading_date: date, minute: 9 * 60 + 30 + i,
    time: `${date}T${String(9 + Math.floor((30 + i) / 60)).padStart(2, "0")}:${String((30 + i) % 60).padStart(2, "0")}:00`, price: 230 + i / 10, volume: 5 }));
  writes = futuStep(() => futu.renderData({ items: rows }, "US.AAPL"));
  if (twice(writes).length) fail(`Futu frame wrote a cell twice: ${twice(writes)}`);
  writes = futuStep(() => futu.renderData({ items: rows }, "US.AAPL"));
  if (twice(writes).length) fail(`Futu second frame wrote a cell twice: ${twice(writes)}`);
  writes = futuStep(() => futu.renderData({ items: rows }, "US.AAPL"));
  if (writes.size) fail(`an unchanged Futu frame wrote: ${[...writes.keys()]}`);
  if (!/AAPL/.test(futuHost.querySelector(".product-quote-name")?.textContent || "")) {
    fail(`Futu header name: ${futuHost.querySelector(".product-quote-name")?.textContent}`);
  }
  await settle();
  window.__trendHeader = { stock, replay, futu };
  return { ok: true };
}

async function finish() {
  const { stock, replay, futu } = window.__trendHeader;
  stock.destroy(); replay.destroy(); futu.destroy();
  return { ok: true };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1540, height: 520, webPreferences: { sandbox: false, offscreen: true } });
  const fixture = path.join(__dirname, "fixtures", "renderer_ui_geometry.html");
  await win.loadURL(pathToFileURL(fixture).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)}).then((r) => r.ok)`);
    if (process.env.TREND_HEADER_SCREENSHOT) {
      const image = await win.webContents.capturePage();
      fs.writeFileSync(process.env.TREND_HEADER_SCREENSHOT, image.toPNG());
    }
    await win.webContents.executeJavaScript(`(${finish.toString()})().then((r) => r.ok)`);
    console.log("trend header single writer ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("trend header single writer ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
