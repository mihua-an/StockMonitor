const { makeTempDir } = require("./support/temp_dirs.cjs");
// 即時資訊's new-row wash in a real Chromium (run with Electron): the event feed mounted on a fake data source. Checked:
// the first fill washes nothing, a new event joining the list washes only its own row with 成交明細's wash, the
// class comes off when the wash ends, a revision of an event already shown (same event_id, new text) or the same
// events sent again patch their rows without a wash, another tab (a new list) washes nothing, and 歷史事件 never washes.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
require("./support/keep_motion.cjs").keepMotion(app);
app.setPath("userData", makeTempDir("stockmonitor-event-feed-wash-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fail = (message) => { throw new Error(message); };
  const { EventFeedComponent } = await import(`${base}js/core/components/event_feed_component.js`);

  const event = (id, code, time) => ({ id, event_id: id, code, name: code, source: "shioaji", event_type: "large_order",
    time, timestamp: `2026-10-20T${time}+08:00`, message: `事件 ${id}` });
  const mountFeed = (mode) => {
    let push = null;
    const context = {
      mode,
      symbolStore: { getSelectedSymbol: () => "2330", subscribe: () => () => {} },
      currentTimestamp: { get: () => null, subscribe: () => () => {} },
      dataSource: { invalidate: () => {}, subscribe: (_name, fn) => { push = fn; return () => {}; } },
      services: {},
    };
    const host = document.createElement("section");
    host.style.cssText = "width:900px;height:300px;display:flex;flex-direction:column";
    document.querySelector("main").appendChild(host);
    const feed = new EventFeedComponent();
    feed.mount({ host, context });
    return { host, feed, push: (vm) => push(vm) };
  };
  // A tab is picked the way a user picks it: a click on its button, which must then be the selected tab.
  const selectTab = (host, key) => {
    const tab = host.querySelector(`[data-role="event-filter-tabs"] [data-panel-tab-key="${key}"]`);
    if (!tab) fail(`tab ${key} is drawn: ${[...host.querySelectorAll("[data-panel-tab-key]")].map((node) => node.dataset.panelTabKey)}`);
    tab.click();
    const selected = host.querySelector('[data-role="event-filter-tabs"] [data-panel-tab-key][aria-selected="true"]');
    if (selected?.dataset.panelTabKey !== key) fail(`a click on tab ${key} selects it (selected: ${selected?.dataset.panelTabKey})`);
  };
  const washed = (host) => [...host.querySelectorAll("tr.row-wash")].map((row) => row.dataset.eventCode);

  const watchPages = [{ id: "p1", name: "自選一", codes: ["2603"] }];
  const live = mountFeed("live");
  let rows = [event("e2", "2317", "09:01:00"), event("e1", "2330", "09:00:00")];
  live.push({ rows, watchPages });
  if (live.host.querySelectorAll("tr[data-event-key]").length !== 2) fail("two events listed");
  if (washed(live.host).length) fail(`the first fill washes nothing: ${washed(live.host)}`);

  rows = [event("e3", "2603", "09:02:00"), ...rows];
  live.push({ rows, watchPages });
  if (washed(live.host).join(",") !== "2603") fail(`only the new event's row washes: ${washed(live.host)}`);
  const cell = live.host.querySelector("tr.row-wash > td");
  if (getComputedStyle(cell).backgroundColor === "rgba(0, 0, 0, 0)") fail("the new row's cells show the wash colour");
  if (getComputedStyle(cell).animationName !== "none") fail(`the wash is stepped by row_wash.js, not a CSS animation: ${getComputedStyle(cell).animationName}`);
  // Another update while the wash runs keeps it on.
  live.push({ rows: [...rows], watchPages });
  if (washed(live.host).join(",") !== "2603") fail("an update during the wash keeps it");
  await wait(550);
  const midway = Number(live.host.querySelector("tr.row-wash")?.style.getPropertyValue("--row-wash"));
  if (!(midway > 0 && midway < 1)) fail(`the wash fades out step by step (midway --row-wash ${midway})`);
  await wait(550);
  if (washed(live.host).length) fail("the class comes off when the wash ends");
  live.push({ rows: [...rows], watchPages });
  if (washed(live.host).length) fail("an ended wash does not come back on the next update");
  // A revision keeps its event_id and changes its text (量比 while its minute is current); a resend is new objects.
  rows = rows.map((item) => (item.event_id === "e1" ? { ...item, message: "事件 e1（修訂）", info: "修訂" } : { ...item }));
  live.push({ rows, watchPages });
  if (washed(live.host).length) fail(`a revision or a resend is not a new row: ${washed(live.host)}`);
  if (live.host.querySelectorAll("tr[data-event-key]").length !== 3) fail("the revision patched its row in place");

  // Another tab is a new list: its rows are not new.
  selectTab(live.host, "p1");
  if (live.host.querySelectorAll("tr[data-event-key]").length !== 1) fail("tab p1 lists its code's event only");
  if (washed(live.host).length) fail(`switching tab washes nothing: ${washed(live.host)}`);

  const replay = mountFeed("replay");
  replay.push({ rows: rows.slice(1), selectedSymbol: "2330", dates: ["2026-10-20"], activeDate: "2026-10-20" });
  selectTab(replay.host, "ALL");
  replay.push({ rows, selectedSymbol: "2330", dates: ["2026-10-20"], activeDate: "2026-10-20" });
  if (washed(replay.host).length) fail("歷史事件 never washes");

  // The date menu is portalled to <body> while open: a VM update still refreshes its dates and the label, and a VM
  // without dates closes it and puts it back in the picker.
  replay.host.querySelector('[data-role="event-date-button"]').click();
  const menu = document.body.querySelector(":scope > .event-feed-date-menu-portal");
  if (!menu || menu.hidden) fail("the date menu opens in the body");
  replay.push({ rows, selectedSymbol: "2330", dates: ["2026-10-21", "2026-10-20"], activeDate: "2026-10-21" });
  const dates = [...menu.querySelectorAll("button[data-event-date]")].map((node) => node.dataset.eventDate).join(",");
  if (dates !== "2026-10-21,2026-10-20") fail(`the open menu shows the new dates: ${dates}`);
  // The options are morphed by date, not rebuilt: an option keeps its element, only active / aria-selected move.
  const option = (date) => menu.querySelector(`button[data-event-date="${date}"]`);
  const kept = option("2026-10-20");
  replay.push({ rows, selectedSymbol: "2330", dates: ["2026-10-21", "2026-10-20"], activeDate: "2026-10-20" });
  if (option("2026-10-20") !== kept) fail("an update keeps the date option's element");
  if (kept.getAttribute("aria-selected") !== "true" || !kept.classList.contains("active")) fail("the active date's option is selected");
  if (option("2026-10-21").getAttribute("aria-selected") !== "false") fail("the other date's option is not selected");
  replay.push({ rows, selectedSymbol: "2330", dates: ["2026-10-21", "2026-10-20"], activeDate: "2026-10-21" });
  if (replay.host.querySelector('[data-role="event-date-label"]').textContent !== "2026-10-21") fail("the label follows the active date");
  replay.push({ rows, selectedSymbol: "2330" });
  if (!menu.hidden || menu.parentElement !== replay.host.querySelector('[data-role="event-date-picker"]')) fail("without dates the menu closes and goes home");

  // Two events with the same code, second and text are two rows; a repeated event_id is drawn once.
  const twin = mountFeed("replay");
  twin.push({ rows: [event("t1", "2330", "09:05:00"), event("t2", "2330", "09:05:00"), event("t1", "2330", "09:05:00")], selectedSymbol: "2330" });
  selectTab(twin.host, "ALL");
  const keys = [...twin.host.querySelectorAll("tr[data-event-key]")].map((row) => row.dataset.eventKey).join(",");
  if (keys !== "id:t1,id:t2") fail(`rows are keyed by event_id only: ${keys}`);
  return { ok: true };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: false, backgroundThrottling: false } });
  const fixture = path.join(__dirname, "fixtures", "renderer_ui_geometry.html");
  await win.loadURL(pathToFileURL(fixture).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)})`);
    console.log("event feed row wash ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("event feed row wash ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
