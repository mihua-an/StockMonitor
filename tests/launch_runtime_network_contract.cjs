"use strict";
// The launcher resolves the effective network once it has set the install flavor and VAR_ROOT in the env it was
// given: requiring it resolves nothing (a bad process-wide pin does not stop the require), and loadRuntime({env})
// reads that env's own config root -- a saved revision with a custom port there is what the runtime reports.
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.STOCK_MONITOR_NETWORK_REVISION = "999999";
const { loadRuntime } = require("../service/platform/js/launch_runtime.js");
delete process.env.STOCK_MONITOR_NETWORK_REVISION;
const { ConfigRevisionStore } = require("../config/js/config_revisions.js");

(async () => {
const varRoot = fs.mkdtempSync(path.join(os.tmpdir(), "launch-network-"));
try {
  const env = { ...process.env, STOCK_MONITOR_VAR_ROOT: varRoot };
  delete env.STOCK_MONITOR_PORT_OVERRIDES;
  delete env.STOCK_MONITOR_NETWORK_REVISION;
  const store = new ConfigRevisionStore(path.join(varRoot, "config"), "network");
  await store.save({ services: { realtime_api: { port: 28123 } } }, { source: "test", activate: true });

  const before = { ...process.env };
  const runtime = loadRuntime({ env, isPackaged: false });
  assert.equal(runtime.network.endpoint("realtime_api").port, 28123, "the saved revision under env's own config root");
  assert.equal(runtime.network.revision, 1);
  assert.match(runtime.network.controllerBaseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual({ ...process.env }, before, "the given env is used, not the process env");

  // A pin naming no revision is refused by loadRuntime, where the launcher reports it -- not at require time.
  assert.throws(() => loadRuntime({ env: { ...env, STOCK_MONITOR_NETWORK_REVISION: "7" }, isPackaged: false }), /names no saved network revision/);
  // A start override layers on top of the saved revision.
  const overridden = loadRuntime({ env: { ...env, STOCK_MONITOR_PORT_OVERRIDES: "realtime_api=28124" }, isPackaged: false });
  assert.equal(overridden.network.endpoint("realtime_api").port, 28124);
} finally {
  fs.rmSync(varRoot, { recursive: true, force: true });
}
console.log("launch runtime network contract ok");
})().catch((error) => { console.error(error); process.exit(1); });
