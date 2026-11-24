const { makeTempDir } = require("./support/temp_dirs.cjs");
const { fixViewport } = require("./support/fixed_viewport.cjs");
// The expandable record rows in a real Chromium (run with Electron): a day's categories in 資料中心 (the page's own code on
// the real data_center.html and a fake app_api) and 帳務 個股數據 (on the real account.html) are one component
// (data_grid.js expandCellHtml / expandDetailRowHtml, data-grid.css). Checked: a click on the row opens and closes it;
// the caret, the open row's marking and its font size, and the tables' stripes compute the same on both pages; a day's
// categories in order, 期貨指數 opening to 日盤／夜盤, 收盤整理 (a failure reads only its retry time).
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-record-expand-rows-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base, dataCenterHtml, accountHtml) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fail = (message) => { throw new Error(message); };
  window.desktopAPI = { networkManifest: { routes: [["/api/", "app_api"]], services: { app_api: { url: "http://app.invalid" } } } };
  const catalogRow = { market: "STK", logical_code: "2330", actual_contract: "2330", trading_date: "2026-10-27", session: "DAY",
    tick: { rows: 100, first_timestamp: "2026-10-27T09:00:00+08:00", last_timestamp: "2026-10-27T13:30:00+08:00" }, problems: [] };
  const retryAt = new Date(2026, 9, 27, 14, 52).getTime() / 1000;
  const view = (products, tick, bidask, quote, bytes, materialization) => ({ products, rows: { tick, bidask, quote }, bytes, materialization });
  const categories = [
    { id: "taiex", ...view(1, 0, 0, 5402, 1100000, { state: "succeeded" }) },
    { id: "futures", ...view(1, 0, 412330, 41876, 86000000, null), sessions: [
      { id: "DAY", ...view(1, 0, 301220, 30110, 61000000, { state: "succeeded" }) },
      { id: "NIGHT", ...view(1, 0, 111110, 11766, 25000000, { state: "succeeded" }) }] },
    { id: "industry", ...view(14, 0, 0, 61420, 9800000, { state: "succeeded" }) },
    { id: "tse", ...view(58, 251220, 1402110, 0, 1400000000, { state: "succeeded" }) },
    { id: "otc", ...view(18, 86186, 210194, 0, 420000000, { state: "failed_retryable", next_attempt_at: retryAt }) },
  ];
  window.fetch = async (input) => {
    const url = new URL(String(input?.url || input));
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/api/sources") return json({ source_settings: { enabled_sources: [], sources: {} } });
    if (url.pathname === "/api/data-center/dates") {
      if (window.__datesFail) return json({ ok: false, items: [], classification: "DATA_CENTER_DAEMON_TIMEOUT", error: "HTTP 500" });
      return json({ ok: true, items: [
        { date: "2026-10-27", complete: true, storage: { ALL: { products: 1, rows: { tick: 100, bidask: 200, quote: 3000 }, industry_index_rows: 1200, bytes: 2048 } } },
        { date: "2026-10-24", complete: false, storage: { ALL: { products: 1, rows: { tick: 100 }, bytes: 2048 } } },
        { date: "2026-10-23", complete: null, storage: { ALL: { products: 1, rows: { tick: 100 }, bytes: 2048 } } }] });
    }
    if (url.pathname === "/api/data-center/date") {
      return json({ ok: true, trading_date: url.searchParams.get("date"), categories });
    }
    if (url.pathname === "/api/data-center/closing") return json({ ok: true, trading_date: null, stage: "waiting_close", sessions: [] });
    if (url.pathname === "/api/actual-account/pairs") return json({ ok: true, available: true, items: [] });
    return json({ ok: false, error: `unexpected ${url.pathname}` }, 404);
  };
  const props = ["backgroundColor", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderBottomColor", "fontSize"];
  const style = (element, names) => Object.fromEntries(names.map((name) => [name, getComputedStyle(element)[name]]));
  // A hidden window runs transitions slowly: the end state is read with every running transition finished.
  const caretStyle = (row) => {
    // (Not the running step's pulse: it repeats for as long as the step runs and has no end to finish.)
    document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity).forEach((animation) => animation.finish());
    return style(row.querySelector(":scope > .record-expand-cell > .record-expand-caret"), ["color", "fontSize", "transform"]);
  };
  const same = (what, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) fail(`${what}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`); };

  // 資料中心: the days, then one day's categories with 期貨指數 open.
  const main = document.querySelector("main");
  main.innerHTML = dataCenterHtml;
  (await import(`${base}js/core/page_frame.js`)).hydratePageFrames(document);
  const page = await import(`${base}js/pages/data_center.js`);
  page.initDataCenterPage();
  // A failed read of the dates: the table says so (never a 載入中 that never ends), and the next read fills it.
  window.__datesFail = true;
  let datesError = null;
  await page.refreshDataCenter().catch((error) => { datesError = error; });
  const dailyText = () => document.getElementById("dataCenterDailyRows").textContent;
  if (!datesError || !dailyText().includes("讀取失敗") || dailyText().includes("載入中")) fail(`a failed dates read is shown in the table: ${dailyText()}`);
  window.__datesFail = false;
  await page.refreshDataCenter();
  if (dailyText().includes("讀取失敗")) fail("a later read replaces the failure");
  const cellsOf = (row) => [...row.cells].map((cell) => cell.textContent.replace(/\s+/g, " ").trim());
  const recent = [...document.querySelectorAll("[data-open-day]")];
  same("a recent day", cellsOf(recent[0]), ["10/27（週二）", "完整", "1", "100", "2.0 KB", "--", "--"]);
  same("完整 no / unknown", recent.slice(1).map((row) => cellsOf(row)[1]), ["不完整", "--"]);
  recent[0].click();
  await wait(50);
  if (document.querySelector('[data-dc-view="day-data"]').hidden) fail("a click on a recent day opens it");
  const dayPanel = document.getElementById("dataCenterDayCategories");
  const categoryRows = () => [...dayPanel.querySelectorAll(".dc-category-table > tbody > tr")].filter((row) => !row.hidden).map(cellsOf);
  same("the categories", categoryRows(), [
    ["加權指數", "1", "--", "--", "5,402", "1.0 MB", "完成"],
    ["›期貨指數", "1", "--", "412,330", "41,876", "82.0 MB", "完成"],
    ["產業指數", "14", "--", "--", "61,420", "9.3 MB", "完成"],
    ["上市股票", "58", "251,220", "1,402,110", "--", "1.3 GB", "完成"],
    ["上櫃股票", "18", "86,186", "210,194", "--", "400.5 MB", "14:52 重試"]]);
  same("the day's closes", [...document.querySelectorAll("#dataCenterDayClosing tbody tr")].map((row) => cellsOf(row).slice(0, 2)),
    [["台股日盤", "完成"], ["指數", "完成"], ["期貨日盤", "完成"], ["期貨夜盤", "完成"]]);
  const futuresRow = dayPanel.querySelector('tr[data-dc-category="futures"]');
  const closedCaret = caretStyle(futuresRow);
  futuresRow.click();
  await wait(50);
  if (!futuresRow.classList.contains("expanded")) fail("a click on 期貨指數 opens it");
  same("期貨指數 open", categoryRows().slice(1, 4).map((row) => row[0]), ["›期貨指數", "日盤", "夜盤"]);
  const centre = (element) => { const box = element.getBoundingClientRect(); return Math.round(box.left + box.width / 2); };
  // 日盤 / 夜盤 cells line up with 期貨指數's in every column.
  const textCentre = (cell) => { const range = document.createRange(); range.selectNodeContents(cell); return centre(range); };
  for (const session of dayPanel.querySelectorAll("tr.dc-session-row:not([hidden])")) {
    [...session.cells].forEach((cell, index) => {
      const above = futuresRow.cells[index];
      const label = (td) => td.querySelector(".record-expand-label") || td;
      const at = index === 0 ? [centre(label(cell)), centre(label(above))] : [textCentre(cell), textCentre(above)];
      if (Math.abs(at[0] - at[1]) > 1) fail(`${session.cells[0].textContent} column ${index} is centred at ${at[0]}, 期貨指數 at ${at[1]}`);
    });
  }
  // The second record row of each table (detail rows are not counted): no stripe on any table.
  const stripe = (table) => style([...table.tBodies[0].rows].filter((row) => !row.hasAttribute("data-row-detail"))[1], ["backgroundColor"]);
  const dcStripe = stripe(futuresRow.closest("table"));
  const dc = { categoryRow: style(futuresRow.cells[0], ["backgroundColor", "fontSize"]), categoryCaret: caretStyle(futuresRow) };
  same("an open caret turns down", closedCaret.transform === dc.categoryCaret.transform ? "same" : "turned", "turned");

  // 帳務 個股數據 with its stock open.
  main.innerHTML = accountHtml;
  (await import(`${base}js/core/page_frame.js`)).hydratePageFrames(document);
  document.querySelector('[data-account-view-panel="stockStats"]').hidden = false;
  const { account, actualAccountExpandedStockStats } = await import(`${base}js/features/account/account_state.js`);
  const { renderStockStats } = await import(`${base}js/features/account/stock_stats_view.js`);
  account.mode = "actual";
  account.market = "台股";
  const analytics = { available: true, stock_stats: [{ code: "2330", name: "台積電", total_profit: 1 }, { code: "2317", name: "鴻海", total_profit: 2 }], daily_stats: [], pair_days: [] };
  account.dashboard = { analytics: { 台股: analytics } };
  actualAccountExpandedStockStats.add("2330");
  renderStockStats(analytics);
  await wait(50);
  const stockRow = document.querySelector('tr[data-stock-stat-code="2330"]');
  const stockDetail = document.querySelector('tr[data-stock-stat-detail="2330"]');
  if (!stockRow?.classList.contains("record-expand-row") || !stockDetail?.classList.contains("record-expand-detail")) {
    fail("個股數據 uses the record-expand rows");
  }
  const stock = { row: style(stockRow.cells[0], ["backgroundColor", "fontSize"]), caret: caretStyle(stockRow), detail: style(stockDetail.cells[0], props) };

  // Both pages' tables are table cards (data-grid-variant="page"): their rows are parted by lines, not striped.
  const stockStripe = stripe(stockRow.closest("table"));
  same("個股數據's second row is not striped", stockStripe, { backgroundColor: "rgba(0, 0, 0, 0)" });
  same("the rows (資料中心 categories / 個股數據)", dcStripe, stockStripe);
  same("the open row's marking (資料中心 期貨指數 / 個股數據)", dc.categoryRow, stock.row);
  same("the open caret (資料中心 期貨指數 / 個股數據)", dc.categoryCaret, stock.caret);
  for (const side of ["Top", "Right", "Bottom", "Left"]) if (stock.detail[`padding${side}`] !== "0px") fail(`the detail cell has no padding: ${JSON.stringify(stock.detail)}`);
  page.disposeDataCenterPage();
  return { ok: true };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1600, height: 1000, webPreferences: { sandbox: false, backgroundThrottling: false } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  await fixViewport(win, 1600, 1000);
  const renderer = path.join(__dirname, "..", "ui", "renderer");
  const base = pathToFileURL(renderer + path.sep).href;
  const dataCenterHtml = fs.readFileSync(path.join(renderer, "pages", "data_center.html"), "utf8");
  const accountHtml = fs.readFileSync(path.join(renderer, "pages", "account.html"), "utf8");
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)}, ${JSON.stringify(dataCenterHtml)}, ${JSON.stringify(accountHtml)})`);
    console.log("record expand rows ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("record expand rows ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
