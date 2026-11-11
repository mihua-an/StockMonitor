"use strict";
// A history folder change saved in 設定 → 資料儲存 is applied by Health at the next full start. On 2026-10-22 a move
// across drives (15 GB, ~2 min) ran synchronously before the control API listened: the desktop's authenticated health
// check timed out and the App ended with "Health 服務未能啟動" while Health went on moving. Now the control API
// listens first, no service starts until the switch is done, and the startup screen shows its progress. The long copy
// runs beside the App, after start-all, and never reaches /status/startup.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Supervisor } = require("../health/supervisor.js");
const { AppLifecycleController } = require("../ui/main/app_lifecycle_controller.js");

const quiet = { log() {}, warn() {}, error() {} };

(async () => {
  // health/main.js: the hold is set before the control API listens; the move runs after it and before start-all.
  const source = fs.readFileSync(path.join(__dirname, "..", "health", "main.js"), "utf8");
  const hold = source.indexOf("supervisor.holdStarts(");
  const listen = source.indexOf('timeline.stage("control_listen"');
  const move = source.indexOf("await applyPendingStorageLocation()");
  const startAll = source.indexOf('supervisor.startAll("startup"');
  assert.ok(hold > 0 && listen > 0 && move > 0 && startAll > 0, "the startup steps are where this contract looks for them");
  assert.ok(hold < listen && listen < move && move < startAll, "hold, listen, move, start-all -- in that order");
  assert.ok(source.indexOf("releaseStarts()", move) > move, "the hold is released after the move");
  const background = source.indexOf("startStorageBackgroundMove({");
  assert.ok(background > startAll, "the background copy begins after the services started, so it cannot hold them");
  assert.ok(!/onProgress/.test(source.slice(background, source.indexOf("\n", source.indexOf("advanceBackgroundMove(", background)))), "the copy's progress goes to the journal, not /status/startup (the desktop waits while that is set)");
  // B is built before the folder may switch: its folders are resolved when it starts, not captured here.
  assert.match(source, /eventsDir: \(\) => storagePaths/);
  assert.match(source, /dailySummaryDir: \(\) => storagePaths[^\n]*\n\s*securityMaster/);

  // The renderer has no clock of its own: on 11-09 it gave up at ~100 s of a start Electron was still waiting out, and
  // stayed on an error page after the backend came up.
  const rendererApp = fs.readFileSync(path.join(__dirname, "..", "ui", "renderer", "app.js"), "utf8");
  assert.ok(rendererApp.includes("await waitForInitialBackendReady();"), "the gate waits for Electron's ready or failed");
  assert.ok(!/source: "timeout"/.test(rendererApp), "the gate cannot end in a timeout of its own");
  assert.ok(source.includes('"storage.rename_retry"'), "a rename retried by the switch reaches the remediation ledger");

  // Supervisor: every start waits for the hold -- start-all and a single ensure alike.
  const started = [];
  const host = (sid) => ({ ensure: async () => { started.push(sid); return { pid: 1 }; }, stop: async () => ({ ok: true }) });
  const supervisor = new Supervisor({ entries: { a: { host: host("a"), autostart: true }, b: { host: host("b"), autostart: true, after: ["a"] } },
    logger: quiet });
  let release;
  supervisor.holdStarts(new Promise((resolve) => { release = resolve; }));
  const all = supervisor.startAll("startup");
  const single = supervisor.ensure("a", "control request");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(started, [], "nothing starts while the move holds the starts");
  assert.equal(supervisor.reasonOf("a"), "waiting for the history folder move");
  release();
  const results = await all;
  await single;
  assert.ok(results.a.ok && results.b.ok, "both start once released");
  assert.deepEqual([...new Set(started)].sort(), ["a", "b"]);
  assert.equal(supervisor.startHold, null, "the hold clears itself");

  // Desktop: while Health reports the move, the services' wait does not count down and the progress is passed on;
  // the move here outlasts the wait's own budget several times over.
  let polls = 0;
  const moving = { to: "D:\\LM_STK", state: "copying", bytes_done: 1, bytes_total: 2, files_done: 1, files_total: 2 };
  const health = { getStartupStatus: async () => (++polls <= 12
    ? { attempt: { generation: 0, health_instance: "h" }, services: {}, storage_move: moving }
    : { attempt: { generation: 1, health_instance: "h" }, services: { app_api: { status: "ready", pid: 5, attempt: 1 },
      realtime_api: { status: "ready", pid: 6, attempt: 1 } }, storage_move: null }) };
  const seen = [];
  const result = await AppLifecycleController.prototype._waitForHealthStartup.call(
    { controllerClient: health, healthBootstrap: { expectedStartupAttempt: () => ({ instance: "h", generation: 1 }) } },
    "backend", { timeoutMs: 60, intervalMs: 20, onStorageMove: (move) => seen.push(move) });
  assert.equal(result.status, "ready", "a move longer than the budget is waited out");
  assert.equal(seen.length, 12);
  assert.equal(seen[0].to, "D:\\LM_STK");

  // A Health that stops answering mid-move is not waited for forever.
  const gone = { getStartupStatus: async () => null };
  const lost = await AppLifecycleController.prototype._waitForHealthStartup.call({ controllerClient: gone }, "backend", { timeoutMs: 60, intervalMs: 20 });
  assert.equal(lost.status, "timeout");
  console.log("health storage move startup contract ok");
})().catch((error) => { console.error(error); process.exit(1); });
