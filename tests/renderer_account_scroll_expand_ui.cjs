const { makeTempDir } = require("./support/temp_dirs.cjs");
// 帳務中心 and 資料中心 in a real Chromium (run with Electron) on the real page markup (user 11-01):
// - a table drawn into its wrapper after the page mounted (當沖分析 每週 / 每月) or whose header is filled in later
//   (星期) is a split data grid: its scrollbar starts under the column titles, never beside them;
// - 每週 / 每月's first column is centred;
// - a block that opens under a row grows with the shared expand motion, and the page scrolls only when the block does
//   not fit -- only as far as it needs, the clicked row is not taken to the top; a block taller than the view puts its
//   row at the top (reveal_scroll.js);
// - 個股數據 / 每日明細 / 配對明細 are one table card: the same border;
// - 資料中心: 執行紀錄's hover fills its whole row, and 讀取資料目錄中 sits beside the title's note (showing it moves
//   nothing below).
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
require("./support/keep_motion.cjs").keepMotion(app);
app.setPath("userData", makeTempDir("stockmonitor-account-scroll-expand-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base, accountHtml, dataCenterHtml) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const fail = (message) => { throw new Error(message); };
  window.desktopAPI = { networkManifest: { routes: [["/api/", "app_api"]], services: { app_api: { url: "http://app.invalid" } } } };

  // 80 當沖 pairs every third day from 2026-01-05: about 34 weeks, so 每週 has more rows than its card shows.
  const pairs = [];
  for (let i = 0; i < 80; i += 1) {
    const date = new Date(Date.UTC(2026, 0, 5) + i * 3 * 86400000).toISOString().slice(0, 10);
    const profit = (i % 3 ? 1 : -1) * (500 + i * 37);
    pairs.push({ id: i + 1, realized_date: date, market: "台股", code: "2330", name: "台積電", trade_type: "當沖",
      direction: i % 2 ? "多" : "空", qty: 1000, buy_price: 100, sell_price: 100, buy_amount: 100000, sell_amount: 100000 + profit,
      tax: 0, fee: 0, buy_fee: 0, sell_fee: 0, profit, roi: profit / 100000, buy_ref: "09:05:00", sell_ref: "", entry_ref: "09:05:00",
      exit_ref: "", entry_minute: 545, hold_period: 15 + i, sort_order: i });
  }
  pairs.reverse();
  // The ledger's 當沖分析 of them (`<ledger>/daytrade-analysis`): the newest 10 weeks and 8 months, the weekdays; the
  // figures only need to be there, the layout is what is checked.
  const group = (label, rows, extra = {}) => ({ label, total_profit: rows.reduce((sum, row) => sum + row.profit, 0), win_rate: 0.5,
    total_count: rows.length, win_count: 0, loss_count: 0, long_count: 0, short_count: 0, pair_ids: rows.map((row) => row.id), ...extra });
  const periods = (keyOf, limit) => {
    const groups = new Map();
    pairs.forEach((row) => { const key = keyOf(row.realized_date); groups.set(key, [...(groups.get(key) || []), row]); });
    return [...groups].slice(0, limit).map(([key, rows]) => group(key, rows));
  };
  const monday = (text) => { const day = new Date(`${text}T00:00:00Z`); day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7)); return day.toISOString().slice(0, 10); };
  const bands = Array.from({ length: 10 }, (_, index) => group(`band ${index}`, [], { bucket_index: index }));
  const slice = { ok: true, available: true, market: "台股", mode: "overview", label: "當沖", pairs,
    summary: group("當沖", pairs), mini_report: { total_count: pairs.length },
    periods: { week: periods(monday, 10), month: periods((text) => text.slice(0, 7), 8) },
    weekdays: ["週一", "週二", "週三", "週四", "週五"].map((name, index) => group(name,
      pairs.filter((row) => new Date(`${row.realized_date}T00:00:00Z`).getUTCDay() === index + 1), { weekday: index + 1 })),
    hold_time: bands, entry_time: bands, matrix: { columns: [], rows: [] }, top_wins: [], top_losses: [] };
  window.fetch = async (input) => {
    const url = new URL(String(input?.url || input));
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/api/sources") return json({ source_settings: { enabled_sources: [], sources: {} } });
    if (url.pathname === "/api/actual-account/daytrade-analysis") return json(slice);
    return json({ ok: true, items: [] });
  };

  const main = document.querySelector("main");
  main.innerHTML = accountHtml;
  document.querySelector(".account-main-pane").style.height = "1700px";
  document.querySelectorAll(".account-view[data-account-view-panel]").forEach((panel) => {
    const on = panel.dataset.accountViewPanel === "daytrade";
    panel.hidden = !on;
    panel.classList.toggle("active", on);
  });
  const { installStandardDataGridSystem } = await import(`${base}js/core/data_grid.js`);
  installStandardDataGridSystem(main);
  const { account } = await import(`${base}js/features/account/account_state.js`);
  const { renderDaytradeAnalysis } = await import(`${base}js/features/account/daytrade_view.js`);
  account.mode = "actual";
  account.market = "台股";
  account.currentView = "daytrade";
  account.dashboard = { analytics: { 台股: { available: true, stock_stats: [], daily_stats: [], pair_days: [] } } };
  renderDaytradeAnalysis();
  await wait(100);
  renderDaytradeAnalysis();
  await frame(); await frame(); await frame();

  // Tables drawn after the page mounted are split grids: the scrolling body starts under the column titles.
  const splitOf = (wrapper, name) => {
    const header = wrapper?.querySelector(":scope > .standard-data-grid-header-band");
    const body = wrapper?.querySelector(":scope > .standard-data-grid-body-scroll");
    if (!wrapper?.classList.contains("standard-data-grid") || !header || !body) fail(`${name} is a split data grid`);
    if (getComputedStyle(wrapper).overflowY !== "hidden") fail(`${name}'s card itself does not scroll`);
    if (Math.round(body.getBoundingClientRect().top) < Math.round(header.getBoundingClientRect().bottom)) fail(`${name}'s rows scroll under the titles`);
    return body;
  };
  const week = splitOf(document.getElementById("actualDaytradeWeekPeriod"), "每週");
  splitOf(document.getElementById("actualDaytradeMonthPeriod"), "每月");
  splitOf(document.querySelector(".account-daytrade-weekday-wrap"), "星期");
  if (week.scrollHeight <= week.clientHeight) fail("每週 has more weeks than its card shows (the fixture)");
  // The rows' columns are the titles' widths in whole pixels that keep the titles' total: nothing to scroll sideways.
  if (week.scrollWidth > week.clientWidth) fail(`每週 does not scroll sideways: ${week.scrollWidth} > ${week.clientWidth}`);
  const firstCell = week.querySelector("tbody tr td");
  if (getComputedStyle(firstCell).textAlign !== "center") fail(`每週's 交易週次 is centred: ${getComputedStyle(firstCell).textAlign}`);
  const weekTitle = document.querySelector("#actualDaytradeWeekPeriod .standard-data-grid-header-table th");
  if (getComputedStyle(weekTitle).textAlign !== "center") fail(`每週's first title is centred: ${getComputedStyle(weekTitle).textAlign}`);

  // A weekday that fits (the view is 1700 px high, the trades at most 660 px) opens with the motion and moves nothing.
  const scroll = document.getElementById("actualAccountContentScroll");
  const weekdayRow = () => document.querySelector("tr[data-daytrade-weekday]");
  const weekdayKey = weekdayRow().dataset.daytradeWeekday;
  const jump = (top) => scroll.scrollTo({ top, behavior: "instant" });
  jump(Math.max(0, weekdayRow().getBoundingClientRect().top - scroll.getBoundingClientRect().top - 120));
  await frame();
  const before = scroll.scrollTop;
  weekdayRow().click();
  const detail = document.querySelector(`tr[data-daytrade-weekday-detail="${weekdayKey}"] > td > .record-expand-body`);
  if (!detail || !detail.getAnimations().length) fail("an opening weekday grows with the expand motion");
  // The weekday's trades are a split grid too (a table brought in by an expanded row).
  await frame(); await frame();
  splitOf(detail.querySelector(".account-daytrade-weekday-detail-wrap"), "a weekday's trades");
  await wait(450);
  if (Math.abs(scroll.scrollTop - before) > 1) fail(`a block that fits moves nothing: ${before} -> ${scroll.scrollTop}`);

  // Closing it plays the motion too, then the row is gone.
  weekdayRow().click();
  const closing = document.querySelector(`tr[data-daytrade-weekday-detail="${weekdayKey}"] > td > .record-expand-body`);
  if (!closing || !closing.getAnimations().length) fail("a closing weekday shrinks with the expand motion");
  await wait(350);
  if (document.querySelector(`tr[data-daytrade-weekday-detail="${weekdayKey}"]`)) fail("a closed weekday's trades are gone");

  // A weekday at the bottom of the view: the page scrolls only as far as the block needs, the row stays below the top.
  const rowTop = weekdayRow().getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
  jump(Math.max(0, rowTop - scroll.clientHeight + 60));
  await frame();
  const start = scroll.scrollTop;
  weekdayRow().click();
  await wait(500);
  const openRow = document.querySelector(`tr[data-daytrade-weekday-detail="${weekdayKey}"]`);
  const viewBox = scroll.getBoundingClientRect();
  const rowBox = weekdayRow().getBoundingClientRect();
  const openBox = openRow.getBoundingClientRect();
  if (scroll.scrollTop <= start + 1) fail(`a block below the view scrolls into it: ${start} -> ${scroll.scrollTop}`);
  const tallerThanView = openBox.bottom - rowBox.top > scroll.clientHeight;
  if (!tallerThanView) {
    if (Math.abs(openBox.bottom - viewBox.bottom) > 2) fail(`the block's bottom lands at the view's bottom: ${openBox.bottom} vs ${viewBox.bottom}`);
    if (rowBox.top < viewBox.top + 80) fail(`the clicked row is not taken to the top: ${rowBox.top - viewBox.top}px from it`);
  } else {
    const tabs = document.querySelector(".account-daytrade-tabs").getBoundingClientRect().height + 8;
    if (Math.abs(rowBox.top - (viewBox.top + tabs)) > 2) fail(`a block taller than the view puts its row under the tabs: ${rowBox.top - viewBox.top}`);
  }

  // revealPlan on its own: what fits moves nothing; what does not, the least that makes it fit.
  const { revealPlan } = await import(`${base}js/core/reveal_scroll.js`);
  const box = document.createElement("div");
  box.style.cssText = "height:200px;overflow-y:auto;position:fixed;top:0;left:0;width:200px";
  box.innerHTML = Array.from({ length: 20 }, (_, i) => `<div style="height:40px" data-i="${i}"></div>`).join("");
  document.body.appendChild(box);
  const at = (i) => box.querySelector(`[data-i="${i}"]`);
  if (revealPlan(at(1), at(3)).length) fail("a region in view needs no scroll");
  const down = revealPlan(at(4), at(6));
  if (down.length !== 1 || down[0].to !== 80) fail(`a region below scrolls by what it lacks: ${JSON.stringify(down.map((p) => p.to))}`);
  const tall = revealPlan(at(8), at(15));
  if (tall[0]?.to !== 320) fail(`a region taller than the view puts its first row at the top: ${tall[0]?.to}`);
  box.scrollTop = 400;
  const up = revealPlan(at(8), at(9));
  if (up[0]?.to !== 320) fail(`a region above scrolls up to it: ${up[0]?.to}`);
  box.remove();

  // 個股數據 / 每日明細 / 配對明細: one card style.
  const wraps = ["account-stock-stats-table-wrap", "account-daily-table-wrap", "account-pair-table-wrap"]
    .map((name) => document.querySelector(`.${name}`));
  const looks = wraps.map((wrap) => {
    const style = getComputedStyle(wrap);
    return [style.borderTopWidth, style.borderTopColor, style.borderRadius, style.backgroundColor, style.boxShadow].join(" ");
  });
  if (new Set(looks).size !== 1) fail(`the three tables share one card: ${JSON.stringify(looks)}`);

  // 資料中心.
  main.innerHTML = dataCenterHtml;
  const loading = document.getElementById("dataCenterLoading");
  if (!loading.closest(".settings-group-title")) fail("讀取資料目錄中 is in the title row");
  const table = document.querySelector(".dc-daily-overview");
  const tableTop = table.getBoundingClientRect().top;
  loading.hidden = false;
  if (table.getBoundingClientRect().top !== tableTop) fail("showing 讀取資料目錄中 moves nothing below");
  const toggle = document.querySelector(".job-log-toggle");
  if (toggle) {
    toggle.style.backgroundColor = "rgb(1, 2, 3)";   // what :hover sets, so the paint is checked without a pointer
    const style = getComputedStyle(toggle);
    if (style.boxShadow !== "none" && /inset 16px/.test(style.boxShadow)) fail("no inset strip covers the row's left");
    if (style.backgroundColor !== "rgb(1, 2, 3)") fail("the hover colour is the row's own background");
  }
  return { ok: true };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 1800, // Offscreen: a hidden window draws (almost) no frames, and the motion and its scroll step on frames.
    webPreferences: { sandbox: false, offscreen: true } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  const read = (name) => fs.readFileSync(path.join(__dirname, "..", "ui", "renderer", "pages", name), "utf8");
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)}, ${JSON.stringify(read("account.html"))}, ${JSON.stringify(read("data_center.html"))})`);
    console.log("account scroll and expand ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("account scroll and expand ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
