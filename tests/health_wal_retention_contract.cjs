"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// Health forwards the session owner's WAL retention request to market_runtime and reports the result.
// It never decides the cutoff and never touches WAL files itself.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = makeTempDir("wal-retention-");
const { loadVarLayout } = require("../config/js/var_paths.js");
process.env[loadVarLayout().root_env] = root;
const { createMaterializerJobRunner, RETENTION_RESULT_SCHEMA } = require("../health/materializer_job_runner.js");

async function main() {
  const calls = [];
  const marketRuntime = {
    async control(type, payload, _timeout, replyType) {
      calls.push({ type, payload, replyType });
      return { type: "wal.prune.ack", payload: { ok: true, removed_segments: 3, pruned_through: 42 } };
    },
  };
  const runner = createMaterializerJobRunner({ binaryPath: path.join(root, "native", "analysis_runtime", "target", "release", "analysis_runtime.exe"), platform: "linux", projectRoot: root, dataRoot: path.join(root, "data"), fs, path,
    marketRuntime, logger: { error() {} } });
  const dir = path.join(root, "output", "materialization_jobs", "wal_retention");
  fs.mkdirSync(dir, { recursive: true });

  // start() runs one poll at once; the fake market_runtime answers at once, so the poll's whole forward is done once
  // the pending promise callbacks have run (setImmediate comes after them).
  const pollDone = () => new Promise((resolve) => setImmediate(resolve));
  runner.start();
  await pollDone();
  assert.strictEqual(calls.length, 0, "no request, no prune");

  fs.writeFileSync(path.join(dir, "request.json"), JSON.stringify({ before_ns: 1790000000000000000, reason: "test" }));
  runner.stop();
  runner.start();
  await pollDone();
  assert.deepStrictEqual(calls.map((c) => [c.type, c.payload.before_ns, c.replyType]), [["wal.prune", 1790000000000000000, "wal.prune.ack"]]);
  const result = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
  assert.strictEqual(result.schema, RETENTION_RESULT_SCHEMA);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.pruned_through, 42);
  assert.strictEqual(result.request.reason, "test");
  assert.ok(!fs.existsSync(path.join(dir, "request.json")), "a forwarded request is consumed");
  assert.strictEqual(runner.probe().wal_retention.removed_segments, 3);

  fs.writeFileSync(path.join(dir, "request.json"), JSON.stringify({ reason: "no cutoff" }));
  runner.stop();
  runner.start();
  await pollDone();
  assert.strictEqual(calls.length, 1, "a request without a cutoff never reaches market_runtime");
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8")).ok, false);
  // The session owner's materialization status (wal_retention.py write_status) rides along in the probe.
  assert.strictEqual(runner.probe().materialization, null, "no status file, nothing reported");
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ schema: "wal-materialization-status-v1", pending_from_ns: 7 }));
  runner.stop();
  runner.start();
  assert.strictEqual(runner.probe().materialization.pending_from_ns, 7);
  runner.stop();
  fs.rmSync(root, { recursive: true, force: true });
  console.log("health_wal_retention_contract: ok");
}

main().catch((error) => { console.error(error); process.exit(1); });

// health/main.js must start the runner it creates, or no job runs after the rebuild.
{
  const main = fs.readFileSync(path.join(__dirname, "..", "health", "main.js"), "utf8");
  assert.ok(/materializerJobs\.start\(\)/.test(main), "Health must start the materializer job runner");
  assert.ok(main.indexOf("materializerJobs.start()") > main.indexOf("supervisor.startAll("), "after market_runtime is up");
  console.log("health starts the materializer runner: ok");
}
