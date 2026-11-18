"use strict";
// Electron main's small JSON files go through the one atomic writer and the one object reader
// (service/platform/js/atomic_files.js):
//  * the forced-quit marker is written by the process that is being forced to quit: a plain writeFileSync could
//    leave the next start a marker cut short; it is a temp file renamed into place;
//  * the saved window state and the config lock owner are read by readJsonObject: an array or a number is not a
//    record and is said so in the log, never taken as one.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ShutdownController, forcedQuitMarkerDir } = require("../ui/main/shutdown_controller.js");
const { readWindowState } = require("../ui/main/main_window_state.js");
const { readJsonObject } = require("../service/platform/js/atomic_files.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "main-json-files-"));
const warn = console.warn;
const warnings = [];
console.warn = (...args) => warnings.push(args.map(String).join(" "));
try {
  const env = { STOCK_MONITOR_VAR_ROOT: path.join(root, "var") };
  const calls = [];
  const tracked = { ...fs };
  for (const name of ["writeFileSync", "renameSync"]) tracked[name] = (...args) => { calls.push([name, path.basename(String(args[0]))]); return fs[name](...args); };
  const controller = new ShutdownController({ electron: {}, node: { fs: tracked, path, processRef: { env, pid: 4321, platform: process.platform } },
    logger: { log() {}, warn() {}, error() {} }, quitWatchdog: {} });
  controller.writeForcedQuitMarker("hard_exit", 1500);
  const marker = path.join(forcedQuitMarkerDir(env), "hard_exit-4321.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")).kind, "hard_exit");
  assert.ok(!calls.some(([name, file]) => name === "writeFileSync" && file === "hard_exit-4321.json"), "the marker is never written in place");
  assert.ok(calls.some(([name, file]) => name === "renameSync" && file.startsWith("hard_exit-4321.json.")), "it is renamed into place");

  const state = path.join(root, "window_state.json");
  fs.writeFileSync(state, "[1, 2]");
  assert.deepEqual(readWindowState(state), {}, "an array is not a saved window state");
  assert.ok(warnings.some((w) => /saved window state.*not a JSON object/.test(w)), "and that is logged");
  fs.writeFileSync(state, JSON.stringify({ realtime: { width: 900 } }));
  assert.deepEqual(readWindowState(state), { realtime: { width: 900 } });
  assert.deepEqual(readWindowState(path.join(root, "absent.json")), {});
  assert.equal(readJsonObject(path.join(root, "absent.json")), null);
} finally {
  console.warn = warn;
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("main json files contract ok");
