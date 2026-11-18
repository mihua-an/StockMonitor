// The stock card's 漲跌 (core/stock_card.js) in both lists that draw it -- a product list too narrow for its table
// (product_cards.js) and 歷史回放's list (stock_list.js) -- is written and coloured as every product header writes it
// (product_quote_header.js formatQuoteChange / quoteMoveClass): the colour is the sign of the change as shown, two
// decimals, so a float remainder or a US move under half a cent is a flat "0.00", never a red or green 0.00.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { makeTempDir } = require("./support/temp_dirs.cjs");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-stock-card-change-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const main = document.querySelector("main");
  main.innerHTML = `<div id="host" style="width:300px"><div data-role="product-list-cards"></div></div>
    <div id="historyStockList" style="width:300px;height:300px;overflow:auto"></div>`;
  const { renderProductCards } = await import(`${base}js/features/realtime/components/product_cards.js`);
  const { historyState } = await import(`${base}js/features/history/history_state.js`);
  const { renderHistoryStockList } = await import(`${base}js/features/history/stock_list.js`);
  const { formatQuoteChange, quoteMoveClass } = await import(`${base}js/core/components/product_quote_header.js`);

  // A row whose Market Runtime change is given as is (displayQuote reads change / change_pct from the quote channel).
  const row = (code, last, change, pct) => ({ code, change, change_pct: pct,
    marketRead: { identity: { code }, channels: { summary: { data: { label: code } },
      quote: { data: { lastPrice: last, prevClose: last - change, change, changePct: pct, dayHigh: last, dayLow: last, openPrice: last } } } } });
  const cases = [["REM", 100, 1e-12, 1e-12], ["CENT", 10, -0.004, -0.004], ["UP", 10, 0.5, 5], ["DOWN", 10, -0.25, -2.5]];
  const host = document.getElementById("host");
  renderProductCards({ root: host, rows: cases.map(([code, last, change, pct]) => row(code, last, change, pct)) });
  historyState.historyUnavailable = "";
  historyState.selectedCode = "";
  historyState.loadingCode = "";
  historyState.stocks = cases.map(([code, last, change, pct]) => ({ code: `H${code}`, name: code, open: last, high: last, low: last, close: last, change, change_pct: pct }));
  renderHistoryStockList();

  const out = [];
  for (const [code, , change, pct] of cases) {
    const want = { text: formatQuoteChange(change, pct), cls: quoteMoveClass(change) };
    for (const [where, node] of [["card", host.querySelector(`[data-card-code="${code}"] .history-stock-change`)],
      ["history", document.querySelector(`[data-history-code="H${code}"] .history-stock-change`)]]) {
      out.push({ code, where, want, text: node?.textContent ?? null, cls: node?.className ?? null });
    }
  }
  return out;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 700, height: 800, webPreferences: { sandbox: false, offscreen: true } });
  const fixture = path.join(__dirname, "fixtures", "renderer_ui_geometry.html");
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    await win.loadURL(pathToFileURL(fixture).href);
    const seen = await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)})`);
    const problems = [];
    for (const s of seen) {
      if (s.text !== s.want.text) problems.push(`${s.where} ${s.code}: text ${s.text}, not ${s.want.text}`);
      if (!String(s.cls).split(/\s+/).includes(s.want.cls)) problems.push(`${s.where} ${s.code}: class ${s.cls}, not ${s.want.cls}`);
    }
    const flat = seen.filter((s) => ["REM", "CENT"].includes(s.code));
    if (flat.some((s) => s.want.cls !== "price-flat" || s.want.text !== "0.00(0.00%)")) problems.push(`the shared rule changed: ${JSON.stringify(flat.map((s) => s.want))}`);
    if (problems.length) {
      console.error(`stock card change ui contract FAILED: ${problems.join("; ")}`);
      app.exit(1);
      return;
    }
    console.log("stock card change ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error(`stock card change ui contract FAILED: ${error?.stack || error}`);
    app.exit(1);
  }
});
