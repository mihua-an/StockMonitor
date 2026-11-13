const { makeTempDir } = require("./support/temp_dirs.cjs");
// 買賣報價's 零股／整張 (docs/decisions.md 零股行情的顯示, user 11-13): on the page that offers it, a switch at the right of
// the book's title (or of the slot's tabs, when a tab names the book) whose text is what a press switches to -- 零股
// while the book is the stock's, 整張 while it is its 盤中零股. Hidden for a product without odd lots, absent where the
// page offers none. A press asks the page to switch. Also the view spec 買賣報價 reads while 零股 is shown. Run with
// Electron.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-orderbook-odd-lot-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const fail = (message) => { throw new Error(message); };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const { OrderBookComponent } = await import(`${base}js/core/components/orderbook_component.js`);
  const { withMarketRead } = await import(`${base}js/core/market_read_adapters.js`);
  const { hasOddLots, oddLotViewSpec } = await import(`${base}js/market_data/stock_view_spec.js`);
  const listeners = [];
  const dataSource = { subscribe: (name, fn) => { if (name === "orderbook") listeners.push(fn); return () => {}; }, invalidate: () => {} };
  const feed = (code, oddLot) => {
    const vm = withMarketRead({ code, displayCode: code, displayName: code, market: "STK", availability: "AVAILABLE", currentPrice: 130,
      lastPrice: 130, prevClose: 129, diffRenderable: false, diffEventToken: "", oddLot,
      bidLevels: [{ price: 129.5, volume: 300, quoteState: "PRICE" }], askLevels: [{ price: 130, volume: 200, quoteState: "PRICE" }] });
    listeners.forEach((fn) => fn(vm));
  };
  const symbolStore = { getSelectedSymbol: () => "2330", subscribe: () => () => {} };
  let presses = 0;
  const services = { oddLot: { toggle: () => { presses += 1; } } };

  document.querySelector("main").innerHTML = '<div id="book" style="position:absolute;left:20px;top:20px;width:320px;height:360px"></div>'
    + '<div id="slot-actions" class="tab-strip-actions"></div><div id="plain" style="position:absolute;left:360px;top:20px;width:320px;height:360px"></div>';
  const host = document.getElementById("book");
  const book = new OrderBookComponent({ depth: 5, showInsideOutside: false, showPriceVolume: false });
  book.mount({ host, context: { mode: "live", dataSource, symbolStore, services }, hydrate: false });
  const control = host.querySelector('[data-role="odd-lot-switch"]');
  const button = () => host.querySelector('[data-role="odd-lot-toggle"]');
  if (!control || !control.closest(".tab-strip-title .tab-strip-actions")) fail("the switch sits in the title bar's actions");
  if (!control.hidden) fail("hidden until the book says whether the product has odd lots");

  feed("2330", { available: true, shown: false });
  await frame();
  if (control.hidden || button().textContent !== "零股" || button().getAttribute("aria-pressed") !== "false") fail(`the stock's book offers 零股 (${button().textContent})`);
  if (!button().classList.contains("pill-switch-btn") || !control.classList.contains("pill-switch")) fail("the shared pill switch");
  const box = button().getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) fail(`the switch is drawn (${JSON.stringify(box)})`);
  button().click();
  if (presses !== 1) fail("a press asks the page to switch");
  feed("2330", { available: true, shown: true });
  await frame();
  if (button().textContent !== "整張" || button().getAttribute("aria-pressed") !== "true") fail(`the 盤中零股 book offers 整張 (${button().textContent})`);
  feed("TXF202612", { available: false, shown: false });
  await frame();
  if (!control.hidden) fail("a product without odd lots has no switch");
  book.destroy();

  // In a slot (its tab names the book): the switch moves to the slot's actions box, and goes with the book.
  const slotActions = document.getElementById("slot-actions");
  const slotted = new OrderBookComponent({ depth: 5, showInsideOutside: false, showPriceVolume: false });
  slotted.mount({ host, context: { mode: "live", dataSource, symbolStore, services }, hydrate: false, actionsHost: slotActions });
  if (!slotActions.querySelector('[data-role="odd-lot-switch"]')) fail("in a slot the switch is in the slot's actions");
  slotted.destroy();
  if (slotActions.querySelector('[data-role="odd-lot-switch"]')) fail("the switch goes with the book");

  // A page that offers no switch (the workspace, 歷史回放): none drawn.
  const plain = new OrderBookComponent({ depth: 5, showInsideOutside: false, showPriceVolume: false });
  plain.mount({ host: document.getElementById("plain"), context: { mode: "live", dataSource, symbolStore, services: {} }, hydrate: false });
  if (document.getElementById("plain").querySelector('[data-role="odd-lot-switch"]')) fail("no switch where the page offers none");
  plain.destroy();

  // The 盤中零股 view: Market Runtime's market ODD of the stock's DAY date, with the book's and the tape's channels.
  const spec = oddLotViewSpec(" 2330 ", "2026-11-13T00:00");
  if (JSON.stringify(spec) !== JSON.stringify({ market: "ODD", code: "2330", trading_date: "2026-11-13", session: "DAY", channels: ["summary", "trades", "orderbook"] })) {
    fail(`the odd-lot view spec: ${JSON.stringify(spec)}`);
  }
  for (const [code, has] of [["2330", true], ["00981A", true], ["TXF202612", false], ["CDF202612", false], ["TXFR1", false], ["TXF", false], ["US.AAPL", false], ["", false]]) {
    if (hasOddLots(code) !== has) fail(`${code || "(none)"} ${has ? "has" : "has no"} odd lots`);
  }
  return { ok: true };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 720, height: 460, webPreferences: { sandbox: false, offscreen: true } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)}).then((r) => r.ok)`);
    console.log("orderbook odd lot switch ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("orderbook odd lot switch ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
