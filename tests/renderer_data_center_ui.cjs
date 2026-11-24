const { makeTempDir } = require("./support/temp_dirs.cjs");
const { fixViewport } = require("./support/fixed_viewport.cjs");
// 資料中心 in a real Chromium (run with Electron), on the real data_center.html, its page code and a fake app_api:
//   * the nav: 總覽, 回放, 模型 over every day, each marked 今天 / 完整 / 不完整; the day list scrolls, the upper half stays;
//   * 資料｜事件｜回放 is one element: its place and size are the same whichever is shown, and on every day;
//   * a day opens on 資料 or 事件 from 總覽 / 模型, on the tab shown from another day, on 回放 from 回放;
//   * 回放 is mounted while it is shown and let go when left; the title row is not over it; a date it picks is the page's;
//   * a day's events each jump to their moment; a day nothing is known of shows "--", never 0.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-data-center-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base, html) {
  const fail = (message) => { throw new Error(message); };
  const same = (got, want, message) => { if (JSON.stringify(got) !== JSON.stringify(want)) fail(`${message}: ${JSON.stringify(got)} instead of ${JSON.stringify(want)}`); };
  const wait = async (until, what) => { for (let i = 0; i < 150; i += 1) { if (until()) return; await new Promise((r) => setTimeout(r, 20)); } fail(`never: ${what}`); };
  const day = (back) => new Date(Date.now() + 8 * 3600e3 - back * 86400e3).toISOString().slice(0, 10);
  const days = Array.from({ length: 30 }, (_, i) => day(i + 1));
  window.desktopAPI = { sourceSettings: { enabled_sources: [], sources: {} }, networkManifest: { routes: [["/api/", "app_api"]], services: { app_api: { url: "http://app.invalid" } } },
    liveEngineConnection: { url: "ws://app.invalid", expected: { service_id: "market_runtime", protocol: 2 } } };
  window.WebSocket = class extends EventTarget { static OPEN = 1; static CONNECTING = 0; readyState = 0; send() {} close() {} };
  const asked = [];
  window.fetch = ((original) => async (input) => {
    const text = String(input?.url || input);
    if (text.startsWith("file:")) return original(input);
    const url = new URL(text);
    asked.push(url.pathname + url.search);
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    switch (url.pathname) {
      case "/api/data-center/dates": return json({ ok: true, items: days.map((date, i) => ({ date, complete: i !== 2, storage: { ALL: { products: 9, rows: { tick: 100, bidask: 200 }, bytes: 2048 } } })) });
      case "/api/data-center/date": return json({ ok: true, categories: [] });
      case "/api/data-center/closing": return json({ ok: true, id: null, stage: "waiting_close", sessions: [], history: [] });
      case "/api/monitor/event-counts": return json({ ok: true, dates: { [days[0]]: { events: 2, up: 1, down: 1, codes: 1 } } });
      case "/api/monitor/events": return json({ ok: true, events: Array.from({ length: 1000 }, (_, i) => ({ event_id: `e${i}`, event_origin: "analysis_runtime", trigger_minute: 601, code: "2330", name: "台積電", label: "1分急拉", direction: "up",
        trading_date: url.searchParams.get("date"), model_predictions: { "3m_up": { probability: 0.71 } } })) });
      case "/api/training/days": return json({ ok: true, days: { [days[0]]: { use: null, next: "train", samples: null, models: [] },
        [days[1]]: { use: "train", next: "train", samples: 93412, models: [{ key: "3m_up", samples: 900, positives: 45, called: 10, hits: 6 }] } } });
      case "/api/history/dates": return json({ ok: true, dates: days });
      default: return json({ ok: true, items: [], stocks: [], events: [], dates: [], points: [], slots: [] });
    }
  })(window.fetch);

  const container = document.getElementById("pageContainer");
  container.style.height = "700px"; container.style.width = "1280px";
  container.innerHTML = html;
  const { hydratePageFrames } = await import(`${base}js/core/page_frame.js`);
  hydratePageFrames(container);
  await import(`${base}js/dashboard_components.js`);
  const page = await import(`${base}js/pages/data_center.js`);
  page.initDataCenterPage();
  await page.refreshDataCenter();

  const $ = (selector) => document.querySelector(selector);
  const text = (node) => node.textContent.replace(/\s+/g, " ").trim();
  const active = () => [...document.querySelectorAll(".settings-nav-item.is-active")].map((item) => item.dataset.dcNav || item.dataset.day);
  const box = (selector) => { const r = $(selector).getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round); };
  const tab = () => $("#dataCenterDayTabs .is-active")?.dataset.dayTab;

  same([...document.querySelectorAll("[data-dc-nav]")].map(text), ["總覽", "回放", "模型"], "the nav's upper half");
  const listed = [...document.querySelectorAll("[data-day]")];
  same(listed.length, 31, "every day and today");
  same(listed.slice(0, 4).map((item) => item.querySelector(".settings-badge").textContent), ["今天", "完整", "完整", "不完整"], "each day's mark");
  if ($("#dataCenterDays").scrollHeight <= $("#dataCenterDays").clientHeight) fail("the day list scrolls by itself");
  const upper = box('[data-dc-nav="overview"]');
  $("#dataCenterDays").scrollTop = 400;
  same(box('[data-dc-nav="overview"]'), upper, "總覽 stays while the list scrolls");
  same([...$("[data-open-day]").cells].slice(1).map(text), ["完整", "9", "100", "2.0 KB", "2", "未使用"], "a recent day");
  if (!$("#dataCenterDayTabs").hidden) fail("no day's tabs on 總覽");

  // A day from 總覽 opens on 資料; the tabs' place is one place.
  listed[2].click();
  await wait(() => asked.some((path) => path.startsWith("/api/data-center/date?")), "the day read");
  same([active(), tab()], [[days[1]], "day-data"], "a day opens on 資料");
  const place = box("#dataCenterDayTabs");
  await wait(() => !$("#dataCenterDayModels").hidden, "the models' record of the day");
  same([...$("#dataCenterDayModels tbody tr").cells].map(text), ["3 分上漲", "900", "5.00%", "10", "60.00%"].map((v, i) => (i === 2 ? text($("#dataCenterDayModels tbody tr").cells[2]) : i === 4 ? text($("#dataCenterDayModels tbody tr").cells[4]) : v)), "how the live model did");
  if (!text($("#dataCenterDayUse")).includes("93,412 筆")) fail("the day's samples");
  $('[data-day-tab="day-events"]').click();
  await wait(() => $("[data-replay-code]"), "the day's events");
  same([box("#dataCenterDayTabs"), tab()], [place, "day-events"], "the tabs on 事件");
  // Every event is counted; only the first rows are drawn until the end is scrolled to.
  same(text($("#dataCenterEventTiles .settings-tile-value")), "1,000", "the day's events");
  const drawn = () => document.querySelectorAll("#dataCenterEvents tbody tr").length;
  same(drawn(), 200, "the rows drawn at first");
  const firstRow = $("#dataCenterEvents tbody tr");
  $("#dataCenterScroll").scrollTo({ top: 1e6, behavior: "instant" });
  await wait(() => drawn() >= 400, "more rows at the end");
  if ($("#dataCenterEvents tbody tr") !== firstRow) fail("the rows already drawn stay");
  $("#dataCenterScroll").scrollTo({ top: 0, behavior: "instant" });
  listed[4].click();
  same([active(), tab()], [[days[3]], "day-events"], "another day keeps the tab");
  $('[data-dc-nav="models"]').click();
  same([active(), $("#dataCenterDayTabs").hidden, $("#manualTrainBtn").hidden], [["models"], true, false], "模型");
  listed[5].click();
  same(tab(), "day-events", "from 模型 a day opens on the one last shown");

  // 回放: one press, the day shown; mounted while shown.
  $('[data-dc-nav="replay"]').click();
  await wait(() => $(".history-workspace .pane-tree-split"), "回放 mounted");
  same([active(), tab(), $(".page-frame-head").hidden], [["replay", days[4]], "replay", true], "回放 of the day shown, without the title row");
  same(box("#dataCenterDayTabs"), place, "the tabs over 回放");
  const head = $(".history-stock-head").getBoundingClientRect();
  if (head.left > place[0] || head.right < place[0] + place[2] || head.top > place[1] || head.bottom < place[1] + place[3]) fail("the tabs stand in 商品列's room");
  listed[6].click();
  await wait(() => asked.some((path) => path === `/api/history/stocks?date=${days[5]}&summary=false`), "another day replayed");
  same([active(), tab()], [["replay", days[5]], "replay"], "a day picked in 回放 is replayed");
  const { setHistoryDateValue } = await import(`${base}js/features/history/picked_date.js`);
  setHistoryDateValue(days[7]);
  same(active(), ["replay", days[7]], "a date picked inside 回放 is the page's day");
  $('[data-day-tab="day-data"]').click();
  same([box("#dataCenterDayTabs"), tab(), active(), $("#dataCenterReplay").children.length], [place, "day-data", [days[7]], 0], "回放 let go; 資料 of the same day");

  // An event's 回放 opens 回放; 總覽 afterwards, and a day from it opens on 資料, not 回放.
  $('[data-day-tab="day-events"]').click();
  await wait(() => $("[data-replay-code]"), "its events");
  $("[data-replay-code]").click();
  await wait(() => $(".history-workspace .pane-tree-split"), "回放 from an event");
  $('[data-dc-nav="overview"]').click();
  listed[1].click();
  same(tab(), "day-events", "not into 回放");
  listed[0].click();
  if (!text($("#dataCenterSubtitle")).includes("今天")) fail("today says it is not materialized yet");
  $('[data-day-tab="day-data"]').click();
  same([...document.querySelectorAll("#dataCenterDayTiles .settings-tile-value")].map(text), ["--", "--", "--", "--"], "nothing stored is --, not 0");
  page.disposeDataCenterPage();
  return { ok: true };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1340, height: 800, webPreferences: { sandbox: false, offscreen: true, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => { if (event.level === "error") console.error(`[renderer] ${String(event.message).slice(0, 400)}`); });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  await fixViewport(win, 1340, 800);
  const renderer = path.join(__dirname, "..", "ui", "renderer");
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(pathToFileURL(renderer + path.sep).href)}, ${JSON.stringify(fs.readFileSync(path.join(renderer, "pages", "data_center.html"), "utf8"))}).then((r) => r.ok)`);
    console.log("data center ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("data center ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
