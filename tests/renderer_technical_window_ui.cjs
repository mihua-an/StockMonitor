const { makeTempDir } = require("./support/temp_dirs.cjs");
// 技術分析's detached window in a real Chromium (run with Electron), on a fake service: changing the product from the list,
// every timeframe button, the focused bar's readout with its date and volume (no 均價: decisions.md); and the broker lane -- asked
// only by a scroll at the oldest local bar, joined while it runs, quota full, the end, a failure that may be retried,
// and a timeframe that stops at its own retention. Set TA_WINDOW_UI_SHOT=<png path> to save a picture.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-technical-window-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const fail = (message) => { throw new Error(message); };
  const tick = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
  for (const sheet of ["tokens.css", "base.css", "components/expand-picker.css", "components/trend-chart.css", "components/quote-header.css",
    "components/product-list.css", "components/mini-candle.css", "pages/history.css", "components/technical-window.css"]) {
    const link = document.createElement("link");
    link.rel = "stylesheet"; link.href = `${base}styles/${sheet}`;
    document.head.appendChild(link);
    await new Promise((resolve) => { link.onload = link.onerror = resolve; });
  }
  localStorage.setItem("technicalAnalysisTimeframeV1", "D");
  // desktopAPI.loadWatchPagesLocal refuses a detached window: the list comes from the service.
  window.desktopAPI = { loadWatchPagesLocal: async () => fail("the window must not use the main window's channel") };
  const { TechnicalWindowComponent } = await import(`${base}js/features/realtime/components/technical_window_component.js`);

  const day = (n) => new Date(Date.UTC(2026, 9, 1 + n)).toISOString().slice(0, 10);
  const row = (date, close) => ({ trading_date: date, open: close - 1, high: close + 2, low: close - 2, close, volume: 100, source: "kbar_store" });
  let older = [];
  const local = new Map([["2330", [row(day(10), 100), row(day(11), 101), row(day(12), 102)]], ["2344", [row(day(11), 50), row(day(12), 51)]]]);
  const asked = [], requests = [];
  const history = async ({ code, resolution, before }) => {
    asked.push({ code, resolution, before });
    const held = [...older.filter((bar) => code === "2330"), ...local.get(code)].filter((bar) => bar.trading_date < before);
    if (resolution === "minute") return { ok: true, segments: [[[540, 810]]], days: [], next_before: null, horizons: { "1": day(11), "3": day(11), "5": day(5), "15": day(1), "30": day(0), "60": day(0) } };
    return { ok: true, bars: held, next_before: null };
  };
  let answer = { state: "RUNNING" }, status = { state: "RUNNING" };
  const service = {
    key: (code) => `${code}|${day(20)}`, sessionDate: () => day(20), history,
    watchPages: async () => ({ ok: true, pages: [{ id: "a", market: "tw", codes: ["2330", "2344"],
      items: [{ code: "2330", name: "台積電" }, { code: "2344", name: "華邦電" }] }] }),
    onKeyChange: () => () => {},
    subscribe: (code, fn) => { fn({ trend: [], day: { open: 10, high: 12, low: 9, close: 11, volume: 5, fixed_k: {} } }); return () => {}; },
    subscribeQuote: () => () => {},
    quoteRead: (code) => ({ identity: { code }, revision: {}, channels: { summary: { data: { code, label: null } }, quote: { data: { lastPrice: 110, prevClose: 100, dayHigh: 112, dayLow: 99, openPrice: 101 } } } }),
    older: { request: async (code, before) => { requests.push({ code, before }); return answer; }, status: async () => status },
  };
  let selected = "2330";
  const context = { mode: "live", services: { technicalAnalysis: service },
    symbolStore: { getSelectedSymbol: () => selected, setSelectedSymbol: (code) => { selected = code; }, subscribe: () => () => {} } };
  const host = document.createElement("section");
  host.style.cssText = "width:1100px;height:640px";
  document.querySelector("main").appendChild(host);
  const component = new TechnicalWindowComponent();
  component.mount({ host, context });
  await tick(200);
  const chart = component.candles.chart;

  if (!host.querySelector(".product-quote-code-input")) fail("no code box");
  const picks = [...host.querySelectorAll('[data-role="ta-timeframe"] [data-pick]')].map((node) => node.dataset.pick).join();
  if (picks !== "D,W,M,1,3,5,15,30,60") fail(`the timeframe row: ${picks}`);
  if (chart.sma.length) fail("this window draws no moving averages");
  if (chart.bars.some((bar) => bar.average != null)) fail("技術分析 draws no 均價 (decisions.md)");
  const readout = () => host.querySelector('[data-role="ta-ohlcv"]').textContent;
  if (!readout().includes("/") || !readout().includes("量") || readout().includes("均")) fail(`the readout: ${readout()}`);
  const header = () => host.querySelector('[data-role="product-price"]').textContent;
  if (header() !== "110.00") fail(`header price: ${header()}`);
  const cards = () => [...host.querySelectorAll("[data-card-code]")];
  if (cards().length !== 2) fail(`the list: ${cards().length}`);

  // The readout follows the pointer.
  const canvas = host.querySelector('[data-role="ta-canvas"]');
  const box = canvas.getBoundingClientRect();
  canvas.dispatchEvent(new MouseEvent("mousemove", { clientX: box.right - 58 - 4 - chart.barWidth, clientY: box.top + 120, bubbles: true }));
  await tick();
  if (!readout().includes(day(12).replaceAll("-", "/"))) fail(`hover reads its bar's date: ${readout()}`);
  canvas.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));

  // Nothing is asked of the broker until the user scrolls at the oldest bar.
  if (requests.length) fail("opening the window asked the broker");
  const older_node = host.querySelector('[data-role="ta-older"]');
  const wheel = () => canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 400, bubbles: true, cancelable: true, clientX: box.left + 300, clientY: box.top + 100 }));
  wheel(); await tick(); wheel(); wheel(); await tick();
  if (requests.length !== 1 || requests[0].before !== day(10)) fail(`one request while running: ${JSON.stringify(requests)}`);
  if (older_node.hidden || !older_node.textContent.includes("下載")) fail("no loading state");

  // Done: the older bars join, the view stays on the bar it showed, the state goes away.
  const viewed = chart.bars[chart.bars.length - 1 - chart.offset].key;
  older = [row(day(8), 90), row(day(9), 95)];
  status = { state: "DONE", start_date: day(8), end_date: day(9), rows: 500 };
  await tick(1300);
  if (chart.bars[0].key !== day(8)) fail(`older bars join: ${chart.bars[0].key}`);
  if (chart.bars[chart.bars.length - 1 - chart.offset].key !== viewed) fail("the download moved the view");
  if (!older_node.hidden) fail("the loading state stays");

  // Quota full: shown, and not asked again.
  chart.offset = chart.bars.length - 1;
  answer = { state: "QUOTA_FULL" };
  wheel(); await tick();
  if (older_node.textContent !== "額度額滿，無法下載") fail(`quota: ${older_node.textContent}`);
  const afterQuota = requests.length;
  wheel(); await tick();
  if (requests.length !== afterQuota) fail("a full quota is asked again");

  // Another product starts over. The end: nothing shown, not asked again.
  cards().find((node) => node.dataset.cardCode === "2344").click();
  await tick(150);
  if (selected !== "2344" || chart.bars[0].key !== day(11)) fail(`changing product: ${selected} ${chart.bars[0]?.key}`);
  if (!older_node.hidden) fail("the quota message belongs to the last product");
  answer = { state: "END" };
  chart.offset = chart.bars.length - 1;
  wheel(); await tick();
  const atEnd = requests.length;
  wheel(); await tick();
  if (requests.length !== atEnd) fail("the end is asked again");
  if (!older_node.hidden) fail(`the end shows nothing: ${older_node.textContent}`);

  // A failure is shown and is not the end: the next scroll asks again.
  component.select("2330");
  await tick(150);
  answer = { state: "FAILED", error: "broker down" };
  chart.offset = chart.bars.length - 1;
  wheel(); await tick();
  if (older_node.textContent !== "下載失敗") fail(`failure: ${older_node.textContent}`);
  const afterFailure = requests.length;
  wheel(); await tick();
  if (requests.length !== afterFailure + 1) fail("a failure is not retried on the next scroll");

  // The timeframes: 1 minute has come to its retention at day 11; asking stops there.
  component.select("2344");
  await tick(150);
  host.querySelector('[data-pick="1"]').click();
  await tick(150);
  const intraday = component.candles.history;
  if (!intraday.reachedHorizon("1", day(11))) fail("the 1-minute retention");
  if (intraday.reachedHorizon("5", day(11))) fail("5 minutes reaches further");
  if (intraday.reachedHorizon("D", day(0))) fail("daily bars have no retention");
  for (const key of picks.split(",")) { host.querySelector(`[data-pick="${key}"]`).click(); await tick(20); }

  if (globalThis.takeShot) { host.querySelector('[data-pick="D"]').click(); await tick(300); await globalThis.takeShot("window"); }
  component.destroy();
  return { ok: true };
}

app.whenReady().then(async () => {
  const shot = process.env.TA_WINDOW_UI_SHOT || "";
  const win = new BrowserWindow({ show: false, width: 1200, height: 720, webPreferences: { sandbox: false, offscreen: Boolean(shot) } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  win.webContents.on("console-message", (details) => { if (details.level === "error" || details.level === 3) console.error("[page]", details.message); });
  if (shot) {
    win.webContents.on("page-title-updated", async (event, title) => {
      if (!title.startsWith("shot:")) return;
      fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript("globalThis.shotDone?.()");
    });
    await win.webContents.executeJavaScript(`globalThis.takeShot = (name) => new Promise((resolve) => { globalThis.shotDone = resolve; document.title = "shot:" + name; }); 0`);
  }
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)})`);
    console.log("technical window ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error(error?.message || error);
    app.exit(1);
  }
});
