const { makeTempDir } = require("./support/temp_dirs.cjs");
// A 買賣報價 price clicked on 即時報價 opens a 模擬 order (paper_order_entry.js, user 10-27), in a real Chromium (run with
// Electron, like renderer_paper_ledger_ui.cjs): the page's shared order book fed a 台股 book through a fake data source.
// With a 模擬帳務 on the page -- showing, or in a tab behind another -- it comes to the front and opens 下單 at the price,
// no popover. Without one, the popover opens beside the book at the price: 數量 and 張／零股 set there, 買進 places a
// limit ROD at once, 今日額度剩餘 and 庫存 shown, Esc and a click outside close it. A futures book opens nothing.
// PAPER_ORDER_POPOVER_SCREENSHOT=<path.png> saves a picture of the popover.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-paper-order-entry-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fail = (message) => { throw new Error(message); };
  // The product catalog names the code's instrument kind (its terms are the estimate's); the ticket never guesses one.
  window.desktopAPI = { searchProductCatalogLocal: async (_source, query) => ({ ok: true, items: [{ code: String(query), type: "stock" }] }) };
  const { OrderBookComponent } =await import(`${base}js/core/components/orderbook_component.js`);
  const { PaperOrderPopover } = await import(`${base}js/features/realtime/components/paper_order_popover.js`);
  const { createPaperOrderEntry } = await import(`${base}js/features/realtime/paper_order_entry.js`);
  const { withMarketRead } = await import(`${base}js/core/market_read_adapters.js`);
  const { buyCost } = await import(`${base}js/core/trade_costs.js`);

  const levels = (start, step, side) => Array.from({ length: 5 }, (_, i) => ({ price: Number((start + side * i * step).toFixed(2)), volume: 100 + i * 10, quoteState: "PRICE" }));
  const stock = withMarketRead({ code: "2303", displayCode: "2303", displayName: "聯電", market: "STK", availability: "AVAILABLE", currentPrice: 48.6, lastPrice: 48.6,
    prevClose: 48.15, bidLevels: levels(48.6, 0.05, -1), askLevels: levels(48.65, 0.05, 1) });
  const futures = withMarketRead({ code: "TXFR1", displayCode: "TXFR1", displayName: "台指期", market: "FUT", availability: "AVAILABLE", currentPrice: 23000, lastPrice: 23000,
    prevClose: 22950, bidLevels: levels(23000, 1, -1), askLevels: levels(23001, 1, 1) });
  const listeners = [];
  const dataSource = { subscribe: (name, fn) => { if (name === "orderbook") listeners.push(fn); return () => {}; }, invalidate: () => {} };
  const feed = (vm) => listeners.forEach((fn) => fn(vm));

  const placed = [];
  const terms = (tax) => ({ amount_rounding: "floor", fee_rate: "0.000399", min_fee: "1", fee_rounding: "ceil", sell_tax_rate: tax, tax_rounding: "floor" });
  const tradeTerms = { stock: terms("0.003"), etf: terms("0.001") };
  const store = { funds: async () => ({ ok: true, capital: { remaining_with_orders: 1642300, trade_terms: tradeTerms } }), place: async (order) => { placed.push(order); return { ok: true }; } };
  const paperHoldings = { subscribe: () => () => {}, refresh: async () => ({ tw: { items: [{ code: "2303", position_qty: 2000 }] } }) };
  const popover = new PaperOrderPopover({ store, paperHoldings, dataSource });

  // Where 模擬帳務 is: none, behind another tab (select mounts it), or showing.
  let ledgerPlace = "none";
  const opened = [];
  const selected = [];
  const fakeLedger = { openOrderAt: (order) => opened.push(order) };
  const entry = createPaperOrderEntry({
    selectComponent: (id) => { selected.push(id); if (ledgerPlace === "behind") ledgerPlace = "showing"; return ledgerPlace === "showing"; },
    mountedComponent: (id) => (id === "paperLedger" && ledgerPlace === "showing" ? fakeLedger : null),
    popover,
  });

  const main = document.querySelector("main");
  main.innerHTML = '<div id="book" style="position:absolute;left:20px;top:20px;width:420px;height:300px"></div><div id="elsewhere" style="position:absolute;left:20px;top:420px;width:50px;height:30px"></div>';
  const host = document.getElementById("book");
  const book = new OrderBookComponent({ depth: 5, showInsideOutside: false, showPriceVolume: false });
  book.mount({ host, context: { mode: "live", dataSource, symbolStore: { getSelectedSymbol: () => "2303", subscribe: () => () => {} }, services: { paperOrderEntry: entry } }, hydrate: false });
  feed(stock);
  await settle();
  const cell = (side, level) => host.querySelector(`tr[data-orderbook-level="${level}"] .orderbook-price-cell.${side}`);
  const pop = popover.root;
  const $ = (sel) => pop.querySelector(sel);

  // 模擬帳務 behind another tab: it is brought to the front and opens at the price; no popover.
  ledgerPlace = "behind";
  cell("ask", 2).click();
  if (selected.join() !== "paperLedger" || JSON.stringify(opened) !== JSON.stringify([{ code: "2303", name: "聯電", price: 48.75 }])) fail(`to 模擬帳務: ${JSON.stringify({ selected, opened })}`);
  if (!pop.hidden) fail("no popover while 模擬帳務 is on the page");
  // Showing: straight there.
  cell("bid", 1).click();
  if (opened.at(-1)?.price !== 48.55 || selected.length !== 1) fail(`a showing 模擬帳務 opens without switching: ${JSON.stringify({ selected, opened })}`);

  // No 模擬帳務: the popover beside the book at the price.
  ledgerPlace = "none";
  cell("bid", 3).click();
  await wait(30);
  await settle();
  if (pop.hidden) fail("the popover opens without 模擬帳務");
  if (opened.length !== 2) fail("the popover, not 模擬帳務");
  const p = pop.getBoundingClientRect(), b = host.querySelector('[data-role="orderbook-root"]').getBoundingClientRect();
  if (!(p.left >= b.right || p.right <= b.left) || p.top < 0 || p.bottom > innerHeight) fail(`beside the book, in the window: ${JSON.stringify(p)} vs ${JSON.stringify(b)}`);
  const price = $('[data-ticket="price"]'), qty = $('[data-ticket="qty"]');
  if (price.value !== "48.45" || qty.value !== "1") fail(`at the price clicked, 1 張: ${price.value} ${qty.value}`);
  if (!$(".paper-order-popover-title").textContent.includes("2303 聯電")) fail(`names the stock: ${$(".paper-order-popover-title").textContent}`);
  if ($('[data-ticket="room"]').textContent !== "額度 1,642,300 · 庫存 2,000 股") fail(`額度 and 庫存: ${$('[data-ticket="room"]').textContent}`);
  if (pop.textContent.includes("ROD") || pop.textContent.includes("IOC")) fail("no 委託條件 to choose");
  $('[data-ticket-step="qty:1"]').click();
  const amount = Math.round(buyCost(tradeTerms.stock, 2000, 48.45)).toLocaleString("zh-TW");
  if (!$('[data-ticket="amount"]').textContent.startsWith(`買 ≈ ${amount}`)) fail(`the amount: ${$('[data-ticket="amount"]').textContent}`);
  // Another price while it is open: it moves there.
  cell("ask", 0).click();
  await settle();
  if (price.value !== "48.65" || pop.hidden) fail(`a second price reopens it there: ${price.value}`);
  if (price.scrollWidth > price.clientWidth + 1) fail(`48.65 fits its box: ${price.scrollWidth} > ${price.clientWidth}`);
  $('[data-ticket-step="qty:1"]').click();
  // A double click is one order; the popover alone decides the side buttons (D08-11): 買進 waits while its order is
  // out, 賣出 is not touched, and 買進 is usable again once the order is answered.
  $('[data-ticket-side="buy"]').click();
  $('[data-ticket-side="buy"]').click();
  if (!$('[data-ticket-side="buy"]').disabled || $('[data-ticket-side="sell"]').disabled) fail("買進 waits while its order is out, 賣出 does not");
  await wait(30);
  if ($('[data-ticket-side="buy"]').disabled) fail("買進 is usable again once its order is answered");
  if (JSON.stringify(placed) !== JSON.stringify([{ code: "2303", side: "買進", qty: 2000, price_type: "limit", tif: "ROD", price: 48.65 }])) fail(`買進 places a limit ROD: ${JSON.stringify(placed)}`);
  if (pop.hidden || !$(".paper-order-popover-message").textContent.startsWith("已送出買進")) fail(`it says what was sent: ${$(".paper-order-popover-message").textContent}`);
  window.__entry = { popover, cell, feed, futures, placed, opened };
  return { ok: true };
}

async function finish() {
  const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const fail = (message) => { throw new Error(message); };
  const { popover, cell, feed, futures, opened } = window.__entry;
  const pop = popover.root;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  if (!pop.hidden) fail("Esc closes it");
  cell("bid", 0).click();
  await settle();
  document.getElementById("elsewhere").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  if (!pop.hidden) fail("a click outside closes it");
  // A futures book: nothing opens.
  feed(futures);
  await settle();
  cell("bid", 0).click();
  await settle();
  if (!pop.hidden || opened.length !== 2) fail("a futures price opens no 模擬 order");
  popover.destroy();
  if (document.querySelector(".paper-order-popover")) fail("destroy removes it");
  return { ok: true };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { sandbox: false } });
  const fixture = path.join(__dirname, "fixtures", "renderer_ui_geometry.html");
  await win.loadURL(pathToFileURL(fixture).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)}).then((r) => r.ok)`);
    if (process.env.PAPER_ORDER_POPOVER_SCREENSHOT) fs.writeFileSync(process.env.PAPER_ORDER_POPOVER_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`(${finish.toString()})().then((r) => r.ok)`);
    console.log("paper order entry ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("paper order entry ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
