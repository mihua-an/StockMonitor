const { makeTempDir } = require("./support/temp_dirs.cjs");
// 買賣報價: a level's ±diff badge (orderbook-book-change, a 720 ms transform/opacity animation) must not pull the price
// texts into composited layers. When it did, every badge start moved the prices of the rows below it into their own
// layers for a frame or two and back: their text was drawn with a different anti-aliasing each time, and the prices
// flickered on every quantity change (user 11-10). Checked in a real Chromium through the DevTools layer tree: no
// layer may belong to a price cell or price text while badges start and run. Run with Electron.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

app.setPath("userData", makeTempDir("stockmonitor-orderbook-badge-layers-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const { OrderBookComponent } = await import(`${base}js/core/components/orderbook_component.js`);
  const { withMarketRead } = await import(`${base}js/core/market_read_adapters.js`);
  const listeners = [];
  const dataSource = { subscribe: (name, fn) => { if (name === "orderbook") listeners.push(fn); return () => {}; }, invalidate: () => {} };
  const levels = (start, side, deltas) => Array.from({ length: 5 }, (_, i) => ({
    price: Number((start + side * i * 0.5).toFixed(2)), volume: 300 + i * 50, delta: deltas[i] ?? 0, quoteState: "PRICE" }));
  const vm = (token, bidDeltas, askDeltas) => withMarketRead({ code: "1815", displayCode: "1815", displayName: "富喬", market: "STK",
    availability: "AVAILABLE", currentPrice: 130, lastPrice: 130, prevClose: 129, diffRenderable: true, diffEventToken: token,
    bidLevels: levels(130, -1, bidDeltas), askLevels: levels(130.5, 1, askDeltas) });
  document.querySelector("main").innerHTML = '<div id="book" style="position:absolute;left:20px;top:20px;width:300px;height:360px"></div>';
  const host = document.getElementById("book");
  const book = new OrderBookComponent({ depth: 5, showInsideOutside: false, showPriceVolume: false });
  book.mount({ host, context: { mode: "live", dataSource, symbolStore: { getSelectedSymbol: () => "1815", subscribe: () => () => {} } }, hydrate: false });
  listeners.forEach((fn) => fn(vm("t0", [], [])));
  window.__feedBadge = (n) => listeners.forEach((fn) => fn(vm(`t${n}`, n % 2 ? [n] : [0, 0, -n], n % 2 ? [] : [0, n])));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return { ok: true, badges: 0 };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 400, height: 460, webPreferences: { sandbox: false, offscreen: true } });
  win.webContents.setFrameRate(60);
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  const dbg = win.webContents.debugger;
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)}).then((r) => r.ok)`);
    dbg.attach("1.3");
    await dbg.sendCommand("DOM.enable");
    const { root } = await dbg.sendCommand("DOM.getDocument", { depth: -1 });
    const { nodeIds } = await dbg.sendCommand("DOM.querySelectorAll", { nodeId: root.nodeId, selector: ".orderbook-price-cell, .orderbook-price-value" });
    const priceNodes = new Set();
    for (const nodeId of nodeIds) priceNodes.add((await dbg.sendCommand("DOM.describeNode", { nodeId })).node.backendNodeId);
    if (priceNodes.size !== 20) throw new Error(`expected 20 price cells and texts, found ${priceNodes.size}`);
    const offenders = new Set();
    let trees = 0, badgeLayers = 0;
    dbg.on("message", (_event, method, params) => {
      if (method !== "LayerTree.layerTreeDidChange") return;
      trees += 1;
      for (const layer of params.layers || []) {
        if (priceNodes.has(layer.backendNodeId)) offenders.add(layer.backendNodeId);
        else if (layer.backendNodeId && layer.drawsContent) badgeLayers += 1;
      }
    });
    await dbg.sendCommand("LayerTree.enable");
    // Badges started on new rows, one after another, each while the earlier ones still run.
    for (let n = 1; n <= 8; n += 1) {
      await win.webContents.executeJavaScript(`window.__feedBadge(${n}); true`);
      win.webContents.invalidate();
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    await new Promise((resolve) => setTimeout(resolve, 900));
    const shown = await win.webContents.executeJavaScript(`document.querySelectorAll(".orderbook-book-change").length`);
    if (!trees) throw new Error("no layer tree was reported: the check saw nothing");
    if (!badgeLayers) throw new Error("no badge layer was seen: the badges never animated, the check proves nothing");
    if (offenders.size) throw new Error(`${offenders.size} price cell/text element(s) got their own composited layer while badges started (${trees} layer trees)`);
    console.log(`orderbook change badge layers ui contract passed (${trees} layer trees, ${badgeLayers} badge layer sightings, ${shown} badge(s) at the end)`);
    app.exit(0);
  } catch (error) {
    console.error("orderbook change badge layers ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
