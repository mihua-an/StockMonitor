"use strict";

// electron-builder afterPack: compile every Python file the installer ships, with the Python it ships.
//
// Without it, the first start of an installed App compiled about 4,500 modules (the App's own code and most of
// site-packages: the staging drops __pycache__) in each of the four Python services at once -- measured 3.0-3.7 s
// per service import instead of 1.2-1.3 s, and the 19.5 s "Python Process 建立" a fresh install showed (user 11-12).
// The files are compiled "checked-hash": a .pyc is valid while its source's hash matches, whatever the file times the
// installer gives them, so an installed App never recompiles them. -f rewrites the timestamp .pyc files the build's
// own runs of the staged Python left behind.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// The Python trees under resources/app-runtime (package.json build.extraResources).
const TREES = ["main.py", "api", "backend", "config", "service", path.join("python", "Lib", "site-packages")];

function compileBytecode(runtime) {
  const python = path.join(runtime, "python", "python.exe");
  if (!fs.existsSync(python)) throw new Error(`compile_bytecode: the staged Python is missing at ${python}`);
  const targets = TREES.filter((tree) => fs.existsSync(path.join(runtime, tree)));
  if (targets.length !== TREES.length) {
    throw new Error(`compile_bytecode: missing under ${runtime}: ${TREES.filter((t) => !targets.includes(t)).join(", ")}`);
  }
  const started = Date.now();
  const result = spawnSync(python, ["-I", "-m", "compileall", "-q", "-f", "-j", "0", "--invalidation-mode", "checked-hash", ...targets],
    { cwd: runtime, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`compile_bytecode: could not run ${python}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`compile_bytecode: compileall exited ${result.status}\n${String(result.stdout || "").slice(-4000)}${String(result.stderr || "").slice(-4000)}`);
  }
  console.log(`[compile_bytecode] ${targets.join(", ")} compiled in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

exports.default = async function afterPack(context) {
  compileBytecode(path.join(context.appOutDir, "resources", "app-runtime"));
};
exports.compileBytecode = compileBytecode;
exports.TREES = TREES;
