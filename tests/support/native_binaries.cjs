"use strict";
// The one place Node tests find the executables a contract runs. A missing one throws: a contract that could not
// run is a failure, never a pass. Rust follows tests/synthetic_runtime.py: STOCK_MONITOR_A_RELEASE names the
// release directory (<CARGO_TARGET_DIR>\release) of a build elsewhere, because the running App locks
// native\market_runtime\target\release. Python follows the product launcher (STOCK_MONITOR_PYTHON_EXECUTABLE,
// else the bundled interpreter, else `python` on PATH).
const fs = require("node:fs");
const path = require("node:path");
const { resolvePythonExecutable } = require("../../service/platform/js/launch_runtime");

const ROOT = path.join(__dirname, "..", "..");

function required(file, hint) {
  if (!fs.existsSync(file)) throw new Error(`${file} not found: ${hint}`);
  return file;
}

function marketRuntimeExe() {
  const release = process.env.STOCK_MONITOR_A_RELEASE || path.join(ROOT, "native", "market_runtime", "target", "release");
  return required(path.join(release, "market_runtime_daemon.exe"),
    "build it with `cargo build --release` in native/market_runtime, or set STOCK_MONITOR_A_RELEASE to <CARGO_TARGET_DIR>\\release");
}

function electronExe() {
  return required(path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"), "run `npm install`");
}

function pythonExe() {
  return resolvePythonExecutable(ROOT);
}

module.exports = { marketRuntimeExe, electronExe, pythonExe };
