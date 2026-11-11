"use strict";
// The main window's debounced bounds save and UI-scale refresh belong to the window that scheduled them: closing it
// cancels both, so a main window reopened right after is never saved or scaled by the old window's timers.
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { createDesktopWindows } = require("../ui/main/desktop_windows");

const root = path.resolve(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "window-timers-"));
const workArea = { x: 0, y: 0, width: 1600, height: 900 };
const display = { id: 1, workArea, workAreaSize: workArea, scaleFactor: 1 };
class Window extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.dead = false; this.boundsReads = 0; this.zooms = 0;
    this.webContents = new EventEmitter();
    this.webContents.setZoomFactor = () => { this.zooms += 1; };
    this.webContents.send = () => {};
  }
  static fromWebContents() { return null; }
  static getAllWindows() { return []; }
  loadFile() { return Promise.resolve(); }
  isDestroyed() { return this.dead; }
  isMinimized() { return false; }
  isMaximized() { return false; }
  getBounds() { this.boundsReads += 1; return { x: 0, y: 0, width: 1300, height: 850 }; }
  getContentBounds() { return { x: 0, y: 0, width: 1300, height: 850 }; }
  setMinimumSize() {} setMaximumSize() {} show() {} focus() {} maximize() {}
  close() { this.dead = true; this.emit("closed"); }
}
const api = createDesktopWindows({
  app: { getPath: () => userData }, BrowserWindow: Window,
  screen: { getPrimaryDisplay: () => display, getDisplayMatching: () => display, getAllDisplays: () => [display] },
  uiMainDir: path.join(root, "ui", "main"), getProjectRoot: () => root,
  onMainWindowCreated: () => {}, connectSources: () => [],
});

(async () => {
  const first = api.createWindow();
  first.emit("resize");
  first.close();
  const second = api.createWindow();
  const zoomsBefore = second.zooms;
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(first.boundsReads, 0, "the closed window's pending save did not run");
  assert.equal(second.boundsReads, 0, "nor did it save the new window");
  assert.equal(second.zooms, zoomsBefore, "nor scale the new window");
  // The new window's own timers still work.
  second.emit("move");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(second.boundsReads > 0);
  console.log("main window geometry timers contract passed");
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
