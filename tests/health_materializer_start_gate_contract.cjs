"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// A materialization job does nothing until its owner record (pid + OS creation time) is durable: Health writes the
// record, then says "start" on the job's stdin. An owner record that cannot be written is a failed start -- the job is
// never told to start (its stdin closes), so a later Health can never find a claim whose process it cannot identify
// writing the historical store.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const root = makeTempDir("materializer-gate-");
const { loadVarLayout } = require("../config/js/var_paths.js");
process.env[loadVarLayout().root_env] = root;
const { createMaterializerJobRunner } = require("../health/materializer_job_runner.js");

const binary = path.join(root, "native", "analysis_runtime", "target", "release", "analysis_runtime.exe");
fs.mkdirSync(path.dirname(binary), { recursive: true });
fs.writeFileSync(binary, "");
const jobsDir = path.join(root, "output", "materialization_jobs");
const pending = path.join(jobsDir, "pending");
const claimed = path.join(jobsDir, "claimed");
fs.mkdirSync(pending, { recursive: true });
const request = { source: "shioaji", market: "STK", code: "*", trading_date: "2026-09-30", session: "DAY" };

function fakeChild(pid, events) {
  const child = new EventEmitter();
  Object.assign(child, { pid, stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false });
  child.kill = () => { child.killed = true; setImmediate(() => child.emit("exit", null)); };
  child.stdin = Object.assign(new EventEmitter(), { end: (data) => {
    // What the job sees at the moment it is told to start (or that its stdin closed).
    const owner = fs.existsSync(path.join(claimed, "job.owner.json")) ? JSON.parse(fs.readFileSync(path.join(claimed, "job.owner.json"), "utf8")) : null;
    events.push({ stdin: data ?? null, owner_pid: owner?.child_pid ?? null });
    // The job may already have ended: the write then fails as a stream error, which must not escape.
    setImmediate(() => child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));
  } });
  return child;
}

async function main() {
  // 1. The owner record is on disk, naming this process, before the job is told to start.
  fs.writeFileSync(path.join(pending, "job.json"), JSON.stringify(request));
  const events = [];
  let spawnedArgs = null;
  const runner = createMaterializerJobRunner({ binaryPath: path.join(root, "native", "analysis_runtime", "target", "release", "analysis_runtime.exe"), platform: "linux", projectRoot: root, dataRoot: path.join(root, "data"), fs, path,
    spawnImpl: (_cmd, args) => { spawnedArgs = args; return fakeChild(4242, events); }, createdMs: () => 1234,
    pollSeconds: 3600, logger: { error() {}, warn() {} }, maxConcurrent: 1 });
  runner.start();
  await new Promise((resolve) => setImmediate(resolve));  // the creation time is awaited before the owner record
  assert.ok(spawnedArgs.includes("--start-gate") && spawnedArgs[spawnedArgs.indexOf("--start-gate") + 1] === "stdin");
  assert.deepStrictEqual(events, [{ stdin: "start\n", owner_pid: 4242 }]);
  const owner = JSON.parse(fs.readFileSync(path.join(claimed, "job.owner.json"), "utf8"));
  assert.strictEqual(owner.child_started_ms, 1234, "the process's OS creation time, not Health's clock");
  runner.stop();
  await new Promise((resolve) => setImmediate(resolve));

  // 2. The owner record cannot be written: the job's stdin closes without "start" and the result is a failed start.
  fs.rmSync(jobsDir, { recursive: true, force: true });
  fs.mkdirSync(pending, { recursive: true });
  fs.writeFileSync(path.join(pending, "job.json"), JSON.stringify(request));
  const events2 = [];
  let child2 = null;
  const failingFs = { ...fs, renameSync: (from, to) => {
    if (String(to).endsWith("job.owner.json")) throw new Error("disk full");
    return fs.renameSync(from, to);
  } };
  const runner2 = createMaterializerJobRunner({ binaryPath: path.join(root, "native", "analysis_runtime", "target", "release", "analysis_runtime.exe"), platform: "linux", projectRoot: root, dataRoot: path.join(root, "data"), fs: failingFs, path,
    spawnImpl: () => { child2 = fakeChild(4343, events2); return child2; }, createdMs: () => 1,
    pollSeconds: 3600, logger: { error() {}, warn() {} }, maxConcurrent: 1 });
  runner2.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(events2, [{ stdin: null, owner_pid: null }], "stdin closed, never \"start\"");
  child2.stdout.emit("data", Buffer.from('{"ok":false,"status":"retryable","error":"not started"}\n'));
  child2.emit("exit", 1);
  const result = JSON.parse(fs.readFileSync(path.join(jobsDir, "done", "job.json"), "utf8"));
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /owner record not written: disk full/);
  runner2.stop();
  fs.rmSync(root, { recursive: true, force: true });
  console.log("health_materializer_start_gate_contract: ok");
}

main().catch((error) => { console.error(error); process.exit(1); });
