const { makeTempDir } = require("./support/temp_dirs.cjs");
// 資料中心's 收盤整理 card in a real Chromium (run with Electron): the page's own code on the real data_center.html and
// a fake app_api answering /api/data-center/closing while STK is being materialized. Checked: the four steps in one row,
// the bar shown at the day's percent, the running job's phase pip in the 執行紀錄, the figures beside; and the card is
// the same job-status component as 模型中心's 訓練狀態 (training.html): step card, log line and figure compute the same.
// Set CLOSING_UI_SHOT=<png path> to save a picture of the card.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-closing-progress-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base, dataCenterHtml, trainingHtml) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fail = (message) => { throw new Error(message); };
  window.desktopAPI = { networkManifest: { routes: [["/api/", "app_api"]], services: { app_api: { url: "http://app.invalid" } } } };
  const now = Date.now();
  const iso = (secondsAgo) => new Date(now - secondsAgo * 1000).toISOString();
  const closing = { ok: true, id: "STK:DAY", trading_date: "2026-10-29", stage: "materializing", settled_at: null,
    next: { id: "FUT:NIGHT", trading_date: "2026-10-29", seal_due_at: iso(-3600 * 14) },
    history: [{ id: "FUT:DAY", trading_date: "2026-10-29", stage: "done", ended_at: iso(3340), codes: 1, events: 169257, gaps: ["FUT:DAY"] },
      { id: "FUT:NIGHT", trading_date: "2026-10-28", stage: "done", ended_at: iso(36000), codes: 1, events: 98000, gaps: [] },
      { id: "US:FULL", trading_date: "2026-10-28", stage: "done", ended_at: iso(9000), codes: 12, events: 1_691_282, gaps: ["US:FULL"] }],
    sessions: [
    { id: "STK:DAY", market: "STK", session: "DAY", seal_due_at: iso(120), accepted: 3113766, sealed: true, state: "running", attempts: 1,
      max_attempts: 5, submitted_at: (now - 95_000) / 1000, result: null, remaining_s: 61,
      job: { job_id: "s1", status: "running", started_at: iso(150), phase: "write",
        phases: { scan: { done: 87, total: 87, elapsed_ms: 3282 }, read: { done: 7_086_938, total: 7_086_938, elapsed_ms: 49_260 },
          write: { done: 1_500_000, total: 3_113_766, elapsed_ms: 34_000 } } } },
    { id: "IDX:DAY", market: "IDX", session: "DAY", seal_due_at: iso(120), accepted: 48631, sealed: true, state: "succeeded", attempts: 1,
      max_attempts: 5, submitted_at: (now - 95_000) / 1000, updated_at: (now - 45_000) / 1000,
      result: { codes: 15, events: 49276, completeness: "complete", completed_at: iso(45) }, job: null },
  ], estimate: { elapsed_s: 150, remaining_s: 61, fraction: 150 / 211 } };
  window.fetch = async (input) => {
    const url = new URL(String(input?.url || input));
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/api/sources") return json({ source_settings: { enabled_sources: [], sources: {} } });
    if (url.pathname === "/api/data-center/closing") return json(closing);
    if (url.pathname === "/api/data-center/dates") return json({ ok: true, items: [] });
    return json({ ok: false, error: `unexpected ${url.pathname}` }, 404);
  };
  const main = document.getElementById("pageContainer");
  main.innerHTML = dataCenterHtml;
  const page = await import(`${base}js/pages/data_center.js`);
  page.initDataCenterPage();
  for (let i = 0; i < 50 && !document.querySelector("#dataCenterClosingLog .job-log-row"); i += 1) await wait(20);

  const steps = [...document.querySelectorAll("#dataCenterClosingSteps .job-step")];
  if (steps.length !== 4) fail(`four steps, got ${steps.length}`);
  const tops = new Set(steps.map((step) => Math.round(step.getBoundingClientRect().top)));
  if (tops.size !== 1) fail(`the steps sit in one row: tops ${[...tops]}`);
  const states = steps.map((step) => step.className.replace("job-step ", ""));
  if (states.join() !== "done,done,now,todo") fail(`step states ${states}`);
  if (steps[0].querySelector(".job-step-h").textContent.trim() !== "台股 收盤") fail("steps are named by the close");
  const bar = document.getElementById("dataCenterClosingBar");
  if (bar.hidden || !bar.querySelector(".job-bar > i")?.style.width.endsWith("%")) fail("the bar shows while the materializer runs");
  if (!document.querySelector("#dataCenterClosingLog .job-log-phase.now")?.textContent.includes("write")) fail("the running phase pip");
  const figures = document.getElementById("dataCenterClosingNext").textContent;
  if (!figures.includes("進度") || !figures.includes("預估剩餘") || !figures.includes("期貨夜盤")) fail(`figures: ${figures}`);
  // One estimate: the card's 預估剩餘 and the running job's eta are the same seconds; write's rate is events a second.
  const topLeft = [...document.querySelectorAll("#dataCenterClosingNext small")].find((s) => s.textContent === "預估剩餘")
    ?.nextElementSibling?.textContent.match(/約 (?:(\d+) 分 )?(\d+) 秒/);
  const pip = document.querySelector("#dataCenterClosingLog .job-log-figs")?.textContent || "";
  const rowLeft = pip.match(/eta (\d+):(\d+):(\d+)/);
  if (!topLeft || !rowLeft) fail(`預估剩餘 and eta both shown: ${figures} | ${pip}`);
  const top = Number(topLeft[1] || 0) * 60 + Number(topLeft[2]);
  const row = Number(rowLeft[1]) * 3600 + Number(rowLeft[2]) * 60 + Number(rowLeft[3]);
  if (top !== row) fail(`預估剩餘 ${top}s vs eta ${row}s`);
  if (/\b0\/s/.test(pip) || !/44\.1k\/s/.test(pip)) fail(`write's rate: ${pip}`);
  const history = document.querySelectorAll("#dataCenterClosingHistory tbody tr");
  if (history.length !== 3) fail(`上次物化 rows: ${history.length}`);
  // 上次物化 is a table card of its own under the 收盤整理 card, titled as a settings group (the 11-01 sample the user
  // approved); its cells keep the card's inset.
  const historyHost = document.querySelector("#dataCenterClosingHistory");
  if (historyHost.firstElementChild?.tagName !== "TABLE" || historyHost.dataset.gridVariant !== "page") fail("上次物化 is a table card");
  if (historyHost.previousElementSibling?.textContent.trim() !== "上次物化") fail("上次物化's group title");
  if (!history[2].textContent.includes("美股")) fail("a Futu close is named 美股");
  // 下次物化 in the card, then 上次物化 below it.
  const nextBox = document.getElementById("dataCenterClosingNext").getBoundingClientRect();
  const historyBox = historyHost.getBoundingClientRect();
  const closingBox = document.querySelector(".dc-closing").getBoundingClientRect();
  if (!(nextBox.bottom <= closingBox.bottom && closingBox.bottom <= historyBox.top)) fail("下次物化 in the card, then 上次物化");
  // 執行紀錄 opens by itself while the close it shows is being materialized (user 11-01).
  await wait(450);
  const logPane = document.querySelector(".dc-closing .job-log-pane");
  if (logPane.hidden || document.getElementById("dataCenterClosingLogToggle").getAttribute("aria-expanded") !== "true") fail("the running close's log is open");
  if (logPane.getBoundingClientRect().height < 120) fail(`the log has room: ${logPane.getBoundingClientRect().height}px`);
  const card = document.querySelector(".dc-closing").getBoundingClientRect();
  if (document.documentElement.scrollWidth > document.documentElement.clientWidth) fail("no page-wide horizontal scroll");

  const look = (element, names) => Object.fromEntries(names.map((name) => [name, getComputedStyle(element)[name]]));
  const sample = () => ({
    step: look(document.querySelector(".job-step.done"), ["backgroundColor", "borderTopColor", "paddingTop"]),
    stepTitle: look(document.querySelector(".job-step-h"), ["fontSize", "color"]),
    row: look(document.querySelector(".job-log-row"), ["fontSize"]),
    log: look(document.querySelector(".job-log"), ["backgroundColor", "borderTopColor"]),
    figure: look(document.querySelector(".job-stats b"), ["fontSize", "color"]),
  });
  const dataCenter = sample();
  page.disposeDataCenterPage();
  main.innerHTML = trainingHtml;
  const { renderSteps, renderLog, renderSummary } = await import(`${base}js/pages/training/model_center_view.js`);
  const job = { state: "SUCCEEDED", started_at: iso(600), updated_at: iso(60), log: [{ step: "checking", started_at: iso(600), ended_at: iso(590) }] };
  document.getElementById("trainingSteps").innerHTML = renderSteps({ job, running: false });
  document.getElementById("trainingLog").innerHTML = renderLog({ job, running: false });
  document.getElementById("trainingSummary").innerHTML = renderSummary({ job, last_success: {}, dataset: {} });
  const training = sample();
  if (JSON.stringify(dataCenter) !== JSON.stringify(training)) {
    fail(`one component on both pages: ${JSON.stringify(dataCenter)} vs ${JSON.stringify(training)}`);
  }
  main.innerHTML = dataCenterHtml;
  page.initDataCenterPage();
  for (let i = 0; i < 100 && !document.querySelector("#dataCenterClosingLog .job-log-row"); i += 1) await wait(20);
  // Leaving the page and coming back draws the card again (its poll restarts with the page).
  if (!document.querySelector("#dataCenterClosingLog .job-log-row")) fail("the card is drawn again when the page is entered again");
  const again = document.querySelector(".dc-closing").getBoundingClientRect();
  return { x: Math.floor(again.left), y: Math.floor(again.top), width: Math.ceil(again.width), height: Math.ceil(card.height) };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1500, height: 900, webPreferences: { sandbox: false, backgroundThrottling: false,
    // A hidden window does not paint every change: the picture is drawn offscreen.
    offscreen: Boolean(process.env.CLOSING_UI_SHOT) } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const renderer = path.join(__dirname, "..", "ui", "renderer");
  const base = pathToFileURL(renderer + path.sep).href;
  const dataCenterHtml = fs.readFileSync(path.join(renderer, "pages", "data_center.html"), "utf8");
  const trainingHtml = fs.readFileSync(path.join(renderer, "pages", "training.html"), "utf8");
  try {
    const rect = await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)}, ${JSON.stringify(dataCenterHtml)}, ${JSON.stringify(trainingHtml)})`);
    if (process.env.CLOSING_UI_SHOT) await new Promise((resolve) => setTimeout(resolve, 300));
    if (process.env.CLOSING_UI_SHOT) fs.writeFileSync(process.env.CLOSING_UI_SHOT, (await win.webContents.capturePage(rect)).toPNG());
    console.log("closing progress ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("closing progress ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
