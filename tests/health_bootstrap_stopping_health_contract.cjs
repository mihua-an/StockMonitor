"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// The bootstrap attached to a Health that answered /health while shutting down (stopping: true), and
// the UI then waited on services that were being stopped. A stopping Health is now waited out, never attached to.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createHealthBootstrap } = require("../ui/main/health_bootstrap.js");

(async () => {
  const root = makeTempDir("health-stopping-");
  const tokenFile = path.join(root, "controller_auth_token");
  const token = "s".repeat(40);
  fs.writeFileSync(tokenFile, token);
  let startAllCalls = 0;
  const server = http.createServer((request, response) => {
    const send = (status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    if (request.url === "/health") return send(200, { ok: true, protocol: "stock-monitor-controller-v2", pid: 5151, stopping: true });
    if (request.url === "/control/start-all") { startAllCalls += 1; return send(200, { ok: true, results: {} }); }
    return send(404, { ok: false });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const previous = process.env.STOCK_MONITOR_CONTROLLER_TOKEN_FILE;
  process.env.STOCK_MONITOR_CONTROLLER_TOKEN_FILE = tokenFile;
  const env = { ...process.env, STOCK_MONITOR_VAR_ROOT: path.join(root, "var") };
  const logs = [];
  try {
    const recordDir = path.join(root, "var", "config", "bootstrap");
    fs.mkdirSync(recordDir, { recursive: true });
    fs.writeFileSync(path.join(recordDir, "health_endpoint.json"), JSON.stringify({ schema: "stock-monitor-health-endpoint-v1", pid: 5151, host: "127.0.0.1", port }));
    const bootstrap = createHealthBootstrap({ isPackaged: false, resourcesPath: "", uiMainDir: path.join(__dirname, "..", "ui", "main"),
      healthBaseUrl: `http://127.0.0.1:${port}`, env, execPath: "never-run", logger: { log: (line) => logs.push(line), warn() {}, error() {} } });
    // The old Health finishes its shutdown shortly after the new UI arrives.
    setTimeout(() => server.close(), 600);
    const started = bootstrap.start(200).catch((error) => error);
    const result = await started;
    assert.equal(startAllCalls, 0, "a stopping Health is never asked to start its services");
    assert.ok(logs.some((line) => line.includes("is shutting down")), logs.join("\n"));
    // After it is gone a new Health is spawned; here the spawn target does not exist, so start() reports that.
    assert.ok(result instanceof Error || result === true);
  } finally {
    if (previous === undefined) delete process.env.STOCK_MONITOR_CONTROLLER_TOKEN_FILE; else process.env.STOCK_MONITOR_CONTROLLER_TOKEN_FILE = previous;
    try { server.close(); } catch (_error) {}
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("health bootstrap stopping health contract ok");
})().catch((error) => { console.error(error); process.exit(1); });
