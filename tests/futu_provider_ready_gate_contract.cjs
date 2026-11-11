"use strict";
// The renderer's Futu product store asks Electron main for Health's provider_futu start outcome before its first
// /api/futu/* read (10-29: it read while the provider was still starting and logged FUTU_PROVIDER_UNAVAILABLE).
// Main waits on Health's "futu" startup unit within the whole start-all (the provider starts after Market Runtime),
// keeps a ready answer, asks again after a failed one, and is reachable from every page through the IPC contract.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const budget = require("../config/js/startup_budget.js");
const { AppLifecycleController } = require("../ui/main/app_lifecycle_controller.js");
const { CHANNELS } = require("../ui/main/ipc_contract.js");

(async () => {
  const controller = new AppLifecycleController({ electron: {}, logger: { error: () => {} } });
  const waits = [];
  const answers = [{ status: "timeout", detail: "Health startup status did not settle within timeout (provider_futu)" }, { status: "ready" }];
  controller._waitForHealthStartup = async (name, options) => {
    waits.push([name, options.timeoutMs]);
    return answers.shift();
  };
  assert.deepEqual(await controller.futuProviderReady(), { status: "timeout", detail: "Health startup status did not settle within timeout (provider_futu)" });
  assert.deepEqual(await controller.futuProviderReady(), { status: "ready", detail: "" }, "a start that did not settle is asked again");
  assert.deepEqual(await controller.futuProviderReady(), { status: "ready", detail: "" });
  assert.equal(waits.length, 2, "a ready answer is kept");
  assert.deepEqual(waits[0], ["futu", budget.START_ALL_TIMEOUT_MS], "waits on Health's futu unit within the start-all");

  // The Futu and Market Runtime outcomes are kept apart.
  const both = new AppLifecycleController({ electron: {}, logger: { error: () => {} } });
  const names = [];
  both._waitForHealthStartup = async (name) => { names.push(name); return { status: "ready" }; };
  await Promise.all([both.futuProviderReady(), both.marketRuntimeReady(), both.futuProviderReady()]);
  assert.deepEqual(names.sort(), ["futu", "market_runtime"]);

  assert.deepEqual(CHANNELS["startup:futu-provider"], CHANNELS["startup:market-runtime"], "an invoke every page may make");
  const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  assert.match(read("ui/main/preload.js"), /waitForFutuProvider: \(\) => ipcRenderer\.invoke\("startup:futu-provider"\)/);
  assert.match(read("ui/main/ipc_registration.js"), /router\.handle\("startup:futu-provider", \(\) => futuProviderReady\(\)\)/);
  assert.match(read("ui/main/desktop_application.js"), /futuProviderReady: \(\) => appLifecycle\.futuProviderReady\(\)/);
  console.log("futu provider ready gate contract passed");
})().catch((error) => { console.error(error); process.exit(1); });
