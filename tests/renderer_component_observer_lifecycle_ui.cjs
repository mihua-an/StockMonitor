const { makeTempDir } = require("./support/temp_dirs.cjs");
// 成交明細 / 成交紀錄 / 即時資訊 own ResizeObservers (the column title's and the data grid's): in a real Chromium (run
// with Electron) each is mounted and destroyed 30 times on a fake data source, and every observer it started is
// disconnected again by destroy() -- an owner teardown call removed from a component leaves observers accumulating.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-observer-lifecycle-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const fail = (message) => { throw new Error(message); };
  // Every observer the page starts, counted while it observes anything.
  let observing = 0;
  const Native = window.ResizeObserver;
  window.ResizeObserver = class CountedResizeObserver extends Native {
    constructor(callback) { super(callback); this.targets = 0; }
    observe(target, options) { if (this.targets++ === 0) observing += 1; return super.observe(target, options); }
    unobserve(target) { if (this.targets > 0 && --this.targets === 0) observing -= 1; return super.unobserve(target); }
    disconnect() { if (this.targets > 0) observing -= 1; this.targets = 0; return super.disconnect(); }
  };
  const context = (mode) => ({
    mode,
    symbolStore: { getSelectedSymbol: () => "2330", subscribe: () => () => {} },
    currentTimestamp: { get: () => null, subscribe: () => () => {} },
    dataSource: { invalidate: () => {}, subscribe: () => () => {} },
    services: {},
    supports: () => true,
  });
  const cases = [
    ["TickDetailsComponent", "tick_details_component.js", "live"],
    ["TradeDetailsComponent", "trade_details_component.js", "replay"],
    ["EventFeedComponent", "event_feed_component.js", "live"],
  ];
  const results = {};
  for (const [name, file, mode] of cases) {
    const Component = (await import(`${base}js/core/components/${file}`))[name];
    const baseline = observing;
    let started = 0;
    for (let cycle = 0; cycle < 30; cycle += 1) {
      const host = document.createElement("section");
      host.style.cssText = "width:900px;height:300px;display:flex;flex-direction:column";
      document.querySelector("main").appendChild(host);
      const component = new Component();
      component.mount({ host, context: context(mode) });
      started = Math.max(started, observing - baseline);
      component.destroy();
      host.remove();
      if (observing !== baseline) fail(`${name}: ${observing - baseline} observer(s) still observing after destroy (cycle ${cycle})`);
    }
    if (started === 0) fail(`${name} started no ResizeObserver: the contract would be measuring nothing`);
    results[name] = started;
  }
  return results;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: false, backgroundThrottling: false } });
  const fixture = path.join(__dirname, "fixtures", "renderer_ui_geometry.html");
  await win.loadURL(pathToFileURL(fixture).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    const started = await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)})`);
    console.log("component observer lifecycle ui contract passed: 30 mount/destroy cycles each, observers per mount", JSON.stringify(started));
    app.exit(0);
  } catch (error) {
    console.error("component observer lifecycle ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
