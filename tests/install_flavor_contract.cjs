"use strict";
// The flavor is decided once, by the composition root, from whether this is the installed app.
// An inherited STOCK_MONITOR_INSTALL_FLAVOR that disagrees must not be kept, or AUTH_ROOT could follow the other
// flavor while userData followed this one.
const assert = require("node:assert/strict");
const { loadRuntime } = require("../service/platform/js/launch_runtime.js");
const { resolveAuthRoot, userDataDir } = require("../config/js/var_paths.js");

const warn = console.warn;
const warnings = [];
console.warn = (...args) => warnings.push(args.join(" "));
try {
  const env = { ...process.env, STOCK_MONITOR_INSTALL_FLAVOR: "installed" };
  delete env.STOCK_MONITOR_AUTH_ROOT;
  loadRuntime({ env, isPackaged: false });
  assert.equal(env.STOCK_MONITOR_INSTALL_FLAVOR, "source", "a source run is the source flavor whatever it inherited");
  assert.ok(warnings.some((w) => /inherited, but this is the source app/.test(w)), "and says so");
  assert.equal(resolveAuthRoot({ env }), resolveAuthRoot({ env: { ...env, STOCK_MONITOR_INSTALL_FLAVOR: "source" } }));
  assert.equal(userDataDir({ env }), userDataDir({ flavor: "source", env }));
} finally {
  console.warn = warn;
}
// Electron main's startup-errors file (written when even var_layout.json cannot be read) is in this flavor's
// userData: a source checkout's went to the installed app's folder.
{
  const path = require("node:path");
  const { loadVarLayout } = require("../config/js/var_paths.js");
  const { flavorOf } = require("../service/platform/js/launch_runtime.js");
  const { startupFallbackFile, FALLBACK_USER_DATA_DIR } = require("../ui/main/early_error_sink.js");
  const flavors = loadVarLayout().flavors;
  assert.deepEqual(Object.keys(FALLBACK_USER_DATA_DIR).sort(), Object.keys(flavors).sort());
  for (const [flavor, spec] of Object.entries(flavors)) assert.equal(FALLBACK_USER_DATA_DIR[flavor], spec.user_data_dir, flavor);
  const appData = path.resolve("AppData", "Roaming");
  assert.equal(startupFallbackFile({ appDataDir: appData, flavor: flavorOf(false) }),
    path.join(appData, flavors.source.user_data_dir, "startup_errors.log"));
  assert.equal(startupFallbackFile({ appDataDir: appData, flavor: flavorOf(true) }),
    path.join(appData, flavors.installed.user_data_dir, "startup_errors.log"));
}
console.log("install flavor contract ok");
