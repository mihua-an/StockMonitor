"use strict";
// A shutdown stage that rejects is recorded and the shutdown goes on: the singleton lock is released, undelivered
// remediation spooled and app.quit() called whatever failed before. Before, one rejected await left the App
// "closing" for good: quitting=true refused every window close and app.quit() never ran.
const assert = require("node:assert/strict");
const { ShutdownController } = require("../ui/main/shutdown_controller");
const { createQuitWatchdog } = require("../ui/main/windows_quit_watchdog");

function controllerWith(overrides) {
  const calls = [];
  const errors = [];
  const window = { isDestroyed: () => false, destroy() { calls.push("destroy"); }, webContents: { send() {} } };
  const controller = new ShutdownController({
    electron: { app: { quit: () => calls.push("app.quit"), exit() {}, once() {} }, dialog: { showErrorBox() {} },
      BrowserWindow: { getAllWindows: () => [window] } },
    node: { performance: { now: () => 0 }, processRef: { pid: 1234, platform: "linux", env: {} } },
    controllerClient: { shutdown: async () => ({ ok: true }) },
    startupCoordinator: { markProgress() {}, stop() {} },
    rendererHealth: { close: async () => ({}) },
    remediationClient: { flush: async () => {}, undelivered: () => [], close() { calls.push("remediation.close"); } },
    appSingleInstance: { releasePrimary: () => { calls.push("release"); return true; } },
    desktopWindows: { getMainWindow: () => window, setMainWindow() {}, saveWindowState() {}, showShutdownState() {} },
    logger: { log() {}, warn() {}, error: (line) => errors.push(String(line)) },
    ...overrides(calls),
  });
  return { controller, calls, errors };
}

(async () => {
  {
    const { controller, calls, errors } = controllerWith(() => ({
      rendererHealth: { close: async () => { throw new Error("sink close rejected"); } },
      controllerClient: { shutdown: async () => { throw new Error("connect ECONNREFUSED"); } },
    }));
    await controller.requestGracefulQuit({ stopPersistentDaemons: true, reason: "test" });
    assert.deepEqual(calls, ["destroy", "release", "remediation.close", "app.quit"]);
    assert.ok(errors.some((e) => e.includes("stage renderer_health_closed failed")), errors.join("\n"));
  }
  {
    const { controller, calls, errors } = controllerWith(() => ({
      desktopWindows: { getMainWindow: () => null, setMainWindow() { throw new Error("window registry broken"); }, showShutdownState() { throw new Error("no window"); } },
    }));
    await controller.requestGracefulQuit({ stopPersistentDaemons: false, reason: "test" });
    assert.ok(calls.includes("release") && calls.at(-1) === "app.quit", calls.join(","));
    assert.ok(errors.some((e) => e.includes("stage shutdown_state_shown failed")));
    assert.ok(errors.some((e) => e.includes("stage windows_destroyed failed")));
  }
  {
    const { controller, calls } = controllerWith(() => ({
      rendererHealth: { close: async () => { throw new Error("sink close rejected"); } },
    }));
    await controller.quitAfterHealthEnded();
    assert.deepEqual(calls, ["destroy", "release", "remediation.close", "app.quit"]);
  }
  // Off Windows the external watchdog is an explicit no-op.
  assert.deepEqual(createQuitWatchdog({ platform: "linux", spawn: () => { throw new Error("must not spawn"); } }).arm({ pid: 1 }),
    { armed: false, reason: "not_windows" });
  console.log("shutdown stage runner contract passed");
})().catch((error) => { console.error(error); process.exit(1); });
