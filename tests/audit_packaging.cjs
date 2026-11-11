"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const { inspect, expected } = require(path.join(root, "scripts/diagnostics/audit_distribution.cjs"));

test("installed startup refuses before reading any runtime contract", () => {
  const { getProjectRoot } = require("../service/platform/js/launch_runtime");
  assert.throws(() => getProjectRoot({ isPackaged: true }), /PACKAGING_CONTRACT_INCOMPLETE/);
});

// Both need the Python runtime a release build stages: a fresh checkout has none.
const staged = { skip: fs.existsSync(path.join(root, "packaging/python/python.exe")) ? false : "packaging/python is not staged" };

test("builder proceeds once the staging contract is genuinely complete, still fails closed for a real gap", staged, async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json")));
  const hookPath = path.resolve(root, pkg.build.beforePack);
  // scripts/tooling/stage_python_runtime.py genuinely stages
  // packaging/python/ (verified: isolated from host site-packages, native
  // extension loads and starts, real FastAPI backend runs under it) -- the
  // repo's actual current state is a complete contract, not an incomplete
  // one, so the hook must resolve rather than reject.
  delete require.cache[hookPath];
  const hook = require(hookPath);
  await assert.doesNotReject(hook({}), "the staging contract is genuinely complete on disk; beforePack must not block it");

  // The fail-closed MECHANISM itself must still work for a genuinely
  // incomplete contract -- proven by actually removing one real, required
  // staged file (not a mock) and confirming the hook rejects, then
  // restoring it so this test leaves no side effect behind.
  const pythonExe = path.join(root, "packaging/python/python.exe");
  const displaced = `${pythonExe}.audit-test-displaced`;
  fs.renameSync(pythonExe, displaced);
  try {
    delete require.cache[hookPath];
    const hookWithRealGap = require(hookPath);
    await assert.rejects(hookWithRealGap({}), /PACKAGING_CONTRACT_INCOMPLETE/);
  } finally {
    fs.renameSync(displaced, pythonExe);
    delete require.cache[hookPath];
  }
});

test("staging inventory is itemized: every category has a real, structural verdict, not a marker-file check", staged, () => {
  const auditPackaging = require(path.join(root, "scripts/tooling/audit_packaging.cjs"));
  const { results, blocking, complete } = auditPackaging.inventory();
  assert.ok(results.length >= 8, "expected a real multi-category inventory, not a single opaque check");
  assert.equal(complete, true,
    "2026-09-20: the redistributable Python interpreter is now genuinely staged and verified "
    + "(scripts/tooling/stage_python_runtime.py) -- all 11 categories are satisfied on disk");
  assert.deepEqual(blocking, [], "no category should be blocking once the contract is genuinely complete");
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));

  // Every category is now genuinely staged.
  for (const id of ["electron_app", "runtime_contract", "python_entry_points", "python_dependency_lock",
    "python_environment_evidence", "market_runtime_binaries", "toolchain_evidence_current",
    "packaged_resource_manifest", "redistributable_python_interpreter", "shioaji_sdk"]) {
    assert.equal(byId[id]?.satisfied, true, `${id} should be satisfied by what's actually on disk`);
  }

  // Futu OpenD must be judged as an external runtime prerequisite (by
  // explicit security design), never as a missing staged resource.
  assert.equal(byId.futu_opend_sidecar?.status, "external_prerequisite");
  assert.equal(byId.futu_opend_sidecar?.satisfied, true);
});

test("toolchain evidence staleness is detected by real content comparison, not assumed", () => {
  const auditPackaging = require(path.join(root, "scripts/tooling/audit_packaging.cjs"));
  const { results } = auditPackaging.inventory();
  const toolchain = JSON.parse(fs.readFileSync(path.join(root, "requirements/toolchain-evidence.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const entry = results.find((r) => r.id === "toolchain_evidence_current");
  if (String(toolchain.electron) === String(pkg.devDependencies.electron)) {
    assert.equal(entry.satisfied, true, "evidence matches package.json -- should pass once regenerated");
  } else {
    assert.equal(entry.satisfied, false);
    assert.match(entry.detail, /stale/);
  }
});

test("audit_distribution.inspect reports no extra/missing for a clean expected-only fixture", () => {
  const dir = makeTempDir("audit-distribution-clean-");
  try {
    for (const name of expected) fs.writeFileSync(path.join(dir, name), "");
    const result = inspect(dir);
    assert.deepEqual(result.extra, []);
    assert.deepEqual(result.missing, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("audit_distribution.inspect flags an extra file and a missing entry, ignores dotfiles/.log", () => {
  const dir = makeTempDir("audit-distribution-dirty-");
  try {
    for (const name of expected) {
      if (name === "StockMonitor.zip") continue; // deliberately omitted -> missing
      fs.writeFileSync(path.join(dir, name), "");
    }
    fs.writeFileSync(path.join(dir, "test.py"), ""); // deliberately extra
    fs.writeFileSync(path.join(dir, ".hidden"), ""); // must be ignored
    fs.writeFileSync(path.join(dir, "stray.log"), ""); // must be ignored
    const result = inspect(dir);
    assert.deepEqual(result.extra, ["test.py"]);
    assert.deepEqual(result.missing, ["StockMonitor.zip"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("all load harness JavaScript parses (not runtime acceptance)", () => {
  for (const name of fs.readdirSync(path.join(root, "tests/load"))) {
    if (!/\.(?:js|cjs|mjs)$/.test(name)) continue;
    const result = spawnSync(process.execPath, ["--check", path.join(root, "tests/load", name)], { encoding: "utf8" });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
});
