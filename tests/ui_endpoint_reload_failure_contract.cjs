"use strict";
// A window whose reload rejects (loadFile() reports failure by rejecting) is not counted as reloaded:
// reloadForEndpointChange awaits every load and names the failed window, and the endpoint rediscovery is recorded as
// failed with that window's identity.
const assert = require("node:assert/strict");

const { createApiEndpoints } = require("../ui/main/api_endpoints.js");
const networkConfig = require("../config/js/network_config.js");

(async () => {
  // The window side: one window loads, one rejects (synchronously-throwing file lookup counts as a failure too).
  const { reloadWindowPages } = require("../ui/main/desktop_windows.js");
  const win = (id, outcome) => ({ id, loadFile: () => (outcome === "ok" ? Promise.resolve() : Promise.reject(new Error("ERR_FILE_NOT_FOUND"))) });
  const realError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await reloadWindowPages([[win(1, "ok"), "index.html"], [win(2, "fail"), "trade_window.html"], [win(3, "ok"), "broken.html"]],
      (page) => { if (page === "broken.html") throw new Error("no release"); return `/release/${page}`; });
  } finally { console.error = realError; }
  assert.deepEqual(result, { windows: 3, reloaded: 1, failed: [
    { page: "trade_window.html", window_id: 2, error: "ERR_FILE_NOT_FOUND" },
    { page: "broken.html", window_id: 3, error: "no release" },
  ] });

  // The endpoint side: a listener reporting a failed window makes the rediscovery outcome "failed" with its identity.
  const records = [];
  const endpoints = createApiEndpoints({ logger: { log() {}, warn() {}, error() {} }, setTimer: () => null,
    remediation: () => ({ emit: (event) => records.push(event) }) });
  const seed = networkConfig.rendererProjection(networkConfig.resolve(networkConfig.loadManifest(), { env: {} }));
  await endpoints.refreshFromHealth({ getNetworkEffective: async () => ({ ok: true, renderer: seed, revision: 1, health_instance_id: "h-1", effective: true }) }, "startup");
  endpoints.onChange(async () => ({ windows: 2, reloaded: 1, failed: [{ page: "trade_window.html", window_id: 2, error: "ERR_FILE_NOT_FOUND" }] }));
  const changed = await endpoints.refreshFromHealth({ getNetworkEffective: async () => ({ ok: true, renderer: seed, revision: 2, health_instance_id: "h-2", effective: true }) }, "health_restart");
  assert.equal(changed, true, "another Health instance: the windows rebind");
  const record = records.at(-1);
  assert.equal(record.mechanismId, "ui.endpoint_rediscovery");
  assert.equal(record.outcome, "failed", "a window still on the old addresses fails the rediscovery");
  assert.deepEqual(record.detail.failed_windows, [{ page: "trade_window.html", window_id: 2, error: "ERR_FILE_NOT_FOUND" }]);

  // All windows reloaded: succeeded.
  endpoints.onChange(async () => ({ windows: 1, reloaded: 1, failed: [] }));
  const ok = createApiEndpoints({ logger: { log() {}, warn() {}, error() {} }, setTimer: () => null, remediation: () => ({ emit: (event) => records.push(event) }) });
  ok.onChange(async () => ({ windows: 1, reloaded: 1, failed: [] }));
  await ok.refreshFromHealth({ getNetworkEffective: async () => ({ ok: true, renderer: seed, revision: 1, health_instance_id: "h-1", effective: true }) }, "startup");
  await ok.refreshFromHealth({ getNetworkEffective: async () => ({ ok: true, renderer: seed, revision: 2, health_instance_id: "h-2", effective: true }) }, "health_restart");
  assert.equal(records.at(-1).outcome, "succeeded");
  assert.equal(records.at(-1).detail.failed_windows, undefined);
  console.log("endpoint reload failure contract passed (CX-116)");
})().catch((error) => { console.error(error); process.exit(1); });
