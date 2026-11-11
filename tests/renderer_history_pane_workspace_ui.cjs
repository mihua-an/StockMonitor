const { makeTempDir } = require("./support/temp_dirs.cjs");
// 歷史回放's lower row is a pane workspace of one row whose five features are fixed, in a real Chromium (run with
// Electron): five panes in one row, every tab without a close button and no tab bar with an add button; a feature
// moved onto another pane leaves four panes, one moved to a pane's edge stands on its own again; a drop at the
// workspace's top or bottom edge opens no new row.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-history-panes-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base, historyHtml) {
  const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const fail = (message) => { throw new Error(message); };
  const { PaneWorkspace } = await import(`${base}js/core/pane_workspace.js`);
  const { moveTab, splitPane } = await import(`${base}js/core/pane_layout.js`);
  const { tabDragSession } = await import(`${base}js/core/tab_drag_session.js`);
  const { HISTORY_PANE_ROWS, HISTORY_PANE_SELECTOR, historyPaneDefaultLayout } = await import(`${base}js/features/history/pane_defaults.js`);

  document.querySelector("main").innerHTML = historyHtml;
  const element = document.querySelector(HISTORY_PANE_SELECTOR);
  element.style.width = "1600px"; element.style.height = "320px";
  // The five features as plain components: what the workspace does with them is the subject, not their content.
  const ids = ["technicalAnalysis", "orderbook", "tickDetails", "priceFlow", "tradeFlow"];
  const definitions = new Map(ids.map((id) => [id, { id, title: id, supportedModes: ["replay"], supportedSlots: [], supportedHosts: ["inline"],
    requiredCapabilities: [], requiredCapabilitiesByMode: {}, create: () => ({ mount({ host }) { host.textContent = id; }, destroy() {}, resize() {} }) }]));
  const registry = {
    list: () => [...definitions.values()], get: (id) => definitions.get(String(id)) || null, supports: (id) => definitions.has(String(id)),
    titleFor: (id) => String(id), tabTitleFor: (id) => String(id), chooserRows: () => [],
  };
  const workspace = new PaneWorkspace({
    pageId: "history", element, context: { mode: "replay", supports: () => true }, registry, storageKey: "historyPanesUiTest",
    defaultLayout: historyPaneDefaultLayout, rows: HISTORY_PANE_ROWS, fixedTabs: true,
  }).mount();
  await settle();

  const panes = () => [...element.querySelectorAll("[data-pane-id]")];
  const tabsOf = (pane) => [...pane.querySelectorAll("[data-panel-tab-key]")].map((tab) => tab.dataset.panelTabKey);
  if (element.querySelectorAll(".pane-row").length !== 1) fail("one row");
  if (JSON.stringify(panes().map(tabsOf)) !== JSON.stringify(ids.map((id) => [id]))) fail(`five panes, one feature each: ${JSON.stringify(panes().map(tabsOf))}`);
  if (element.querySelector(".panel-tab-close")) fail("no tab can be closed");
  if (element.querySelector("[data-panel-tab-add]")) fail("no feature can be added");

  // 買賣報價 joins 技術分析's pane: four panes, the first holding both.
  workspace.apply(moveTab(workspace.layout, "orderbook", "replayTechnical", null, workspace._options()));
  await settle();
  if (panes().length !== 4 || JSON.stringify(tabsOf(panes()[0])) !== JSON.stringify(["technicalAnalysis", "orderbook"])) {
    fail(`a moved feature shares the pane it joined: ${JSON.stringify(panes().map(tabsOf))}`);
  }
  if (element.querySelector(".panel-tab-close")) fail("a shared pane's tabs cannot be closed either");

  // A drop at the workspace's top or bottom edge opens no row (one row only); a pane's edge still splits.
  tabDragSession.begin({ pageId: "history", paneId: "replayTechnical", componentId: "orderbook" });
  const box = element.getBoundingClientRect();
  const target = (x, y) => workspace._dropTarget({ clientX: x, clientY: y, target: document.elementFromPoint(x, y) });
  if (target(box.left + 300, box.top + 3)) fail("no new row at the top edge");
  if (target(box.left + 300, box.bottom - 3)) fail("no new row at the bottom edge");
  tabDragSession.end();

  // Back on its own beside 技術分析: five panes again.
  workspace.apply(splitPane(workspace.layout, "orderbook", "replayTechnical", "right", workspace._options()));
  await settle();
  if (panes().length !== 5 || panes().map(tabsOf).some((tabs) => tabs.length !== 1)) fail(`five panes again: ${JSON.stringify(panes().map(tabsOf))}`);
  if (element.querySelectorAll(".pane-row").length !== 1) fail("still one row");
  workspace.destroy();
  return { ok: true };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1700, height: 900, webPreferences: { sandbox: false, backgroundThrottling: false } });
  const fixture = path.join(__dirname, "fixtures", "renderer_ui_geometry.html");
  await win.loadURL(pathToFileURL(fixture).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  const historyHtml = fs.readFileSync(path.join(__dirname, "..", "ui", "renderer", "pages", "history.html"), "utf8");
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)}, ${JSON.stringify(historyHtml)})`);
    console.log("history pane workspace ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("history pane workspace ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
