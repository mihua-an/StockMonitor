const { makeTempDir } = require("./support/temp_dirs.cjs");
// 帳務 個股數據 and 當沖分析 in a real Chromium (run with Electron) on the real account.html markup and a fake app_api:
// the dashboard carries no pair list (R14-23), so an expanded stock reads its own pairs (`<ledger>/pairs?code=`) and
// 當沖分析 reads the ledger's slice of the chosen mode (`<ledger>/daytrade-analysis?market=&mode=`). Checked: each says
// 載入中 until its read settles, then shows the read rows; a stock's figures and the 當沖 figures are the ledger's as
// sent (not recomputed in the page), and a band opens the pairs its pair_ids name; a read is made once per dashboard
// (and mode) and again for a new dashboard, every view waiting on it redraws, and a failed read or a ledger awaiting
// its rebuild says so. Also the page's notice line (R14-24): an error shows there and
// stays until closed, never as a blocking alert; the line takes no space while hidden.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-account-pair-reads-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base, accountHtml) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fail = (message) => { throw new Error(message); };
  window.desktopAPI = { networkManifest: { routes: [["/api/", "app_api"]], services: { app_api: { url: "http://app.invalid" } } } };

  const pair = (id, code, tradeType, direction, profit, entry, hold) => ({
    id, realized_date: "2026-10-15", market: "台股", code, name: code === "2330" ? "台積電" : "鴻海", trade_type: tradeType,
    direction, qty: 1000, buy_price: 100, sell_price: 100 + profit / 1000, buy_amount: 100000, sell_amount: 100000 + profit,
    tax: 0, fee: 0, buy_fee: 0, sell_fee: 0, profit, roi: profit / 100000, buy_ref: entry, sell_ref: "", entry_ref: entry,
    exit_ref: "", entry_minute: tradeType === "當沖" ? Number(entry.slice(0, 2)) * 60 + Number(entry.slice(3, 5)) : null,
    hold_period: hold, sort_order: id,
  });
  const pairs = {
    "code=2330": [pair(1, "2330", "一般", "", 10000, "2026-10-14", 1), pair(2, "2330", "當沖", "多", 2000, "09:05:00", 15)],
  };
  // The ledger's slice of each mode. Its figures are deliberately not what the pairs sum to, so a page that recomputed
  // them would show other numbers; the 10~20分 band names pair 2 only.
  const long = pair(2, "2330", "當沖", "多", 2000, "09:05:00", 15);
  const short = pair(3, "2317", "當沖", "空", -500, "10:30:00", 70);
  const holdLabels = ["0~10分", "10~20分", "20~30分", "30~40分", "40~50分", "50~60分", "1~2h", "2~3h", "3~4h", "4h+"];
  const group = (label, ids, extra = {}) => ({ label, total_profit: 777 * ids.length, win_rate: ids.length ? 0.5 : null,
    total_count: ids.length, win_count: 0, loss_count: 0, long_count: 0, short_count: 0, pair_ids: ids, ...extra });
  const slice = (mode, label, rows) => ({
    ok: true, available: true, market: "台股", mode, label, pairs: rows,
    summary: group(label, rows.map((row) => row.id), { total_profit: 7777 }),
    mini_report: { total_count: rows.length, expectancy: 1 },
    periods: { week: [group("2026/10/W3", rows.map((row) => row.id))], month: [group("2026/10", rows.map((row) => row.id))] },
    weekdays: ["週一", "週二", "週三", "週四", "週五"].map((name, index) => group(name, index === 3 ? rows.map((row) => row.id) : [], { weekday: index + 1 })),
    hold_time: holdLabels.map((name, index) => group(name, rows.filter((row) => (row.hold_period >= 10 && row.hold_period < 20 ? 1 : 6) === index).map((row) => row.id), { bucket_index: index })),
    entry_time: [group("09:00~09:10", [], { bucket_index: 0 })],
    matrix: { columns: holdLabels, rows: [] },
    top_wins: rows.filter((row) => row.profit > 0).map((row) => row.id), top_losses: rows.filter((row) => row.profit < 0).map((row) => row.id),
  });
  const slices = { overview: slice("overview", "當沖", [short, long]), short: slice("short", "空單", [short]) };
  const gets = [];
  let failPairs = false;
  let unavailable = false;
  window.fetch = async (input) => {
    const url = new URL(String(input?.url || input));
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/api/sources") return json({ source_settings: { enabled_sources: [], sources: {} } });
    gets.push(`${url.pathname}?${decodeURIComponent(url.search.slice(1))}`);
    if (url.pathname === "/api/actual-account/pairs") {
      if (failPairs) return json({ ok: false, error: "ledger locked" }, 503);
      if (unavailable) return json({ ok: true, available: false, ledger_state: { state: "REBUILD_PENDING", reason: "ledger rebuild pending" }, items: [] });
      return json({ ok: true, available: true, items: pairs[`code=${url.searchParams.get("code")}`] || [] });
    }
    if (url.pathname === "/api/actual-account/daytrade-analysis") {
      if (failPairs) return json({ ok: false, error: "ledger locked" }, 503);
      if (unavailable) return json({ ok: true, available: false, ledger_state: { state: "REBUILD_PENDING", reason: "ledger rebuild pending" } });
      return json(slices[url.searchParams.get("mode")]);
    }
    return json({ ok: false, error: `unexpected ${url.pathname}` }, 404);
  };

  document.querySelector("main").innerHTML = accountHtml;
  const { account, actualAccountExpandedStockStats } = await import(`${base}js/features/account/account_state.js`);
  const { renderStockStats } = await import(`${base}js/features/account/stock_stats_view.js`);
  const { renderDaytradeAnalysis } = await import(`${base}js/features/account/daytrade_view.js`);

  // A stock's figures as the ledger sends them -- deliberately not what its pairs would sum to, so a page that
  // recomputed them from the pairs would show other numbers.
  const stockStat = { code: "2330", name: "台積電", total_profit: 12345, win_rate: 0.75, win_count: 3, loss_count: 1, total_count: 4,
    avg_trade_profit: 3086.25, normal_count: 1, normal_profit: 10000, daytrade_count: 3, daytrade_profit: 2345, long_count: 3,
    long_profit: 2345, short_count: 0 };
  const dashboard = () => ({ analytics: { 台股: { available: true, stock_stats: [stockStat], daily_stats: [], pair_days: [] } } });
  account.mode = "actual";
  account.market = "台股";
  account.dashboard = dashboard();
  const analytics = () => account.dashboard.analytics.台股;
  if ("details" in analytics()) fail("the fixture dashboard is the new shape");

  // 個股數據: closed, no read; expanded, 載入中 then the stock's pairs.
  renderStockStats(analytics());
  if (gets.length) fail(`a closed stock reads nothing: ${gets}`);
  const body = document.getElementById("actualStockStatsBody");
  const mainRow = body.querySelector('tr[data-stock-stat-code="2330"]');
  if (!mainRow || !mainRow.cells[4].textContent.includes("12,345")) fail(`總收益 is the ledger's: ${mainRow?.cells[4].textContent}`);
  actualAccountExpandedStockStats.add("2330");
  renderStockStats(analytics());
  if (!body.textContent.includes("載入中")) fail("an expanded stock says 載入中 until its pairs are read");
  await wait(50);
  if (gets.join("|") !== "/api/actual-account/pairs?market=台股&code=2330") fail(`one read for the stock: ${gets}`);
  const detail = body.querySelector('tr[data-stock-stat-detail="2330"]');
  if (!detail.textContent.includes("75.00%") && !detail.textContent.includes("75%")) fail(`整體勝率 is the ledger's 75%: ${detail.textContent.slice(0, 200)}`);
  // An 一般 pair exists, so 零股 opens first and lists it.
  const inlineRows = () => [...body.querySelectorAll(".account-stock-inline-table tbody tr")];
  if (inlineRows().length !== 1 || !inlineRows()[0].textContent.includes("2026-10-15")) fail("零股 lists the stock's 一般 pair");
  body.querySelector('button[data-stock-trade-mode="daytrade"]').click();
  if (inlineRows().length !== 1 || !inlineRows()[0].dataset.stockReplayId) fail("當沖 lists the stock's 當沖 pair");
  renderStockStats(analytics());
  if (gets.length !== 1) fail(`the read is kept for the dashboard: ${gets}`);

  // 當沖分析: 載入中, then the ledger's slice in every section.
  account.currentView = "daytrade";
  renderDaytradeAnalysis();
  if (!document.getElementById("actualDayTradeSummary").textContent.includes("載入中")) fail("當沖分析 says 載入中 until it is read");
  await wait(50);
  if (gets[1] !== "/api/actual-account/daytrade-analysis?market=台股&mode=overview") fail(`當沖 read: ${gets}`);
  const report = [...document.querySelectorAll("#actualDirectionReportBody tr[data-daytrade-replay-id]")];
  if (report.length !== 2) fail(`當沖交易明細 lists both 當沖 pairs: ${report.length}`);
  if (!document.getElementById("actualDayTradeSummary").textContent.includes("7,777")) fail("當沖總收益 is the ledger's, as sent");
  const holdRows = [...document.querySelectorAll("#actualHoldTimeBody tr[data-daytrade-bucket-kind]")];
  if (holdRows.length !== 10) fail(`hold buckets: ${holdRows.length}`);
  if (!holdRows[1].textContent.includes("10~20分") || !holdRows[1].textContent.includes("777")) fail(`a band row is the ledger's: ${holdRows[1].textContent}`);
  holdRows[1].click();   // 10~20分: names the 15-minute pair
  const opened = [...document.querySelectorAll(".account-daytrade-bucket-detail tbody tr[data-daytrade-replay-id]")];
  if (opened.length !== 1 || opened[0].dataset.daytradeReplayId !== "2") fail("a band opens on the pair its pair_ids name");
  document.querySelector('.account-daytrade-tabs [data-daytrade-mode="short"]')?.click();
  account.daytradeMode = "short";
  renderDaytradeAnalysis();
  await wait(50);
  if (gets[2] !== "/api/actual-account/daytrade-analysis?market=台股&mode=short") fail(`a mode reads its own slice: ${gets}`);
  if (document.querySelectorAll("#actualDirectionReportBody tr[data-daytrade-replay-id]").length !== 1) fail("空單 shows the short pair only");
  if (!document.getElementById("actualDayTradeSummary").textContent.includes("空單")) fail("the slice names its mode");
  account.daytradeMode = "overview";
  renderDaytradeAnalysis();
  if (gets.length !== 3) fail(`a mode already read is not read again: ${gets}`);

  // One read waited on by two views redraws both once it settles.
  const { stockPairs } = await import(`${base}js/features/account/day_reads.js`);
  account.dashboard = dashboard();
  const redrawn = [];
  stockPairs("台股", "2330", () => redrawn.push("first"));
  stockPairs("台股", "2330", () => redrawn.push("second"));
  await wait(50);
  if (redrawn.join(",") !== "first,second") fail(`both waiting views redraw: ${redrawn}`);

  // A ledger awaiting its rebuild has no pairs: said so, not drawn as zero figures.
  unavailable = true;
  account.dashboard = dashboard();
  renderDaytradeAnalysis();
  await wait(50);
  if (!document.getElementById("actualDayTradeSummary").textContent.includes("暫不可用：ledger rebuild pending")) fail("an unavailable ledger is named");
  unavailable = false;
  const readsBefore = gets.length;

  // A new dashboard (the ledger changed) reads again; a failed read says so.
  failPairs = true;
  account.dashboard = dashboard();
  renderDaytradeAnalysis();
  await wait(50);
  if (gets.length !== readsBefore + 1) fail(`a new dashboard reads again: ${gets}`);
  if (!document.getElementById("actualDayTradeSummary").textContent.includes("讀取失敗")) fail("a failed read is shown");
  if (document.querySelectorAll("#actualDirectionReportBody tr[data-daytrade-replay-id]").length) fail("no old rows under a failed read");
  // The notice line: an error is shown in place, not alerted; closing it hides it and frees its space.
  const { setMessage } = await import(`${base}js/features/account/account_format.js`);
  let alerts = 0;
  window.alert = () => { alerts += 1; };
  const notice = document.getElementById("actualAccountNotice");
  if (getComputedStyle(notice).display !== "none") fail("the hidden notice line takes no space");
  setMessage("自動同步失敗，請稍後手動重試", true);
  if (alerts || notice.hidden || getComputedStyle(notice).display === "none") fail("an error shows on the notice line, not as an alert");
  if (!notice.classList.contains("account-notice-error") || !notice.textContent.includes("自動同步失敗")) fail("the error text and its error style");
  notice.querySelector("[data-account-notice-close]").click();
  if (!notice.hidden || getComputedStyle(notice).display !== "none") fail("closing hides the notice line");
  setMessage("同步完成：3 筆 Raw Transaction");
  if (notice.hidden || notice.classList.contains("account-notice-error")) fail("a result shows as plain text");
  // The notice floats at the top as 設定's message does (user 11-01) and takes no room: the content scroll starts
  // under the header and keeps the remaining height whether a notice shows or not (the main pane's grid once gave
  // the notice its 1fr row and pushed the scroll into an implicit row below it).
  const pane = document.querySelector(".account-main-pane");
  pane.style.height = "700px";
  const scroll = document.getElementById("actualAccountContentScroll");
  const header = document.querySelector(".account-page-header");
  const noticeBox = notice.getBoundingClientRect();
  const scrollBox = scroll.getBoundingClientRect();
  const paneBox = pane.getBoundingClientRect();
  if (getComputedStyle(notice.closest(".settings-toast-stack")).position !== "fixed") fail("the notice floats in 設定's message stack");
  if (noticeBox.height > 48) fail(`the notice is one line high: ${noticeBox.height}px`);
  if (Math.round(scrollBox.top) !== Math.round(header.getBoundingClientRect().bottom)) fail(`the content scroll starts under the header: ${scrollBox.top}`);
  if (Math.round(scrollBox.bottom) !== Math.round(paneBox.bottom)) fail(`the content scroll fills the pane: ${scrollBox.bottom} vs ${paneBox.bottom}`);
  notice.hidden = true;
  if (Math.round(scroll.getBoundingClientRect().top) !== Math.round(scrollBox.top)) fail("the notice moves nothing");
  if (Math.round(scroll.getBoundingClientRect().bottom) !== Math.round(paneBox.bottom)) fail("without the notice the scroll still fills the pane");
  return { ok: true };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { sandbox: false } });
  const fixture = path.join(__dirname, "fixtures", "renderer_ui_geometry.html");
  await win.loadURL(pathToFileURL(fixture).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  const accountHtml = fs.readFileSync(path.join(__dirname, "..", "ui", "renderer", "pages", "account.html"), "utf8");
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)}, ${JSON.stringify(accountHtml)})`);
    console.log("account pair reads ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("account pair reads ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
