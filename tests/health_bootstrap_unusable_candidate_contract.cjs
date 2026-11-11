"use strict";
// A restarted Health that never answers healthy is not left running: the restart ends it, its exit is the next
// (budgeted) restart, and that one recovers. Here the first Health asks for a planned restart, the second one stays
// alive without ever listening, the third is ready.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHealthBootstrap, PLANNED_RESTART_EXIT } = require("../ui/main/health_bootstrap.js");

const FAKE_HEALTH = `
"use strict";
const fs = require("fs"); const http = require("http"); const path = require("path");
const root = path.resolve(__dirname, "..");
const counter = path.join(root, "run_count");
const run = (Number(fs.existsSync(counter) ? fs.readFileSync(counter, "utf8") : 0) || 0) + 1;
fs.writeFileSync(counter, String(run));
const plan = JSON.parse(fs.readFileSync(path.join(root, "runs.json"), "utf8"))[run - 1] || { phase: "ready" };
fs.appendFileSync(path.join(root, "events.log"), JSON.stringify({ run, pid: process.pid }) + "\\n");
if (plan.silent) { setInterval(() => {}, 1000); return; }
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(req.url === "/health" ? { ok: true, protocol: "stock-monitor-controller-v2", pid: process.pid, instance_id: "h-" + run, phase: plan.phase } : { ok: false }));
});
server.listen(Number(plan.port), "127.0.0.1", () => {
  fs.mkdirSync(path.join(root, "var", "config", "bootstrap"), { recursive: true });
  fs.writeFileSync(path.join(root, "var", "config", "bootstrap", "health_endpoint.json"),
    JSON.stringify({ schema: "stock-monitor-health-endpoint-v1", pid: process.pid, host: "127.0.0.1", port: server.address().port }));
  if (plan.exitAfterMs) setTimeout(() => process.exit(plan.exitCode), plan.exitAfterMs);
});
`;

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_error) { /* not an error: ESRCH is the answer "gone" */ return false; } };

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "health-unusable-candidate-"));
  fs.mkdirSync(path.join(root, "health"), { recursive: true });
  fs.mkdirSync(path.join(root, "ui", "main"), { recursive: true });
  fs.writeFileSync(path.join(root, "health", "main.js"), FAKE_HEALTH);
  const port = 43000 + Math.floor(Math.random() * 2000);
  fs.writeFileSync(path.join(root, "runs.json"), JSON.stringify([
    { port, phase: "ready", exitAfterMs: 1000, exitCode: PLANNED_RESTART_EXIT },
    { port, silent: true },
    { port, phase: "ready" },
  ]));
  const tokenFile = path.join(root, "controller_auth_token");
  fs.writeFileSync(tokenFile, "c".repeat(40));
  const previous = process.env.STOCK_MONITOR_CONTROLLER_TOKEN_FILE;
  process.env.STOCK_MONITOR_CONTROLLER_TOKEN_FILE = tokenFile;
  const env = { ...process.env, STOCK_MONITOR_VAR_ROOT: path.join(root, "var") };
  const restarted = [];
  const outcomes = [];
  const bootstrap = createHealthBootstrap({ isPackaged: false, resourcesPath: "", uiMainDir: path.join(root, "ui", "main"),
    healthBaseUrl: `http://127.0.0.1:${port}`, env, execPath: process.execPath, logger: { log() {}, warn() {}, error() {} },
    restartHealthyMs: { planned: 2000, crash: 10000 } });
  bootstrap.setRemediation({ begin: ({ mechanismId, triggerReason }) => ({ finish: (outcome, { detail }) => outcomes.push({ mechanismId, triggerReason, outcome, stage: detail?.stage }) }) });
  bootstrap.onRestarted(({ reason }) => restarted.push(reason));
  const events = () => (fs.existsSync(path.join(root, "events.log"))
    ? fs.readFileSync(path.join(root, "events.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
  try {
    assert.equal(await bootstrap.start(15000), true);
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline && !restarted.length) await new Promise((resolve) => setTimeout(resolve, 200));
    const silent = events().find((e) => e.run === 2);
    assert.ok(silent, "the silent candidate was spawned");
    assert.equal(alive(silent.pid), false, "the candidate that never answered healthy was ended");
    assert.deepEqual(restarted, ["crash_recovery"], "the next restart recovered and was announced");
    assert.deepEqual(outcomes.map((o) => [o.triggerReason, o.outcome, o.stage]),
      [["planned_restart", "failed", "healthy"], ["unexpected_exit", "succeeded", "ready"]]);
  } finally {
    bootstrap.markShuttingDown();
    const pids = events().map((e) => e.pid);
    for (const pid of pids) { try { process.kill(pid); } catch (_error) { /* not an error: already gone */ } }
    // The test ends when its event loop does: exiting while a killed child's process handle is still closing
    // aborts Node on Windows (UV_HANDLE_CLOSING in async.c), so wait until every fake Health is gone.
    const goneBy = Date.now() + 10000;
    while (pids.some(alive) && Date.now() < goneBy) await new Promise((resolve) => setTimeout(resolve, 50));
    if (previous === undefined) delete process.env.STOCK_MONITOR_CONTROLLER_TOKEN_FILE; else process.env.STOCK_MONITOR_CONTROLLER_TOKEN_FILE = previous;
  }
  console.log("health bootstrap unusable candidate contract passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
