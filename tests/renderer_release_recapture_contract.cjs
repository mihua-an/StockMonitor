"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// 僅關閉介面 + reopen must pick up renderer changes. rendererFile() re-captured only when "every window
// is destroyed", but every caller creates its window before asking for the file, so the new window itself was always
// alive at that moment. A release is kept only while some window is SHOWING it.
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { createDesktopWindows } = require("../ui/main/desktop_windows");

const root = makeTempDir("release-recapture-");
fs.cpSync(path.resolve(__dirname, "..", "ui", "renderer"), path.join(root, "ui", "renderer"), { recursive: true });
const uiMain = path.join(root, "ui", "main");
fs.mkdirSync(uiMain, { recursive: true });
const userData = path.join(root, "user-data");
const workArea = { x: 0, y: 0, width: 1600, height: 900 };
const display = { id: 1, workArea, workAreaSize: workArea };
const windows = [];
class Window extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.dead = false; this.url = "";
    this.webContents = new EventEmitter();
    this.webContents.setZoomFactor = () => {};
    this.webContents.send = () => {};
    this.webContents.getURL = () => this.url;
    windows.push(this);
  }
  static getAllWindows() { return windows.filter((w) => !w.dead); }
  static fromWebContents(sender) { return windows.find((win) => win.webContents === sender); }
  loadFile(file) { assert.ok(fs.existsSync(file)); this.file = file; this.url = pathToFileURL(file).href; }
  isDestroyed() { return this.dead; }
  isMinimized() { return false; }
  isMaximized() { return false; }
  getBounds() { return { x: 0, y: 0, width: 1300, height: 850 }; }
  getContentBounds() { return this.getBounds(); }
  show() {} focus() {} maximize() {}
  close() { this.dead = true; this.emit("closed"); }
  destroy() { this.close(); }
}
const api = createDesktopWindows({
  app: { getPath: () => userData },
  BrowserWindow: Window, screen: { getPrimaryDisplay: () => display, getDisplayMatching: () => display, getAllDisplays: () => [display] },
  uiMainDir: uiMain, getProjectRoot: () => root, onMainWindowCreated: () => {}, connectSources: () => [],
});
const appJs = path.join(root, "ui", "renderer", "js", "app.js");
const first = api.createWindow();
const firstRelease = path.dirname(first.file);
fs.appendFileSync(appJs, "\n// edited while the window is open\n");
api.createOrShowWatchPageEditor();
assert.equal(path.dirname(windows.at(-1).file), firstRelease, "windows open together stay on one release");
for (const win of [...windows]) win.close();
const reopened = api.createWindow();
const secondRelease = path.dirname(reopened.file);
assert.notEqual(secondRelease, firstRelease, "a window opened after every window closed shows the current renderer");
assert.match(fs.readFileSync(path.join(secondRelease, "js", "app.js"), "utf8"), /edited while the window is open/);
fs.rmSync(root, { recursive: true, force: true });
console.log("renderer release recapture contract passed");
