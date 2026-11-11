"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// The data center's 收盤整理 card shows where a materialization job is: Health turns the job's stderr progress lines
// into progress.json (phase, done / total, when each phase began, how the job ended) and keeps every other stderr line
// for the failure report only.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const root = makeTempDir("materializer-progress-");
const { loadVarLayout } = require("../config/js/var_paths.js");
process.env[loadVarLayout().root_env] = root;
const { createMaterializerJobRunner, parseProgressLine, PROGRESS_SCHEMA } = require("../health/materializer_job_runner.js");

const binary = path.join(root, "native", "analysis_runtime", "target", "release", "analysis_runtime.exe");
fs.mkdirSync(path.dirname(binary), { recursive: true });
fs.writeFileSync(binary, "");
const jobs = path.join(root, "output", "materialization_jobs");
fs.mkdirSync(path.join(jobs, "pending"), { recursive: true });
fs.writeFileSync(path.join(jobs, "pending", "jobA.json"), JSON.stringify({ job_id: "jobA", source: "shioaji", market: "STK",
  code: "*", trading_date: "2026-10-29", session: "DAY", close_operation_id: "close:shioaji:STK:*:2026-10-29:DAY" }));
// An earlier Health's run still marked running ended with that Health.
fs.writeFileSync(path.join(jobs, "progress.json"), JSON.stringify({ schema: PROGRESS_SCHEMA, jobs: {
  old: { job_id: "old", status: "running", started_at: "2026-10-28T06:40:00.000Z", updated_at: "2026-10-28T06:41:00.000Z", phases: {} } } }));

let child = null;
function spawnImpl() {
  child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() {}, on() {} };
  child.pid = 4242;
  child.kill = () => {};
  return child;
}
const progressFile = () => JSON.parse(fs.readFileSync(path.join(jobs, "progress.json"), "utf8"));
const line = (phase, done, total) => `${JSON.stringify({ progress: { date: "2026-10-29", phase, done, total, elapsed_ms: 5 } })}\n`;

async function main() {
  assert.strictEqual(parseProgressLine("[analysis_runtime] something else"), null);
  assert.strictEqual(parseProgressLine(line("read", 1, 2).trim()).phase, "read");

  const runner = createMaterializerJobRunner({ binaryPath: path.join(root, "native", "analysis_runtime", "target", "release", "analysis_runtime.exe"), platform: "linux", projectRoot: root, dataRoot: path.join(root, "data"), fs, path, spawnImpl,
    pollSeconds: 3600, logger: { error() {}, warn() {} }, createdMs: () => Date.now() });
  runner.start();
  assert.ok(child, "the job was started");
  let file = progressFile();
  assert.strictEqual(file.jobs.old.status, "interrupted", "a run an earlier Health left open is not shown as running");
  assert.deepStrictEqual([file.jobs.jobA.status, file.jobs.jobA.market, file.jobs.jobA.session, file.jobs.jobA.phase],
    ["running", "STK", "DAY", null], "the job is listed as soon as it starts");

  // A line split across chunks, a CRLF line, and a diagnostic line between progress lines.
  const scan = line("scan", 3, 3);
  child.stderr.emit("data", Buffer.from(line("scan", 0, 0) + scan.slice(0, 20)));
  child.stderr.emit("data", Buffer.from(scan.slice(20).replace("\n", "\r\n") + "[analysis_runtime] a warning\n"));
  child.stderr.emit("data", Buffer.from(line("read", 0, 1000)));
  file = progressFile();
  assert.strictEqual(file.jobs.jobA.phase, "read", "a phase change is written at once");
  assert.deepStrictEqual([file.jobs.jobA.phases.scan.done, file.jobs.jobA.phases.scan.total], [3, 3]);
  assert.ok(file.jobs.jobA.phases.read.started_at, "each phase keeps when it began");

  child.stderr.emit("data", Buffer.from(line("read", 1000, 1000) + line("write", 0, 76)));
  child.stdout.emit("data", Buffer.from(`${JSON.stringify({ ok: false, status: "retryable", error: "boom" })}\n`));
  child.emit("exit", 1);
  file = progressFile();
  assert.deepStrictEqual([file.jobs.jobA.status, file.jobs.jobA.error, file.jobs.jobA.phase], ["retryable", "boom", "write"],
    "the job's end is written with how it ended");
  assert.ok(file.jobs.jobA.ended_at);
  const result = JSON.parse(fs.readFileSync(path.join(jobs, "done", "jobA.json"), "utf8"));
  assert.strictEqual(result.status, "retryable", "the result is unchanged");
  runner.stop();
  fs.rmSync(root, { recursive: true, force: true });
  console.log("health_materializer_progress_contract: ok");
}

main().catch((error) => { console.error(error); process.exit(1); });
