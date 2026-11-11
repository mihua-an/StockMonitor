const { makeTempDir } = require("./support/temp_dirs.cjs");
// 帳務 配對回放 in Chromium (run with Electron), on the real account.html markup and a fake app_api: 配對明細's 當沖 row
// shows its clocks only; 走勢 opens the replay under the row as its own two rows of three cards -- 走勢資訊｜買賣報價｜
// 成交明細, 技術分析｜價量｜大單流向 (使用者 11-03) -- not 歷史回放's components, 走勢資訊 overlaying 加權、個股 and
// 產業指數 (the day's stored indexes from app_api), and the play bar under them (the day's seconds, 播放, 1/2/5/10x).
// There is no Market Runtime here: the cards say the replay is being opened (renderer_pair_replay_session_contract.mjs
// drives a replay). 走勢 again closes it. Only the day's indexes are read from FastAPI.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-account-pair-replay-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base, accountHtml) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const fail = (message) => { throw new Error(message); };
  window.desktopAPI = { networkManifest: { routes: [["/api/", "app_api"]], services: { app_api: { url: "http://app.invalid" } } } };
  const pair = {
    id: 7, realized_date: "2026-10-15", market: "台股", code: "2330", name: "台積電", trade_type: "當沖", direction: "多",
    qty: 1000, buy_price: 100, sell_price: 102, buy_amount: 100000, sell_amount: 102000, tax: 0, fee: 0, buy_fee: 0, sell_fee: 0,
    profit: 2000, roi: 0.02, buy_ref: "09:05:12", sell_ref: "09:20:40", entry_ref: "09:05:12", exit_ref: "09:20:40",
    entry_minute: 545, hold_period: 15, sort_order: 1,
  };
  const reads = [];
  window.fetch = async (input) => {
    const url = new URL(String(input?.url || input));
    reads.push(url.pathname);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/api/sources") return json({ source_settings: { enabled_sources: [], sources: {} } });
    if (url.pathname === "/api/actual-account/day") return json({ ok: true, available: true, trades: [], pairs: [pair] });
    if (url.pathname === "/api/actual-account/pairs") return json({ ok: true, available: true, items: [pair] });
    if (url.pathname === "/api/history/pair-indexes") {
      return json({ ok: true, date: "2026-10-15", code: "2330",
        market: { code: "TAIEX", name: "加權", reason: "", points: [{ time: "09:00", price: 20000 }, { time: "09:05", price: 20200 }], prev_close: 20000 },
        industry: { code: "IX0010", name: "半導體類指數", reason: "", points: [{ time: "09:00", price: 1000 }, { time: "09:05", price: 990 }], prev_close: 1000 } });
    }
    return json({ ok: false, error: `unexpected ${url.pathname}` }, 404);
  };

  document.querySelector("main").innerHTML = accountHtml;
  document.querySelector('[data-account-view-panel="pairs"]').hidden = false;
  await import(`${base}js/dashboard_components.js`);
  const { account, actualAccountExpandedPairDays } = await import(`${base}js/features/account/account_state.js`);
  const { renderPairDetails } = await import(`${base}js/features/account/daily_pairs_view.js`);
  const { installPairReplayOrigin } = await import(`${base}js/features/account/pair_replay.js`);
  installPairReplayOrigin(() => renderPairDetails());
  account.mode = "actual";
  account.market = "台股";
  account.dashboard = { analytics: { 台股: { available: true, stock_stats: [], daily_stats: [], pair_days: [{ date: "2026-10-15", total_profit: 2000, daytrade_profit: 2000, total_count: 1 }] } } };
  account.currentView = "pairs";
  actualAccountExpandedPairDays.add("2026-10-15");
  renderPairDetails();
  await wait(50);

  const row = () => document.querySelector('.account-daily-pair-row[data-pair-id="7"]');
  if (!row()) fail("the 當沖 pair is listed under its day");
  if (!row().textContent.includes("2330・09:05 → 09:20")) fail(`the 當沖 row shows its clocks only: ${row().textContent}`);
  row().querySelector("[data-pair-action='replay']").click();
  const panel = () => document.querySelector("#actualPairBody [data-pair-replay-panel]");
  if (!panel()) fail("the replay opens under its row");
  await wait(80);
  await frames();

  // Two rows of three cards, drawn by the replay itself (no mounted component).
  const cards = [...panel().querySelectorAll(".pair-replay-card")];
  const titles = cards.map((card) => card.querySelector(".pair-replay-title > span").textContent);
  const want = ["走勢資訊", "買賣報價", "成交明細", "技術分析", "價量", "大單流向"];
  if (titles.join("|") !== want.join("|")) fail(`the six cards: ${titles}`);
  // The replay draws its cards itself; only 價量 is 即時報價's own component (使用者 11-03).
  const mounted = [...panel().querySelectorAll("[data-component-id]")].map((node) => node.dataset.componentId);
  if (mounted.join("|") !== "priceFlow") fail(`only 價量 is a mounted component: ${mounted}`);
  const tops = cards.map((card) => Math.round(card.getBoundingClientRect().top));
  const heights = cards.map((card) => Math.round(card.getBoundingClientRect().height));
  if (new Set(tops.slice(0, 3)).size !== 1 || new Set(tops.slice(3)).size !== 1 || tops[3] <= tops[0]) fail(`two rows of three: ${tops}`);
  // The top row lower than the bottom one (使用者 11-03: the play bar in view), each row's cards as tall as each other.
  if (new Set(heights.slice(0, 3)).size !== 1 || new Set(heights.slice(3)).size !== 1 || heights[0] >= heights[3]) fail(`the rows' heights: ${heights}`);
  // 價量 is 即時報價's own component (its ▲/thumb/▼ row scrollbar and 內外盤比 bars), whole and in its own columns,
  // also in a panel as narrow as the 帳務 page leaves it on a 1456px-wide window: the 配對明細 table's own cell rules
  // (a 176px first column, centred, 5px padding) stay on its own cells and never reach the ladder's.
  {
    const { pairReplayContext } = await import(`${base}js/features/account/pair_replay_session.js`);
    const fields = ["large_buy", "large_sell", "large_unknown", "large_count", "small_buy", "small_sell", "small_unknown", "small_count",
      "unclassified_buy", "unclassified_sell", "unclassified_unknown", "unclassified_count"];
    const buckets = [];
    for (let index = 0; index < 30; index += 1) {
      buckets.push({ price: 469 - index * 0.5, volume: 1097, out: 347, in: 750, flow: [0, 172 + index, 0, 6, 347, 578, 0, 418, 0, 0, 0, 0] });
    }
    const card = panel().querySelector("[data-replay-price-flow]");
    if (!card.querySelector(".price-flow [data-role='price-flow-rail']")) fail("價量 is 即時報價's component, with its row scrollbar");
    panel().style.width = "820px";
    pairReplayContext.dataSource.setResolver("priceFlow", () => ({ availability: "AVAILABLE", code: "2330", identity: "replay|test|2330",
      // The header's totals are the replay's B totals (price_volume.totals), not the rows added back up.
      priceVolume: { buckets, flow_fields: fields, totals: { large: { buy: 300, sell: 100 }, small: { buy: 100, sell: 300 }, unclassified: { buy: 0, sell: 0 } } },
      currentPrice: 465, referencePrice: 470 }));
    pairReplayContext.dataSource.invalidate("priceFlow");
    await wait(80);
    await frames();
    const host = card.querySelector("[data-role='price-flow-scroll']");
    const columns = [...host.querySelectorAll("thead th")].map((th) => Math.round(th.getBoundingClientRect().width));
    const firstCell = getComputedStyle(host.querySelector("tbody td"));
    const fits = host.scrollWidth <= host.clientWidth;
    const rail = card.querySelector("[data-role='price-flow-rail']");
    const railShown = rail.getBoundingClientRect().height > 0 && rail.childElementCount > 0;
    panel().style.width = "";
    if (Math.max(...columns) > 80) fail(`價量's columns are its own: ${columns}`);
    if (firstCell.textAlign !== "right") fail(`價量's numbers are right-aligned: ${firstCell.textAlign}`);
    if (!fits) fail(`價量's ladder fits its card: ${host.scrollWidth} > ${host.clientWidth}`);
    if (!railShown) fail("價量's 30 prices scroll with 即時報價's row scrollbar");
    const shares = [...card.querySelectorAll("[data-role='price-flow-summary'] [data-role='outside-ratio']")].map((b) => b.textContent);
    if (shares.join("|") !== "75.00%|25.00%") fail(`價量's 大單／小單 外盤 shares are B's totals: ${shares}`);
  }

  // 走勢資訊 overlays 加權、產業指數 and the stock: the indexes' lines up to the replay time.
  await wait(80);
  await frames();
  const legend = [...panel().querySelectorAll(".pair-replay-legend-item")].map((item) => item.textContent.trim());
  // 股號 漲跌幅, 產業指數 漲跌幅 (加權 is the faint line without a label).
  if (legend.join("|") !== "2330 --|產業指數 1.00%") fail(`the legend: ${legend}`);
  const indexLine = getComputedStyle(panel().querySelector("[data-replay-overlay] polyline.is-market"));
  if (Number(indexLine.strokeOpacity) >= 1) fail(`the indexes are faded behind the stock: ${indexLine.strokeOpacity}`);
  const lines = [...panel().querySelectorAll("[data-replay-overlay] polyline")].map((line) => line.getAttribute("class"));
  if (lines.join("|") !== "pair-replay-line is-market|pair-replay-line is-industry") fail(`the indexes' lines (the stock has no replay here): ${lines}`);
  const colours = lines.map((name) => getComputedStyle(panel().querySelector(`[data-replay-overlay] polyline.${name.split(" ")[1]}`)).stroke);
  if (new Set(colours).size !== 2) fail(`each line its own colour: ${colours}`);
  if (panel().querySelectorAll("[data-replay-overlay] .pair-replay-mark").length !== 2) fail("the entry and exit marks are on 走勢資訊");
  // Without a Market Runtime the stock's cards say the replay is being opened (never a FastAPI read standing in for it).
  if (!/回放/.test(cards[2].textContent)) fail(`成交明細 says why there is no tape: ${cards[2].textContent.trim().slice(0, 80)}`);
  const historyReads = reads.filter((path) => path.startsWith("/api/history/"));
  if (historyReads.join("|") !== "/api/history/pair-indexes") fail(`only the day's indexes are read: ${reads}`);

  // The play bar: the day's seconds, from the entry; 播放 and the four speeds.
  const range = document.getElementById("actualPairReplayRange");
  if (range.step !== "1" || Number(range.value) !== 9 * 3600 + 5 * 60 + 12) fail(`the bar is the day's seconds, at the entry: ${range.step}/${range.value}`);
  if (document.getElementById("actualPairReplayTime").textContent !== "09:05:12") fail("the time shows the entry second");
  const speeds = [...panel().querySelectorAll("[data-replay-speed]")].map((button) => button.textContent).join(" ");
  if (speeds !== "1x 2x 5x 10x") fail(`the speeds: ${speeds}`);
  if (!document.getElementById("actualPairReplayPlay")) fail("播放 is on the bar");
  const barTop = panel().querySelector(".replay-bar").getBoundingClientRect().top;
  if (barTop <= Math.max(...tops)) fail("the play bar is under the cards");

  // 走勢 again closes it.
  row().querySelector("[data-pair-action='replay']").click();
  await wait(50);
  if (panel()) fail("走勢 again closes the replay");
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 1200, webPreferences: { sandbox: false } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  const accountHtml = fs.readFileSync(path.join(__dirname, "..", "ui", "renderer", "pages", "account.html"), "utf8");
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)}, ${JSON.stringify(accountHtml)})`);
    console.log("account pair replay ui passed");
    app.exit(0);
  } catch (error) {
    console.error("account pair replay ui FAILED:", error?.message || error);
    app.exit(1);
  }
});
