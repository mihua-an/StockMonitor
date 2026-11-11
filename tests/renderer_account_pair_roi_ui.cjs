const { makeTempDir } = require("./support/temp_dirs.cjs");
// 配對明細's 報酬率 in Chromium (run with Electron), on the real account.html markup and a fake app_api: a pair's rate is
// the one the ledger serialized (AccountReadService._pair_row `roi`, the same row every answer carries), never worked
// out again in the page from its 買進／賣出金額. The fixture's rates are deliberately not profit / amount, so a page that
// recomputed them would show other numbers; a pair the ledger gives no rate (nothing put in) shows none.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-account-pair-roi-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base, accountHtml, sources) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fail = (message) => { throw new Error(message); };
  window.desktopAPI = { networkManifest: { routes: [["/api/", "app_api"]], services: { app_api: { url: "http://app.invalid" } } } };
  const pair = (id, direction, tradeType, roi) => ({
    id, realized_date: "2026-10-15", market: "台股", code: "2330", name: "台積電", trade_type: tradeType, direction,
    qty: 1000, buy_price: 100, sell_price: 102, buy_amount: 100000, sell_amount: 102000, tax: 0, fee: 0, buy_fee: 0, sell_fee: 0,
    profit: 2000, roi, invested_amount: 100000, buy_ref: "09:05:12", sell_ref: "09:20:40", entry_ref: "09:05:12",
    exit_ref: "09:20:40", entry_minute: 545, entry_band: "09:00~09:10", hold_period: 15, sort_order: id,
  });
  // profit / buy_amount is 2.00% and profit / sell_amount 1.96%: neither is what the ledger sent.
  const pairs = [pair(1, "多", "當沖", 0.0123), pair(2, "空", "當沖", 0.0456), pair(3, "", "一般", null)];
  window.fetch = async (input) => {
    const url = new URL(String(input?.url || input));
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/api/sources") return json({ source_settings: { enabled_sources: [], sources: {} } });
    if (url.pathname === "/api/actual-account/day") return json({ ok: true, available: true, trades: [], pairs });
    return json({ ok: false, error: `unexpected ${url.pathname}` }, 404);
  };

  document.querySelector("main").innerHTML = accountHtml;
  document.querySelector('[data-account-view-panel="pairs"]').hidden = false;
  const { account, actualAccountExpandedPairDays } = await import(`${base}js/features/account/account_state.js`);
  const { renderPairDetails } = await import(`${base}js/features/account/daily_pairs_view.js`);
  account.mode = "actual";
  account.market = "台股";
  account.dashboard = { analytics: { 台股: { available: true, stock_stats: [], daily_stats: [], pair_days: [{ date: "2026-10-15", total_profit: 6000, daytrade_profit: 4000, total_count: 3 }] } } };
  account.currentView = "pairs";
  actualAccountExpandedPairDays.add("2026-10-15");
  renderPairDetails();
  await wait(50);

  const text = (id) => document.querySelector(`.account-daily-pair-row[data-pair-id="${id}"]`)?.textContent || fail(`pair ${id} is listed`);
  if (!text(1).includes("(1.23%)")) fail(`a 多 pair shows the ledger's rate: ${text(1)}`);
  if (!text(2).includes("(4.56%)")) fail(`a 空 pair shows the ledger's rate: ${text(2)}`);
  for (const id of [1, 2, 3]) {
    if (text(id).includes("2.00%") || text(id).includes("1.96%")) fail(`pair ${id}'s rate is not worked out from its amounts: ${text(id)}`);
  }
  if (text(3).includes("%")) fail(`a pair the ledger gives no rate shows none: ${text(3)}`);

  // No account view works a pair's 報酬率 out of its amounts.
  for (const [file, source] of Object.entries(sources)) {
    if (/pairRoiBase|profit\)?\s*(\|\|\s*0\)?\s*)?\/\s*\(?\s*(Number\()?\s*pair\??\.(buy|sell)_amount/.test(source)) fail(`${file} computes a pair's 報酬率`);
  }
  return { ok: true };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 1000, webPreferences: { sandbox: false } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  const accountHtml = fs.readFileSync(path.join(__dirname, "..", "ui", "renderer", "pages", "account.html"), "utf8");
  const featureDir = path.join(__dirname, "..", "ui", "renderer", "js", "features", "account");
  const sources = Object.fromEntries(fs.readdirSync(featureDir).filter((name) => name.endsWith(".js"))
    .map((name) => [name, fs.readFileSync(path.join(featureDir, name), "utf8")]));
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)}, ${JSON.stringify(accountHtml)}, ${JSON.stringify(sources)})`);
    console.log("account pair roi ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("account pair roi ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
