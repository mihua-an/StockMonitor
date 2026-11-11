"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// A timed-out job was dropped from in_flight / children the moment kill() was called, before the
// process had exited, so a restart or the next tick could run the same job beside it.
// Stdout / stderr were accumulated without bound for the job's whole lifetime.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { mock } = require("node:test");

const root = makeTempDir("materializer-timeout-");
const { loadVarLayout } = require("../config/js/var_paths.js");
process.env[loadVarLayout().root_env] = root;
const { createMaterializerJobRunner } = require("../health/materializer_job_runner.js");

const binary = path.join(root, "native", "analysis_runtime", "target", "release", "analysis_runtime.exe");
fs.mkdirSync(path.dirname(binary), { recursive: true });
fs.writeFileSync(binary, "");
const pending = path.join(root, "output", "materialization_jobs", "pending");
const done = path.join(root, "output", "materialization_jobs", "done");
fs.mkdirSync(pending, { recursive: true });
const job = (id) => fs.writeFileSync(path.join(pending, `${id}.json`), JSON.stringify({ source: "shioaji", market: "STK",
  code: "*", trading_date: "2026-09-30", session: "DAY" }));
// The job timeout and kill grace run on mocked timers: the test moves the clock past each one, so it reaches
// exactly the state between them however slow the machine is.
const flush = () => new Promise((resolve) => setImmediate(resolve));

function child() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.pid = 4242;
  c.exitCode = null;
  c.exit = (code) => { c.exitCode = code; c.emit("exit", code); };
  return c;
}

async function main() {
  // 1. On Windows the tree goes first, while the child is alive: the job stays in flight until that ends it.
  job("stuck");
  const stuck = child();
  stuck.kill = () => assert.fail("kill() before the tree kill would leave taskkill /T nothing to walk");
  const taskkills = [];
  const runner = createMaterializerJobRunner({ binaryPath: path.join(root, "native", "analysis_runtime", "target", "release", "analysis_runtime.exe"), projectRoot: root, dataRoot: path.join(root, "data"), fs, path,
    spawnImpl: () => stuck, pollSeconds: 3600, logger: { error() {}, warn() {} }, jobTimeoutMs: 30,
    platform: "win32", execFileImpl: (file, args, _opts, done_) => { taskkills.push([file, ...args]); setImmediate(() => { stuck.exit(1); done_(null); }); } });
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  runner.start();
  mock.timers.tick(30);  // timed out: the tree is ended now
  assert.deepStrictEqual(taskkills[0], ["taskkill.exe", "/PID", "4242", "/T", "/F"], "the whole tree, forced, with its parent alive");
  assert.strictEqual(runner.probe().in_flight, 1, "a timed-out job is still in flight while its process runs");
  assert.ok(!fs.existsSync(done) || fs.readdirSync(done).length === 0, "no result before the process has exited");
  await flush();  // its exit releases the job
  mock.timers.reset();
  assert.strictEqual(runner.probe().in_flight, 0);
  const result = JSON.parse(fs.readFileSync(path.join(done, "stuck.json"), "utf8"));
  assert.match(result.error, /timed out/);
  runner.stop();

  // 2. A chatty child: only the tails are kept, and the result line still parses.
  job("chatty");
  const chatty = child();
  chatty.kill = () => {};
  const runner2 = createMaterializerJobRunner({ binaryPath: path.join(root, "native", "analysis_runtime", "target", "release", "analysis_runtime.exe"), platform: "linux", projectRoot: root, dataRoot: path.join(root, "data"), fs, path,
    spawnImpl: () => chatty, pollSeconds: 3600, logger: { error() {} } });
  runner2.start();
  const noise = "x".repeat(1024 * 1024);
  for (let i = 0; i < 8; i += 1) { chatty.stdout.emit("data", Buffer.from(noise + "\n")); chatty.stderr.emit("data", Buffer.from(noise)); }
  chatty.stdout.emit("data", Buffer.from(JSON.stringify({ ok: true, status: "complete" }) + "\n"));
  chatty.exit(0);
  const chattyResult = JSON.parse(fs.readFileSync(path.join(done, "chatty.json"), "utf8"));
  assert.strictEqual(chattyResult.ok, true);
  runner2.stop();
  const source = fs.readFileSync(path.join(__dirname, "..", "health", "materializer_job_runner.js"), "utf8");
  // Stderr is read line by line (its progress lines go to progress.json); the rest and an endless line are tails.
  assert.ok(/tail\(stdout \+ chunk/.test(source) && /tail\(`\$\{stderr\}\$\{line\}\\n`, STDERR_TAIL_CHARS\)/.test(source)
    && /tail\(stderr \+ stderrPartial, STDERR_TAIL_CHARS\)/.test(source), "both streams are kept as tails");
  // A whole-session job over 14 GB of WAL took 149 s and a 120 s bound killed it five times; the default
  // is the ledger's running lease (15 min).
  assert.ok(/const DEFAULT_TIMEOUT_MS = 15 \* 60 \* 1000;/.test(source), "default job timeout is 15 minutes");

  fs.rmSync(root, { recursive: true, force: true });
  console.log("health_materializer_timeout_contract: ok");
}

main().catch((error) => { console.error(error); process.exit(1); });
