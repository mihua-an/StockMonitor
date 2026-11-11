const { makeTempDir } = require("./support/temp_dirs.cjs");
// 價量 follows the current price in a real Chromium (run with Electron), the component on a fake data source (使用者
// 10-22). Checked: a new instrument centres the current price; a price that moves past the bottom or the top of the
// panel is scrolled back into view; scrolled away (the current price off screen) the panel is not moved by any update;
// scrolled back so the current price shows, it follows again.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-price-flow-follow-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const fail = (message) => { throw new Error(message); };
  const frames = (n = 3) => new Promise((resolve) => { const step = (k) => (k ? requestAnimationFrame(() => step(k - 1)) : resolve()); step(n); });
  const { PriceFlowComponent } = await import(`${base}js/core/components/price_flow_component.js`);

  let push = null;
  const context = {
    mode: "live",
    symbolStore: { getSelectedSymbol: () => "2330", subscribe: () => () => {} },
    dataSource: { invalidate: () => {}, subscribe: (_name, fn) => { push = fn; return () => {}; } },
    services: {},
  };
  const host = document.createElement("section");
  host.style.cssText = "width:520px;height:330px;display:flex;flex-direction:column";
  document.querySelector("main").appendChild(host);
  const component = new PriceFlowComponent();
  component.mount({ host, context });

  const prices = Array.from({ length: 60 }, (_, n) => 100 + n);
  const vm = (current) => ({
    code: "2330", identity: "2330", currentPrice: current, referencePrice: 130,
    priceVolume: {
      flow_fields: ["large_buy", "large_sell", "small_buy", "small_sell", "unclassified_buy", "unclassified_sell"],
      buckets: prices.map((price) => ({ price, volume: 10, out: 5, in: 5, flow: [1, 1, 4, 4, 0, 0] })),
    },
  });
  const scroll = host.querySelector('[data-role="price-flow-scroll"]');
  // Whether the current price row is wholly on screen, below the sticky header.
  const currentShown = () => {
    const row = scroll.querySelector("tbody tr.is-current");
    if (!row) return false;
    const view = scroll.getBoundingClientRect(), head = scroll.querySelector("thead").getBoundingClientRect(), rect = row.getBoundingClientRect();
    return rect.top >= head.bottom - 1 && rect.bottom <= view.bottom + 1;
  };
  const show = async (current) => { push(vm(current)); await frames(); };

  await show(130);
  if (!currentShown()) fail("a new instrument shows its current price");
  await show(100);           // the lowest price: past the bottom of the panel
  if (!currentShown()) fail("a price past the bottom is scrolled back into view");
  // Scrolled just onto the bottom row, no room kept; a price on screen, even on the edge row, never moves the panel.
  const edge = scroll.scrollTop;
  await show(101);
  if (scroll.scrollTop !== edge) fail(`a price still on screen does not scroll: ${edge} -> ${scroll.scrollTop}`);
  const pitch = component.rowSnap.rowHeight;
  const bottomRow = scroll.querySelector("tbody tr:last-child").getBoundingClientRect();
  if (scroll.getBoundingClientRect().bottom - bottomRow.bottom > 1) fail("the lowest price sits on the bottom row");
  // The rows below the sticky header: the top one holds 100 + (rows - 1).
  await show(100 + Math.floor(scroll.clientHeight / pitch) - 2);
  if (scroll.scrollTop !== edge) fail("a price on the top row is on screen: no scroll");
  await show(159);           // the highest: past the top
  if (!currentShown()) fail("a price past the top is scrolled back into view");

  // The user scrolls to the bottom to read other prices: the current price (at the top) is off screen.
  component.rowSnap.scrollToIndex(component.rowCount);
  await frames();
  if (currentShown()) fail("the setup scrolled the current price off screen");
  const reading = scroll.scrollTop;
  await show(150);
  await show(158);
  if (scroll.scrollTop !== reading) fail(`scrolled away, an update never moves the panel: ${reading} -> ${scroll.scrollTop}`);

  // Scrolled back so the current price shows: it follows again.
  component.rowSnap.scrollToIndex(0);
  await frames();
  if (!currentShown()) fail("the current price is back on screen");
  await show(100);
  if (!currentShown()) fail("following again after scrolling back to the current price");
  return { ok: true };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { sandbox: false } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)})`);
    console.log("price flow follow ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("price flow follow ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
