const { makeTempDir } = require("./support/temp_dirs.cjs");
const { fixViewport } = require("./support/fixed_viewport.cjs");
// 歷史回放 is one pane workspace (core/tree_workspace.js) whose eight features are fixed, in a real Chromium (run with
// Electron): the upper half 個股走勢 | 歷史事件·交易明細·價量 | 商品列 (pinned, 176 px), the lower row four panes at 280 px; no
// tab closes and none is added; a tab joins another pane, or opens one on any of a pane's four edges; 商品列 keeps its
// width and never loses its row; what the user arranged is saved under the one stored name and comes back, a lower row
// saved as rows of panes included.
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
  const same = (got, want, message) => { if (JSON.stringify(got) !== JSON.stringify(want)) fail(`${message}: ${JSON.stringify(got)} instead of ${JSON.stringify(want)}`); };
  const { TreeWorkspace } = await import(`${base}js/core/tree_workspace.js`);
  const { moveTreeTab, splitTreePane, treePanes, pinnedInPlace } = await import(`${base}js/core/pane_tree.js`);
  const { tabDragSession } = await import(`${base}js/core/tab_drag_session.js`);
  const { HISTORY_STOCKS_PANE, HISTORY_STOCKS_WIDTH, HISTORY_WORKSPACE_SELECTOR, historyInitialTree, saveHistoryTree } = await import(`${base}js/features/history/pane_defaults.js`);

  const ids = ["replayTrend", "eventFeed", "tradeDetails", "priceFlow", "technicalAnalysis", "orderbook", "tickDetails", "tradeFlow"];
  const definitions = new Map(ids.map((id) => [id, { id, title: id, supportedModes: ["replay"], supportedSlots: [], supportedHosts: ["inline"],
    requiredCapabilities: [], requiredCapabilitiesByMode: {}, create: () => ({ mount({ host }) { host.textContent = id; }, destroy() {}, resize() {} }) }]));
  const registry = {
    list: () => [...definitions.values()], get: (id) => definitions.get(String(id)) || null, supports: (id) => definitions.has(String(id)),
    titleFor: (id) => String(id), tabTitleFor: (id) => String(id), chooserRows: () => [],
  };
  let element = null;
  const mount = async () => {
    document.querySelector("main").innerHTML = historyHtml;
    element = document.querySelector(HISTORY_WORKSPACE_SELECTOR);
    element.style.width = "1600px"; element.style.height = "800px";
    const workspace = new TreeWorkspace({
      pageId: "history", element, context: { mode: "replay", supports: () => true }, registry, fixedTabs: true,
      initialTree: historyInitialTree({ width: 1600, height: 800 }), onChange: saveHistoryTree,
      pinned: { [HISTORY_STOCKS_PANE]: { element: document.querySelector(".history-stock-sidebar"), width: HISTORY_STOCKS_WIDTH } },
    }).mount();
    await settle();
    return workspace;
  };
  const panes = () => [...element.querySelectorAll("[data-pane-id]")];
  const tabs = () => panes().map((pane) => [...pane.querySelectorAll("[data-panel-tab-key]")].map((tab) => tab.dataset.panelTabKey).join("+"));
  const stocks = () => element.querySelector(".history-stock-sidebar").getBoundingClientRect();
  const DEFAULT = ["replayTrend", "eventFeed+tradeDetails+priceFlow", "technicalAnalysis", "orderbook", "tickDetails", "tradeFlow"];

  localStorage.clear();
  let workspace = await mount();
  same(tabs(), DEFAULT, "the default arrangement");
  if (element.querySelector(".panel-tab-close") || element.querySelector("[data-panel-tab-add]")) fail("no feature closes and none is added");
  same(Math.round(panes()[2].getBoundingClientRect().height), 280, "the lower row's height");
  same(Math.round(stocks().width), 176, "商品列's width");
  same(Math.round(stocks().right), Math.round(element.getBoundingClientRect().right), "商品列 at the right edge");
  same(Math.round(stocks().bottom), Math.round(panes()[0].getBoundingClientRect().bottom), "商品列 beside the upper half only");
  same(Math.round(panes()[5].getBoundingClientRect().right), Math.round(element.getBoundingClientRect().right), "the lower row runs the full width");

  // A drop on each edge of a pane opens a pane there; 商品列 takes none.
  tabDragSession.begin({ pageId: "history", paneId: "replayEvent", componentId: "priceFlow" });
  const box = panes()[0].getBoundingClientRect();
  const target = (x, y) => workspace._dropTarget({ clientX: x, clientY: y, target: document.elementFromPoint(x, y) });
  same([target(box.left + 5, box.top + 200)?.edge, target(box.right - 5, box.top + 200)?.edge, target(box.left + box.width / 2, box.bottom - 8)?.edge], ["left", "right", "bottom"], "a pane's edges");
  same(target(box.left + box.width / 2, box.top + 220)?.kind, "join", "a pane's middle");
  same(target(stocks().left + 80, stocks().top + 200), null, "商品列 takes no tab");
  tabDragSession.end();

  // 價量 under 個股走勢: a column beside 商品列, which keeps its place; saved and back on the next visit.
  workspace._change(splitTreePane(workspace.layout, "priceFlow", "replayPrimary", "bottom"));
  await settle();
  same(tabs(), ["replayTrend", "priceFlow", "eventFeed+tradeDetails", ...DEFAULT.slice(2)], "split below");
  same([Math.round(stocks().width), Math.round(stocks().right)], [176, Math.round(element.getBoundingClientRect().right)], "商品列 where it was");
  workspace.destroy();
  workspace = await mount();
  same(tabs(), ["replayTrend", "priceFlow", "eventFeed+tradeDetails", ...DEFAULT.slice(2)], "the saved arrangement comes back");

  // The last pane beside 商品列 stays: emptying the upper half is refused.
  let layout = workspace.layout;
  for (const id of ["priceFlow", "replayTrend", "eventFeed"]) layout = moveTreeTab(layout, id, "replayTechnical");
  const before = layout;
  layout = moveTreeTab(layout, "tradeDetails", "replayTechnical");
  if (layout !== before || !pinnedInPlace(layout)) fail("商品列 keeps a pane beside it");
  workspace._change(layout);
  await settle();
  same(Math.round(stocks().width), 176, "商品列 beside the last pane");
  workspace.destroy();

  // A lower row saved as rows of panes: one the user rearranged is kept, the five panes as shipped take the new default.
  const rows = (list) => ({ version: 2, rows: [{ id: "row-0", size: 1, extra: false, panes: list.map((componentIds, i) => ({ id: ["replayTechnical", "replaySecondary", "replayTertiary", "replayPriceFlow", "replayAuxiliary"][i], size: 1 / list.length, componentIds, activeComponentId: componentIds[0] })) }] });
  localStorage.setItem("historyReplayPaneLayout", JSON.stringify(rows([["technicalAnalysis"], ["orderbook"], ["tickDetails"], ["priceFlow"], ["tradeFlow"]])));
  workspace = await mount();
  same(tabs(), DEFAULT, "the shipped five panes become the default");
  workspace.destroy();
  localStorage.setItem("historyReplayPaneLayout", JSON.stringify(rows([["technicalAnalysis", "orderbook"], ["tradeFlow"], ["priceFlow", "tickDetails"]])));
  workspace = await mount();
  same(tabs(), ["replayTrend", "eventFeed+tradeDetails", "technicalAnalysis+orderbook", "tradeFlow", "priceFlow+tickDetails"], "a rearranged row is kept");
  same(treePanes(workspace.layout).length, 5, "every feature once");
  workspace.destroy();

  // A splitter drag moves only its own edge, on whole pixels, and is saved; 商品列 has no splitter.
  localStorage.clear();
  workspace = await mount();
  const rails = [...element.querySelectorAll(".pane-splitter-col")];
  same(rails.length, 4, "one splitter between the upper panes, three in the lower row");
  for (const [index, rail] of rails.entries()) {
    for (const delta of [0, 15, -15]) {
      const at = () => [...element.querySelectorAll(".pane-splitter-col")].map((item) => item.getBoundingClientRect().left);
      const old = at();
      rail.setPointerCapture = () => {};
      rail.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: old[index] }));
      document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: old[index] + delta }));
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: old[index] + delta }));
      await settle();
      at().forEach((left, other) => { if (Math.abs(left - (old[other] + (other === index ? delta : 0))) > 1.01) fail(`splitter ${other} moved with ${index}`); });
    }
  }
  same(Math.round(stocks().width), 176, "商品列 after the drags");
  const fractional = panes().map((pane) => pane.getBoundingClientRect()).filter((r) => [r.left, r.top, r.width, r.height].some((v) => Math.abs(v - Math.round(v)) > 0.01));
  if (fractional.length) fail(`panes on half pixels: ${JSON.stringify(fractional)}`);
  workspace.destroy();
  return { ok: true };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1700, height: 900, webPreferences: { sandbox: false, backgroundThrottling: false } });
  const fixture = path.join(__dirname, "fixtures", "renderer_ui_geometry.html");
  await win.loadURL(pathToFileURL(fixture).href);
  await fixViewport(win, 1700, 900);
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
