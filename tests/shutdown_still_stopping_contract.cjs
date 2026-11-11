"use strict";
// Health's full shutdown is bounded well past Electron's 60 s wait and keeps running after the
// request gives up. That timeout was reported as "Service Controller unreachable" with an error box. A timeout is now
// "still stopping in the background"; only a real failure to reach Health raises the box.
const assert = require("node:assert/strict");
const { ShutdownController } = require("../ui/main/shutdown_controller");

async function quitWith(shutdownError) {
  const errorBoxes = [];
  const logs = [];
  const window = { isDestroyed: () => false, destroy() {} };
  const controller = new ShutdownController({
    electron: {
      app: { quit() {}, exit() {}, once() {} },
      dialog: { showErrorBox: (title) => errorBoxes.push(title) },
      BrowserWindow: { getAllWindows: () => [window] },
    },
    node: { performance: { now: () => 0 }, processRef: { pid: 1234 } },
    controllerClient: { shutdown: async () => { throw shutdownError; } },
    startupCoordinator: { markProgress() {}, stop() {} },
    rendererHealth: { close: async () => {} },
    appSingleInstance: { releasePrimary: () => true },
    desktopWindows: { getMainWindow: () => window, setMainWindow() {}, saveWindowState() {}, showShutdownState() {} },
    reopenMainWindow: () => null,
    logger: { log: (line) => logs.push(line), warn: (line) => logs.push(line), error: (line) => logs.push(line) },
  });
  await controller.requestGracefulQuit({ stopPersistentDaemons: true, reason: "test" });
  return { errorBoxes, logs };
}

(async () => {
  const timedOut = await quitWith(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
  assert.deepEqual(timedOut.errorBoxes, [], "a slow shutdown is not reported as unreachable");
  assert.ok(timedOut.logs.some((line) => line.includes("controller_still_stopping=true")));

  const unreachable = await quitWith(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
  assert.deepEqual(unreachable.errorBoxes, ["無法聯絡 Service Controller"]);
  console.log("shutdown still-stopping contract ok");
})().catch((error) => { console.error(error); process.exit(1); });
