const { makeTempDir } = require("./support/temp_dirs.cjs");
// 即時資訊's model columns in a real Chromium (run with Electron), the event feed mounted on a fake data source (user
// 11-07): each title shows its minutes and then a trend icon -- "3" then up, "3" then down, "5" up, "5" down -- with no
// 分; the full title (3分上漲 ...) stays as the accessible name; the up icon is the user's up colour
// and the down icon the down colour, and both follow a change of that setting (--price-up-color / --price-down-color)
// without a redraw.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-event-feed-title-icons-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const fail = (message) => { throw new Error(message); };
  const { EventFeedComponent } = await import(`${base}js/core/components/event_feed_component.js`);
  const context = {
    mode: "live",
    symbolStore: { getSelectedSymbol: () => "2330", subscribe: () => () => {} },
    currentTimestamp: { get: () => null, subscribe: () => () => {} },
    dataSource: { invalidate: () => {}, subscribe: () => () => {} },
    services: {},
  };
  const host = document.createElement("section");
  host.style.cssText = "width:900px;height:300px;display:flex;flex-direction:column";
  document.querySelector("main").appendChild(host);
  new EventFeedComponent().mount({ host, context });

  const root = document.documentElement.style;
  root.setProperty("--price-up-color", "rgb(225, 25, 25)");
  root.setProperty("--price-down-color", "rgb(0, 153, 61)");
  const ids = ["model_3m_up", "model_3m_down", "model_5m_up", "model_5m_down"];
  const cells = ids.map((id) => host.querySelector(`thead th[data-column-id="${id}"]`));
  if (cells.some((cell) => !cell)) fail("the four model titles are drawn");
  const expected = [["3", "up", "3分上漲"], ["3", "down", "3分下跌"], ["5", "up", "5分上漲"], ["5", "down", "5分下跌"]];
  cells.forEach((cell, index) => {
    const [text, icon, full] = expected[index];
    const label = cell.querySelector(".canonical-title-label");
    if (label.textContent.trim() !== text) fail(`${full} shows "${label.textContent.trim()}", not "${text}"`);
    const mark = label.querySelector(".direction-glyph");
    if (mark?.dataset.direction !== icon || !mark.querySelector("svg")) fail(`${full} has the ${icon} icon`);
    if (label.firstChild.nodeType !== Node.TEXT_NODE || label.lastElementChild !== mark) fail(`${full}: the minutes come before the icon`);
    if (mark.getBoundingClientRect().width < 10) fail(`${full}'s icon is drawn (width ${mark.getBoundingClientRect().width})`);
    if (cell.hasAttribute("title") || cell.getAttribute("aria-label") !== full) fail(`${full} is the accessible name, with no hover text: "${cell.title}"`);
  });
  const colour = (index) => getComputedStyle(cells[index].querySelector(".direction-glyph")).color;
  if (colour(0) !== "rgb(225, 25, 25)" || colour(1) !== "rgb(0, 153, 61)") fail(`icons take the up/down colours: ${colour(0)} ${colour(1)}`);
  root.setProperty("--price-up-color", "rgb(0, 153, 61)");
  root.setProperty("--price-down-color", "rgb(225, 25, 25)");
  if (colour(2) !== "rgb(0, 153, 61)" || colour(3) !== "rgb(225, 25, 25)") fail(`icons follow 綠漲紅跌: ${colour(2)} ${colour(3)}`);
  const plain = host.querySelector('thead th[data-column-id="time"]');
  if (plain.hasAttribute("title") || plain.querySelector(".direction-glyph") || plain.textContent.trim() !== "時間") {
    fail("a title without shortTitle/icon is drawn as before");
  }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: false, offscreen: true } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)})`);
    console.log("event feed model title icons ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("event feed model title icons ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
