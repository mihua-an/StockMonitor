const { makeTempDir } = require("./support/temp_dirs.cjs");
// 歷史回放's 商品列 in a real Chromium (run with Electron): the stock list (features/history/stock_list.js) owns its container
// and draws it from historyState alone; the picked date (features/history/picked_date.js) tells whoever shows it.
//   * named states: no history (historyUnavailable says why) -> the list's message; a day without stocks; its stocks.
//   * a picked date reaches its listeners once per change, whoever picked it; listing a date picks nothing.
//   * the loading mark (historyState.loadingCode) and the active row are data: a change rewrites the class of the rows
//     it concerns and nothing else -- every row element stays the same node.
//   * the page (pages/history.js) only changes historyState and calls the components: it writes no container.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-history-sidebar-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const fail = (message) => { throw new Error(message); };
  const main = document.querySelector("main");
  main.innerHTML = `<div id="historyStockList" style="height:300px;overflow:auto"></div>`;
  const { historyState } = await import(`${base}js/features/history/history_state.js`);
  const { pickedHistoryDate, setHistoryDateValue, onHistoryDateChange, ensureHistoryDateOption } = await import(`${base}js/features/history/picked_date.js`);
  const { renderHistoryStockList } = await import(`${base}js/features/history/stock_list.js`);
  const stockList = document.getElementById("historyStockList");

  // --- no history, then a failed read with the dates already listed: the list says why ----------------------------
  historyState.dates = [];
  historyState.stocks = [];
  historyState.historyUnavailable = "找不到歷史 parquet";
  renderHistoryStockList();
  if (stockList.querySelector(".history-stock-list-empty")?.textContent !== "找不到歷史 parquet") fail(`no-history list: ${stockList.innerHTML}`);
  historyState.dates = ["2026-11-04", "2026-11-03"];
  historyState.historyUnavailable = "歷史資料載入失敗";
  renderHistoryStockList();
  if (stockList.querySelector(".history-stock-list-empty")?.textContent !== "歷史資料載入失敗") fail(`failure list: ${stockList.innerHTML}`);
  historyState.historyUnavailable = "";

  // --- the picked date --------------------------------------------------------------------------------------------
  const told = [];
  const stop = onHistoryDateChange((date) => told.push(date));
  historyState.selectedDate = "2026-11-02";
  if (pickedHistoryDate() !== "2026-11-02") fail("before one is picked, the date last shown");
  setHistoryDateValue("2026-11-03");
  setHistoryDateValue("2026-11-03");
  setHistoryDateValue("2026-11-04");
  if (told.join() !== "2026-11-03,2026-11-04" || pickedHistoryDate() !== "2026-11-04") fail(`picked: ${told} / ${pickedHistoryDate()}`);
  ensureHistoryDateOption("2026-10-30");
  if (historyState.dates.join() !== "2026-11-04,2026-11-03,2026-10-30") fail(`jump date not listed: ${historyState.dates}`);
  if (pickedHistoryDate() !== "2026-11-04") fail("listing a date does not pick it");
  stop();
  setHistoryDateValue("2026-11-03");
  if (told.length !== 2) fail("a removed listener is not told");

  // --- a day without stocks -----------------------------------------------------------------------------------------
  historyState.stocks = [];
  renderHistoryStockList();
  if (stockList.querySelector(".history-stock-list-empty")?.textContent !== "該日無股票資料") fail(`no-stocks list: ${stockList.innerHTML}`);

  // --- the day's stocks: the loading mark and the active row are class writes on the rows concerned ----------------
  historyState.stocks = [
    { code: "2330", name: "台積電", open: 1090, high: 1110, low: 1085, close: 1105, change: 15, change_pct: 1.38 },
    { code: "2317", name: "鴻海", open: 200, high: 205, low: 198, close: 199, change: -1, change_pct: -0.5 },
    { code: "2454", name: "聯發科", open: 1300, high: 1320, low: 1290, close: 1300, change: 0, change_pct: 0 },
  ];
  historyState.selectedCode = "2330";
  historyState.loadingCode = "";
  renderHistoryStockList();
  const rows = [...stockList.querySelectorAll(".history-stock-item")];
  if (rows.length !== 3) fail(`stock rows: ${rows.length}`);
  if (!rows[0].classList.contains("active")) fail("the selected stock's row is active");
  const spinning = () => [...stockList.querySelectorAll(".loading-spinner")].filter((node) => getComputedStyle(node).display !== "none");
  if (spinning().length) fail("no row spins before a load");

  const records = [];
  const observer = new MutationObserver((list) => records.push(...list));
  observer.observe(stockList, { subtree: true, childList: true, characterData: true, attributes: true });
  const step = (change) => {
    change();
    renderHistoryStockList();
    records.push(...observer.takeRecords());
    return records.splice(0);
  };
  const describe = (list) => list.map((r) => `${r.type}:${r.target.dataset?.historyCode || r.target.nodeName}:${r.attributeName || ""}`).join(", ");

  let written = step(() => { historyState.loadingCode = "2317"; });
  if (!written.length || written.some((r) => r.type !== "attributes" || r.attributeName !== "class" || r.target.dataset.historyCode !== "2317")) {
    fail(`starting the 2317 load should write only 2317's class: ${describe(written)}`);
  }
  if (!rows[1].classList.contains("history-stock-item-loading") || spinning().length !== 1 || !rows[1].contains(spinning()[0])) fail("the loading row spins");

  written = step(() => { historyState.selectedCode = "2317"; });
  const touched = new Set(written.map((r) => r.target.dataset?.historyCode));
  if (written.some((r) => r.type === "childList") || [...touched].some((code) => code !== "2330" && code !== "2317")) {
    fail(`moving the selection should write only the two rows' attributes: ${describe(written)}`);
  }

  written = step(() => { historyState.loadingCode = ""; });
  if (written.some((r) => r.type !== "attributes" || r.attributeName !== "class" || r.target.dataset.historyCode !== "2317")) {
    fail(`ending the load should write only 2317's class: ${describe(written)}`);
  }
  if (spinning().length) fail("no row spins after the load");
  if ([...stockList.querySelectorAll(".history-stock-item")].some((node, i) => node !== rows[i])) fail("a row element was replaced");

  written = step(() => {});
  if (written.length) fail(`an unchanged state wrote: ${describe(written)}`);
  observer.disconnect();
  return { ok: true };
}

function pageSource() {
  const source = fs.readFileSync(path.join(__dirname, "..", "ui", "renderer", "js", "pages", "history.js"), "utf8");
  const problems = [];
  if (/innerHTML/.test(source)) problems.push("pages/history.js writes innerHTML (the stock list owns its container)");
  if (/history-stock-item-loading|querySelectorAll\?\.\("\.history-stock-item"\)/.test(source)) {
    problems.push("pages/history.js marks stock rows itself (stock_list.js draws the mark from historyState.loadingCode)");
  }
  return problems;
}

app.whenReady().then(async () => {
  const problems = pageSource();
  if (problems.length) {
    console.error("history sidebar owners ui contract FAILED:", problems.join("; "));
    app.exit(1);
    return;
  }
  const win = new BrowserWindow({ show: false, width: 600, height: 500, webPreferences: { sandbox: false, offscreen: true } });
  const fixture = path.join(__dirname, "fixtures", "renderer_ui_geometry.html");
  await win.loadURL(pathToFileURL(fixture).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)}).then((r) => r.ok)`);
    console.log("history sidebar owners ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("history sidebar owners ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
