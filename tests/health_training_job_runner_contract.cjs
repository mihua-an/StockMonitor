"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// Model training is a process Health starts -- after the close (auto) or on a request model_api left
// (manual) -- never a thread inside an API, so closing the UI and FastAPI does not interrupt it.
// When an auto attempt is due is the training domain's own ledger (schedule.json, written by the job): the
// fake job below writes it the way service/analysis/online_training/job.py does; Health keeps no retry timing.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { createTrainingJobRunner, taipeiClock } = require("../health/training_job_runner.js");

function fakeChild(pid) {
  const child = new EventEmitter();
  Object.assign(child, { pid, exitCode: null, stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { written: null, end(data = "") { this.written = data; } }) });
  child.finish = (result, code = 0) => {
    child.stdout.emit("data", Buffer.from(`log line\n${JSON.stringify(result)}\n`));
    child.exitCode = code;
    child.emit("exit", code);
  };
  child.kill = () => { child.exitCode = 1; child.emit("exit", 1); };
  return child;
}

(async () => {
  const projectRoot = makeTempDir("training-runner-");
  const dataRoot = path.join(projectRoot, "data");
  fs.mkdirSync(path.join(projectRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "config", "model_training.json"), JSON.stringify({
    schema: "model-training-v1", auto: { retry_minutes: 30, quiet: { from: "09:00", to: "13:30" } },
  }));
  let clock = new Date("2026-10-05T06:30:00Z"); // 14:30 Asia/Taipei
  let idle = true;
  const spawned = [];
  const ledgerFile = path.join(dataRoot, "model", "online_training", "schedule.json");
  const ledger = (entry) => { fs.mkdirSync(path.dirname(ledgerFile), { recursive: true }); fs.writeFileSync(ledgerFile, JSON.stringify(entry)); };
  // The session owner's settled notice (service/market/shared/materialization_jobs.py publish_settled_session).
  const settledFile = path.join(projectRoot, "output", "materialization_jobs", "settled", "shioaji.json");
  const settle = (date, status = "materialized") => {
    fs.mkdirSync(path.dirname(settledFile), { recursive: true });
    fs.writeFileSync(settledFile, JSON.stringify({ schema: "session-settled-v1", source: "shioaji",
      sessions: { "FUT:NIGHT": { trading_date: "2026-10-01", status: "materialized", settled_at: "2026-10-02T05:10:00+08:00" },
        "STK:DAY": { trading_date: date, status, settled_at: clock.toISOString() } } }));
  };
  // What the job records: an attempt when it starts (the next one due 30 min later); when it ends DONE, WAITING with
  // that due time (FAILED), or WAITING with none (NOT_READY: the next settled notice starts the next one).
  const jobLedger = (args, child) => {
    if (!args.includes("auto")) return;
    const date = args[args.indexOf("--trading-date") + 1];
    const attempts = (fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, "utf8")).attempts : 0) + 1;
    const nextDue = new Date(clock.getTime() + 30 * 60000).toISOString();
    ledger({ trading_date: date, attempts, state: "RUNNING", next_due_at: nextDue });
    const finish = child.finish;
    child.finish = (result, code) => {
      const done = result.state === "SUCCEEDED" || String(result.state).startsWith("SKIPPED");
      ledger({ trading_date: date, attempts, state: done ? "DONE" : "WAITING", finished_at: clock.toISOString(),
        next_due_at: result.state === "NOT_READY" ? null : nextDue });
      finish(result, code);
    };
  };
  const runner = createTrainingJobRunner({ platform: "linux",
    projectRoot, dataRoot, pythonExecutable: "python.exe", analysisRuntimeBinary: () => "B.exe", securityMaster: "master.csv", logDir: path.join(projectRoot, "logs"),
    fs, path, now: () => clock, materializerIdle: () => idle, logger: { warn() {} }, env: () => ({}), createdMsAsync: async (pid) => 1000 + pid, processAlive: () => false, settledFile,
    spawnImpl: (file, args, options) => { const child = fakeChild(100 + spawned.length); jobLedger(args, child); spawned.push({ file, args, options, child }); return child; },
  });

  assert.deepStrictEqual(taipeiClock(new Date("2026-10-05T06:31:00Z")), { date: "2026-10-05", hhmm: "14:31" });

  // No clock starts it: at 14:30 with the day not settled, nothing starts -- not even a NOT_READY attempt.
  runner.tick();
  assert.strictEqual(spawned.length, 0, "no settled notice yet");
  settle("2026-10-05", "failed");
  runner.tick();
  assert.strictEqual(spawned.length, 0, "a session that settled failed has nothing to train on");

  // Settled materialized, but the materializer is still running another job: still nothing.
  clock = new Date("2026-10-05T06:42:00Z");
  settle("2026-10-05");
  idle = false;
  runner.tick();
  assert.strictEqual(spawned.length, 0, "the materializer is still busy");

  // Idle: the auto job starts once, for the settled date, with B's binary for the feature export.
  idle = true;
  runner.tick();
  assert.strictEqual(spawned.length, 1);
  const auto = spawned[0];
  assert.deepStrictEqual(auto.args.slice(0, 4), ["-m", "service.analysis.online_training.job", "--mode", "auto"]);
  assert.ok(auto.args.includes("--trading-date") && auto.args.includes("2026-10-05"));
  assert.strictEqual(auto.options.env.STOCK_MONITOR_ANALYSIS_RUNTIME_EXE, "B.exe");
  assert.strictEqual(auto.args[auto.args.indexOf("--security-master") + 1], "master.csv", "the security master Health gives B");
  runner.tick();
  assert.strictEqual(spawned.length, 1, "one job at a time");

  // NOT_READY: no clock retry -- only a settled notice newer than that attempt starts another.
  auto.child.finish({ ok: true, state: "NOT_READY" });
  assert.strictEqual(runner.probe().last_result.state, "NOT_READY");
  clock = new Date("2026-10-05T08:00:00Z");
  runner.tick();
  assert.strictEqual(spawned.length, 1, "an hour later, the same notice: nothing");
  settle("2026-10-05");
  runner.tick();
  assert.strictEqual(spawned.length, 2, "settled again: the next attempt");

  // FAILED: retried retry_minutes later, not before.
  spawned[1].child.finish({ ok: false, state: "FAILED" });
  clock = new Date("2026-10-05T08:20:00Z");
  runner.tick();
  assert.strictEqual(spawned.length, 2, "not due yet");
  clock = new Date("2026-10-05T08:31:00Z");
  runner.tick();
  assert.strictEqual(spawned.length, 3, "retried 30 minutes later");

  // SUCCEEDED: done for the date.
  spawned[2].child.finish({ ok: true, state: "SUCCEEDED" });
  assert.strictEqual(runner.probe().schedule.state, "DONE");
  clock = new Date("2026-10-05T12:00:00Z");
  runner.tick();
  assert.strictEqual(spawned.length, 3);

  // The next day settles inside the TW day session (an App started mid-session catching up the close): it waits.
  clock = new Date("2026-10-06T02:00:00Z"); // 10:00 Asia/Taipei
  settle("2026-10-06");
  runner.tick();
  assert.strictEqual(spawned.length, 3, "no training starts during the day session");
  clock = new Date("2026-10-06T05:31:00Z"); // 13:31
  runner.tick();
  assert.strictEqual(spawned.length, 4, "after the session it starts");

  // An attempt that died without recording its end is still followed by one once the ledger says it is due.
  ledger({ trading_date: "2026-10-06", attempts: 1, state: "RUNNING", next_due_at: "2026-10-06T07:00:00.000Z" });
  spawned[3].child.exitCode = 0; spawned[3].child.emit("exit", 0);
  clock = new Date("2026-10-06T06:50:00Z");
  runner.tick();
  assert.strictEqual(spawned.length, 4, "not due yet");
  clock = new Date("2026-10-06T07:01:00Z");
  runner.tick();
  assert.strictEqual(spawned.length, 5, "due: the next attempt starts");
  spawned[4].child.finish({ ok: true, state: "SUCCEEDED" });

  // A damaged ledger stops auto starts (never read as "nothing attempted yet") and is reported once.
  fs.writeFileSync(ledgerFile, "{\"trading_date\": \"2026-10-07\", \"att");
  const damageErrors = [];
  const originalError = console.error;
  console.error = (...args) => damageErrors.push(args.join(" "));
  clock = new Date("2026-10-07T07:01:00Z");
  runner.tick();
  runner.tick();
  console.error = originalError;
  assert.strictEqual(spawned.length, 5, "a damaged schedule ledger starts nothing");
  assert.strictEqual(damageErrors.length, 1, damageErrors.join(" | "));
  assert.ok(runner.probe().schedule.damaged);
  ledger({ trading_date: "2026-10-06", attempts: 1, state: "DONE", next_due_at: "2026-10-06T07:00:00.000Z" });

  // A manual request is taken even after the day's auto run. The job removes it once its own status is written
  // (service/analysis/online_training/job.py), so it stays while the job starts; the runner does not drop it first.
  const requests = path.join(dataRoot, "model", "online_training", "requests");
  fs.mkdirSync(requests, { recursive: true });
  const request1 = path.join(requests, "manual-1.json");
  fs.writeFileSync(request1, "{}");
  runner.tick();
  assert.strictEqual(spawned.length, 6);
  assert.deepStrictEqual(spawned[5].args.slice(2, 6), ["--mode", "manual", "--job-id", "manual-1"]);
  assert.deepStrictEqual(spawned[5].args.slice(-2), ["--request-file", request1]);
  assert.ok(fs.existsSync(request1), "the request is the job's to remove once its status is on disk");
  runner.tick();
  assert.strictEqual(spawned.length, 6, "a request whose job runs is not started twice");

  // Full shutdown ends a running job and reports it as interrupted.
  const receipt = await runner.stopAndWait(200);
  assert.strictEqual(receipt.ok, true);
  assert.strictEqual(receipt.interrupted.job_id, "manual-1");
  assert.strictEqual(runner.probe().last_result.state, "INTERRUPTED");

  // A job that dies without a result line is a failure, never a success.
  const silent = createTrainingJobRunner({ platform: "linux",
    projectRoot, dataRoot, pythonExecutable: "python.exe", analysisRuntimeBinary: () => "B.exe", securityMaster: "master.csv", logDir: path.join(projectRoot, "logs"),
    fs, path, now: () => clock, logger: { warn() {} }, env: () => ({}), createdMsAsync: async (pid) => 1000 + pid, processAlive: () => false,
    spawnImpl: () => { const child = fakeChild(200); setImmediate(() => { child.exitCode = 3; child.emit("exit", 3); }); return child; },
  });
  fs.writeFileSync(path.join(requests, "manual-2.json"), "{}");
  silent.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(silent.probe().last_result.state, "FAILED");
  assert.ok(!fs.existsSync(path.join(requests, "manual-2.json")), "a job that ended before taking its request: removed here");

  // A request starts its job when the file appears, not on the next poll (an hour here).
  const watchedSpawns = [];
  const watched = createTrainingJobRunner({ platform: "linux",
    projectRoot, dataRoot: path.join(projectRoot, "watched"), pythonExecutable: "python.exe", analysisRuntimeBinary: () => "B.exe",
    logDir: path.join(projectRoot, "logs"), fs, path, now: () => clock, logger: { warn() {} }, env: () => ({}), createdMsAsync: async (pid) => 1000 + pid, processAlive: () => false, pollSeconds: 3600,
    spawnImpl: (file, args) => { const child = fakeChild(300); watchedSpawns.push(args); return child; },
  });
  watched.start();
  const watchedRequests = path.join(projectRoot, "watched", "model", "online_training", "requests");
  assert.ok(fs.existsSync(watchedRequests), "the requests directory exists to be watched");
  fs.writeFileSync(path.join(watchedRequests, "manual-3.json"), "{}");
  const deadline = Date.now() + 3000;
  while (!watchedSpawns.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.strictEqual(watchedSpawns.length, 1, "the request started its job without waiting for the poll");
  assert.ok(watchedSpawns[0].includes("manual-3"));
  await watched.stopAndWait(200);
  fs.rmSync(projectRoot, { recursive: true, force: true });
  console.log("training job runner contract passed");
})().catch((error) => { console.error(error); process.exit(1); });
