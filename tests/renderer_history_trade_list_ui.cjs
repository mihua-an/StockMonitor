const { makeTempDir } = require("./support/temp_dirs.cjs");
// 歷史回放's 交易明細 in a real Chromium (run with Electron): 股名, 股數, 買價, 賣價, 損益 under titles in line with their figures;
// the side shows in 股數's colour only; the typed code or name narrows 總覽 and 今日 alike; a date picked in its menu is 今日's;
// no pages; a row opens to 買入 / 賣出 and replays its trade, and closing it replays nothing.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-history-trades-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const fail = (message) => { throw new Error(message); };
  const same = (got, want, message) => { if (JSON.stringify(got) !== JSON.stringify(want)) fail(`${message}: ${JSON.stringify(got)} instead of ${JSON.stringify(want)}`); };
  const settle = async (ms = 60) => { await new Promise((r) => setTimeout(r, ms)); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); };
  document.querySelector("main").innerHTML = '<div id="host" class="dashboard-card" style="width:340px;height:420px"></div>';
  const { TradeDetailsComponent } = await import(`${base}js/core/components/trade_details_component.js`);
  const { historyState, installHistoryPageHooks } = await import(`${base}js/features/history/history_state.js`);
  const { buildReplayTradeDetailsViewModel } = await import(`${base}js/features/history/replay_view_models.js`);
  const pair = (id, date, code, name, direction, buy, sell, profit) => ({ id, realized_date: date, code, name, direction, qty: 1000, buy_price: buy, sell_price: sell,
    buy_amount: buy * 1000, sell_amount: sell * 1000, buy_fee: 100, sell_fee: 100, tax: 150, profit, roi: profit / (buy * 1000), buy_ref: "10:12", sell_ref: "10:38", entry_ref: "10:12", exit_ref: "10:38" });
  let component = null;
  const draw = () => component.update(buildReplayTradeDetailsViewModel());
  installHistoryPageHooks({ invalidateReplayComponents: draw, rerenderHistoryCurrentChart() {}, updateHistoryTimeLabel() {}, updatePlayButton() {}, setHistoryChartLoading() {} });
  Object.assign(historyState, { pickedDate: "2026-11-23", dates: ["2026-11-23", "2026-11-20"] });
  const replayed = [];
  const context = { mode: "replay", services: { tradeDetails: {
    onRowSelect: (item) => replayed.push(item.id),
    onScopeChange: (scope) => { historyState.tradeDetails.scope = scope; draw(); },
    onQueryChange: (query) => { historyState.tradeDetails.query = query; draw(); },
    onDateSelect: (date) => { Object.assign(historyState.tradeDetails, { scope: "today", date }); draw(); },
  } }, dataSource: { invalidate() {}, subscribe: () => () => {} } };
  const host = document.getElementById("host");
  component = new TradeDetailsComponent();
  component.mount({ host, context, hydrate: false });
  draw();
  if (!host.textContent.includes("交易明細載入中")) fail("before the first answer");
  Object.assign(historyState.tradeDetails, { loadedAt: Date.now(), rows: [
    pair(1, "2026-11-23", "2330", "台積電", "多", 1072, 1083, 6305), pair(2, "2026-11-20", "1815", "富喬", "空", 128.5, 134, 4925), pair(3, "2026-09-01", "2303", "聯電", "多", 81, 80, -1350)] });
  draw();
  await settle();
  const rows = () => [...host.querySelectorAll("tr.ledger-row")];
  const names = () => rows().map((row) => row.cells[0].textContent);
  same(names(), ["台積電", "富喬", "聯電"], "every pair");
  if (/第一頁|上一頁|最後一頁/.test(host.textContent) || host.querySelector('input[type="number"]')) fail("no pages");

  // The side is 股數's colour; the name keeps the row's own.
  same(rows().map((row) => row.cells[1].querySelector("span")?.className), ["price-up", "price-down", "price-up"], "股數's colour");
  if (rows().some((row) => row.cells[0].querySelector("span") || /price-/.test(row.cells[0].className))) fail("股名 has no colour");
  const textBox = (cell) => { const range = document.createRange(); range.selectNodeContents(cell); const r = range.getBoundingClientRect(); return (r.left + r.right) / 2; };
  const heads = [...host.querySelectorAll("thead tr")].find((tr) => tr.getClientRects().length && tr.cells.length === 5);
  same([...heads.cells].map((c) => c.textContent.trim()), ["股名", "股數", "買價", "賣價", "損益"], "the titles");
  for (let i = 1; i < 5; i += 1) if (Math.abs(textBox(heads.cells[i]) - textBox(rows()[0].cells[i])) > 1.5) fail(`title ${i} is not over its figures`);

  // Narrowing.
  const input = host.querySelector('[data-role="trade-query"]');
  const type = async (text) => { input.value = text; input.dispatchEvent(new Event("input", { bubbles: true })); await settle(); };
  await type("23"); same(names(), ["台積電", "聯電"], "a code's start");
  host.querySelector('[data-trade-scope="today"]').click(); await settle();
  same(names(), ["台積電"], "今日 is the replayed day, the typed text still narrowing");
  await type("富"); if (!host.textContent.includes("沒有符合的交易")) fail("nothing matches");
  await type("");
  host.querySelector('[data-role="trade-date-button"]').click(); await settle();
  const options = [...document.querySelectorAll("[data-trade-date]")];
  same(options.map((b) => b.dataset.tradeDate), ["2026-11-23", "2026-11-20", "2026-09-01"], "the dates with trades and the recorded ones");
  options[2].click(); await settle();
  same(names(), ["聯電"], "a picked date is 今日's");
  same(host.querySelector('[data-role="trade-date-label"]').textContent, "2026-09-01", "the box names it");
  host.querySelector('[data-trade-scope="overview"]').click(); await settle();

  // A row opens and replays its trade; closing replays nothing.
  rows()[0].cells[0].click(); await settle(600);
  same([...host.querySelectorAll("tr[data-detail-key=\"t:1\"] .ledger-pair tr")].map((r) => [...r.cells].map((c) => c.textContent)),
    [["", "買入", "賣出"], ["時間", "10:12", "10:38"], ["單價", "1,072", "1,083"], ["價金", "1,072,100", "1,082,750"], ["報酬率", "0.59%"]], "what a row opens to");
  same(replayed, [1], "opening replays");
  rows()[0].cells[0].click(); await settle(600);
  if (host.querySelector("tr[data-detail-key]")) fail("closed again");
  same(replayed, [1], "closing replays nothing");
  component.destroy();
  return { ok: true };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 700, height: 700, webPreferences: { sandbox: false, offscreen: true, backgroundThrottling: false } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)}).then((r) => r.ok)`);
    console.log("history trade list ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("history trade list ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
