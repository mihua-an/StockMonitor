// The rows under an opening / closing block move with it, frame by frame, in a real Chromium (run with Electron)
// (使用者 11-02 影片：收合時內容淡出、空位留著，最後下面的列一次跳上來). Traced per animation frame: the row under
//   資料中心's date detail (a block in a detail row, its categories read when it opens),
//   資料中心's 期貨指數 → 日盤／夜盤 (table rows themselves),
//   帳務 每日明細's day (the page draws the table again when the day's trades arrive).
// The row's last move before it rests must be small: it got there with the block, not in one jump at the end (a detail
// cell held at the page table's 40 px row height, a block that grew to an empty placeholder and then jumped to its
// content, a table row whose height cannot animate).
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { makeTempDir } = require("./support/temp_dirs.cjs");

app.disableHardwareAcceleration();
require("./support/keep_motion.cjs").keepMotion(app);
app.setPath("userData", makeTempDir("stockmonitor-expand-motion-ui-"));
app.on("window-all-closed", () => {});

// Shared by both scenarios (stringified into the page).
const tracer = `
  const trace = async (act, probe, ms) => {
    const out = [];
    const t0 = performance.now();
    act();
    while (performance.now() - t0 < ms) {
      await new Promise((r) => requestAnimationFrame(r));
      const el = probe();
      if (el) out.push(Math.round(el.getBoundingClientRect().top));
    }
    return out;
  };`;

async function dataCenter(base, html) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.desktopAPI = { networkManifest: { routes: [["/api/", "app_api"]], services: { app_api: { url: "http://app.invalid" } } } };
  const view = (products, quote, materialization) => ({ products, rows: { tick: 0, bidask: 0, quote }, bytes: 1000, materialization });
  const categories = [
    { id: "taiex", ...view(1, 5402, { state: "succeeded" }) },
    { id: "futures", ...view(1, 41876, null), sessions: [{ id: "DAY", ...view(1, 30110, { state: "succeeded" }) },
      { id: "NIGHT", ...view(1, 11766, { state: "succeeded" }) }] },
    { id: "industry", ...view(14, 61420, { state: "succeeded" }) },
  ];
  window.fetch = async (input) => {
    const url = new URL(String(input?.url || input));
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/api/sources") return json({ source_settings: { enabled_sources: [], sources: {} } });
    await wait(60);
    if (url.pathname === "/api/data-center/dates") return json({ ok: true, items: [
      { date: "2026-10-27", complete: true, storage: { ALL: { products: 1, rows: { tick: 100 }, bytes: 2048 } } },
      { date: "2026-10-24", complete: true, storage: { ALL: { products: 1, rows: { tick: 100 }, bytes: 2048 } } }] });
    if (url.pathname === "/api/data-center/date") return json({ ok: true, trading_date: url.searchParams.get("date"), categories });
    if (url.pathname === "/api/data-center/closing") return json({ ok: true, trading_date: null, stage: "waiting_close", sessions: [] });
    return json({ ok: true, items: [] });
  };
  document.querySelector("main").innerHTML = html;
  const page = await import(`${base}js/pages/data_center.js`);
  page.initDataCenterPage();
  await page.refreshDataCenter();
  await wait(100);
  __TRACER__
  const dateRow = () => document.querySelector("tr.dc-daily-row");
  const nextDate = () => document.querySelectorAll("tr.dc-daily-row")[1];
  const futures = () => document.querySelector('tr[data-dc-category="futures"]');
  const below = () => [...document.querySelectorAll(".dc-category-table > tbody > tr")].find((row) => row.textContent.includes("產業指數"));
  return {
    "資料中心 date opens (its categories read)": await trace(() => dateRow().click(), nextDate, 600),
    "資料中心 期貨指數 opens 日盤／夜盤": await trace(() => futures().click(), below, 520),
    "資料中心 期貨指數 closes": await trace(() => futures().click(), below, 450),
    "資料中心 date closes": await trace(() => dateRow().click(), nextDate, 450),
  };
}

