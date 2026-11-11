"use strict";
// _waitForHealthStartup counted 480 attempts, each a request of up to 1.5 s plus a 0.25 s pause, so
// its nominal 120 s could stretch to ~14 minutes. It now holds one wall-clock deadline, request timeouts included.
const assert = require("node:assert/strict");
const { AppLifecycleController } = require("../ui/main/app_lifecycle_controller.js");

(async () => {
  const timeouts = [];
  const slowHealth = {
    // A Health that never answers inside the request timeout it is given.
    getStartupStatus: (timeoutMs) => new Promise((resolve) => { timeouts.push(timeoutMs); setTimeout(() => resolve(null), timeoutMs); }),
  };
  const started = Date.now();
  const result = await AppLifecycleController.prototype._waitForHealthStartup.call(
    { controllerClient: slowHealth }, "backend", { timeoutMs: 1200, intervalMs: 50 });
  const elapsed = Date.now() - started;
  assert.equal(result.status, "timeout");
  assert.ok(elapsed < 1200 + 400, `the deadline holds (${elapsed} ms)`);
  assert.ok(timeouts.every((ms) => ms <= 1200), "no request outlives the deadline");

  const readyHealth = { getStartupStatus: async () => ({ attempt: { generation: 1, health_instance: "h" },
    services: { provider_futu: { status: "ready", pid: 7, attempt: 1 } } }) };
  const ready = await AppLifecycleController.prototype._waitForHealthStartup.call({ controllerClient: readyHealth }, "futu");
  assert.equal(ready.status, "ready");

  // Attached to a Health that outlived an earlier UI, a "ready" of that boot's attempt is not this
  // UI's; the wait holds until the attempt the UI asked for (by number, never by wall clock) settles.
  let polls = 0;
  const attachedHealth = { getStartupStatus: async () => (++polls < 4
    ? { attempt: { generation: 1, health_instance: "h" }, services: { provider_futu: { status: "ready", pid: 7, attempt: 1 } } }
    : { attempt: { generation: 2, health_instance: "h" }, services: { provider_futu: { status: "ready", pid: 8, attempt: 2 } } }) };
  const fresh = await AppLifecycleController.prototype._waitForHealthStartup.call(
    { controllerClient: attachedHealth, healthBootstrap: { expectedStartupAttempt: () => ({ instance: "h", generation: 2 }) } },
    "futu", { timeoutMs: 3000, intervalMs: 10 });
  assert.deepEqual([fresh.status, fresh.pid, polls], ["ready", 8, 4], "the earlier boot's ready is not taken");
  // Another Health's outcomes are never this UI's.
  const other = { getStartupStatus: async () => ({ attempt: { generation: 2, health_instance: "other" },
    services: { provider_futu: { status: "ready", pid: 9, attempt: 2 } } }) };
  const foreign = await AppLifecycleController.prototype._waitForHealthStartup.call(
    { controllerClient: other, healthBootstrap: { expectedStartupAttempt: () => ({ instance: "h", generation: 2 }) } },
    "futu", { timeoutMs: 200, intervalMs: 10 });
  assert.equal(foreign.status, "timeout");
  console.log("health startup wait deadline contract ok");
})().catch((error) => { console.error(error); process.exit(1); });
