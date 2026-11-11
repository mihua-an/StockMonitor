"use strict";
// 11-07 01:34 a full shutdown answered ok:false and health.log had only `shutdown complete ok=false`: the receipts went
// to the caller (whose script printed 200 bytes of them) and the handoff record, which the next shutdown overwrote, so
// what made it false could not be told afterwards. Health now logs each receipt that is not ok, with its reason.
// The same night a shutdown asked for while Health was still starting its services (01:49, two sessions restarting
// the App a few seconds apart) found start_all finishing after it and then starting the watcher, the materializer
// and the training runner beside the shutdown.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "health", "main.js"), "utf8");

// logFailedReceipts, run as written in main.js with a recording warn().
const match = source.replace(/\r\n/g, "\n").match(/\n  function logFailedReceipts\(scope, receipts, failed\) \{[\s\S]*?\n  \}\n/);
assert.ok(match, "main.js defines logFailedReceipts");
const warned = [];
// eslint-disable-next-line no-new-func
const logFailedReceipts = new Function("warn", `${match[0]}; return logFailedReceipts;`)((line) => warned.push(line));
logFailedReceipts("full", {
  app_api: { ok: true },
  market_runtime: { ok: false, error: "refusing to stop an unverified occupant" },
  materializer_jobs: { ok: false, stopped: false, still_running: [4242] },
}, ["market_runtime", "materializer_jobs"]);
assert.equal(warned.length, 2, "one line per receipt that is not ok");
assert.match(warned[0], /shutdown full: market_runtime not ok: refusing to stop an unverified occupant/);
assert.match(warned[1], /shutdown full: materializer_jobs not ok: .*still_running.*4242/, "a receipt without an error is logged as it is");

// Both shutdown scopes that report receipts log the failed ones before answering.
const perform = source.slice(source.indexOf("async function performShutdown"), source.indexOf("function logFailedReceipts"));
const fullReturn = perform.indexOf("return { ok: failed.length === 0, scope, receipts, failed_services: failed");
assert.ok(fullReturn > 0 && perform.lastIndexOf("logFailedReceipts(scope, receipts, failed)", fullReturn) > 0, "the full shutdown logs its failed receipts");
const backendReturn = perform.indexOf("return { ok: Object.values(receipts).every((r) => r?.ok !== false), scope, receipts, retained }");
assert.ok(backendReturn > 0 && perform.lastIndexOf("logFailedReceipts(scope, receipts", backendReturn) > 0, "the ui_backend shutdown logs its failed receipts");

// After start_all: a shutdown already under way starts nothing more.
const afterStart = source.slice(source.indexOf('log(`startup: ${'));
const guard = afterStart.indexOf("if (shuttingDown || supervisor.stopping)");
assert.ok(guard > 0, "the startup checks for a shutdown under way");
for (const call of ["supervisor.watch();", "materializerJobs.start();", "trainingJobs.start();"]) {
  const at = afterStart.indexOf(call);
  assert.ok(at > guard, `${call} only runs when no shutdown is under way`);
}
assert.ok(afterStart.slice(guard, afterStart.indexOf("supervisor.watch();")).includes("return;"), "the startup ends there");

console.log("health shutdown receipts logged contract: ok");
