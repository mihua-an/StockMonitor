const { makeTempDir } = require("./support/temp_dirs.cjs");
const { fixViewport } = require("./support/fixed_viewport.cjs");
// 帳務 個股數據 in a real Chromium (run with Electron) on the real page markup (user 11-07): the table has the user's
// twelve columns in the user's order and, with a stock open, nothing in it scrolls sideways (its columns and its trades'
// columns are shares of the card, not fixed px summing past it) nor cuts a cell's text at a 1300 px window; the detail
// opens as wide as the table -- its cards and trades never reach past the table's right edge.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-account-stock-stat-expand-width-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base, accountHtml) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fail = (message) => { throw new Error(message); };
  window.desktopAPI = { networkManifest: { routes: [["/api/", "app_api"]], services: { app_api: { url: "http://app.invalid" } } } };
  const pair = { id: 7, realized_date: "2026-11-04", market: "台股", code: "2344", name: "華邦電", trade_type: "當沖", direction: "空",
    qty: 2000, buy_price: 142, sell_price: 144, buy_amount: 284000, sell_amount: 288000, tax: 432, fee: 229, buy_fee: 115, sell_fee: 114,
    profit: 3339, roi: 0.0116, buy_ref: "10:00:00", sell_ref: "09:10:00", entry_ref: "09:10:00", exit_ref: "10:00:00", entry_minute: 550,
    hold_period: 50, sort_order: 1 };
  window.fetch = async (input) => {
    const url = new URL(String(input?.url || input));
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.pathname.endsWith("/pairs")) return json({ ok: true, available: true, items: [pair] });
    if (url.pathname === "/api/sources") return json({ source_settings: { enabled_sources: [], sources: {} } });
    return json({ ok: true, items: [] });
  };
  const main = document.querySelector("main");
  main.innerHTML = accountHtml;
  document.querySelectorAll(".account-view[data-account-view-panel]").forEach((panel) => {
    const on = panel.dataset.accountViewPanel === "stockStats";
    panel.hidden = !on;
    panel.classList.toggle("active", on);
  });
  const { installStandardDataGridSystem } = await import(`${base}js/core/data_grid.js`);
  installStandardDataGridSystem(main);
  const { account } = await import(`${base}js/features/account/account_state.js`);
  const { renderStockStats } = await import(`${base}js/features/account/stock_stats_view.js`);
  const item = { code: "2344", name: "華邦電", holding_qty: 0, holding_cost: 0, total_profit: 3339, normal_profit: 0, daytrade_profit: 3339,
    daytrade_win_rate: 1, daytrade_profit_loss_ratio: null, long_profit: null, long_profit_loss_ratio: null, short_profit: 3339,
    short_profit_loss_ratio: null, total_count: 1, avg_trade_profit: 3339, return_rate: 0.0116, win_rate: 1, profit_loss_ratio: null,
    win_count: 1, loss_count: 0, normal_count: 0, daytrade_count: 1, daytrade_return_rate: 0.0116, daytrade_tax: 432, daytrade_fee: 229,
    avg_daytrade_profit: 3339, daytrade_buy_qty: 2000, daytrade_sell_qty: 2000, daytrade_buy_amount: 284000, daytrade_sell_amount: 288000,
    short_count: 1, short_win_rate: 1, avg_short_profit: 3339, short_return_rate: 0.0116, long_count: 0 };
  account.mode = "actual";
  account.market = "台股";
  account.currentView = "stockStats";
  account.dashboard = { analytics: { 台股: { available: true, stock_stats: [item], daily_stats: [], pair_days: [] } } };
  renderStockStats(account.dashboard.analytics["台股"]);
  await wait(200);
  document.querySelector('tr[data-stock-stat-code="2344"]').click();
  await wait(1200);   // the open motion and the pairs' read have settled
  const heads = [...document.querySelectorAll(".account-stock-stats-table > thead th")].map((th) => th.textContent.trim());
  if (heads.join(",") !== "股號,股名,庫存,庫存成本,淨損益,當沖淨損益,當沖勝率,多單收益,空單收益,當沖盈虧比,多單盈虧比,空單盈虧比") fail(`the stock table's columns are ${heads.join(",")}`);
  const statsWrap = document.querySelector(".account-stock-stats-table-wrap");
  const scroller = [statsWrap, ...statsWrap.querySelectorAll("*")].find((el) => el.scrollWidth > el.clientWidth + 1
    && ["auto", "scroll"].includes(getComputedStyle(el).overflowX));
  const cut = [...statsWrap.querySelectorAll("th, td")].filter((cell) => !cell.hasAttribute("colspan") && cell.textContent.trim()
    && cell.scrollWidth > cell.clientWidth + 1).map((cell) => `${cell.textContent.trim()}(${cell.scrollWidth}>${cell.clientWidth})`);
  if (cut.length) fail(`cells cut off: ${cut.join(" ")}`);
  if (scroller) fail(`${scroller.className} scrolls sideways: ${scroller.scrollWidth}px in ${scroller.clientWidth}px`);
  const table = document.querySelector(".account-stock-stats-table").getBoundingClientRect();
  const stack = document.querySelector(".account-stock-stat-expanded-stack");
  if (!stack) fail("the detail did not open");
  if (stack.scrollWidth > Math.ceil(table.width) + 1) fail(`the detail is ${stack.scrollWidth}px wide under a ${Math.round(table.width)}px table`);
  const parts = [...stack.querySelectorAll(".account-stock-stat-group, .account-stock-inline-trades, .account-stock-inline-table-wrap")];
  if (!parts.length) fail("no cards or trades table in the detail");
  for (const part of parts) {
    const right = part.getBoundingClientRect().right;
    if (right > table.right + 1) fail(`${part.className} ends at ${Math.round(right)}, past the table's right edge ${Math.round(table.right)}`);
  }
  const groups = [...stack.querySelectorAll(".account-stock-stat-detail-grid > .account-stock-stat-group")].map((g) => g.getBoundingClientRect());
  if (groups.length >= 2 && Math.abs(groups[0].width - groups[1].width) > 1) fail("the two cards of a row are not one width");
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1300, height: 1000, webPreferences: { sandbox: false, offscreen: true } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  await fixViewport(win, 1300, 1000);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  const html = fs.readFileSync(path.join(__dirname, "..", "ui", "renderer", "pages", "account.html"), "utf8");
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)}, ${JSON.stringify(html)})`);
    console.log("account stock stat expand width ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("account stock stat expand width ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
