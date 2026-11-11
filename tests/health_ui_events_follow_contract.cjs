"use strict";
// Electron main must hear every shutdown Health announces for as long as the App runs. The stream is silent until a
// shutdown, and global fetch (undici) ended it after 300 s without data (bodyTimeout), so a tool's /control/shutdown
// full 5 minutes after start found no UI to tell (`ui told=0`) and the windows recorded reconnects. A stream that
// broke for any other reason (a reset connection) was never followed again either.
//
// undici's 300 s is stood in for by a global dispatcher with a 300 ms body timeout: the follower must not use it.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Agent, setGlobalDispatcher, getGlobalDispatcher } = require("undici");
const { makeTempDir } = require("./support/temp_dirs.cjs");
const { createControllerHttpApi } = require("../health/control_api");
const { createControllerClient } = require("../ui/main/controller_client");
const { ShutdownController } = require("../ui/main/shutdown_controller");

const quiet = { log() {}, info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, what, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
};

// A real Health control API and an Electron main following it. `breakNextUiEvents()`: Health's side resets the
// connection of the next GET /control/ui-events before answering (a keep-alive socket Health already closed).
async function app() {
  const order = [];
  const remediation = [];
  const token = "t".repeat(32);
  let api = null;
  let resetNextUiEvents = 0;
  let uiEventsRequests = 0;
  const performShutdown = async (scope) => {
    const ui = await api.announceUiClosing(scope);
    order.push(`health:stop_services:${scope}:told=${ui.told}:answered=${ui.answered}`);
    return { ok: true, scope };
  };
  api = createControllerHttpApi({ host: "127.0.0.1", port: 0, token, identity: () => ({}), supervisor: { status: () => ({}), stopping: false },
    collector: {}, performShutdown, logger: quiet });
  const sockets = new Set();
  api.server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  api.server.prependListener("request", (request) => {
    if (!request.url.startsWith("/control/ui-events")) return;
    uiEventsRequests += 1;
    if (resetNextUiEvents > 0) { resetNextUiEvents -= 1; request.socket.destroy(); }
  });
  await api.listen();
  const baseUrl = `http://127.0.0.1:${api.server.address().port}`;
  const tokenFile = path.join(makeTempDir("ui-events-follow-auth-"), "controller_auth_token");
  fs.writeFileSync(tokenFile, token);
  process.env.STOCK_MONITOR_CONTROLLER_TOKEN_FILE = tokenFile;
  const client = createControllerClient({ fs, baseUrl });
  let controller = null;
  const webContents = { id: 9, send: (channel, payload) => {
    order.push(`ui:${channel}:${payload.scope}`);
    setTimeout(() => controller.rendererStopped({ sender: webContents }), 10);
  } };
  const window = { isDestroyed: () => false, destroy() {}, webContents };
  let quit = false;
  const remediationClient = {
    flush: async () => {},
    begin({ mechanismId, triggerReason, detail }) {
      remediation.push({ mechanismId, outcome: "started", triggerReason, detail });
      return { finish: (outcome, { detail: result } = {}) => remediation.push({ mechanismId, outcome, detail: result }) };
    },
  };
  controller = new ShutdownController({
    electron: { app: { quit() { quit = true; }, exit() {}, once() {} }, dialog: { showErrorBox() {} },
      BrowserWindow: { getAllWindows: () => [window] } },
    node: { performance: { now: () => 0 }, processRef: { pid: 1234, env: {} }, fs, path },
    controllerClient: client, startupCoordinator: { markProgress() {}, stop() {} }, rendererHealth: { close: async () => {} },
    remediationClient, appSingleInstance: { releasePrimary: () => true },
    desktopWindows: { getMainWindow: () => window, setMainWindow() {}, saveWindowState() {}, showShutdownState() {} },
    healthBootstrap: { markShuttingDown() {} }, logger: quiet, rendererStopAnswerMs: 1000,
  });
  controller.spawnExternalQuitWatchdog = () => {};
  return {
    order, remediation, api, baseUrl, token, controller, client, isQuit: () => quit,
    breakNextUiEvents: () => { resetNextUiEvents += 1; },
    resetAllConnections: () => { for (const socket of sockets) socket.destroy(); },
    uiEventsRequests: () => uiEventsRequests,
  };
}

