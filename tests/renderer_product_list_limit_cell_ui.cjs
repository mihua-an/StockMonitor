// A 漲停 / 跌停 price in the product list keeps base.css's red / green box with white text in a selected row, in a real
// Chromium (run with Electron) on the real stylesheets: the selected row's background is every other cell's, and no
// product-list rule restates the limit box.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { makeTempDir } = require("./support/temp_dirs.cjs");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-product-list-limit-cell-ui-"));
app.on("window-all-closed", () => {});

function scenario() {
  const main = document.querySelector("main");
  main.innerHTML = `<div class="product-list"><div class="product-list-table-wrap">
    <table data-role="product-list-table" class="product-list-table lined-rows"><tbody>
      <tr class="product-list-selected-row"><td id="name">台積電</td><td id="up" class="price-up limit-up-price">1,100</td></tr>
      <tr class="product-list-selected-row"><td>鴻海</td><td id="down" class="price-down limit-down-price">90.0</td></tr>
      <tr><td>聯發科</td><td id="plainUp" class="price-up limit-up-price">1,500</td></tr>
    </tbody></table></div></div>
    <div class="account-page"><table class="data-table finance-table"><tbody><tr><td id="profit" class="price-up">1</td><td id="loss" class="price-down">-1</td><td id="plainCell">0</td></tr><tr><td id="emptyCell" class="empty" colspan="3">無資料</td></tr></tbody></table></div>
    <div class="trend-info-row trend-stock-metrics"><div><b id="metric" class="price-up">1.0%</b><b id="metricPlain">--</b></div></div>
    <table class="record-table trade-details-table"><tbody><tr class="trade-details-row"><td id="flat" class="price-flat">0</td><td id="record">x</td></tr></tbody></table>
    <div class="orderbook"><table class="orderbook-table"><tbody><tr><td><span id="book" class="orderbook-price-value price-up limit-up-price">10</span></td></tr></tbody></table></div>
    <div class="product-quote-header"><div class="product-quote-price-box"><div id="quote" class="quote-main-price price-down limit-down-price">9</div></div></div>`;
  const css = (id) => { const s = getComputedStyle(document.getElementById(id)); return [s.backgroundColor, s.color]; };
  const probe = document.createElement("div");
  document.body.appendChild(probe);
  const token = (name) => { probe.style.color = `var(${name})`; return getComputedStyle(probe).color; };
  return { name: css("name"), up: css("up"), down: css("down"), plainUp: css("plainUp"),
    profit: css("profit"), loss: css("loss"), plainCell: css("plainCell"), flat: css("flat"), record: css("record"),
    book: css("book"), quote: css("quote"), emptyCell: css("emptyCell"), metric: css("metric"), metricPlain: css("metricPlain"),
    slate100: token("--slate-100"),
    limitUp: token("--limit-up-bg"), limitDown: token("--limit-down-bg"), white: token("--white"), active: token("--row-active-bg"),
    upColor: token("--price-up-color"), downColor: token("--price-down-color"), flatColor: token("--price-flat-color"),
    slate50: token("--slate-50"), blue50x: token("--blue-50x") };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 600, height: 400, webPreferences: { sandbox: false, offscreen: true } });
  const fail = (message) => { console.error(`product list limit cell ui contract FAILED: ${message}`); app.exit(1); };
  try {
    await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
    const at = await win.webContents.executeJavaScript(`(${scenario.toString()})()`);
    if (at.name[0] !== at.active) return fail(`a selected row's cell is ${at.name[0]}, not the selected background ${at.active}`);
    for (const [id, bg] of [["up", at.limitUp], ["down", at.limitDown], ["plainUp", at.limitUp]]) {
      if (at[id][0] !== bg) return fail(`${id}: the limit cell's background is ${at[id][0]}, not ${bg}`);
      if (at[id][1] !== at.white) return fail(`${id}: the limit cell's text is ${at[id][1]}, not white`);
    }
    // The market colours are base.css's alone, on any table's cell: 帳務's profit / loss, 交易明細's flat, a cell
    // without one keeps its table's default; 五檔 and the product header's limit price are white on its box.
    for (const [id, color] of [["profit", at.upColor], ["loss", at.downColor], ["flat", at.flatColor],
      ["plainCell", at.slate50], ["emptyCell", at.slate50], ["record", at.blue50x], ["metric", at.upColor], ["metricPlain", at.slate100], ["book", at.white], ["quote", at.white]]) {
      if (at[id][1] !== color) return fail(`${id}: text ${at[id][1]}, not ${color}`);
    }
    if (at.book[0] !== at.limitUp || at.quote[0] !== at.limitDown) return fail(`limit boxes: ${at.book[0]} / ${at.quote[0]}`);
    console.log("product list limit cell ui contract passed");
    app.exit(0);
  } catch (error) {
    fail(error?.stack || error);
  }
});
