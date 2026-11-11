"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// The JavaScript clients of Market Runtime against the REAL daemon binary, whose WebSocket
// server now enforces RFC 6455 (masked client frames, no RSV bits, valid control frames; close 1002 otherwise) and
// reassembles fragmented messages.
//   - Health's controller client: health/services/market_runtime_host.js control() -- Node's WebSocket, header auth
//   - the renderer: Chromium's WebSocket (market_data/realtime.js) holding no credential; Electron main adds the
//     viewer's Authorization header to the handshake (ui/main/client_auth.js). Run in Electron
// The Python clients (websockets) are covered by tests/test_rust_event_sink_ack.py and the other RuntimeProcess tests,
// Rust B's client by native/analysis_runtime/tests/b_end_to_end.rs. STOCK_MONITOR_A_RELEASE names a freshly built
// pair while the deployed one is locked by the running App.
const assert = require("node:assert/strict");
const crypto = require("node:crypto"), fs = require("node:fs"), net = require("node:net"), os = require("node:os"), path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { MarketRuntimeHost } = require("../health/services/market_runtime_host");
const { marketRuntimeExe, electronExe } = require("./support/native_binaries.cjs");

const ROOT = path.join(__dirname, "..");
const binary = marketRuntimeExe();
const electron = electronExe();

const tokens = { controller: "controller-token-0123456789abcdef", viewer: "viewer-token-0123456789abcdef" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function freePort() {
  return new Promise((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}
// Resolves true once the child has exited, false after `ms`; never keeps the test process alive on its own.
function exitWithin(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.off("exit", onExit); resolve(false); }, ms);
    function onExit() { clearTimeout(timer); resolve(true); }
    child.once("exit", onExit);
  });
}
// The stop Health uses (MarketRuntimeHost.stop: the controller's durable `shutdown`), then a bounded wait for the
// process to be gone; only a daemon that does not exit is killed, and a kill that does not end it is a failure.
async function stopDaemon(daemon, host) {
  if (daemon.exitCode !== null || daemon.signalCode !== null) return;
  try { await host.control("shutdown", {}, 20000, "shutdown.ack"); } catch (error) { console.error("[market_runtime shutdown] failed", error); }
  if (await exitWithin(daemon, 20000)) return;
  console.error(`[market_runtime shutdown] pid ${daemon.pid} still running after shutdown; killing it`);
  daemon.kill();
  if (!(await exitWithin(daemon, 5000))) throw new Error(`market_runtime pid ${daemon.pid} did not exit after kill`);
}
async function reachable(port, deadline) {
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => { const s = net.connect(port, "127.0.0.1", () => { s.destroy(); resolve(true); }); s.on("error", () => resolve(false)); });
    if (ok) return true;
    await sleep(50);
  }
  return false;
}

(async () => {
  const dir = makeTempDir("w6-a-ws-clients-");
  const credentials = path.join(dir, "credentials.json");
  fs.writeFileSync(credentials, JSON.stringify({ schema: "market-runtime-credentials-v1",
    roles: Object.fromEntries(Object.entries(tokens).map(([role, token]) => [role, crypto.createHash("sha256").update(token).digest("hex")])) }));
  const port = await freePort();
  const daemon = spawn(binary, ["--port", String(port), "--data-dir", path.join(dir, "a"), "--credentials", credentials, "--rollover", "off"],
    { stdio: "ignore", windowsHide: true });
  const host = new MarketRuntimeHost({ fs, path, projectRoot: ROOT, dataRoot: dir, configRoot: dir, logDir: dir, credentialsFile: credentials,
    controllerToken: tokens.controller, effective: { services: { market_runtime: { host: "127.0.0.1", port } } } });
  try {
    assert.ok(await reachable(port, Date.now() + 15000), "market_runtime did not start");
    // 1. Health's controller client, exactly as Health uses it.
    let health = null;
    for (let attempt = 0; attempt < 40 && health?.type !== "health"; attempt += 1) {
      health = await host.control("health", {}, 1500).catch(() => null);
      if (health?.type !== "health") await sleep(250);
    }
    assert.equal(health?.type, "health", "Health's Node WebSocket client is answered");
    const wrong = await new MarketRuntimeHost({ fs, path, projectRoot: ROOT, dataRoot: dir, configRoot: dir, logDir: dir, credentialsFile: credentials,
      controllerToken: tokens.viewer, effective: { services: { market_runtime: { host: "127.0.0.1", port } } } }).control("metrics", {}, 1500)
      .then((reply) => reply, (error) => ({ refused: String(error?.message || error) }));
    assert.ok(wrong.refused || wrong.type === "error", "a viewer credential cannot run a controller command");

    // 2. The renderer's Chromium WebSocket, its credential added by Electron main's webRequest hook, in Electron.
    {
      const appDir = path.join(dir, "renderer-client");
      fs.mkdirSync(appDir);
      fs.writeFileSync(path.join(appDir, "main.js"), `
const { app, BrowserWindow, session } = require("electron");
app.whenReady().then(async () => {
  let inject = false;
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ["ws://127.0.0.1/*"] }, (details, callback) => {
    const headers = { ...details.requestHeaders };
    if (inject) headers.Authorization = "Bearer ${tokens.viewer}";
    callback({ requestHeaders: headers });
  });
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  const done = (text) => { process.stdout.write("RESULT " + text + "\\n"); app.quit(); };
  setTimeout(() => done(JSON.stringify({ timeout: true })), 10000);
  await win.loadURL("data:text/html,<html></html>");
  const open = () => win.webContents.executeJavaScript(\`new Promise((resolve) => {
    const ws = new WebSocket("ws://127.0.0.1:${port}/live");
    const big = "x".repeat(200000);   // a client frame well past 64 KiB: Chromium sends it masked, unfragmented
    ws.onopen = () => { ws.send(JSON.stringify({ type: "health", pad: big })); };
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === "health") { ws.close(1000); resolve(JSON.stringify({ ok: true, protocol: ws.protocol })); } };
    ws.onerror = () => resolve(JSON.stringify({ error: true }));
  })\`);
  const without = JSON.parse(await open());
  inject = true;
  const withHeader = JSON.parse(await open());
  done(JSON.stringify({ without, withHeader }));
});`);
      const run = spawnSync(electron, [path.join(appDir, "main.js")], { encoding: "utf8", timeout: 30000, windowsHide: true });
      const line = String(run.stdout || "").split(/\r?\n/).find((l) => l.startsWith("RESULT "));
      assert.ok(line, `Electron produced no result: ${run.stderr || run.error || ""}`.slice(0, 400));
      const result = JSON.parse(line.slice("RESULT ".length));
      assert.deepEqual(result.without, { error: true }, "a page without the credential is refused");
      assert.deepEqual(result.withHeader, { ok: true, protocol: "" }, "the header Electron main adds authenticates the page's socket");
    }
    console.log("market_runtime WebSocket clients contract passed (Health Node client, renderer Chromium client)");
  } finally {
    // The data directory is removed only once the daemon holding it has exited.
    await stopDaemon(daemon, host);
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
