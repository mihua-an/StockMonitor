const { makeTempDir } = require("./support/temp_dirs.cjs");
// 歷史回放's date-list read belongs to the visit that sent it, in a real Chromium (run with Electron): the page's own
// code on the real history.html with a fake API that holds /api/history/dates until released. The navigation that
// mounts the page no longer waits for this read (page_mount.js), so the page can be left -- or mounted again -- while
// it is out. Checked:
//   * an answer for a visit that was left draws nothing and opens no day (no read for its date goes out);
//   * an answer for an earlier visit, arriving after the current visit's own, does not replace the current dates;
//   * a replay opened from elsewhere (openHistoryReplay, 帳務's 回放) waits for the visit's date list and the day it
//     opens, then opens its own day and stock -- the late default day never replaces it.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-history-visit-owner-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base, historyHtml) {
  const fail = (message) => { throw new Error(message); };
  window.desktopAPI = { networkManifest: { routes: [["/api/", "app_api"]], services: { app_api: { url: "http://app.invalid" } } } };
  const requests = [];
  const heldDates = [];
  window.fetch = async (input) => {
    const url = new URL(String(input?.url || input));
    requests.push(`${url.pathname}${url.search}`);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/api/history/dates") {
      const dates = await new Promise((resolve) => heldDates.push(resolve));
      return json({ ok: true, dates });
    }
    if (url.pathname === "/api/sources") return json({ source_settings: { enabled_sources: [], sources: {} } });
    return json({ ok: false, error: `not served in this test: ${url.pathname}` }, 404);
  };
  const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
  const container = document.getElementById("pageContainer");
  const page = await import(`${base}js/pages/history.js`);
  const { historyState } = await import(`${base}js/features/history/history_state.js`);
  const mount = () => {
    container.innerHTML = historyHtml;
    page.bindHistoryEvents();
    return page.refreshHistoryPage();
  };
  const sentFor = (date) => requests.filter((url) => url.includes(date) && !url.startsWith("/api/history/dates"));
  const swallow = (promise) => promise.catch((error) => String(error?.message || error));

  // --- left before the dates answered: the late answer draws nothing ---------------------------------------------
  const left = swallow(mount());
  await tick();
  if (heldDates.length !== 1) fail(`the visit asks for the dates once: ${requests.join(" ")}`);
  page.disposeHistoryPage();
  container.innerHTML = "";
  heldDates.shift()(["2026-10-01"]);
  await left;
  await tick();
  if (historyState.dates.length) fail(`a left visit's dates were applied: ${historyState.dates}`);
  if (sentFor("2026-10-01").length) fail(`a left visit opened its day: ${sentFor("2026-10-01")}`);

  // --- mounted again while the earlier visit's read is out: the earlier answer is dropped -------------------------
  const earlier = swallow(mount());
  await tick();
  page.disposeHistoryPage();
  const current = swallow(mount());
  await tick();
  if (heldDates.length !== 2) fail(`both visits asked: ${heldDates.length}`);
  const [answerEarlier, answerCurrent] = heldDates.splice(0);
  answerCurrent(["2026-11-04", "2026-11-03"]);
  await current;
  await tick();
  if (historyState.dates.join() !== "2026-11-04,2026-11-03") fail(`the current visit's dates: ${historyState.dates}`);
  answerEarlier(["2026-09-30"]);
  await earlier;
  await tick();
  if (historyState.dates.join() !== "2026-11-04,2026-11-03") fail(`an earlier visit's answer replaced the dates: ${historyState.dates}`);
  if (sentFor("2026-09-30").length) fail(`an earlier visit opened its day: ${sentFor("2026-09-30")}`);
  page.disposeHistoryPage();

  // --- a replay opened from elsewhere waits for the visit's date list, then opens its own day ---------------------
  historyState.dates = [];
  historyState.selectedDate = "";
  const visit = swallow(mount());
  const replay = swallow(page.openHistoryReplay({ date: "2026-10-20", code: "4958", name: "臻鼎-KY", time: "10:00:00" }));
  await tick();
  if (sentFor("2026-10-20").length) fail(`the replay opened its day before the visit's dates answered: ${sentFor("2026-10-20")}`);
  heldDates.shift()(["2026-11-04", "2026-10-20"]);
  await visit;
  await replay;
  await tick();
  if (!sentFor("2026-10-20").length) fail(`the replay's day was read: ${requests.join(" ")}`);
  if (historyState.selectedDate !== "2026-10-20" || historyState.selectedCode !== "4958") {
    fail(`the replay's day and stock are shown: ${historyState.selectedDate} ${historyState.selectedCode}`);
  }
  page.disposeHistoryPage();
  return { ok: true };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1500, height: 1000, webPreferences: { sandbox: false, backgroundThrottling: false, offscreen: true } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const renderer = path.join(__dirname, "..", "ui", "renderer");
  const base = pathToFileURL(renderer + path.sep).href;
  const historyHtml = fs.readFileSync(path.join(renderer, "pages", "history.html"), "utf8");
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)}, ${JSON.stringify(historyHtml)}).then((r) => r.ok)`);
    console.log("history visit owner ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("history visit owner ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
