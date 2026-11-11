"use strict";
// 關閉介面與 FastAPI, then 完整關閉 in the tray while it ran: the second click was dropped (the shutdown already under
// way returned at once), the UI quit and Health, the providers and Rust A/B kept running. A full request during a
// UI-only shutdown widens it: Health is asked for "full" before the App quits.
const assert = require("node:assert/strict");
const { ShutdownController } = require("../ui/main/shutdown_controller");

function harness({ onAsk = async () => ({ ok: true }) } = {}) {
  const asked = [];
  const traces = [];
  const window = { isDestroyed: () => false, destroy() {} };
  let quits = 0;
  const controller = new ShutdownController({
    electron: {
      app: { quit() { quits += 1; }, exit() {}, once() {} },
      dialog: { showErrorBox() {} },
      BrowserWindow: { getAllWindows: () => [window] },
    },
    node: { performance: { now: () => 0 }, processRef: { pid: 1234 } },
    controllerClient: { shutdown: async (scope) => { asked.push(scope); return onAsk(scope); } },
    startupCoordinator: { markProgress() {}, stop() {} },
    rendererHealth: { close: async () => {} },
    appSingleInstance: { releasePrimary: () => true },
    desktopWindows: { getMainWindow: () => window, setMainWindow() {}, saveWindowState() {}, showShutdownState() {} },
    reopenMainWindow: () => null,
    logger: { log: (line) => traces.push(line), warn() {}, error() {} },
  });
  return { controller, asked, traces, quits: () => quits };
}

(async () => {
  // 完整關閉 while Health is still answering the UI-only request.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const during = harness({ onAsk: async (scope) => { if (scope === "ui_backend") await gate; return { ok: true }; } });
  const first = during.controller.requestGracefulQuit({ stopPersistentDaemons: false, reason: "user_close_ui_backend" });
  await new Promise((resolve) => setImmediate(resolve));
  const second = during.controller.requestGracefulQuit({ stopPersistentDaemons: true, reason: "user_full_shutdown" });
  release();
  await Promise.all([first, second]);
  assert.deepEqual(during.asked, ["ui_backend", "full"], "Health is asked for the full shutdown too");
  assert.equal(during.quits(), 1, "the App quits once");
  assert.ok(during.traces.some((line) => line.includes("widened_to_full")));

  // 完整關閉 before the UI-only request went out: Health is asked once, for "full".
  const before = harness();
  const a = before.controller.requestGracefulQuit({ stopPersistentDaemons: false, reason: "user_close_ui_backend" });
  const b = before.controller.requestGracefulQuit({ stopPersistentDaemons: true, reason: "user_full_shutdown" });
  await Promise.all([a, b]);
  assert.deepEqual(before.asked, ["full"]);

  // The same scope twice is one shutdown, recorded, not two.
  const repeat = harness();
  await Promise.all([
    repeat.controller.requestGracefulQuit({ stopPersistentDaemons: false, reason: "user_close_ui_backend" }),
    repeat.controller.requestGracefulQuit({ stopPersistentDaemons: false, reason: "user_close_ui_backend" }),
  ]);
  assert.deepEqual(repeat.asked, ["ui_backend"]);
  assert.ok(repeat.traces.some((line) => line.includes("repeat_request")));
  console.log("shutdown scope widen contract ok");
})().catch((error) => { console.error(error); process.exit(1); });
