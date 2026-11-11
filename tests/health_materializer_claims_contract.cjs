"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// A materialization job is in exactly one place -- pending/, claimed/ (Health took it by an atomic
// rename) or done/ (its result, written before the claim goes). A request that cannot be read is quarantined and
// answered, never deleted; a claim left by an earlier Health is put back to pending, recorded.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const root = makeTempDir("materializer-claims-");
const { loadVarLayout } = require("../config/js/var_paths.js");
process.env[loadVarLayout().root_env] = root;
const { createMaterializerJobRunner } = require("../health/materializer_job_runner.js");

const binary = path.join(root, "native", "analysis_runtime", "target", "release", "analysis_runtime.exe");
fs.mkdirSync(path.dirname(binary), { recursive: true });
fs.writeFileSync(binary, "");
const jobs = path.join(root, "output", "materialization_jobs");
const dir = (name) => path.join(jobs, name);
for (const name of ["pending", "claimed"]) fs.mkdirSync(dir(name), { recursive: true });
const request = { source: "shioaji", market: "STK", code: "*", trading_date: "2026-10-08", session: "DAY" };
fs.writeFileSync(path.join(dir("pending"), "good.json"), JSON.stringify(request));
fs.writeFileSync(path.join(dir("pending"), "torn.json"), "{not json");
// A claim an earlier Health left behind (it crashed mid-job).
fs.writeFileSync(path.join(dir("claimed"), "orphan.json"), JSON.stringify(request));
fs.writeFileSync(path.join(dir("claimed"), "orphan.owner.json"), JSON.stringify({ instance: "materializer-1-1", child_pid: 4242 }));

const children = [];
function spawnImpl() {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 900 + children.length, kill() {} });
  children.push(child);
  return child;
}

async function main() {
  const events = [];
  const runner = createMaterializerJobRunner({ binaryPath: path.join(root, "native", "analysis_runtime", "target", "release", "analysis_runtime.exe"), platform: "linux", projectRoot: root, dataRoot: path.join(root, "data"), fs, path, spawnImpl,
    pollSeconds: 3600, logger: { error() {}, warn() {} }, maxConcurrent: 4, remediation: { emit: (e) => events.push(e) },
    processAlive: () => false, execFileImpl: () => {}, createdMs: () => 1000 });
  runner.start();
  await new Promise((resolve) => setImmediate(resolve));  // the owner record follows the awaited creation time

  // The orphan was put back to pending first, then claimed again by this Health together with the good request.
  assert.deepStrictEqual(events.filter((e) => e.mechanismId === "materialization.claim_recovered").map((e) => e.detail.job_id), ["orphan"]);
  assert.deepStrictEqual(fs.readdirSync(dir("pending")).sort(), [], "every readable request is claimed");
  const claimed = fs.readdirSync(dir("claimed")).filter((n) => !n.endsWith(".owner.json")).sort();
  assert.deepStrictEqual(claimed, ["good.json", "orphan.json"]);
  const owner = JSON.parse(fs.readFileSync(path.join(dir("claimed"), "good.owner.json"), "utf8"));
  assert.ok(owner.instance.startsWith("materializer-") && owner.instance !== "materializer-1-1");

  // The torn request: quarantined and answered, never deleted.
  assert.ok(fs.existsSync(path.join(dir("quarantine"), "torn.json")));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir("done"), "torn.json"), "utf8")).status, "invalid_request");

  // A job that finishes: its result first, then the claim goes.
  const child = children[0];
  child.stdout.emit("data", Buffer.from(`${JSON.stringify({ ok: true, status: "materialized" })}\n`));
  child.emit("exit", 0);
  const finishedId = fs.existsSync(path.join(dir("done"), "good.json")) ? "good" : "orphan";
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir("done"), `${finishedId}.json`), "utf8")).status, "materialized");
  assert.ok(!fs.existsSync(path.join(dir("claimed"), `${finishedId}.json`)), "the claim is gone once the result is written");

  // Stopping puts what is still claimed back to pending, explicitly.
  runner.stop();
  children[1].emit("exit", null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(fs.readdirSync(dir("claimed")).filter((n) => n.endsWith(".json") && !n.endsWith(".owner.json")), []);
  assert.strictEqual(fs.readdirSync(dir("pending")).length, 1);
  fs.rmSync(root, { recursive: true, force: true });
  console.log("health_materializer_claims_contract: ok");
}

main().catch((error) => { console.error(error); process.exit(1); });
