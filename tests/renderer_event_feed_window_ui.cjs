const { makeTempDir } = require("./support/temp_dirs.cjs");
// The event feed draws only the rows around its viewport, in a real Chromium (run with Electron): 650 events in 歷史事件
// draw a window of rows, not 650; the scroll extent and the row scrollbar still cover all 650; a scroll to the middle
// draws the rows there at their own offsets with their own stripes; a new list draws its window again.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-event-feed-window-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const frames = (n) => new Promise((resolve) => { const step = (left) => (left ? requestAnimationFrame(() => step(left - 1)) : resolve()); step(n); });
  const fail = (message) => { throw new Error(message); };
  const { EventFeedComponent } = await import(`${base}js/core/components/event_feed_component.js`);
  const { sharedRowController } = await import(`${base}js/core/row_snap.js`);

  const clock = (i) => { const s = 9 * 3600 + i * 20; return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((v) => String(v).padStart(2, "0")).join(":"); };
  const events = (count, prefix = "e") => Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, event_id: `${prefix}${i}`,
    code: "2330", name: "台積電", source: "shioaji", event_type: "large_order", time: clock(i), message: `事件 ${i}` }));
  let push = null;
  const context = {
    mode: "replay",
    symbolStore: { getSelectedSymbol: () => "2330", subscribe: () => () => {} },
    currentTimestamp: { get: () => null, subscribe: () => () => {} },
    dataSource: { invalidate: () => {}, subscribe: (_name, fn) => { push = fn; return () => {}; } },
    services: {},
  };
  const host = document.createElement("section");
  host.style.cssText = "width:900px;height:420px;display:flex;flex-direction:column";
  document.querySelector("main").appendChild(host);

  // 即時資訊 on a page has the button that opens its detached window; 歷史事件 and the detached window itself have none.
  let opened = null;
  window.desktopAPI = { detachedWindows: { eventFeed: {} }, openDetachedView: async (descriptor) => { opened = descriptor; } };
  const popoutOf = (mode, hostType) => {
    const box = document.createElement("section");
    document.querySelector("main").appendChild(box);
    new EventFeedComponent().mount({ host: box, hostType, context: { ...context, mode, id: "live:realtime" } });
    return box.querySelector('[data-role="event-popout"]');
  };
  if (popoutOf("replay", "inline") || popoutOf("live", "detached")) fail("only 即時資訊 on a page opens a window");
  const popout = popoutOf("live", "inline");
  if (!popout) fail("no pop-out button on 即時資訊");
  popout.click();
  if (opened?.componentId !== "eventFeed" || opened.symbolMode !== "follow" || opened.contextMode !== "live") fail(`pop-out: ${JSON.stringify(opened)}`);

  const feed = new EventFeedComponent();
  feed.mount({ host, context });
  await frames(3);

  push({ rows: events(650), selectedSymbol: "2330" });
  await frames(4);
  const viewport = host.querySelector(".standard-data-grid-body-scroll");
  const snap = sharedRowController(viewport);
  if (!viewport || !snap) fail("the feed's body viewport has its row controller");
  const drawn = () => [...host.querySelectorAll("tr[data-event-key]")];
  const pitch = snap.rowHeight;
  const visible = snap.visibleRows;
  if (!(pitch > 0) || !(visible > 1)) fail(`the viewport is measured: pitch ${pitch}, ${visible} rows`);
  if (drawn().length > visible + 14) fail(`650 events draw a window, not every row: ${drawn().length} drawn, ${visible} visible`);
  if (drawn()[0]?.dataset.eventKey !== "id:e0") fail(`at the top the first drawn row is the first event: ${drawn()[0]?.dataset.eventKey}`);
  const metrics = snap.metrics();
  if (metrics.logicalRows !== 650 || metrics.maxIndex !== 650 - visible) fail(`the controller counts every event: ${JSON.stringify(metrics)}`);
  const extent = viewport.scrollHeight - viewport.clientHeight;
  if (Math.abs(extent - (650 - visible) * pitch) > 1.5) fail(`the scroll extent reaches the last event: ${extent} vs ${(650 - visible) * pitch}`);

  // A scroll to row 301 draws that row as the viewport's top row, where the full list would have it.
  snap.scrollToIndex(301);
  await frames(3);
  const topRow = drawn().find((row) => row.dataset.eventKey === "id:e301");
  if (!topRow) fail(`after scrolling to 301 its row is drawn: ${drawn()[0]?.dataset.eventKey}..${drawn().at(-1)?.dataset.eventKey}`);
  const offset = topRow.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
  if (Math.abs(offset) > 1) fail(`row 301 sits at the viewport top: ${offset}px`);
  if (!drawn().some((row) => row.dataset.eventKey === `id:e${301 + visible - 1}`)) fail("the viewport's last row is drawn");
  if (drawn().length > visible + 14) fail(`a scrolled window stays a window: ${drawn().length}`);
  // The rows are parted by a line, not striped: every drawn row has the same background.
  const plain = getComputedStyle(drawn()[0]).backgroundColor;
  const background = (index) => getComputedStyle(drawn().find((row) => row.dataset.eventKey === `id:e${index}`)).backgroundColor;
  if (background(302) !== plain || background(303) !== plain) fail(`rows are not striped: ${plain} / ${background(302)} / ${background(303)}`);

  // A shorter new list: the extent shrinks and the view is clamped to its last rows.
  push({ rows: events(40, "n"), selectedSymbol: "2330" });
  await frames(4);
  const shortMetrics = snap.metrics();
  if (shortMetrics.logicalRows !== 40) fail(`the new list counts 40 rows: ${shortMetrics.logicalRows}`);
  if (!drawn().some((row) => row.dataset.eventKey === "id:n39")) fail("the new list's last row is drawn after the clamp");
  if (drawn().some((row) => row.dataset.eventKey.startsWith("id:e"))) fail("no row of the old list stays drawn");

  push({ rows: [], selectedSymbol: "2330" });
  await frames(2);
  if (drawn().length || snap.metrics().logicalRows !== 0) fail("an empty list draws no event row and has no extent");
  feed.destroy();
  return { ok: true };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: false, backgroundThrottling: false } });
  const fixture = path.join(__dirname, "fixtures", "renderer_ui_geometry.html");
  await win.loadURL(pathToFileURL(fixture).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)})`);
    console.log("event feed window ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("event feed window ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
