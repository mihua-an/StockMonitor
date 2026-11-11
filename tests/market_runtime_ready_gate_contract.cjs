"use strict";
// 10-22 (Codex 1022-ST-02, ST-06): the renderer's /live connection waited for nothing but the two APIs, so on a cold
// start it connected while Market Runtime was still replaying its WAL and then retried (the startup order says a
// component starts only once what it needs is READY). It now asks Electron main, which waits for Health's
// market_runtime outcome within A's own start limit; and the start-all the UI waits for is never shorter than the
// recovery Health still lets A run.
const assert = require("node:assert/strict");
const budget = require("../config/js/startup_budget.js");
const { AppLifecycleController } = require("../ui/main/app_lifecycle_controller.js");

(async () => {
  assert.ok(budget.START_ALL_TIMEOUT_MS > budget.MARKET_RUNTIME_START_MAX_MS,
    "start-all outlasts A's longest start (it was 15 min against A's 20 min recovery)");
  assert.equal(budget.MARKET_RUNTIME_START_MAX_MS, budget.MARKET_RUNTIME_FIRST_ANSWER_MS + budget.MARKET_RUNTIME_RECOVERY_LIMIT_MS);

  const controller = new AppLifecycleController({ electron: {}, logger: { error: () => {} } });
  const waits = [];
  const answers = [{ status: "failed", detail: "market_runtime: WAL scan did not finish" }, { status: "ready" }];
  controller._waitForHealthStartup = async (name, options) => {
    waits.push([name, options.timeoutMs]);
    return answers.shift();
  };
  assert.deepEqual(await controller.marketRuntimeReady(), { status: "failed", detail: "market_runtime: WAL scan did not finish" });
  assert.deepEqual(await controller.marketRuntimeReady(), { status: "ready", detail: "" }, "a failed start is asked again");
  assert.deepEqual(await controller.marketRuntimeReady(), { status: "ready", detail: "" });
  assert.equal(waits.length, 2, "a ready answer is kept: later windows do not wait again");
  assert.deepEqual(waits[0], ["market_runtime", budget.MARKET_RUNTIME_START_MAX_MS], "waits on A within A's own limit");

  const shared = new AppLifecycleController({ electron: {}, logger: { error: () => {} } });
  let release;
  let calls = 0;
  shared._waitForHealthStartup = () => { calls += 1; return new Promise((resolve) => { release = resolve; }); };
  const first = shared.marketRuntimeReady();
  const second = shared.marketRuntimeReady();
  release({ status: "ready" });
  assert.deepEqual(await Promise.all([first, second]), [{ status: "ready", detail: "" }, { status: "ready", detail: "" }]);
  assert.equal(calls, 1, "callers that come together share one wait");
  console.log("market runtime ready gate contract passed");
})().catch((error) => { console.error(error); process.exit(1); });
