"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// Attaching to a running Health awaited /control/start-all -- which answered only after every
// stage had run -- with no timeout, and took any answer as success. Health answers at once with the
// attempt it began, and that attempt -- {health instance, generation} -- is what this UI's startup waits for.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createHealthBootstrap } = require("../ui/main/health_bootstrap.js");

(async () => {
  const root = makeTempDir("health-attach-");
  const tokenFile = path.join(root, "controller_auth_token");
  const token = "t".repeat(40);
  fs.writeFileSync(tokenFile, token);
  let accept = true;
  // Refuse this many start-all requests before accepting; every request's body is kept.
  let refuseFirst = 0;
  const bodies = [];
  const server = http.createServer(async (request, response) => {
    const send = (status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    if (request.headers.authorization !== `Bearer ${token}`) return send(401, { ok: false });
    if (request.url === "/health") return send(200, { ok: true, protocol: "stock-monitor-controller-v2", pid: 4242, instance_id: "health-a" });
    if (request.url === "/control/start-all") {
      let text = "";
      for await (const chunk of request) text += chunk;
      bodies.push(JSON.parse(text || "{}"));
      if (refuseFirst > 0) { refuseFirst -= 1; return send(503, { ok: false, error: "starting to stop" }); }
      if (!accept) return send(503, { ok: false, error: "shutting down" });
      return send(202, { ok: true, accepted: true, attempt: { generation: 3, health_instance: "health-a" } });
    }
    return send(404, { ok: false });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const env = { ...process.env, STOCK_MONITOR_VAR_ROOT: path.join(root, "var"), STOCK_MONITOR_CONTROLLER_TOKEN_FILE: tokenFile };
  const previous = process.env.STOCK_MONITOR_CONTROLLER_TOKEN_FILE;
  process.env.STOCK_MONITOR_CONTROLLER_TOKEN_FILE = tokenFile;
  const errors = [];
  try {
    const bootstrap = createHealthBootstrap({ isPackaged: false, resourcesPath: "", uiMainDir: path.join(__dirname, "..", "ui", "main"),
      healthBaseUrl: `http://127.0.0.1:${port}`, env, logger: { log() {}, warn() {}, error: (line) => errors.push(line) } });
    const recordDir = path.join(root, "var", "config", "bootstrap");
    fs.mkdirSync(recordDir, { recursive: true });
    fs.writeFileSync(path.join(recordDir, "health_endpoint.json"), JSON.stringify({ schema: "stock-monitor-health-endpoint-v1", pid: 4242, host: "127.0.0.1", port }));

    const started = await Promise.race([bootstrap.start(), new Promise((resolve) => setTimeout(() => resolve("blocked"), 2000))]);
    assert.equal(started, true, "attach returns without waiting for every stage");
    assert.deepEqual(bootstrap.expectedStartupAttempt(), { instance: "health-a", generation: 3 }, "the attempt Health began");

    accept = false;
    const again = createHealthBootstrap({ isPackaged: false, resourcesPath: "", uiMainDir: path.join(__dirname, "..", "ui", "main"),
      healthBaseUrl: `http://127.0.0.1:${port}`, env, logger: { log() {}, warn() {}, error: (line) => errors.push(line) } });
    // An attach whose start-all is refused every time fails -- it never reads an earlier boot's attempt as its own.
    await assert.rejects(again.start(), /did not accept a start-all/);
    assert.equal(again.expectedStartupAttempt(), null, "a start-all that was not accepted names no attempt");
    assert.ok(errors.some((line) => line.includes("was not accepted (HTTP 503)")), errors.join("\n"));

    // A start-all accepted on the second try: both tries carry the same request id, and the retry is recorded -- once
    // the remediation emitter exists (the attach runs before it is built).
    accept = true;
    refuseFirst = 1;
    bodies.length = 0;
    const third = createHealthBootstrap({ isPackaged: false, resourcesPath: "", uiMainDir: path.join(__dirname, "..", "ui", "main"),
      healthBaseUrl: `http://127.0.0.1:${port}`, env, logger: { log() {}, warn() {}, error() {} } });
    assert.equal(await third.start(), true);
    assert.equal(bodies.length, 2);
    assert.ok(bodies[0].request_id && bodies[0].request_id === bodies[1].request_id, JSON.stringify(bodies));
    const records = [];
    third.setRemediation({ begin: (event) => ({ finish: (outcome, extra) => records.push({ event, outcome, extra }) }) });
    assert.equal(records.length, 1);
    assert.equal(records[0].event.mechanismId, "health.attach_start_all_retry");
    assert.equal(records[0].outcome, "succeeded");
    assert.equal(records[0].extra.attempt, 2);
    assert.equal(records[0].extra.detail.first_error, "not accepted (HTTP 503)");
  } finally {
    if (previous === undefined) delete process.env.STOCK_MONITOR_CONTROLLER_TOKEN_FILE; else process.env.STOCK_MONITOR_CONTROLLER_TOKEN_FILE = previous;
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("health bootstrap attach start-all contract ok");
})().catch((error) => { console.error(error); process.exit(1); });
