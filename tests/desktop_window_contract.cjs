"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { createDesktopWindows } = require("../ui/main/desktop_windows");
const root = path.resolve(__dirname, "..");
const uiMain = path.join(root, "ui", "main");
const userData = makeTempDir("window-contract-");
const workArea = { x: 0, y: 0, width: 1600, height: 900 };
const display = { id: 1, workArea, workAreaSize: workArea };
const windows = [];
class Window extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.dead = false;
    this.webContents = new EventEmitter();
    this.webContents.setZoomFactor = () => {};
    this.webContents.send = (...args) => { this.lastMessage = args; };
    windows.push(this);
  }
  static fromWebContents(sender) { return windows.find(win => win.webContents === sender); }
  loadFile(file, options) {
    assert.ok(fs.existsSync(file)); this.file = file; this.hash = options?.hash;
    if (Window.failing === path.basename(file)) return Promise.reject(new Error("ERR_FAILED (-2) loading " + file));
    return Promise.resolve();
  }
  isDestroyed() { return this.dead; }
  isMinimized() { return false; }
  isMaximized() { return false; }
  getBounds() { return { x: 0, y: 0, width: 1300, height: 850 }; }
  getContentBounds() { return this.getBounds(); }
  show() {} focus() {} maximize() {}
  close() { this.dead = true; this.emit("closed"); }
}
let announced = 0;
const api = createDesktopWindows({
  app: { getPath: () => userData },
  BrowserWindow: Window, screen: {
    getPrimaryDisplay: () => display, getDisplayMatching: () => display,
    getAllDisplays: () => [display],
  }, uiMainDir: uiMain, getProjectRoot: () => root,
  onMainWindowCreated: () => { announced++; },
  connectSources: () => [],
});
assert.equal(windows.length, 0);
const main = api.createWindow();
assert.equal(api.getMainWindow(), main);
assert.equal(announced, 1);
api.createOrShowTradeWindow({ mode: "add" });
api.createOrShowTradeWindow({ mode: "edit", trade: { trade_id: "existing" } });
assert.equal(windows.length, 2); // repeated open reuses the editor
assert.equal(windows[1].lastMessage[1].trade.trade_id, "existing");
api.closeTradeWindow({ sender: main.webContents });
assert.equal(windows[1].dead, false);
api.createOrShowWatchPageEditor();
api.createOrShowWatchPageEditor();
assert.equal(windows.length, 3);
const releaseDir = path.dirname(main.file);
assert.notEqual(releaseDir, path.join(uiMain, "..", "renderer"));
assert.ok(releaseDir.startsWith(path.join(userData, "renderer-assets")));
for (const win of windows) assert.equal(path.dirname(win.file), releaseDir);
main.webContents.emit("did-fail-load", {}, -6, "ERR_FILE_NOT_FOUND", "file:///missing-index.html", true);
assert.equal(path.basename(main.file), "startup_error.html", "main-frame load failure must render a visible fallback page");
assert.equal(api.trustedRendererPage(`${new URL(`file:///${main.file.replaceAll("\\", "/")}`).href}#detail`), "startup_error.html");
assert.equal(windows[0].options.webPreferences.preload, path.join(uiMain, "preload.js"));

(async () => {
  // A secondary window whose page does not load is recorded with its kind and file, closed (never left blank), and
  // one load-failure window shows startup_error.html naming it.
  const errors = [];
  const realError = console.error;
  const capture = () => { console.error = (...args) => errors.push(args.join(" ")); };
  Window.failing = "workspace_view.html";
  const before = windows.length;
  capture();
  try {
    api.createOrShowWorkspaceWindow("2330");
    await new Promise((resolve) => setImmediate(resolve));
  } finally { console.error = realError; Window.failing = null; }
  const workspace = windows[before];
  assert.equal(workspace.dead, true, "the blank workspace window is closed");
  assert.ok(errors.some((line) => line.includes("[WINDOWS] workspace window failed to load workspace_view.html") && line.includes("ERR_FAILED")), errors.join("\n"));
  const failurePage = windows[before + 1];
  assert.equal(path.basename(failurePage.file), "startup_error.html", "the failure is shown, not a blank window");
  assert.match(decodeURIComponent(failurePage.hash), /workspace window \(workspace_view\.html\): ERR_FAILED/);
  assert.equal(failurePage.dead, false);
  api.createOrShowWorkspaceWindow("2330");
  assert.equal(windows[before + 2].dead, false, "the next open creates a fresh workspace window");

  // The detached views share the same handling.
  Window.failing = "detached_view.html";
  capture();
  try {
    const opened = api.getDetachedViewManager().open({ version: 1, componentId: "eventFeed", contextMode: "live", contextId: "main", symbolMode: "follow" });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    await new Promise((resolve) => setImmediate(resolve));
  } finally { console.error = realError; Window.failing = null; }
  assert.equal(windows[before + 3].dead, true);
  assert.ok(errors.some((line) => line.includes("[WINDOWS] detached view eventFeed window failed to load detached_view.html")), errors.join("\n"));
  assert.equal(windows.length, before + 4, "the one load-failure window is reused");
  assert.match(decodeURIComponent(failurePage.hash), /detached view eventFeed window \(detached_view\.html\)/);

  // Windows' session end is Rust A's (native/market_runtime/src/server/session_end.rs), not the main window's.
  assert.equal(main.listenerCount("session-end"), 0, "the main window does not run a second shutdown at session end");
  main.close();
  assert.equal(api.getMainWindow(), null);
  assert.equal(windows[1].dead, true);
  assert.equal(windows[2].dead, true);
  assert.equal(failurePage.dead, true, "the load-failure window closes with the App");
  console.log("desktop window ownership and resource contract passed");
})().catch((error) => { console.error(error); process.exit(1); });
