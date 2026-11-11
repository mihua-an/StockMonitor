"use strict";
// A startup wait is bounded by wall-clock time, its budget from the unit registry: slow heartbeat requests do not
// stretch it, and each request is given only what is left. Before, "32 x 250 ms" counted attempts, so 32 requests of
// 800 ms each made an 8 s budget last over 30 s.
const assert = require("node:assert/strict");
const { StartupCoordinator, STARTUP_UNITS } = require("../ui/main/startup_lifecycle");

(async () => {
  const coordinator = new StartupCoordinator({ electronPid: 1, logger: { log() {}, warn() {}, error() {} } });
  const timeouts = [];
  const slowHeartbeat = async (timeoutMs) => {
    timeouts.push(timeoutMs);
    await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 600)));
    return { response: { ok: true }, payload: {} };
  };
  const started = Date.now();
  const attached = await coordinator.waitForHeartbeat(slowHeartbeat, () => false, { budgetMs: 2000 });
  const elapsed = Date.now() - started;
  assert.equal(attached, false);
  assert.ok(elapsed < 2300, `the wait ended within its budget (${elapsed} ms)`);
  assert.ok(timeouts.every((t) => t <= 800) && timeouts.at(-1) < 800, `the last request got only what was left: ${timeouts}`);

  // A condition met is answered at once.
  assert.equal(await coordinator.waitUntil(async () => true, { budgetMs: 1000 }), true);
  // Every unit that waits has its budget in the registry, and every display threshold is there too.
  for (const id of ["shioaji_attach", "live_ingress", "moomoo_attach", "futu_catalog_refresh"]) {
    assert.ok(STARTUP_UNITS.find((u) => u.id === id).wait_ms > 0, id);
  }
  assert.throws(() => coordinator._waitBudget("first_paint"), /no wait_ms budget/);
  coordinator.stop();
  console.log("startup wait budget contract passed");
})().catch((error) => { console.error(error); process.exit(1); });
