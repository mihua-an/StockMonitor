"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// One training job across Health instances: the runner only knew its own in-memory child, so a Health restarted after
// a crash started a second job while the first one still ran. The job's owner record (pid + OS creation time) is on
// disk before the job is told to start, and a later Health starts nothing while that exact process runs.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { createTrainingJobRunner } = require("../health/training_job_runner.js");

function fakeChild(pid) {
  const child = new EventEmitter();
  Object.assign(child, { pid, exitCode: null, stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { written: null, end(data = "") { this.written = data; } }) });
  child.finish = (result) => {
    child.stdout.emit("data", Buffer.from(`${JSON.stringify(result)}\n`));
    child.exitCode = 0;
    child.emit("exit", 0);
  };
  return child;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

(async () => {
  const projectRoot = makeTempDir("training-owner-");
  const dataRoot = path.join(projectRoot, "data");
  const requests = path.join(dataRoot, "model", "online_training", "requests");
  const ownerFile = path.join(dataRoot, "model", "online_training", "job.owner.json");
  fs.mkdirSync(requests, { recursive: true });
  const request = (id) => fs.writeFileSync(path.join(requests, `${id}.json`), "{}");
  // The machine: which pids run, and when each was created.
  const alive = new Map();
  const events = [];
  const errors = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args) => errors.push(args.join(" "));
  console.warn = () => {};
  let nextPid = 500;
  const killed = [];
  const health = (extra = {}) => {
    const spawned = [];
    const runner = createTrainingJobRunner({ platform: "linux",
      projectRoot, dataRoot, pythonExecutable: "python.exe", analysisRuntimeBinary: () => "B.exe", securityMaster: "m.csv",
      logDir: path.join(projectRoot, "logs"), fs, path, logger: { warn() {} }, env: () => ({}), settledFile: path.join(projectRoot, "none.json"),
      remediation: { emit: (event) => events.push(event) },
      processAlive: (pid) => alive.has(Number(pid)),
      createdMsAsync: async (pid) => (alive.has(Number(pid)) ? alive.get(Number(pid)) : null),
      terminateTree: async (pid) => { killed.push(pid); alive.delete(Number(pid)); return true; },
      spawnImpl: (_file, args) => { const child = fakeChild(nextPid++); alive.set(child.pid, 7000 + child.pid); spawned.push({ args, child }); return child; },
      ...extra,
    });
    return { runner, spawned };
  };

  // The record is on disk -- this exact process -- before the job is told to start.
  const first = health();
  request("manual-1");
  first.runner.tick();
  assert.strictEqual(first.spawned.length, 1);
  const job = first.spawned[0];
  assert.ok(job.args.includes("--start-gate"), "the job waits for Health's start");
  assert.strictEqual(job.child.stdin.written, null, "not started before its owner record exists");
  await flush();
  const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
  assert.deepStrictEqual([owner.job_id, owner.child_pid, owner.child_created_ms], ["manual-1", job.child.pid, 7000 + job.child.pid]);
  assert.strictEqual(job.child.stdin.written, "start\n");
  fs.rmSync(path.join(requests, "manual-1.json"));   // the job takes its request once its status is written

  // Health crashes (the runner is gone, its job keeps running) and a new Health starts with a request waiting.
  request("manual-2");
  const second = health();
  second.runner.tick();
  await flush();
  second.runner.tick();
  await flush();
  assert.strictEqual(second.spawned.length, 0, "no second job while the first one's exact process runs");
  assert.strictEqual(second.runner.probe().running.job_id, "manual-1");
  assert.strictEqual(second.runner.probe().running.adopted, true);
  assert.deepStrictEqual(events.map((e) => [e.mechanismId, e.outcome, Boolean(e.detail.kept)]), [["training.owner_recovered", "succeeded", true]],
    "kept once, not every poll");

  // It ends: its record is released and the waiting request starts.
  alive.delete(job.child.pid);
  second.runner.tick();
  assert.strictEqual(second.spawned.length, 1, "the waiting request starts once the earlier job is gone");
  assert.ok(second.spawned[0].args.includes("manual-2"));
  assert.strictEqual(events.at(-1).detail.released, "its process is gone");
  await flush();
  assert.strictEqual(JSON.parse(fs.readFileSync(ownerFile, "utf8")).job_id, "manual-2");
  second.spawned[0].child.finish({ ok: true, state: "SUCCEEDED" });
  assert.ok(!fs.existsSync(ownerFile), "a job that ended takes its record with it");

  // A record whose pid now names another process (created at another time) is released.
  fs.writeFileSync(ownerFile, JSON.stringify({ instance: "training-old", job_id: "manual-x", child_pid: 900, child_created_ms: 1, started_at: new Date().toISOString() }));
  alive.set(900, 2);
  request("manual-3");
  const third = health();
  third.runner.tick();
  await flush();
  assert.strictEqual(third.spawned.length, 1, "the pid was reused: the earlier job is gone");
  assert.strictEqual(events.at(-1).detail.released, "its pid names another process");
  third.spawned[0].child.finish({ ok: true, state: "SUCCEEDED" });

  // Alive but unverifiable, or a record that cannot be read: nothing starts, reported once.
  fs.writeFileSync(ownerFile, JSON.stringify({ instance: "training-old", job_id: "manual-y", child_pid: 901, child_created_ms: 5, started_at: new Date().toISOString() }));
  alive.set(901, null);
  request("manual-4");
  const fourth = health();
  for (let i = 0; i < 3; i += 1) { fourth.runner.tick(); await flush(); }
  assert.strictEqual(fourth.spawned.length, 0);
  assert.match(fourth.runner.probe().owner_problem, /cannot be read to verify it/);
  assert.strictEqual(errors.filter((e) => e.includes("manual-y")).length, 1, errors.join(" | "));
  assert.strictEqual(events.at(-1).outcome, "failed");
  fs.writeFileSync(ownerFile, "{\"instance\": \"tr");
  fourth.runner.tick();
  assert.strictEqual(fourth.spawned.length, 0, "a damaged record is not read as no job");
  assert.match(fourth.runner.probe().owner_problem, /unreadable/);

  // A full shutdown ends the earlier job it kept, as its own.
  fs.writeFileSync(ownerFile, JSON.stringify({ instance: "training-old", job_id: "manual-z", child_pid: 902, child_created_ms: 9, started_at: new Date().toISOString() }));
  alive.set(902, 9);
  const fifth = health();
  fifth.runner.tick();
  await flush();
  assert.strictEqual(fifth.runner.probe().running.job_id, "manual-z");
  const receipt = await fifth.runner.stopAndWait(100);
  assert.deepStrictEqual([receipt.ok, receipt.interrupted.job_id, killed.at(-1)], [true, "manual-z", 902]);
  assert.ok(!fs.existsSync(ownerFile));
  assert.strictEqual(events.at(-1).mechanismId, "health.forced_termination");

  // A job whose process cannot be named (its creation time unknown) is never told to start.
  for (const name of fs.readdirSync(requests)) fs.rmSync(path.join(requests, name));
  const sixth = health({ createdMsAsync: async () => null });
  request("manual-5");
  sixth.runner.tick();
  await flush();
  assert.strictEqual(sixth.spawned[0].child.stdin.written, "", "stdin closed without start: the job exits untouched");
  assert.ok(!fs.existsSync(ownerFile));

  console.error = originalError;
  console.warn = originalWarn;
  fs.rmSync(projectRoot, { recursive: true, force: true });
  console.log("training job owner contract passed");
})().catch((error) => { process.stderr.write(`${error?.stack || error}
`); process.exit(1); });
