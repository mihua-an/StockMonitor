"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// A restart's readiness and its shutdown are about the Health process that restart spawned. Here the first restarted
// Health exits for another planned restart before it is ready: its restart must not read the next Health's "ready"
// as its own, and must not send the next Health a shutdown meant for the unready one.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHealthBootstrap, PLANNED_RESTART_EXIT } = require("../ui/main/health_bootstrap.js");

// The stand-in Health: run N reads its behaviour from runs.json, writes its endpoint record and answers /health.
const FAKE_HEALTH = `
"use strict";
const fs = require("fs"); const http = require("http"); const path = require("path");
const root = path.resolve(__dirname, "..");
const counter = path.join(root, "run_count");
const run = (Number(fs.existsSync(counter) ? fs.readFileSync(counter, "utf8") : 0) || 0) + 1;
fs.writeFileSync(counter, String(run));
const plan = JSON.parse(fs.readFileSync(path.join(root, "runs.json"), "utf8"))[run - 1] || { phase: "ready" };
const log = (line) => fs.appendFileSync(path.join(root, "events.log"), JSON.stringify({ run, pid: process.pid, ...line }) + "\\n");
const server = http.createServer((req, res) => {
  const send = (body) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url === "/health") return send({ ok: true, protocol: "stock-monitor-controller-v2", pid: process.pid, instance_id: "h-" + run, phase: plan.phase });
  if (req.url === "/control/shutdown") { log({ shutdown: true }); send({ ok: true }); return setTimeout(() => process.exit(0), 50); }
  send({ ok: false });
});
server.listen(Number(plan.port), "127.0.0.1", () => {
  fs.mkdirSync(path.join(root, "var", "config", "bootstrap"), { recursive: true });
  fs.writeFileSync(path.join(root, "var", "config", "bootstrap", "health_endpoint.json"),
    JSON.stringify({ schema: "stock-monitor-health-endpoint-v1", pid: process.pid, host: "127.0.0.1", port: server.address().port }));
  log({ listening: server.address().port });
  if (plan.exitAfterMs) setTimeout(() => process.exit(plan.exitCode), plan.exitAfterMs);
});
`;

(async () => {
  const root = makeTempDir("health-restart-identity-");
  fs.mkdirSync(path.join(root, "health"), { recursive: true });
  fs.mkdirSync(path.join(root, "ui", "main"), { recursive: true });
  fs.writeFileSync(path.join(root, "health", "main.js"), FAKE_HEALTH);
  const portBase = 41000 + Math.floor(Math.random() * 2000);
  fs.writeFileSync(path.join(root, "runs.json"), JSON.stringify([
    { port: portBase, phase: "ready", exitAfterMs: 1500, exitCode: PLANNED_RESTART_EXIT },        // the first Health
    { port: portBase, phase: "starting", exitAfterMs: 1500, exitCode: PLANNED_RESTART_EXIT },     // never ready, restarts again
    { port: portBase, phase: "ready" },                                                          // the one that stays
  ]));
  const tokenFile = path.join(root, "controller_auth_token");
  fs.writeFileSync(tokenFile, "c".repeat(40));
  const previous = process.env.STOCK_MONITOR_CONTROLLER_TOKEN_FILE;
  process.env.STOCK_MONITOR_CONTROLLER_TOKEN_FILE = tokenFile;
  const env = { ...process.env, STOCK_MONITOR_VAR_ROOT: path.join(root, "var") };
  const restarted = [];
  const bootstrap = createHealthBootstrap({ isPackaged: false, resourcesPath: "", uiMainDir: path.join(root, "ui", "main"),
    healthBaseUrl: `http://127.0.0.1:${portBase}`, env, execPath: process.execPath, logger: { log() {}, warn() {}, error() {} } });
  bootstrap.onRestarted(({ reason }) => restarted.push(reason));
  const events = () => (fs.existsSync(path.join(root, "events.log"))
    ? fs.readFileSync(path.join(root, "events.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
  try {
    assert.equal(await bootstrap.start(15000), true);
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !restarted.length) await new Promise((resolve) => setTimeout(resolve, 200));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const seen = events();
    const third = seen.find((e) => e.run === 3 && e.listening);
    assert.ok(third, `the third Health started: ${JSON.stringify(seen)}`);
    assert.ok(!seen.some((e) => e.run === 3 && e.shutdown), "the Health that stays is never sent the unready one's shutdown");
    assert.deepEqual(restarted, ["planned_restart"], "announced once, for the restart whose own Health became ready");
  } finally {
    bootstrap.markShuttingDown();
    const pids = [...new Set(events().map((e) => e.pid))];
    for (const pid of pids) { try { process.kill(pid); } catch (_error) { /* not an error: already gone */ } }
    // The fake Healths hold files under root until they are gone: wait for that before the directory is removed.
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_error) { /* not an error: gone */ return false; } };
    const gone = Date.now() + 10000;
    while (pids.some(alive) && Date.now() < gone) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(pids.filter(alive), [], "every fake Health exited");
    if (previous === undefined) delete process.env.STOCK_MONITOR_CONTROLLER_TOKEN_FILE; else process.env.STOCK_MONITOR_CONTROLLER_TOKEN_FILE = previous;
  }
  console.log("health bootstrap restart identity contract passed");
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