const post = (ctx, scope) => fetch(`${ctx.baseUrl}/control/shutdown`, { method: "POST",
  headers: { Authorization: `Bearer ${ctx.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ scope }) }).then((r) => r.json());

// The shutdown a tool asks of Health reaches the window before any service stops.
async function assertToldFirst(ctx) {
  await post(ctx, "full");
  const stop = ctx.order.findIndex((entry) => entry.startsWith("health:stop_services"));
  assert.equal(ctx.order[stop], "health:stop_services:full:told=1:answered=true", ctx.order.join("\n"));
  assert.ok(ctx.order.slice(0, stop).includes("ui:app:closing:full"), ctx.order.join("\n"));
  await ctx.api.close();
  await until(ctx.isQuit, "the App to quit once Health ended");
}

(async () => {
  const defaultDispatcher = getGlobalDispatcher();
  setGlobalDispatcher(new Agent({ bodyTimeout: 300 }));
  try {
    // 1. Idle past the HTTP client's body timeout: the stream is still there, nothing was recorded, and a full
    //    shutdown asked by a tool is announced to the window first.
    {
      const ctx = await app();
      ctx.controller.followHealth();
      await sleep(1200);
      assert.deepEqual(ctx.remediation, [], "an idle stream is not a broken one");
      assert.equal(ctx.uiEventsRequests(), 1, "followed once, never again");
      await assertToldFirst(ctx);
      assert.deepEqual(ctx.remediation, []);
    }
  } finally {
    setGlobalDispatcher(defaultDispatcher);
  }

  // 2. The stream's connection breaks while Health runs: followed again at once, one ui.health_events_refollow
  //    operation (stream_broken -> succeeded), and the next shutdown is announced.
  {
    const ctx = await app();
    ctx.controller.followHealth();
    await until(() => ctx.uiEventsRequests() === 1, "the first follow");
    await sleep(50);
    ctx.resetAllConnections();
    await until(() => ctx.remediation.some((event) => event.outcome === "succeeded"), "the stream to be followed again");
    assert.deepEqual(ctx.remediation.map((event) => [event.mechanismId, event.outcome, event.triggerReason]),
      [["ui.health_events_refollow", "started", "stream_broken"], ["ui.health_events_refollow", "succeeded", undefined]]);
    await assertToldFirst(ctx);
  }

  // 3. Health's side resets the connection before the stream opens (the attached UI's 10-29 20:12 `fetch failed`):
  //    followed again (stream_not_opened -> succeeded). The stream's request also never rides a pooled keep-alive
  //    socket: a request made just before on the client's pool does not carry it.
  {
    const ctx = await app();
    await ctx.client.getStatus();
    const connectionsBefore = await new Promise((resolve) => ctx.api.server.getConnections((error, count) => resolve(count)));
    ctx.breakNextUiEvents();
    ctx.controller.followHealth();
    await until(() => ctx.remediation.some((event) => event.outcome === "succeeded"), "the stream to be followed again");
    assert.deepEqual(ctx.remediation.map((event) => [event.outcome, event.triggerReason]),
      [["started", "stream_not_opened"], ["succeeded", undefined]]);
    assert.equal(ctx.uiEventsRequests(), 2);
    const connectionsAfter = await new Promise((resolve) => ctx.api.server.getConnections((error, count) => resolve(count)));
    assert.equal(connectionsAfter, connectionsBefore + 1, "the stream has a connection of its own");
    await assertToldFirst(ctx);
  }

  // 4. Health stops answering (it died): the follow again fails, the operation records it, and nothing loops -- the
  //    bootstrap follows the Health it restarts.
  {
    const ctx = await app();
    ctx.controller.followHealth();
    await until(() => ctx.uiEventsRequests() === 1, "the first follow");
    await sleep(50);
    ctx.api.server.close();
    ctx.resetAllConnections();
    await until(() => ctx.remediation.some((event) => event.outcome === "failed"), "the follow again to fail");
    await sleep(200);
    assert.deepEqual(ctx.remediation.map((event) => [event.outcome, event.triggerReason]),
      [["started", "stream_broken"], ["failed", undefined]]);
    assert.match(ctx.remediation[1].detail.error, /ECONNREFUSED/);
    ctx.controller.stopFollowingHealth();
  }

  // 5. Health ends the stream itself without announcing (a network handoff restart): not a break, no record; the
  //    bootstrap follows the restarted Health. The UI's own close ends the stream without a record either.
  {
    const ctx = await app();
    ctx.controller.followHealth();
    await until(() => ctx.uiEventsRequests() === 1, "the first follow");
    await sleep(50);
    await ctx.api.close();
    await sleep(200);
    assert.deepEqual(ctx.remediation, []);
    assert.equal(ctx.uiEventsRequests(), 1);
    assert.equal(ctx.isQuit(), false);
  }
  delete process.env.STOCK_MONITOR_CONTROLLER_TOKEN_FILE;
  console.log("health ui-events follow contract ok");
})().catch((error) => { console.error(error); process.exit(1); });
