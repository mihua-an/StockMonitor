const { makeTempDir } = require("./support/temp_dirs.cjs");
// 帳務 當沖分析: which row is marked as the open replay's source (`account-active-source-row`) has one owner,
// daytrade_replay_host.js. Run with Electron, on the real account.html markup. Checked: the view's rows carry only
// their replay id and whether they can be replayed -- never the mark, whatever replay is open; the same pair listed
// in the weekday detail, a band's detail, the ranking and the direction report is marked only in the part of the page
// its replay was opened from, the mark moves when the origin changes and goes when no 當沖 replay is open.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-daytrade-replay-source-row-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base, accountHtml) {
  const fail = (message) => { throw new Error(message); };
  window.desktopAPI = { networkManifest: { routes: [["/api/", "app_api"]], services: { app_api: { url: "http://app.invalid" } } } };
  document.querySelector("main").innerHTML = accountHtml;
  const { account, actualAccountReplayState } = await import(`${base}js/features/account/account_state.js`);
  account.market = "台股";
  const { daytradeBucketDetailRowsHtml, rankingRows } = await import(`${base}js/features/account/daytrade_view.js`);
  const { isDaytradeReplayOrigin, renderDaytradeReplayHost } = await import(`${base}js/features/account/daytrade_replay_host.js`);

  const pair = { id: 2, realized_date: "2026-10-15", market: "台股", code: "2330", name: "台積電", trade_type: "當沖",
    direction: "多", qty: 1000, profit: 2000, roi: 0.02, entry_ref: "09:05:00", exit_ref: "09:20:00", buy_ref: "09:05:00", sell_ref: "09:20:00", hold_period: 15 };

  // The view's rows, drawn while each 當沖 origin's replay of this very pair is open: no mark from the view.
  for (const origin of ["daytrade", "daytradeBucket", "daytradeWeekday", "daytradeRanking"]) {
    Object.assign(actualAccountReplayState, { origin, pairId: 2, pair: null });
    const html = daytradeBucketDetailRowsHtml([pair]) + rankingRows([pair]);
    if (html.includes("account-active-source-row")) fail(`the view marks a source row (${origin} open)`);
    if (!html.includes('data-daytrade-replay-id="2"') || !html.includes("account-daytrade-detail-replayable")) fail("the view's rows carry their replay id and replayable mark");
  }

  // The same pair in the four parts of the page a 當沖 replay opens from.
  const detail = (cls) => {
    const host = document.createElement("div");
    host.className = cls;
    host.innerHTML = `<table><tbody>${daytradeBucketDetailRowsHtml([pair])}</tbody></table>`;
    document.getElementById("actualDirectionReportCard").before(host);
  };
  detail("account-daytrade-weekday-detail");
  detail("account-daytrade-bucket-detail");
  document.getElementById("actualTopLossBody").innerHTML = rankingRows([pair]);
  document.getElementById("actualDirectionReportBody").innerHTML = rankingRows([pair]);
  const marked = () => [...document.querySelectorAll(".account-active-source-row")].map((row) =>
    row.closest(".account-daytrade-weekday-detail") ? "weekday" : row.closest(".account-daytrade-bucket-detail") ? "bucket"
      : row.closest(".account-ranking-grid") ? "ranking" : row.closest(".account-direction-report-card") ? "report" : "elsewhere").join();
  if (document.querySelectorAll('[data-daytrade-replay-id="2"]').length !== 4) fail("the pair is listed four times");

  for (const [origin, where] of [["daytradeWeekday", "weekday"], ["daytradeBucket", "bucket"], ["daytradeRanking", "ranking"], ["daytrade", "report"]]) {
    if (!isDaytradeReplayOrigin(origin)) fail(`${origin} is a 當沖 origin`);
    Object.assign(actualAccountReplayState, { origin, pairId: 2, pair: null });
    renderDaytradeReplayHost();
    if (marked() !== where) fail(`${origin}: marked ${marked() || "nothing"}, want ${where}`);
  }
  Object.assign(actualAccountReplayState, { origin: "daytrade", pairId: 9, pair: null });
  renderDaytradeReplayHost();
  if (marked()) fail(`another pair's replay marks ${marked()}`);
  Object.assign(actualAccountReplayState, { origin: "pairs", pairId: 2, pair: null });
  if (isDaytradeReplayOrigin("pairs") || isDaytradeReplayOrigin("stockStats")) fail("每日明細 / 個股數據 are not 當沖 origins");
  renderDaytradeReplayHost();
  if (marked()) fail(`a 每日明細 replay marks ${marked()}`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 1000, webPreferences: { sandbox: false } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  const accountHtml = fs.readFileSync(path.join(__dirname, "..", "ui", "renderer", "pages", "account.html"), "utf8");
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)}, ${JSON.stringify(accountHtml)})`);
    console.log("daytrade replay source row ui passed");
    app.exit(0);
  } catch (error) {
    console.error("daytrade replay source row ui FAILED:", error?.message || error);
    app.exit(1);
  }
});
