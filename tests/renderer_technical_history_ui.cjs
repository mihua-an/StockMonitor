const { makeTempDir } = require("./support/temp_dirs.cjs");
// 技術分析 reaching back into earlier days, in a real Chromium (run with Electron), the component on a fake service.
// Checked: all nine timeframes in the one picker; the older pages are asked for while the view is not full and stop at
// the oldest day; scrolling back brings the next page without moving the view; a live update changes the data only
// (toolbar and canvas are the same nodes, a scrolled-back view stays); D/W/M end in today's bar; the picker's choice is
// kept under its stored name. Set TA_HISTORY_UI_SHOT=<png path prefix> to save pictures.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-technical-history-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const fail = (message) => { throw new Error(message); };
  // A hidden window's animation frames come about once a second: the chart's data does not wait for them.
  const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
  const settle = () => tick(80);
  const { TechnicalAnalysisComponent } = await import(`${base}js/features/realtime/components/technical_analysis_component.js`);
  for (const sheet of ["tokens.css", "components/expand-picker.css", "components/trend-chart.css"]) {
    const link = document.createElement("link");
    link.rel = "stylesheet"; link.href = `${base}styles/${sheet}`;
    document.head.appendChild(link);
    await new Promise((resolve) => { link.onload = link.onerror = resolve; });
  }
  localStorage.setItem("technicalAnalysisTimeframeV1", "5");

  // Local days, newest last: every weekday of three weeks but one missing day, 265 minutes each.
  const dates = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-26", "2026-10-27", "2026-10-28",
    "2026-10-29", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"];
  let price = 100;
  const rows = new Map(dates.map((date, dayIndex) => {
    const minutes = [];
    for (let m = 540; m < 805; m += 1) {
      const open = price;
      price += Math.sin(m / 17 + dayIndex) * 0.4;
      minutes.push([m, open, Math.max(open, price) + 0.2, Math.min(open, price) - 0.2, price, 5 + (m % 13)]);
    }
    return [date, minutes];
  }));
  const asked = [];
  const history = async ({ code, resolution, before }) => {
    asked.push({ code, resolution, before });
    const older = dates.filter((date) => date < before);
    if (resolution === "minute") {
      const page = older.slice(-5);
      return { ok: true, segments: [[[540, 810]]], days: page.map((date) => ({ trading_date: date, source: "kbar_store", timeframe: 1, bars: rows.get(date) })),
        next_before: older.length > 5 ? page[0] : null };
    }
    return { ok: true, bars: older.map((date) => {
      const day = rows.get(date);
      return { trading_date: date, open: day[0][1], close: day.at(-1)[4], high: Math.max(...day.map((r) => r[2])), low: Math.min(...day.map((r) => r[3])),
        volume: day.reduce((sum, r) => sum + r[5], 0), source: "kbar_store" };
    }), next_before: null };
  };

  const trendPoint = (minute) => ({ minute, open: price, high: price + 0.3, low: price - 0.3, close: price + 0.1, minute_volume: 7 });
  const fixed = (k, upto) => {
    const out = [];
    for (let start = 540; start <= upto; start += k) out.push({ start_minute: start, end_minute: start + k - 1, open: price, high: price + 1, low: price - 1, close: price + 0.5, volume: 30 });
    return out;
  };
  const stateAt = (upto) => {
    const trend = [];
    for (let m = 540; m <= upto; m += 1) trend.push(trendPoint(m));
    return { trend, day: { open: price, high: price + 3, low: price - 3, close: price + 1, volume: 900,
      fixed_k: { k3: fixed(3, upto), k5: fixed(5, upto), k15: fixed(15, upto), k30: fixed(30, upto), k60: fixed(60, upto) } } };
  };
  let listener = null;
  const service = {
    key: (code) => `${code}|2026-11-06`, sessionDate: () => "2026-11-06", history,
    onKeyChange: () => () => {},
    subscribe: (code, fn) => { listener = fn; fn(stateAt(560)); return () => { listener = null; }; },
  };
  const context = {
    mode: "live",
    symbolStore: { getSelectedSymbol: () => "2330", subscribe: () => () => {} },
    dataSource: { invalidate: () => {}, subscribe: () => () => {}, get: () => null },
    services: { technicalAnalysis: service },
  };
  const host = document.createElement("section");
  host.style.cssText = "width:860px;height:460px;display:flex;flex-direction:column;background:#101418";
  document.querySelector("main").appendChild(host);
  // The pane's button opens the detached window on the product on screen.
  let opened = null;
  window.desktopAPI = { detachedWindows: { technicalWindow: {} }, openDetachedView: async (descriptor) => { opened = descriptor; } };
  const component = new TechnicalAnalysisComponent();
  component.mount({ host, context });
  await settle();
  const popout = host.querySelector('[data-role="ta-popout"]');
  if (!popout) fail("no pop-out button");
  popout.click();
  await settle();
  if (opened?.componentId !== "technicalWindow" || opened.symbol !== "2330") fail(`pop-out: ${JSON.stringify(opened)}`);

  const chart = component.chart;
  const picks = [...host.querySelectorAll('[data-role="ta-timeframe"] [data-pick]')].map((node) => node.dataset.pick).join();
  if (picks !== "1,3,5,15,30,60,D,W,M") fail(`the timeframes: ${picks}`);
  if (!asked.length || asked[0].before !== "2026-11-06" || asked[0].resolution !== "minute") fail(`first page ${JSON.stringify(asked[0])}`);
  if (!chart.bars.some((bar) => bar.dayStart)) fail("a chart of several days marks its days");
  if (chart.bars.at(-1).key !== "2026-11-06|560") fail(`today ends the chart: ${chart.bars.at(-1).key}`);
  if (asked.length !== 1) fail(`a page of 5 days at 5 minutes fills the view, no more is read: ${JSON.stringify(asked)}`);
  const picture = async (name) => { if (globalThis.takeShot) { await new Promise(requestAnimationFrame); await tick(120); await globalThis.takeShot(name); } };
  await picture("5m-latest");

  // Scrolling back: the next page arrives, the bar on screen stays on screen.
  const toolbar = host.querySelector('[data-role="ta-toolbar"]');
  const canvas = host.querySelector('[data-role="ta-canvas"]');
  const wheel = (dy) => canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: dy, deltaX: 0, bubbles: true, cancelable: true, clientX: 300, clientY: 200 }));
  const held = chart.bars.length;
  let guard = 0;
  while (asked.length < 2 && guard < 200) { wheel(400); guard += 1; await tick(); }
  if (asked.length < 2) fail("scrolling back never asked for the next page");
  const viewedBefore = chart.bars[chart.bars.length - 1 - chart.offset].key;
  await settle();
  if (chart.bars.length <= held) fail("the older page did not join the chart");
  if (chart.bars[chart.bars.length - 1 - chart.offset].key !== viewedBefore) fail("the page moved the view");
  if (asked[1].before !== asked[0].before && asked[1].before >= asked[0].before) fail("the next page is older");
  await picture("5m-scrolled");

  // A live update while scrolled back: data only, the view stays.
  const offset = chart.offset;
  listener(stateAt(570));
  await settle();
  if (chart.offset <= offset) fail("a new bar keeps a scrolled-back view where it was");
  if (chart.bars[chart.bars.length - 1 - chart.offset].key !== viewedBefore) fail("a live update moved the scrolled-back view");
  if (host.querySelector('[data-role="ta-toolbar"]') !== toolbar || host.querySelector('[data-role="ta-canvas"]') !== canvas) fail("a live update rebuilt the toolbar or the canvas");

  // To the oldest day: asked until the answer says nothing older, then not again.
  for (guard = 0; guard < 400 && !chart.bars[0].key.startsWith("2026-10-19"); guard += 1) { wheel(4000); await tick(); }
  await settle();
  if (!chart.bars[0].key.startsWith("2026-10-19")) fail(`the oldest local day is reached: ${chart.bars[0].key}`);
  const count = asked.length;
  wheel(4000);
  await settle();
  if (asked.length !== count) fail("nothing older: not asked again");

  // Picking a timeframe: 60m, then D, W and M, each ending in today's bar.
  const pick = async (key) => { host.querySelector(`[data-pick="${key}"]`).click(); await settle(); };
  await pick("60");
  if (chart.bars.at(-1).key !== "2026-11-06|540") fail(`60m ends in today's bar: ${chart.bars.at(-1).key}`);
  if (chart.offset !== 0) fail("a new timeframe shows the newest bars");
  await picture("60m");
  await pick("D");
  if (chart.bars.at(-1).key !== "2026-11-06" || chart.bars.length !== dates.length + 1) fail(`D: ${chart.bars.length} bars ending ${chart.bars.at(-1).key}`);
  if (chart.bars.some((bar) => bar.key === "2026-10-30")) fail("a day with no local data is not shown");
  await picture("day");
  await pick("W");
  if (chart.bars.at(-1).key !== "2026-11-02" || chart.bars.length !== 3) fail(`W: ${chart.bars.map((bar) => bar.key)}`);
  await picture("week");
  await pick("M");
  if (chart.bars.map((bar) => bar.key).join() !== "2026-10,2026-11") fail(`M: ${chart.bars.map((bar) => bar.key)}`);
  if (localStorage.getItem("technicalAnalysisTimeframeV1") !== "M") fail("the choice is kept under its stored name");
  if (asked.filter((query) => query.resolution === "day").length !== 1) fail("D, W and M read the same page");

  component.destroy();
  return { ok: true };
}

app.whenReady().then(async () => {
  const shot = process.env.TA_HISTORY_UI_SHOT || "";
  const win = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { sandbox: false, offscreen: Boolean(shot) } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  win.webContents.on("console-message", (details) => { if (details.level === "error" || details.level === 3) console.error("[page]", details.message); });
  if (shot) {
    // The page asks for a picture by title; capturePage needs the frame the page just drew.
    win.webContents.on("page-title-updated", async (event, title) => {
      if (!title.startsWith("shot:")) return;
      const name = title.slice(5);
      const image = await win.webContents.capturePage();
      fs.writeFileSync(`${shot}-${name}.png`, image.toPNG());
      await win.webContents.executeJavaScript("globalThis.shotDone?.()");
    });
    await win.webContents.executeJavaScript(`globalThis.takeShot = (name) => new Promise((resolve) => { globalThis.shotDone = resolve; document.title = "shot:" + name; }); 0`);
  }
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)})`);
    console.log("technical history ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("technical history ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
