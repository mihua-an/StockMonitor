"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// A claim an earlier Health left is finished when its result exists (only the claim goes); queued again
// only once its job process -- that exact process, by creation time -- has been ended and has exited; and left
// claimed, blocked and recorded when that process cannot be verified or does not exit. Never two runs of one job.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const root = makeTempDir("materializer-orphan-");
const { loadVarLayout } = require("../config/js/var_paths.js");
process.env[loadVarLayout().root_env] = root;
const { createMaterializerJobRunner } = require("../health/materializer_job_runner.js");

const binary = path.join(root, "native", "analysis_runtime", "target", "release", "analysis_runtime.exe");
fs.mkdirSync(path.dirname(binary), { recursive: true });
fs.writeFileSync(binary, "");
const jobs = path.join(root, "output", "materialization_jobs");
const dir = (name) => path.join(jobs, name);
for (const name of ["pending", "claimed", "done"]) fs.mkdirSync(dir(name), { recursive: true });
const request = { source: "shioaji", market: "STK", code: "*", trading_date: "2026-10-08", session: "DAY" };
const claim = (id, owner) => {
  fs.writeFileSync(path.join(dir("claimed"), `${id}.json`), JSON.stringify(request));
  fs.writeFileSync(path.join(dir("claimed"), `${id}.owner.json`), JSON.stringify({ instance: "materializer-1-1", ...owner }));
};
// finished: its result was written, the Health died before the claim went.
claim("finished", { child_pid: 11, child_started_ms: 1000 });
fs.writeFileSync(path.join(dir("done"), "finished.json"), JSON.stringify({ ok: true }));
// running: its process (pid 22, created when the record says) is still alive.
claim("running", { child_pid: 22, child_started_ms: 2000 });
// unknown: pid 33 is alive but the record states no start time to verify it by.
claim("unknown", { child_pid: 33 });

const alive = new Set([22, 33]);
const spawned = [];
function spawnImpl() {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 900 + spawned.length, kill() {} });
  spawned.push(child);
  return child;
}

async function main() {
  const events = [];
  const kills = [];
  const runner = createMaterializerJobRunner({ binaryPath: path.join(root, "native", "analysis_runtime", "target", "release", "analysis_runtime.exe"), projectRoot: root, dataRoot: path.join(root, "data"), fs, path, spawnImpl,
    pollSeconds: 3600, logger: { error() {}, warn() {} }, maxConcurrent: 4, remediation: { emit: (e) => events.push(e) },
    platform: "win32", processAlive: (pid) => alive.has(Number(pid)), createdMs: (pid) => ({ 22: 2100 }[pid] ?? null),
    execFileImpl: (_cmd, args, _opts, done) => { kills.push(Number(args[1])); setTimeout(() => { alive.delete(Number(args[1])); done(null); }, 30); } });
  runner.start();
  await new Promise((resolve) => setImmediate(resolve));  // recovery awaits each live claim's creation time

  assert.ok(!fs.existsSync(path.join(dir("claimed"), "finished.json")), "a finished job's claim is cleared");
  assert.ok(fs.existsSync(path.join(dir("done"), "finished.json")), "its result stays");
  assert.ok(fs.existsSync(path.join(dir("claimed"), "running.json")), "a live orphan's job is not queued again yet");
  assert.strictEqual(spawned.length, 0, "nothing runs beside the orphan");
  const unknownOwner = JSON.parse(fs.readFileSync(path.join(dir("claimed"), "unknown.owner.json"), "utf8"));
  assert.match(unknownOwner.blocked.reason, /cannot be verified/);
  assert.deepStrictEqual(kills, [22], "only the verified orphan is terminated");

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(!alive.has(22));
  assert.strictEqual(spawned.length, 1, "queued again and run once its process has exited");
  const recoveries = events.filter((e) => e.mechanismId === "materialization.claim_recovered").map((e) => [e.detail.job_id, e.outcome]);
  assert.deepStrictEqual(recoveries.sort(), [["finished", "succeeded"], ["running", "succeeded"], ["unknown", "failed"]]);
  runner.stop();
  spawned[0].emit("exit", null);
  fs.rmSync(root, { recursive: true, force: true });
  console.log("health_materializer_orphan_contract: ok");
}

main().catch((error) => { console.error(error); process.exit(1); });
