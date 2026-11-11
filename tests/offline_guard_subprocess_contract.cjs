"use strict";
// The offline guard's subprocess allowance reads argv per interpreter: Python flags that skip sitecustomize.py
// (-S, -I, -E) and Node inline code are refused, and a permitted child always carries the guard's environment
// (PYTHONPATH led by the snapshot, the offline variables, NODE_OPTIONS --require guard) even when the contract
// hands it an empty one.
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// This contract drives the guard from outside; inside scripts/diagnostics/check_offline.py the guard is already
// loaded and refuses the launches this contract makes on purpose.
if (process.env.STOCK_MONITOR_OFFLINE_CHECK === "1") { console.log("offline guard subprocess contract: skipped (runs outside the offline check)"); process.exit(0); }
const root = path.resolve(__dirname, "..");
const guard = path.join(root, "scripts", "diagnostics", "offline_guard.cjs");
const probe = spawnSync(process.env.PYTHON || "python", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
if (probe.status !== 0) { console.log("offline guard subprocess contract: skipped (no python)"); process.exit(0); }
const python = probe.stdout.trim();

const child = String.raw`
const { spawnSync } = require("node:child_process");
const py = process.env.STOCK_MONITOR_OFFLINE_PYTHON;
const out = {};
const attempt = (name, file, args, options) => {
  try { const r = spawnSync(file, args, { encoding: "utf8", ...options }); out[name] = { ran: true, stdout: r.stdout, status: r.status }; }
  catch (error) { out[name] = { ran: false, error: String(error.message) }; }
};
attempt("S", py, ["-S", "-c", "print(1)"]);
attempt("I", py, ["-I", "-c", "print(1)"]);
attempt("E", py, ["-E", "-c", "print(1)"]);
attempt("Sc", py, ["-Sc", "print(1)"]);
attempt("X", py, ["-X", "dev", "-c", "print(1)"]);
attempt("outside", py, ["C:/elsewhere/x.py"]);
attempt("c", py, ["-c", "import os; print(os.environ.get('STOCK_MONITOR_OFFLINE_CHECK'), os.environ['PYTHONPATH'].split(os.pathsep)[0])"], { env: { SystemRoot: process.env.SystemRoot } });
attempt("node_e", process.execPath, ["-e", "1"]);
attempt("node_script", process.execPath, [process.argv[1]], { env: { SystemRoot: process.env.SystemRoot } });
process.stdout.write(JSON.stringify(out));
`;
const run = spawnSync(process.execPath, ["--require", guard, "-e", child, path.join(root, "tests", "support", "print_guard_env.cjs")], {
  cwd: root, encoding: "utf8",
  env: { ...process.env, STOCK_MONITOR_OFFLINE_ALLOW: "subprocess", STOCK_MONITOR_OFFLINE_PYTHON: python, STOCK_MONITOR_OFFLINE_CHECK: "1" },
});
assert.equal(run.status, 0, run.stderr);
const out = JSON.parse(run.stdout);
for (const refused of ["S", "I", "E", "Sc", "X", "outside", "node_e"]) {
  assert.equal(out[refused].ran, false, `${refused} must be refused: ${JSON.stringify(out[refused])}`);
  assert.match(out[refused].error, /Offline contract forbids/);
}
assert.equal(out.c.ran, true, JSON.stringify(out.c));
const [check, first] = out.c.stdout.trim().split(" ");
assert.equal(check, "1", "the offline variables reach a Python child given an empty environment");
assert.equal(path.resolve(first).toLowerCase(), root.toLowerCase(), "PYTHONPATH is led by the snapshot, where sitecustomize.py is");
assert.equal(out.node_script.ran, true, JSON.stringify(out.node_script));
const nodeEnv = JSON.parse(out.node_script.stdout);
assert.equal(nodeEnv.guard_loaded, true, `a Node child given an empty environment still loads the guard: ${JSON.stringify(nodeEnv)}`);
assert.equal(nodeEnv.STOCK_MONITOR_OFFLINE_CHECK, "1");
console.log("offline guard subprocess contract passed");
