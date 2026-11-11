"use strict";
// An endpoint change reloads every renderer window, but the detached descriptor, the trade payload and
// the workspace seed were sent once, on the first did-finish-load -- a reloaded window came back blank / reset.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { DetachedViewManager } = require("../ui/main/detached_view_manager.js");

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.webContents = Object.assign(new EventEmitter(), { send: (channel, payload) => this.sent.push([channel, payload]) });
    FakeWindow.last = this;
  }
  loadFile() {}
  isDestroyed() { return false; }
  show() {} focus() {}
}

const manager = new DetachedViewManager({ BrowserWindow: FakeWindow, preloadPath: "p", rendererPath: "r" });
const opened = manager.open({ version: 1, componentId: "technicalWindow", contextMode: "live", contextId: "main", symbolMode: "pinned", symbol: "2330" });
assert.strictEqual(opened.ok, true, JSON.stringify(opened));
const win = FakeWindow.last;
win.webContents.emit("did-finish-load");
win.webContents.emit("did-finish-load");  // the reload after an endpoint change
assert.strictEqual(win.sent.filter(([channel]) => channel === "detached-view:descriptor").length, 2,
  "the reloaded view receives its descriptor again");

const windows = ["desktop_windows.js", "secondary_window_factory.js", "window_load_failure.js"]
  .map((file) => fs.readFileSync(path.join(__dirname, "..", "ui", "main", file), "utf8")).join("\n");
assert.ok(!/webContents\.once\("did-finish-load"/.test(windows), "no window bootstrap is sent only on the first load");
const workspace = fs.readFileSync(path.join(__dirname, "..", "ui", "renderer", "workspace_view.js"), "utf8");
assert.ok(workspace.includes("readMembers()") && workspace.includes("writeMembers(store.list())"),
  "workspace members are restored after a reload");
console.log("secondary window reload contract passed");
