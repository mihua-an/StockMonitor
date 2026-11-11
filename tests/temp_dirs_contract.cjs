"use strict";
// tests/support/temp_dirs.cjs: a test's temp directories are gone however its process ends, in Node and in
// Electron, and withEnv puts the environment back even when the body throws.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { makeTempDir, removeTempDir, withEnv } = require("./support/temp_dirs.cjs");

const helper = JSON.stringify(path.join(__dirname, "support", "temp_dirs.cjs"));
const electron = path.join(path.dirname(require.resolve("electron/package.json")), "dist", "electron.exe");

function run(command, args, body) {
  const script = path.join(makeTempDir("temp-dirs-script-"), "case.cjs");
  fs.writeFileSync(script, `const { makeTempDir } = require(${helper});\nconst dir = makeTempDir("temp-dirs-case-");\n`
    + `require("node:fs").writeFileSync(require("node:path").join(dir, "data.txt"), "x");\nconsole.log(dir);\n${body}\n`);
  const result = spawnSync(command, [...args, script], { encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
  const dir = result.stdout.trim().split(/\r?\n/)[0];
  assert.ok(dir, `${body}: the case printed no directory (${result.stderr})`);
  return { dir, status: result.status };
}

for (const [body, status] of [["", 0], ["throw new Error('assertion failed');", 1], ["process.exit(0);", 0],
  ["Promise.reject(new Error('async failure'));", 1]]) {
  const outcome = run(process.execPath, [], body);
  assert.equal(outcome.status, status, body);
  assert.equal(fs.existsSync(outcome.dir), false, `${body || "a passing test"}: ${outcome.dir} left behind`);
}

// Electron: userData given to the app is removed after app.exit, once Chromium has let go of it.
{
  const outcome = run(electron, [], "const { app } = require('electron'); app.setPath('userData', dir);"
    + " app.whenReady().then(() => app.exit(0));");
  assert.equal(outcome.status, 0);
  // removed by the detached cleanup once Electron's processes are gone: watched, with a bound
  const deadline = Date.now() + 30000;
  while (fs.existsSync(outcome.dir) && Date.now() < deadline) spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 100)"]);
  assert.equal(fs.existsSync(outcome.dir), false, `electron userData ${outcome.dir} left behind`);
}

// Only what makeTempDir made is removed.
assert.throws(() => removeTempDir(path.resolve(__dirname)), /not made by makeTempDir/);

(async () => {
  process.env.TEMP_DIRS_CONTRACT_KEEP = "kept";
  delete process.env.TEMP_DIRS_CONTRACT_NEW;
  await assert.rejects(withEnv({ TEMP_DIRS_CONTRACT_KEEP: "changed", TEMP_DIRS_CONTRACT_NEW: "added" }, async () => {
    assert.equal(process.env.TEMP_DIRS_CONTRACT_KEEP, "changed");
    throw new Error("body failed");
  }), /body failed/);
  assert.equal(process.env.TEMP_DIRS_CONTRACT_KEEP, "kept");
  assert.equal("TEMP_DIRS_CONTRACT_NEW" in process.env, false);
  console.log("temp_dirs_contract: ok");
})().catch((error) => { console.error(error); process.exit(1); });
