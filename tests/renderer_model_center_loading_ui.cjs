const { makeTempDir } = require("./support/temp_dirs.cjs");
// 模型中心 before its first answer, in a real Chromium (run with Electron): the page's own code on the real
// training.html with a fake API that holds /api/training/models until released. Checked: the moment the page is
// entered every card shows the shared load-state component (載入中…), the answer's content replaces it, a failed
// first answer turns the cards to 讀取失敗, and 帳務's placeholder is the same component with the same look.
// Set MODEL_CENTER_LOADING_SHOT=<dir> to save a picture of the page while loading and after the answer.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-model-center-loading-ui-"));
app.on("window-all-closed", () => {});

const CARD_BODIES = ["trainingLog", "trainingSummary", "trainingToday", "liveModelCards", "modelPairCards", "importanceCards"];

// Enter the page with the answer held back; returns what each card shows then.
async function enter(base, trainingHtml, cards, outcome) {
  window.desktopAPI = { networkManifest: { routes: [["/api/", "app_api"]], services: { app_api: { url: "http://app.invalid" } } } };
  const slots = [1, 3, 5, 10, 15].flatMap((minutes) => ["up", "down"].map((direction) => ({
    key: `${minutes}m_${direction}`, horizon_minutes: minutes, direction, enabled: true, model: `m-${minutes}-${direction}`,
    kind: "lightgbm", champion_state: "OK", validation_auc: 0.62, candidates: [] })));
  const answer = { ok: true, job: { state: "SUCCEEDED", started_at: "2026-10-31T14:50:00+08:00", finished_at: "2026-10-31T15:10:00+08:00" },
    running: false, pending_request: null, last_success: { finished_at: "2026-10-31T15:10:00+08:00", trained: [] }, slots,
    dataset: { samples: 1200000, codes: 980, trading_dates: ["2026-10-30"] },
    today: { trading_date: "2026-11-02", phase: "BEFORE_OPEN", window: { trained_dates: ["2026-10-30"], test_only_dates: [], events: 18210896, bytes: 15996817481 } } };
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  window.__releaseModels = release;
  window.fetch = async (input) => {
    const url = new URL(String(input?.url || input));
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/api/sources") return json({ source_settings: { enabled_sources: [], sources: {} } });
    if (url.pathname === "/api/training/models") {
      await held;
      if (outcome === "fail") return json({ ok: false, error: "MODEL_API_DOWN" }, 503);
      return json(answer);
    }
    return json({ ok: false, error: `unexpected ${url.pathname}` }, 404);
  };
  document.getElementById("pageContainer").innerHTML = trainingHtml;
  const page = await import(`${base}js/pages/training.js`);
  page.bindTrainingEvents();
  window.__refresh = page.refreshTrainingStatus().catch((error) => String(error?.message || error));
  return cards.map((id) => document.getElementById(id).innerHTML);
}

async function settle(cards) {
  window.__releaseModels();
  await window.__refresh;
  return cards.map((id) => document.getElementById(id).innerHTML);
}

async function accountLook(base) {
  const { loadStateHtml, emptyStateHtml } = await import(`${base}js/core/load_state_view.js`);
  const box = document.createElement("div");
  box.innerHTML = loadStateHtml("failed", "<x>") + emptyStateHtml("這一天沒有交易資料") + loadStateHtml("pending");
  document.body.appendChild(box);
  const [failed, empty, pending] = box.children;
  const style = getComputedStyle(failed);
  const out = { failed: failed.textContent, failedHtml: failed.innerHTML, empty: empty.dataset.state, pending: pending.textContent,
    color: style.color, fontSize: style.fontSize, padding: style.padding };
  box.remove();
  return out;
}

app.whenReady().then(async () => {
  const shots = process.env.MODEL_CENTER_LOADING_SHOT;
  const win = new BrowserWindow({ show: false, width: 1500, height: 1100, webPreferences: { sandbox: false, backgroundThrottling: false,
    // A hidden window does not paint every change: the picture is drawn offscreen.
    offscreen: Boolean(shots) } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const renderer = path.join(__dirname, "..", "ui", "renderer");
  const base = pathToFileURL(renderer + path.sep).href;
  const trainingHtml = fs.readFileSync(path.join(renderer, "pages", "training.html"), "utf8");
  const run = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(", ")})`);
  const shot = async (name) => {
    if (!shots) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.mkdirSync(shots, { recursive: true });
    fs.writeFileSync(path.join(shots, name), (await win.webContents.capturePage()).toPNG());
  };
  const fail = (message) => { throw new Error(message); };
  try {
    const loading = await run(enter, base, trainingHtml, CARD_BODIES, "ok");
    loading.forEach((html, i) => {
      if (!html.includes('class="load-state" data-state="loading"') || !html.includes("載入中…")) fail(`${CARD_BODIES[i]} shows the loading state before the answer: ${html}`);
    });
    await shot("model_center_loading.png");
    const loaded = await run(settle, CARD_BODIES);
    loaded.forEach((html, i) => {
      if (html.includes("load-state")) fail(`${CARD_BODIES[i]} replaced its loading state with the answer: ${html}`);
    });
    if (!loaded[3].includes("mc-live") || !loaded[2].includes("18.21M")) fail(`the answer is drawn: ${loaded[3].slice(0, 200)} | ${loaded[2]}`);
    await shot("model_center_loaded.png");

    const failedFirst = await run(enter, base, trainingHtml, CARD_BODIES, "fail");
    if (!failedFirst.every((html) => html.includes(`data-state="loading"`))) fail("a page entered again starts from the loading state");
    const failed = await run(settle, CARD_BODIES);
    failed.forEach((html, i) => {
      if (!html.includes(`data-state="failed"`) || !html.includes("讀取失敗")) fail(`${CARD_BODIES[i]} says its first answer failed: ${html}`);
    });

    const look = await run(accountLook, base);
    if (look.failed !== "讀取失敗：<x>" || look.failedHtml.includes("<x>")) fail(`the detail is escaped text: ${JSON.stringify(look)}`);
    if (look.pending !== "載入中…" || look.empty !== "empty") fail(`states: ${JSON.stringify(look)}`);
    // 帳務's placeholder before it moved onto the component: slate-400 text at the page's size, 12px 4px.
    if (look.padding !== "12px 4px" || look.color !== "rgb(148, 163, 184)") fail(`the look 帳務 had: ${JSON.stringify(look)}`);
    console.log("model center loading ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("model center loading ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
