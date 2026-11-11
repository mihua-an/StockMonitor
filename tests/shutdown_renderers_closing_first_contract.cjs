"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// Windows stayed open while Health stopped Market Runtime and the APIs under them, so every App close made each window
// record a reconnect (renderer.live_ws_reconnect / renderer.sse_reconnect) that nobody ever finished. Electron main now
// tells every window the App is closing and waits for each to say its transports stopped before it asks Health to stop
// anything: a window that only got told read app_api's EOF (~100 ms later) before the message and still recorded one.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ShutdownController } = require("../ui/main/shutdown_controller");

// answerAfterMs: when the window says its transports stopped (null: never).
async function quit(stopPersistentDaemons, timelinePath = null, answerAfterMs = 30) {
  const order = [];
  let controller = null;
  const webContents = { id: 7, send: (channel, payload) => {
    order.push(`${channel}:${payload.scope}`);
    if (answerAfterMs !== null) {
      setTimeout(() => { order.push("answered"); controller.rendererStopped({ sender: webContents }); }, answerAfterMs);
    }
  } };
  const window = { isDestroyed: () => false, destroy() { order.push("destroy"); }, webContents };
  controller = new ShutdownController({
    electron: { app: { quit() {}, exit() {}, once() {} }, dialog: { showErrorBox() {} }, BrowserWindow: { getAllWindows: () => [window] } },
    node: { performance: { now: () => 0 }, processRef: { pid: 1234 }, fs },
    controllerClient: { shutdown: async (scope) => { order.push(`shutdown:${scope}`); return { ok: true }; } },
    startupCoordinator: { markProgress() {}, stop() {} },
    rendererHealth: { close: async () => {} },
    appSingleInstance: { releasePrimary: () => true },
    desktopWindows: { getMainWindow: () => window, setMainWindow() {}, saveWindowState() {}, showShutdownState() {} },
    reopenMainWindow: () => null,
    logger: { log() {}, warn() {}, error() {} }, timelinePath, rendererStopAnswerMs: 200,
  });
  controller.spawnExternalQuitWatchdog = () => {};
  await controller.requestGracefulQuit({ stopPersistentDaemons, reason: "test" });
  return order;
}

(async () => {
  // Health is asked only after the window answered.
  assert.deepEqual((await quit(true)).slice(0, 4), ["app:closing:full", "answered", "shutdown:full", "destroy"]);
  assert.deepEqual((await quit(false)).slice(0, 4), ["app:closing:ui_backend", "answered", "shutdown:ui_backend", "destroy"]);
  // A window that never answers (hung) does not hold the close: it goes on after the answer budget.
  const started = Date.now();
  assert.deepEqual((await quit(true, null, null)).slice(0, 3), ["app:closing:full", "shutdown:full", "destroy"]);
  assert.ok(Date.now() - started >= 190, "the budget was waited for");
  // Both live transports stop on it instead of reconnecting.
  const realtime = fs.readFileSync(path.join(__dirname, "..", "ui", "renderer", "js", "market_data", "realtime.js"), "utf8");
  assert.match(realtime, /desktopAPI\?\.onAppClosing\?\.\(\(\) => stopRealtimeStream\("app_closing"\)\)/);
  // The preload runs every registered stop first, then answers main.
  const preload = fs.readFileSync(path.join(__dirname, "..", "ui", "main", "preload.js"), "utf8");
  assert.match(preload, /ipcRenderer\.on\("app:closing", \(_event, payload\) => \{[\s\S]*?listener\(payload \|\| \{\}\)[\s\S]*?ipcRenderer\.send\("app:closing-done"\)/);
  // Each stage is appended to the log session's shutdown_timeline.log as it happens (Electron main had only its console).
  const os = require("node:os");
  const file = path.join(makeTempDir("shutdown-timeline-"), "shutdown_timeline.log");
  await quit(true, file);
  const stages = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => l.split(" ms ")[1].split(" ")[0]);
  assert.deepEqual(stages, ["requested", "renderers_told", "renderer_health_closed", "remediation_flushed", "controller_answered",
    "windows_destroyed", "remediation_spooled", "app_quit"]);
  // The external watchdog records when the main process, each Chromium helper and the launcher end (they share the
  // launcher's console window, which stayed ~10 s after 完全關閉).
  let script = "";
  const watchdog = new ShutdownController({
    electron: { app: { getAppMetrics: () => [{ pid: 4001, type: "Browser" }, { pid: 4002, type: "GPU" }, { pid: 4003, type: "Utility" }] } },
    node: { path, performance: { now: () => 0 }, fs: { ...fs, writeFileSync: (_file, body) => { script = body; } },
      processRef: { pid: 4001, ppid: 3000, platform: "win32", execPath: "C:\\e\\electron.exe", env: { TEMP: os.tmpdir() } } },
    logger: { log() {}, warn() {}, error() {} }, timelinePath: file,
    spawnImpl: () => ({ unref() {} }),
  });
  watchdog.spawnExternalQuitWatchdog();
  for (const expected of ["pid = 4001; type = 'Browser'", "pid = 4002; type = 'GPU'", "pid = 4003; type = 'Utility'", "pid = 3000; type = 'launcher'"]) {
    assert.ok(script.includes(expected), `${expected} is watched`);
  }
  assert.ok(script.includes("process gone ") && script.includes(file.replace(/'/g, "''")), "each end goes to the shutdown timeline");
  assert.ok(script.includes("Stop-Process -Id 4001 -Force"), "the 10 s watchdog itself is kept");
  console.log("shutdown renderers-closing-first contract ok");
})().catch((error) => { console.error(error); process.exit(1); });