async function accountDaily(base, html) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.desktopAPI = { networkManifest: { routes: [["/api/", "app_api"]], services: { app_api: { url: "http://app.invalid" } } } };
  window.fetch = async (input) => {
    const url = new URL(String(input?.url || input));
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/api/sources") return json({ source_settings: { enabled_sources: [], sources: {} } });
    await wait(80);
    // The day's trades: read after the day opens, the block grows from 載入中 to them.
    const trade = (id, time, action) => ({ trade_id: id, time, code: "4958", name: "臻鼎-KY", market: "台股", action, is_daytrade: true,
      qty: 1000, avg_price: 488, gross_amount: 488000, fee: 195, tax: 0, fills: [] });
    if (url.pathname.endsWith("/day")) return json({ ok: true, trades: [trade("a", "13:03:31", "買進"), trade("b", "10:49:04", "賣出")], pairs: [] });
    return json({ ok: true, items: [] });
  };
  document.querySelector("main").innerHTML = html;
  document.querySelector(".account-main-pane").style.height = "900px";
  document.querySelectorAll(".account-view[data-account-view-panel]").forEach((panel) => {
    const on = panel.dataset.accountViewPanel === "daily";
    panel.hidden = !on;
    panel.classList.toggle("active", on);
  });
  const { installStandardDataGridSystem } = await import(`${base}js/core/data_grid.js`);
  installStandardDataGridSystem(document.querySelector("main"));
  const { account } = await import(`${base}js/features/account/account_state.js`);
  const { renderDailyStats } = await import(`${base}js/features/account/daily_pairs_view.js`);
  account.mode = "actual"; account.market = "台股"; account.currentView = "daily";
  const day = (date, v) => ({ date, settlement: v, today_realized: v, normal_profit: 0, daytrade_profit: v, normal_trade_diff: 0, long_profit: 0, short_profit: v });
  const analytics = { available: true, daily_stats: [day("2026-11-02", 2371), day("2026-10-30", -500)] };
  account.dashboard = { analytics: { 台股: analytics } };
  renderDailyStats(analytics);
  await wait(200);
  __TRACER__
  const row = (date) => document.querySelector(`tr[data-daily-date="${date}"]`);
  const first = await trace(() => row("2026-11-02").click(), () => row("2026-10-30"), 700);
  return {
    "帳務 每日明細 day opens": first,
    "帳務 每日明細 day closes": await trace(() => row("2026-11-02").click(), () => row("2026-10-30"), 450),
    "帳務 每日明細 day opens again": await trace(() => row("2026-11-02").click(), () => row("2026-10-30"), 520),
  };
}

app.whenReady().then(async () => {
  const fail = (message) => { console.error(`expand motion ui contract FAILED: ${message}`); app.exit(1); };
  const renderer = path.join(__dirname, "..", "ui", "renderer");
  const base = pathToFileURL(renderer + path.sep).href;
  const read = (name) => fs.readFileSync(path.join(renderer, "pages", name), "utf8");
  const run = async (scenario, html) => {
    const win = new BrowserWindow({ show: false, width: 1300, height: 1000, webPreferences: { sandbox: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.setFrameRate(60);
    await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
    const source = scenario.toString().replace("__TRACER__", tracer);
    const traces = await win.webContents.executeJavaScript(`(${source})(${JSON.stringify(base)}, ${JSON.stringify(html)})`);
    win.destroy();
    return traces;
  };
  try {
    const traces = { ...(await run(dataCenter, read("data_center.html"))), ...(await run(accountDaily, read("account.html"))) };
    for (const [name, tops] of Object.entries(traces)) {
      const moves = tops.slice(1).map((top, i) => top - tops[i]).filter((step) => step !== 0);
      if (!moves.length) return fail(`${name}: the row under it never moved (${tops.join(" ")})`);
      const last = moves[moves.length - 1];
      if (Math.abs(last) > 4) return fail(`${name}: the row under it ended with a ${last}px jump (${tops.join(" ")})`);
      if (moves.length < 3) return fail(`${name}: the row under it moved in ${moves.length} step(s), not with the block (${tops.join(" ")})`);
    }
    console.log("expand motion ui contract passed");
    app.exit(0);
  } catch (error) {
    fail(error?.stack || error);
  }
});
