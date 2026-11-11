"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// Health started every pending materialization job at once (each held the whole WAL),
// and stop() only cleared its timer, so jobs outlived Health and a restarted Health could run the same job twice.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const root = makeTempDir("materializer-jobs-");
const { loadVarLayout } = require("../config/js/var_paths.js");
process.env[loadVarLayout().root_env] = root;
const { createMaterializerJobRunner } = require("../health/materializer_job_runner.js");

// The job is Rust B's binary in its --materialize mode.
const binary = path.join(root, "native", "analysis_runtime", "target", "release", "analysis_runtime.exe");
fs.mkdirSync(path.dirname(binary), { recursive: true });
fs.writeFileSync(binary, "");
const pending = path.join(root, "output", "materialization_jobs", "pending");
fs.mkdirSync(pending, { recursive: true });
for (let i = 1; i <= 5; i += 1) {
  // job1's session evidence holds a connection outage during trading for two codes (gap_codes): only it says so.
  fs.writeFileSync(path.join(pending, `job${i}.json`), JSON.stringify({ source: "shioaji", market: "STK", code: "*",
    trading_date: "2026-09-30", session: "DAY", ...(i === 1 ? { gap_codes: ["2317", "2330"] } : {}),
    // job2 folds a closed session again from the historical store with its gaps' fills (history_fill.py).
    ...(i === 2 ? { fill: { fills_dir: "F:/fills/k", unresolved_codes: ["1802"] } } : {}) }));
}

const spawned = [];
const spawnedArgs = [];
function spawnImpl(command, args) {
  spawnedArgs.push({ command, args });
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; setImmediate(() => child.emit("exit", null)); };
  spawned.push(child);
  return child;
}

async function main() {
  const runner = createMaterializerJobRunner({ binaryPath: path.join(root, "native", "analysis_runtime", "target", "release", "analysis_runtime.exe"), platform: "linux", projectRoot: root, dataRoot: path.join(root, "data"), fs, path, spawnImpl,
    pollSeconds: 3600, logger: { error() {} }, maxConcurrent: 2 });
  runner.start();
  assert.strictEqual(spawned.length, 2, "at most two jobs run at once");
  // Not the release file a deploy replaces: a copy named by its content (service/platform/js/native_job_binary.js).
  const jobCopy = path.join(root, "state", "native_jobs", `analysis_runtime-${require("crypto").createHash("sha256").update("").digest("hex").slice(0, 16)}.exe`);
  assert.strictEqual(spawnedArgs[0].command, jobCopy, "the job runs its copy of Rust B's binary, never the release file");
  assert.ok(fs.existsSync(jobCopy), "the copy is on disk");
  assert.strictEqual(spawnedArgs[0].args[0], "--materialize", "in its one-shot materialization mode");
  const gapArgs = spawnedArgs.map(({ args }) => args.includes("--gap-codes") ? args[args.indexOf("--gap-codes") + 1] : null);
  assert.deepStrictEqual(gapArgs.sort(), ["2317,2330", null].sort(),
    "the codes with a connection outage go to the job; a job without any gets no --gap-codes");
  const value = (args, flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
  const fillJob = spawnedArgs.find(({ args }) => args.includes("--fills-dir"));
  assert.ok(fillJob, "the fill job was started");
  assert.deepStrictEqual([value(fillJob.args, "--input"), value(fillJob.args, "--fills-dir"), value(fillJob.args, "--unresolved-codes"),
    fillJob.args.includes("--data-dir")], ["store", "F:/fills/k", "1802", false], "a fill job reads the store with its fills, not the WAL");
  assert.ok(spawnedArgs.every(({ args }) => value(args, "--voided-events") === path.join(root, "data", "live-engine", "voided_events.json")),
    "every job leaves out Market Runtime's void events, whichever its input");
  const plain = spawnedArgs.find(({ args }) => !args.includes("--fills-dir"));
  assert.ok(plain.args.includes("--data-dir") && !plain.args.includes("--input"), "an ordinary job reads the WAL");
  assert.ok(spawnedArgs.every(({ args }) => value(args, "--volume-baseline-root") === path.join(root, "data", "market")),
    "every job publishes its session's volume baseline where Rust B reads it");
  assert.strictEqual(runner.probe().in_flight, 2);

  const stopped = runner.stop();
  assert.strictEqual(stopped.ended_jobs, 2, "stop ends the running jobs");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(spawned.every((child) => child.killed));
  assert.strictEqual(fs.readdirSync(pending).length, 5, "an ended job stays pending for the next Health");
  const done = path.join(root, "output", "materialization_jobs", "done");
  assert.ok(!fs.existsSync(done) || fs.readdirSync(done).length === 0, "and no result is written for it");
  // Full shutdown waits for the processes to be gone: a child that exits is released; one that does not is
  // reported, not hidden.
  const stuck = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 777, kill() {} });
  const runner2 = createMaterializerJobRunner({ binaryPath: path.join(root, "native", "analysis_runtime", "target", "release", "analysis_runtime.exe"), platform: "linux", projectRoot: root, dataRoot: path.join(root, "data"), fs, path,
    spawnImpl: () => stuck, pollSeconds: 3600, logger: { error() {}, warn() {} }, maxConcurrent: 1, killGraceMs: 10,
    execFileImpl: () => {} });
  runner2.start();
  assert.deepStrictEqual(runner2.childPids(), [777], "the running job's process, for 連線診斷 記憶體");
  const waited = await runner2.stopAndWait(200);
  assert.strictEqual(waited.ok, false, "a child that never exits fails the wait");
  assert.deepStrictEqual(waited.still_running, [777]);
  const runner3 = createMaterializerJobRunner({ binaryPath: path.join(root, "native", "analysis_runtime", "target", "release", "analysis_runtime.exe"), platform: "linux", projectRoot: root, dataRoot: path.join(root, "data"), fs, path, spawnImpl,
    pollSeconds: 3600, logger: { error() {} }, maxConcurrent: 1 });
  runner3.start();
  assert.strictEqual((await runner3.stopAndWait(1000)).ok, true, "a child that exits is waited for and released");
  assert.deepStrictEqual(runner3.childPids(), [], "no job running: no process");
  fs.rmSync(root, { recursive: true, force: true });
  console.log("health_materializer_jobs_contract: ok");
}

main().catch((error) => { console.error(error); process.exit(1); });
