// The shared stock card (core/stock_card.js) in a real Chromium (run with Electron) on the real stylesheets: 現價 at the
// official 漲停 / 跌停 is 紅底白字 / 綠底白字 in both lists that draw it -- a product list too narrow for its table
// (product_cards.js) and 歷史回放's list (stock_list.js). No official limit means no mark, whatever the change; a 試撮
// price is compared and marked "#" as in the table; and a row leaving the limit loses the box.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { makeTempDir } = require("./support/temp_dirs.cjs");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-stock-card-limit-price-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const fail = (message) => { throw new Error(message); };
  const main = document.querySelector("main");
  main.innerHTML = `<div id="host" style="width:300px"><div data-role="product-list-cards"></div></div>
    <div id="historyStockList" style="width:300px;height:300px;overflow:auto"></div>`;
  const { renderProductCards } = await import(`${base}js/features/realtime/components/product_cards.js`);
  const { historyState } = await import(`${base}js/features/history/history_state.js`);
  const { renderHistoryStockList } = await import(`${base}js/features/history/stock_list.js`);

  const row = (code, last, prev, extra = {}) => ({ code, ...extra, change: last - prev, change_pct: (last - prev) / prev * 100,
    marketRead: { identity: { code }, channels: { summary: { data: { label: code } }, quote: { data: { lastPrice: last, prevClose: prev, dayHigh: last, dayLow: last, openPrice: prev } } } } });
  const host = document.getElementById("host");
  const closeOf = (code) => host.querySelector(`[data-card-code="${code}"] .history-stock-close`);
  renderProductCards({ root: host, rows: [
    row("UP", 132.5, 120.5, { limit_up: 132.5, limit_down: 108.5 }),
    row("DOWN", 108.5, 120.5, { limit_up: 132.5, limit_down: 108.5 }),
    row("PLAIN", 125, 120.5, { limit_up: 132.5, limit_down: 108.5 }),
    // +9.96% with no official limit: never derived from 昨收.
    row("NOLIMIT", 132.5, 120.5),
    row("AUCTION", 100, 120.5, { limit_up: 132.5, limit_down: 108.5, status: "simtrade", indicative_price: 132.5 }),
  ] });

  historyState.historyUnavailable = "";
  historyState.selectedCode = "";
  historyState.loadingCode = "";
  historyState.stocks = [
    { code: "HUP", name: "a", open: 1, high: 2, low: 1, close: 132.5, change: 12, change_pct: 9.96, limit_up: 132.5, limit_down: 108.5 },
    { code: "HDOWN", name: "b", open: 1, high: 2, low: 1, close: 108.5, change: -12, change_pct: -9.96, limit_up: 132.5, limit_down: 108.5 },
    { code: "HNONE", name: "c", open: 1, high: 2, low: 1, close: 132.5, change: 12, change_pct: 9.96 },
  ];
  renderHistoryStockList();
  const history = (code) => document.querySelector(`[data-history-code="${code}"] .history-stock-close`);

  const probe = document.createElement("div");
  document.body.appendChild(probe);
  const token = (name) => { probe.style.color = `var(${name})`; return getComputedStyle(probe).color; };
  const css = (node) => { const s = getComputedStyle(node); const b = node.getBoundingClientRect();
    return { bg: s.backgroundColor, color: s.color, weight: s.fontWeight, font: s.fontSize, w: b.width, h: b.height, text: node.textContent, cls: node.className }; };
  const seen = { up: css(closeOf("UP")), down: css(closeOf("DOWN")), plain: css(closeOf("PLAIN")), noLimit: css(closeOf("NOLIMIT")), auction: css(closeOf("AUCTION")),
    hUp: css(history("HUP")), hDown: css(history("HDOWN")), hNone: css(history("HNONE")),
    limitUp: token("--limit-up-bg"), limitDown: token("--limit-down-bg"), white: token("--white"), upColor: token("--price-up-color") };

  // A refresh that leaves the limit writes the class on the same element (morphInto, no rebuild).
  const node = closeOf("UP");
  renderProductCards({ root: host, rows: [row("UP", 130, 120.5, { limit_up: 132.5, limit_down: 108.5 })], changedCodes: new Set(["UP"]), topologyChanged: true });
  seen.leftSameNode = closeOf("UP") === node;
  seen.leftClass = closeOf("UP").className;
  return seen;
}

function check(at) {
  const problems = [];
  for (const [id, bg] of [["up", at.limitUp], ["down", at.limitDown], ["auction", at.limitUp], ["hUp", at.limitUp], ["hDown", at.limitDown]]) {
    if (at[id].bg !== bg) problems.push(`${id}: background ${at[id].bg}, not ${bg}`);
    if (at[id].color !== at.white) problems.push(`${id}: text ${at[id].color}, not white`);
    if (at[id].weight !== "900") problems.push(`${id}: weight ${at[id].weight}, not base.css's 900`);
    if (at[id].h > 22) problems.push(`${id}: the box is ${at[id].h}px tall`);
  }
  for (const id of ["plain", "noLimit", "hNone"]) {
    if (/limit-(up|down)-price/.test(at[id].cls)) problems.push(`${id}: marked without being at an official limit: ${at[id].cls}`);
    if (at[id].bg !== "rgba(0, 0, 0, 0)") problems.push(`${id}: background ${at[id].bg}`);
    if (at[id].color !== at.upColor) problems.push(`${id}: text ${at[id].color}, not the up colour`);
    if (at[id].weight !== "400") problems.push(`${id}: weight ${at[id].weight}`);
  }
  if (at.auction.text !== "#132.50") problems.push(`the 試撮 price reads ${at.auction.text}, not #132.50`);
  if (!at.leftSameNode) problems.push("leaving the limit rebuilt the price element");
  if (/limit-(up|down)-price/.test(at.leftClass)) problems.push(`the box stayed after leaving the limit: ${at.leftClass}`);
  return problems;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 700, height: 800, webPreferences: { sandbox: false, offscreen: true } });
  const fixture = path.join(__dirname, "fixtures", "renderer_ui_geometry.html");
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    await win.loadURL(pathToFileURL(fixture).href);
    const at = await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)})`);
    console.log(JSON.stringify({ up: at.up, plain: at.plain, hUp: at.hUp, limitUp: at.limitUp, white: at.white }));
    const problems = check(at);
    if (problems.length) {
      console.error(`stock card limit price ui contract FAILED: ${problems.join("; ")}`);
      app.exit(1);
      return;
    }
    console.log("stock card limit price ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error(`stock card limit price ui contract FAILED: ${error?.stack || error}`);
    app.exit(1);
  }
});
