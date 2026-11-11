"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// Every App renderer is observed, not only the main window: a secondary window (trade editor, watch-page editor,
// workspace, detached view) created after start-up has its console errors written to error.log and leaves the
// registry when it is destroyed; a window that existed before the hook was installed is observed too.
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createRendererHealthRegistry } = require("../ui/main/renderer_health");
const { observeEveryRenderer } = require("../ui/main/desktop_application");

(async () => {
  const output = makeTempDir("renderer-health-every-window-");
  const errorLogPath = path.join(output, "error.log");
  const registry = createRendererHealthRegistry({ fs, path, outputDir: output, electronPid: 42, errorLogPath });
  const app = new EventEmitter();
  const existing = new EventEmitter(); existing.id = 1;
  observeEveryRenderer({ app, BrowserWindow: { getAllWindows: () => [{ webContents: existing }] }, rendererHealth: registry });

  const editor = new EventEmitter(); editor.id = 7;
  app.emit("web-contents-created", {}, editor);
  app.emit("web-contents-created", {}, editor); // the same contents again is one record
  await registry.flush();
  const read = () => JSON.parse(fs.readFileSync(path.join(output, "renderer_health.json"), "utf8"));
  assert.deepEqual(read().renderers.map((r) => r.id).sort(), [1, 7]);

  editor.emit("console-message", { level: "error", message: "watch page sync failed", lineNumber: 3, sourceId: "watch_pages_window.js" });
  existing.emit("console-message", { level: "warning", message: "pre-existing window warning", lineNumber: 1, sourceId: "app.js" });
  // 10-22 12:53: Market Runtime dropped a window that had not read for 7 s, and nothing said what the window did.
  existing.getURL = () => "file:///C:/app/ui/renderer/index.html?x=1";
  existing.emit("unresponsive");
  existing.emit("responsive");
  editor.emit("destroyed");
  await registry.close();
  const log = fs.readFileSync(errorLogPath, "utf8");
  assert.match(log, /watch page sync failed \(watch_pages_window\.js:3\)/, "a secondary window's console error reaches error.log");
  assert.match(log, /pre-existing window warning/, "a window created before the hook is observed");
  assert.match(log, /\[MAIN WARN\] \[RENDERER UNRESPONSIVE\] index\.html stopped answering/);
  assert.match(log, /\[RENDERER UNRESPONSIVE\] index\.html answers again after \d+ ms/);
  assert.deepEqual(read().renderers.map((r) => r.id), [1], "a destroyed window leaves the registry");
  console.log("renderer health observes every window contract passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
