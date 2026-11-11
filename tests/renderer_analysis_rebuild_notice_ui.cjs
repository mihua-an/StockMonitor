const { makeTempDir } = require("./support/temp_dirs.cjs");
// 分析資料重建中 (B's rebuild from the durable stream): in a real Chromium with the App's stylesheets, ComponentHost lays the
// shared notice over a pane whose data is Rust B's (價量 here, the real component) while Market Runtime says B is
// CATCHING_UP, with the percent and a bar of that width; each new state only changes the notice's content (the same
// elements stay); LIVE hides it; a component that is not B's (買賣報價's registration without the flag) gets none; and
// switching the pane away or destroying it removes the notice and its subscription.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-analysis-rebuild-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const fail = (message) => { throw new Error(message); };
  const { ComponentHost } = await import(`${base}js/core/component_host.js`);
  const { ComponentRegistry } = await import(`${base}js/core/component_registry.js`);
  const { PriceFlowComponent } = await import(`${base}js/core/components/price_flow_component.js`);
  const listeners = new Set();
  let current = null;
  const push = (state) => { current = state; for (const listener of [...listeners]) listener(state); };
  const subscribe = (listener) => { listeners.add(listener); if (current) listener(current); return () => listeners.delete(listener); };
  const context = {
    id: "live:test", mode: "live",
    symbolStore: { getSelectedSymbol: () => "2330", subscribe: () => () => {} },
    currentTimestamp: { get: () => null, subscribe: () => () => {} },
    dataSource: { invalidate: () => {}, subscribe: () => () => {}, resolve: () => null },
    services: { analysisState: { subscribe } },
    supports: () => true,
  };
  const registry = new ComponentRegistry();
  registry.register({ id: "priceFlow", analysisSourced: true, create: () => new PriceFlowComponent() });
  registry.register({ id: "plain", create: () => ({ mount({ host }) { host.innerHTML = '<div class="plain-pane">x</div>'; }, destroy() {} }) });

  const host = document.createElement("section");
  host.style.cssText = "width:600px;height:300px;display:flex;flex-direction:column";
  document.querySelector("main").appendChild(host);
  push({ state: "CATCHING_UP", progress: 0.4, cursor: 400, head: 1000, catch_up_from: 0 });
  const componentHost = new ComponentHost({ host, hostId: "t", context, registry, hydrate: false });
  componentHost.mount("priceFlow");
  const overlay = host.querySelector(":scope > .analysis-rebuild");
  if (!overlay) fail("no notice over 價量 while B catches up");
  if (host.lastElementChild !== overlay) fail("the notice must be the host's last child, over the component");
  if (overlay.hidden) fail("the notice is hidden while B catches up");
  const text = overlay.textContent.replace(/\s+/g, "");
  if (!text.includes("分析資料重建中") || !text.includes("40%")) fail(`notice text: ${text}`);
  if (host.querySelector("[title]")) fail("no title tooltips in the App");
  const hostBox = host.getBoundingClientRect(), box = overlay.getBoundingClientRect();
  if (Math.abs(box.width - hostBox.width) > 1 || Math.abs(box.height - hostBox.height) > 1 || Math.abs(box.top - hostBox.top) > 1) {
    fail(`the notice must cover the pane: ${JSON.stringify(box)} vs ${JSON.stringify(hostBox)}`);
  }
  if (getComputedStyle(overlay).position !== "absolute") fail("the notice is laid over, not in the flow");
  const fill = overlay.querySelector(".analysis-rebuild-fill");
  const bar = overlay.querySelector(".analysis-rebuild-bar");
  const ratio = (el) => el.getBoundingClientRect().width / bar.getBoundingClientRect().width;
  if (Math.abs(ratio(fill) - 0.4) > 0.02) fail(`bar fill ${ratio(fill)}`);

  push({ state: "CATCHING_UP", progress: 0.75, cursor: 750, head: 1000, catch_up_from: 0 });
  if (host.querySelector(".analysis-rebuild-fill") !== fill) fail("a new progress must update the same bar, not rebuild it");
  if (!overlay.textContent.includes("75%") || Math.abs(ratio(fill) - 0.75) > 0.02) fail(`progress not updated: ${overlay.textContent}`);

  push({ state: "CATCHING_UP", progress: null, cursor: 750, head: 1000, catch_up_from: null });
  if (overlay.hidden || overlay.querySelector(".analysis-rebuild-bar") || /%/.test(overlay.textContent)) {
    fail("without a measured span only the words are shown");
  }

  push({ state: "LIVE", progress: null, cursor: 1000, head: 1000, catch_up_from: null });
  if (!overlay.hidden || overlay.getBoundingClientRect().height !== 0) fail("LIVE must hide the notice");
  push({ state: "CATCHING_UP", progress: 0.1, cursor: 100, head: 1000, catch_up_from: 0 });
  if (overlay.hidden || host.querySelector(":scope > .analysis-rebuild") !== overlay) fail("a new catch-up shows the same notice again");

  componentHost.switchComponent("plain");
  if (host.querySelector(".analysis-rebuild")) fail("a component that is not B's gets no notice");
  if (listeners.size !== 0) fail("switching away must end the notice's subscription");
  componentHost.switchComponent("priceFlow");
  if (!host.querySelector(":scope > .analysis-rebuild")) fail("switching back lays the notice over 價量 again");
  componentHost.destroy();
  if (host.querySelector(".analysis-rebuild") || listeners.size !== 0 || host.dataset.analysisSourced) fail("destroy leaves the notice behind");

  // A context without the service (歷史回放, 配對回放) shows none.
  const replayHost = document.createElement("section");
  document.querySelector("main").appendChild(replayHost);
  const replay = new ComponentHost({ host: replayHost, hostId: "r", context: { ...context, mode: "replay", services: {} }, registry, hydrate: false });
  replay.mount("priceFlow");
  if (replayHost.querySelector(".analysis-rebuild")) fail("a replay context has no notice");
  replay.destroy();
  return "ok";
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: false, backgroundThrottling: false } });
  const fixture = path.join(__dirname, "fixtures", "renderer_ui_geometry.html");
  await win.loadURL(pathToFileURL(fixture).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)})`);
    console.log("analysis rebuild notice ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("analysis rebuild notice ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
