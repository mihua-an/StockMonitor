"use strict";
// A full shutdown asked of Health by anyone but the UI (a tool calling /control/shutdown, a signal, Windows' session
// end through Rust A) stopped the business APIs while the windows were still streaming from them; the UI was told
// only after Health had exited, so every close recorded ui.catalog_stream_reconnect / renderer.sse_reconnect /
// renderer.live_ws_reconnect (10-29 05:15). Health now announces the shutdown on the UI's event stream and waits for
// the UI to say its windows stopped before the first service stops -- the same order as the tray's 完整關閉.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTempDir } = require("./support/temp_dirs.cjs");
const { createControllerHttpApi } = require("../health/control_api");
const { createUiClosingChannel } = require("../health/ui_closing_channel");
const { createControllerClient } = require("../ui/main/controller_client");
const { ShutdownController } = require("../ui/main/shutdown_controller");

const root = path.resolve(__dirname, "..");
const quiet = { log() {}, warn() {}, error() {} };
const until = async (check, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

// An Electron main over a real Health control API: `order` is what happened, in order.
async function app({ uiFollows = true, windowAnswers = true } = {}) {
  const order = [];
  const token = "t".repeat(32);
  let api = null;
  // health/main.js performShutdown: announce, then stop the services.
  const performShutdown = async (scope) => {
    const ui = await api.announceUiClosing(scope);
    order.push(`health:stop_services:${scope}:told=${ui.told}:answered=${ui.answered}`);
    return { ok: true, scope };
  };
  api = createControllerHttpApi({ host: "127.0.0.1", port: 0, token, identity: () => ({}), supervisor: { status: () => ({}), stopping: false },
    collector: {}, performShutdown, logger: quiet });
  await api.listen();
  const baseUrl = `http://127.0.0.1:${api.server.address().port}`;
  const tokenFile = path.join(makeTempDir("ui-first-auth-"), "controller_auth_token");
  fs.writeFileSync(tokenFile, token);
  process.env.STOCK_MONITOR_CONTROLLER_TOKEN_FILE = tokenFile;
  const client = { ...createControllerClient({ fs, baseUrl }) };
  let controller = null;
  const webContents = { id: 9, send: (channel, payload) => {
    order.push(`ui:${channel}:${payload.scope}`);
    if (windowAnswers) setTimeout(() => { order.push("ui:window_stopped"); controller.rendererStopped({ sender: webContents }); }, 20);
  } };
  const window = { isDestroyed: () => false, destroy() { order.push("ui:destroy"); }, webContents };
  let quit = false;
  controller = new ShutdownController({
    electron: { app: { quit() { quit = true; order.push("ui:quit"); }, exit() {}, once() {} }, dialog: { showErrorBox() {} },
      BrowserWindow: { getAllWindows: () => [window] } },
    node: { performance: { now: () => 0 }, processRef: { pid: 1234, env: {} }, fs, path },
    controllerClient: client, startupCoordinator: { markProgress() {}, stop() {} }, rendererHealth: { close: async () => {} },
    remediationClient: { flush: async () => { order.push("ui:remediation_flushed"); } },
    appSingleInstance: { releasePrimary: () => true },
    desktopWindows: { getMainWindow: () => window, setMainWindow() {}, saveWindowState() {}, showShutdownState() {} },
    healthBootstrap: { markShuttingDown() { order.push("ui:bootstrap_marked"); } },
    logger: quiet, rendererStopAnswerMs: windowAnswers ? 1000 : 100,
  });
  controller.spawnExternalQuitWatchdog = () => {};
  return { order, api, baseUrl, token, controller, client, isQuit: () => quit };
}

const post = (ctx, scope) => fetch(`${ctx.baseUrl}/control/shutdown`, { method: "POST",
  headers: { Authorization: `Bearer ${ctx.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ scope }) }).then((r) => r.json());

(async () => {
  // 1. Someone else asks Health for a full shutdown: the window stops before any service stops, and the App quits
  //    once Health ends its stream (here: the control API closing, as finish() does before Health exits).
  {
    const ctx = await app();
    ctx.controller.followHealth();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const answer = await post(ctx, "full");
    assert.equal(answer.ok, true);
    const stop = ctx.order.findIndex((entry) => entry.startsWith("health:stop_services"));
    assert.equal(ctx.order[stop], "health:stop_services:full:told=1:answered=true", ctx.order.join("\n"));
    assert.deepEqual(ctx.order.slice(0, stop), ["ui:bootstrap_marked", "ui:app:closing:full", "ui:window_stopped", "ui:remediation_flushed"],
      ctx.order.join("\n"));
    assert.equal(ctx.controller.quitting, true, "the UI's own reconnects see the App closing (isClosing)");
    assert.equal(ctx.isQuit(), false, "the App waits for Health to end");
    await ctx.api.close();
    await until(ctx.isQuit);
    assert.equal(ctx.order.filter((entry) => entry === "ui:app:closing:full").length, 1, "the windows are told once");
  }
  // 2. The tray's own 完整關閉: Electron stops its windows, asks Health; Health's announcement is answered at once and
  //    the windows are not told twice.
  {
    const ctx = await app();
    ctx.client.shutdown = async (scope) => post(ctx, scope);
    ctx.controller.followHealth();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await ctx.controller.requestGracefulQuit({ stopPersistentDaemons: true, reason: "user_full_shutdown" });
    const stop = ctx.order.findIndex((entry) => entry.startsWith("health:stop_services"));
    assert.equal(ctx.order[stop], "health:stop_services:full:told=1:answered=true", ctx.order.join("\n"));
    assert.deepEqual(ctx.order.slice(0, stop), ["ui:bootstrap_marked", "ui:app:closing:full", "ui:window_stopped", "ui:remediation_flushed"]);
    assert.ok(ctx.isQuit());
    await ctx.api.close();
  }
  // 3. No UI follows this Health (closed with 關閉介面與 FastAPI): nothing to wait for.
  {
    const ctx = await app();
    const started = Date.now();
    await post(ctx, "full");
    assert.deepEqual(ctx.order, ["health:stop_services:full:told=0:answered=false"]);
    assert.ok(Date.now() - started < 1000);
    await ctx.api.close();
  }
  // 4. A UI that never answers does not hold the shutdown past the channel's bound.
  {
    const channel = createUiClosingChannel({ answerMs: 150, logger: quiet });
    const response = { writableEnded: false, destroyed: false, writeHead() {}, write() {}, end() {} };
    const request = { on() {} };
    channel.attach(request, response);
    const started = Date.now();
    const result = await channel.announce("full");
    assert.equal(result.told, 1);
    assert.equal(result.answered, false);
    assert.ok(Date.now() - started >= 140 && Date.now() - started < 1000);
  }
  delete process.env.STOCK_MONITOR_CONTROLLER_TOKEN_FILE;

  // Health: every shutdown that ends the UI announces before its first stop; only the network handoff (the UI stays
  // and follows the restarted Health) does not. The Windows session end and signals go through graceful().
  const healthMain = fs.readFileSync(path.join(root, "health", "main.js"), "utf8");
  const full = healthMain.slice(healthMain.indexOf('if (scope !== "full")'), healthMain.indexOf("await stage(API_SERVICES)"));
  assert.match(full, /if \(uiEnds\) await announceUiClosing\(scope\);/);
  const uiBackend = healthMain.slice(healthMain.indexOf('if (scope === "ui_backend")'), healthMain.indexOf("supervisor.stop(n, \"ui_backend_shutdown\")"));
  assert.match(uiBackend, /await announceUiClosing\(scope\);/);
  assert.match(healthMain, /performShutdown\("full", \{ uiEnds: false \}\)[\s\S]{0,120}network handoff/);
  assert.equal((healthMain.match(/performShutdown\("full"\)/g) || []).length, 1, "graceful() (signals, Windows session end) announces");
  // Electron follows Health from its first answer, and a restarted Health again.
  const lifecycle = fs.readFileSync(path.join(root, "ui", "main", "app_lifecycle_controller.js"), "utf8");
  assert.match(lifecycle, /refreshFromHealth\(this\.controllerClient, "startup"\);\s*\/\/[^\n]*\n\s*this\.shutdownController\.followHealth\(\);/);
  const application = fs.readFileSync(path.join(root, "ui", "main", "desktop_application.js"), "utf8");
  assert.match(application, /onRestarted\?\.\(\(\) => shutdownController\.followHealth\(\)\)/);
  console.log("health-initiated shutdown ui-first contract ok");
})().catch((error) => { console.error(error); process.exit(1); });
