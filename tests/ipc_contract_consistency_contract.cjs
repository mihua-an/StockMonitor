"use strict";
// One channel contract (ui/main/ipc_contract.js), read by every layer: a payload is accepted or refused by the same
// rule wherever it is checked, and what a handler does after a committed or failed write follows from the write.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { channelRule, DETACHED_WINDOWS, viewDescriptorErrors, wireBytes } = require("../ui/main/ipc_contract");
const { DetachedViewManager } = require("../ui/main/detached_view_manager");
const { installAllDomains } = require("./support/ipc_domains.cjs");
const quiet = { warn() {}, error() {}, log() {} };

(async () => {
  // R08-09: detached-view:open -- the authorizer's schema and the window manager's validation are the same rule.
  const opened = [];
  class FakeWindow { constructor(options) { this.options = options; this.webContents = { on() {} }; opened.push(this); }
    loadFile() {} isDestroyed() { return false; } once() {} }
  const manager = new DetachedViewManager({ BrowserWindow: FakeWindow, preloadPath: "p", rendererPath: "r" });
  const schema = channelRule("detached-view:open").schema;
  const base = { version: 1, componentId: "eventFeed", contextMode: "live", contextId: "main", symbolMode: "follow" };
  const warn = console.warn; console.warn = () => {};
  try {
    for (const descriptor of [base, { ...base, symbol: "" }, { ...base, symbolMode: "pinned", symbol: "2330" },
      { ...base, version: undefined }, { ...base, version: "1" }, { ...base, symbolMode: undefined }, { ...base, componentId: "trend" },
      { ...base, symbolMode: "pinned" }, { ...base, contextId: " " }, { ...base, market: "台股" }]) {
      const accepted = schema(descriptor) === true;
      assert.equal(manager.open(descriptor).ok, accepted, JSON.stringify(descriptor));
      assert.equal(viewDescriptorErrors(descriptor).length === 0, accepted);
    }
  } finally { console.warn = warn; }
  assert.equal(schema({ ...base, version: undefined }), false, "a descriptor without its version is refused at the channel, not deeper");
  // The window is sized by detached_windows.json.
  manager.open({ ...base, componentId: "technicalWindow", symbolMode: "pinned", symbol: "2330" });
  assert.deepEqual(opened.at(-1).options.minWidth, DETACHED_WINDOWS.technicalWindow.minWidth);
  assert.deepEqual(opened.at(-1).options.width, DETACHED_WINDOWS.technicalWindow.defaultWidth);
  // trade-window:open: a new trade's market (the main window's, from Rust A's US session) is in every layer -- the
  // schema accepts only 台股 / 美股 and the window factory passes it on.
  assert.equal(channelRule("trade-window:open").schema({ mode: "add", market: "美股" }), true);
  assert.equal(channelRule("trade-window:open").schema({ mode: "add", market: "US" }), false);
  const windows = fs.readFileSync(path.join(__dirname, "..", "ui", "main", "secondary_window_factory.js"), "utf8");
  assert.match(windows, /market: raw\.market === "美股" \? "美股" : "台股"/);

  // R08-13: the renderer's component registry reads the same detached_windows.json (handed over by preload).
  globalThis.window = { desktopAPI: { detachedWindows: DETACHED_WINDOWS } };
  const { ComponentRegistry } = await import("../ui/renderer/js/core/component_registry.js");
  const registry = new ComponentRegistry();
  for (const id of [...Object.keys(DETACHED_WINDOWS), "productList"]) registry.register({ id, create: () => ({}) });
  for (const id of Object.keys(DETACHED_WINDOWS)) {
    assert.equal(registry.get(id).supportsDetachedWindow, true, id);
    assert.deepEqual({ ...registry.get(id).detachedWindow }, DETACHED_WINDOWS[id], id);
  }
  assert.equal(registry.get("productList").supportsDetachedWindow, false);
  for (const id of ["tickDetails", "tickDetailsA", "tradeDetails", "orderbook", "trendChart", "tradeFlow"]) assert.equal(Object.hasOwn(DETACHED_WINDOWS, id), false, `成交明細 has no detached window: ${id}`);
  const components = fs.readFileSync(path.join(__dirname, "..", "ui", "renderer", "js", "dashboard_components.js"), "utf8");
  assert.doesNotMatch(components, /supportsDetachedWindow|detachedWindow\s*:/, "no component definition restates the list or its sizes");
  delete globalThis.window;

  // The product pages are written by settings_api only (POST /api/subscriptions/ops): main only reads them.
  {
    const { handlers } = installAllDomains({ authorize: () => true, logger: quiet, overrides: {
      watchPageStore: { load: () => ({ ok: true, pages: [] }) } } });
    assert.deepEqual(await handlers.get("watch-pages:load-local")({}), { ok: true, pages: [] });
    assert.equal(handlers.has("watch-pages:save-local"), false);
  }

  // R08-11: a window that cannot be told the saved colors does not turn the committed save into a failure.
  {
    const { broadcastColors } = require("../ui/main/desktop_application");
    const told = [];
    const win = (id, send) => ({ id, isDestroyed: () => false, webContents: { send } });
    const BrowserWindow = { getAllWindows: () => [win(1, () => { throw new Error("Object has been destroyed"); }), win(2, (c, v) => told.push([c, v]))] };
    assert.deepEqual(broadcastColors(BrowserWindow, { priceUpColor: "#000000" }, quiet), [1]);
    assert.deepEqual(told, [["preferences:colors-changed", { priceUpColor: "#000000" }]], "the other windows are still told");
    const broadcast = [];
    const { handlers } = installAllDomains({ authorize: () => true, logger: quiet, overrides: {
      colorPreferenceStore: { save: (v) => ({ ...v, saved: true }) },
      broadcastColors: (colors) => { broadcast.push(colors); return broadcastColors(BrowserWindow, {}, quiet); } } });
    // D06-07: the saved colors go out only in the broadcast; the answer says the save went through, nothing more.
    assert.deepEqual(await handlers.get("preferences:set-colors")({}, { priceUpColor: "#111111" }), { ok: true });
    assert.deepEqual(broadcast, [{ priceUpColor: "#111111", saved: true }], "the stored value is what is broadcast");
  }

  // R08-12 / R08-15: one bootstrap snapshot; the source projection comes from STARTUP_UNITS, the shared settings
  // object is not modified and no environment variable is written after start.
  {
    const { sourceSettings } = require("../config/js/source_settings");
    const { STARTUP_UNITS } = require("../ui/main/startup_lifecycle");
    const { createRendererBootstrap } = require("../ui/main/desktop_application");
    const before = JSON.stringify(sourceSettings);
    const envBefore = process.env.STOCK_MONITOR_SOURCES;
    let colorReads = 0;
    const bootstrap = createRendererBootstrap({
      runtime: {},
      apiEndpoints: { served: () => ({ revision: 1, services: {} }), authority: () => "effective", routes: () => ({}),
        serviceUrl: () => "ws://x", projection: () => ({}) },
      desktopWindows: { trustedRendererPage: () => "trade_window.html" },
      colorPreferenceStore: { current: () => { colorReads += 1; return { priceUpColor: "#123456" }; } },
    });
    const snapshot = bootstrap({ senderFrame: { url: "x" } });
    assert.equal(snapshot.ok, true);
    assert.equal("isolatedMode" in snapshot, false);
    assert.equal(snapshot.liveEngineConnection, null);
    assert.equal(snapshot.detachedWindows, DETACHED_WINDOWS);
    assert.deepEqual(snapshot.colorPreferences, { priceUpColor: "#123456" });
    assert.equal(snapshot.sourceSettings.startup_steps.live_ingress, "shioaji");
    assert.equal(snapshot.sourceSettings.startup_steps.moomoo_products, "futu");
    assert.ok(!("canonical_runtime" in snapshot.sourceSettings.startup_steps), "no step outside the registry");
    assert.deepEqual(Object.keys(snapshot.sourceSettings.startup_steps).sort(),
      STARTUP_UNITS.filter((unit) => unit.source).map((unit) => unit.id).sort());
    assert.ok(Object.isFrozen(snapshot.sourceSettings));
    assert.equal(JSON.stringify(sourceSettings), before, "the shared settings object is untouched");
    assert.equal(process.env.STOCK_MONITOR_SOURCES, envBefore);
    const settingsJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "source_settings.json"), "utf8"));
    assert.ok(!("startup_steps" in settingsJson), "the step -> source mapping lives in STARTUP_UNITS only");
    const app = fs.readFileSync(path.join(__dirname, "..", "ui", "main", "desktop_application.js"), "utf8");
    assert.doesNotMatch(app, /process\.env\.STOCK_MONITOR_SOURCES\s*=/);
    const preload = fs.readFileSync(path.join(__dirname, "..", "ui", "main", "preload.js"), "utf8");
    assert.equal([...preload.matchAll(/sendSync\(/g)].length, 1, "one synchronous IPC per preload");
  }
  // The color store is read from disk once; a save replaces the kept value.
  {
    const os = require("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "color-current-"));
    const saved = process.env.STOCK_MONITOR_VAR_ROOT;
    process.env.STOCK_MONITOR_VAR_ROOT = tmp;
    try {
      const { createColorPreferenceStore, DEFAULT_COLORS } = require("../ui/main/color_preference_store");
      const store = createColorPreferenceStore(path.resolve(__dirname, ".."));
      const read = fs.readFileSync;
      let reads = 0;
      fs.readFileSync = (...args) => { reads += 1; return read(...args); };
      try {
        assert.deepEqual(store.current(), DEFAULT_COLORS);
        store.current(); store.current();
        assert.equal(reads, 1);
        store.save({ priceUpColor: "#abcdef" });
        assert.equal(store.current().priceUpColor, "#abcdef");
        assert.equal(reads, 1);
      } finally { fs.readFileSync = read; }
    } finally {
      if (saved === undefined) delete process.env.STOCK_MONITOR_VAR_ROOT; else process.env.STOCK_MONITOR_VAR_ROOT = saved;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // R08-20: a byte budget counts UTF-8 bytes of the serialized value, not JavaScript string length.
  assert.equal(wireBytes("abc"), 3);
  assert.equal(wireBytes("台積電"), 9);
  assert.equal(wireBytes({ a: "台" }), Buffer.byteLength('{"a":"台"}'));
  const remediation = channelRule("remediation:report").schema;
  const event = (detail) => ({ schema: "s", page_instance_id: "p", mechanism_id: "m", detail });
  const filled = (last) => event({ a: "x".repeat(16000), b: "x".repeat(16000), c: "x".repeat(16000), d: "x".repeat(16000), e: "x".repeat(last) });
  const room = 64 * 1024 - wireBytes(filled(0));
  assert.equal(remediation(filled(room)), true, "exactly 64 KiB");
  assert.equal(remediation(filled(room + 1)), false, "one byte over");
  const cjk = { a: "台".repeat(12000), b: "台".repeat(12000) };
  assert.ok(JSON.stringify(event(cjk)).length < 64 * 1024, "short enough by string length");
  assert.equal(remediation(event(cjk)), false, "72 KB of UTF-8 is over the 64 KiB budget");
  assert.equal(remediation(event({ a: "台".repeat(10000) })), true);
  console.log("IPC contract consistency contract passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
