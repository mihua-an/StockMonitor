"use strict";
// Electron main hands out endpoints only as Health confirmed them -- the launch included. Not confirmed (launch, a
// Health restart, a failed read) is fenced: no URL, no credential origin and no CSP source for main or for a loading
// window. Health holds a read until its endpoints settle and the read is asked again until it does (no attempt
// budget); entering the fence after a confirmation tells the windows at once; another instance or revision behind the
// same URLs reloads the windows.
const assert = require("node:assert/strict");
const { createApiEndpoints } = require("../ui/main/api_endpoints.js");
const networkConfig = require("../config/js/network_config.js");

(async () => {
  const pauses = [];
  let closing = false;
  const endpoints = createApiEndpoints({ logger: { log() {}, warn() {}, error() {} }, isClosing: () => closing,
    sleep: async (ms) => { pauses.push(ms); } });
  const seed = networkConfig.rendererProjection(networkConfig.resolve(networkConfig.loadManifest(), { env: {} }));
  const reloads = [];
  endpoints.onChange((_p, reason) => reloads.push(reason));
  const effective = (over = {}) => ({ ok: true, renderer: seed, revision: 1, health_instance_id: "h-1", effective: true, ...over });
  // A Health that answers each read from a script: not settled for the first `pending` reads, then confirmed.
  const scripted = (answers) => {
    const waits = [];
    return { waits, getNetworkEffective: async (waitMs) => { waits.push(waitMs); return answers.length > 1 ? answers.shift() : answers[0]; } };
  };

  // Launch: nothing is handed out before Health has confirmed -- not even the resolver's own seed.
  assert.equal(endpoints.fenced(), true);
  assert.throws(() => endpoints.serviceUrl("realtime_api"), /not confirmed/);
  assert.deepEqual(endpoints.apiOrigins(), [], "no origin carries the client credential");
  assert.deepEqual(endpoints.connectSources(), [], "no CSP source");
  assert.deepEqual(endpoints.served().services, {});

  // Health answers before its endpoints settle: the first read returns at once, the rest are held reads (wait_ms),
  // asked again until Health confirms -- far past any fixed attempt count.
  const notSettled = effective({ effective: false, phase: "resuming_operation", operation: "op-1" });
  const health = scripted([...Array(40).fill(notSettled), effective()]);
  assert.equal(await endpoints.refreshFromHealth(health, "startup"), false);
  await endpoints.settled();
  assert.equal(health.waits[0], 0, "the first read is not held");
  assert.ok(health.waits.slice(1).every((w) => w > 0), "the following reads are held by Health");
  assert.equal(health.waits.length, 41);
  assert.deepEqual(pauses, [], "a Health that answers is never paced");
  assert.equal(endpoints.authority().status, "effective");
  assert.ok(endpoints.serviceUrl("realtime_api"));
  assert.ok(endpoints.apiOrigins().length > 0);
  assert.deepEqual(reloads, ["startup"], "the window that loaded while fenced is reloaded");

  // A Health restart: fenced at once (the windows are told), then rebound to the new instance though the URLs match.
  reloads.length = 0;
  let settle;
  const settledHealth = new Promise((resolve) => { settle = resolve; });
  let reads = 0;
  const restarted = { getNetworkEffective: async () => (reads++ === 0
    ? effective({ health_instance_id: "h-2", effective: false, phase: "starting", operation: "op-2" })
    : settledHealth) };
  assert.equal(await endpoints.refreshFromHealth(restarted, "health_restart"), false);
  assert.deepEqual(reloads, ["fenced: health_restart"], "entering the fence reloads the windows with no address");
  assert.deepEqual(endpoints.apiOrigins(), []);
  settle(effective({ health_instance_id: "h-2" }));
  await endpoints.settled();
  assert.equal(endpoints.fenced(), false);
  assert.deepEqual(reloads, ["fenced: health_restart", "health_restart"]);

  // An unreachable Health is paced (it answers at once with a refusal), still without an attempt budget.
  reloads.length = 0;
  pauses.length = 0;
  let refusals = 0;
  const flaky = { getNetworkEffective: async () => { if (refusals++ < 6) throw new Error("ECONNREFUSED"); return effective({ health_instance_id: "h-2" }); } };
  await endpoints.refreshFromHealth(flaky, "network_apply");
  assert.equal(endpoints.authority().status, "unavailable");
  await endpoints.settled();
  assert.deepEqual(pauses, [1000, 2000, 5000, 10000, 10000, 10000]);
  assert.equal(endpoints.authority().status, "effective");

  // A newer refresh takes over the older one's loop; the App closing ends a loop with an abandoned record.
  const records = [];
  const closingEndpoints = createApiEndpoints({ logger: { log() {}, warn() {}, error() {} }, isClosing: () => closing,
    sleep: async () => {}, remediation: () => ({ emit: (event) => records.push(event) }) });
  closing = false;
  const never = { getNetworkEffective: async () => { closing = true; return effective({ effective: false, phase: "starting" }); } };
  await closingEndpoints.refreshFromHealth(never, "health_restart");
  await closingEndpoints.settled();
  assert.equal(records.at(-1).outcome, "abandoned");
  console.log("ui api endpoints authority contract passed");
})().catch((error) => { console.error(error); process.exit(1); });
