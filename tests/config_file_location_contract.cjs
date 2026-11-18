"use strict";
// config/*.json is found next to the module that reads it (config/js/../<file>), in a checkout and inside the packaged
// app alike (build.files carries config/*.json with config/js). A second rule that preferred
// <STOCK_MONITOR_RESOURCES_PATH>/app-runtime/config could read another copy than the one beside the code.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "config-location-"));
const previous = process.env.STOCK_MONITOR_RESOURCES_PATH;
try {
  const other = path.join(root, "app-runtime", "config");
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, "network_manifest.json"), "{}");
  fs.writeFileSync(path.join(other, "source_settings.json"), "{}");
  process.env.STOCK_MONITOR_RESOURCES_PATH = root;
  const networkConfig = require("../config/js/network_config.js");
  const { loadSourceSettings } = require("../config/js/source_settings.js");
  const configDir = path.resolve(__dirname, "..", "config");
  assert.deepEqual(networkConfig.loadManifest(), JSON.parse(fs.readFileSync(path.join(configDir, "network_manifest.json"), "utf8")),
    "the manifest beside the code, not the {} elsewhere");
  assert.ok(loadSourceSettings({}), "the source settings beside the code load (the {} elsewhere is invalid)");
} finally {
  if (previous === undefined) delete process.env.STOCK_MONITOR_RESOURCES_PATH; else process.env.STOCK_MONITOR_RESOURCES_PATH = previous;
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("config file location contract ok");
