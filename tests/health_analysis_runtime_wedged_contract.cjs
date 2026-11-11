"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// After its first hello, a B that stopped doing anything stayed "alive" forever, so
// the supervisor never replaced it and every projection froze.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const { AnalysisRuntimeHost } = require("../health/services/analysis_runtime_host.js");

const root = makeTempDir("analysis-host-");
const binary = path.join(root, "native", "analysis_runtime", "target", "release", "analysis_runtime.exe");
fs.mkdirSync(path.dirname(binary), { recursive: true });
fs.writeFileSync(binary, "");

const spawned = [];
function spawnImpl(_binary, args) {
  const child = new EventEmitter();
  child.args = args;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 1000 + spawned.length;
  child.kill = () => { child.exitCode = 1; child.emit("exit", 1, null); };
  spawned.push(child);
  setImmediate(() => {
    child.stdout.write(`${JSON.stringify({ type: "hello", instance_id: `ar-${child.pid}` })}\n`);
    // B says ready once Market Runtime confirmed its durable subscription (Codex 1022-ST-03); a child told to stay
    // unsubscribed says hello only.
    if (!spawnImpl.unsubscribed) child.stdout.write(`${JSON.stringify({ type: "ready", instance_id: `ar-${child.pid}` })}\n`);
  });
  return child;
}

const events = [];

async function main() {
  const host = new AnalysisRuntimeHost({ fs, path, projectRoot: root, dataRoot: path.join(root, "data"), eventsDir: path.join(root, "storage", "analysis-events"), configRoot: root,
    logDir: path.join(root, "logs"), effective: { services: { market_runtime: { host: "127.0.0.1", port: 1 } } },
    tokenFile: "t", spawnImpl, logger: { error() {} }, remediation: { begin: (start) => ({ finish: (outcome, extra) => events.push({ start, outcome, extra }) }) } });
  await host.ensure();
  assert.strictEqual(spawned.length, 1);
  // B's rule events go to the storage location Health resolved, not under its --data-dir.
  assert.strictEqual(spawned[0].args[spawned[0].args.indexOf("--events-dir") + 1], path.join(root, "storage", "analysis-events"));
  assert.strictEqual((await host.supervisorProbe()).alive, true, "fresh after hello");

  spawned[0].stdout.write(`${JSON.stringify({ type: "metrics" })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  host.helloAt -= 120000;
  assert.strictEqual((await host.supervisorProbe()).alive, true, "recent metrics keep it alive");

  host.metricsAt -= 120000;
  const probe = await host.supervisorProbe();
  assert.strictEqual(probe.alive, false, "no metrics for too long: not alive");
  assert.strictEqual(probe.wedged, true);
  assert.strictEqual(probe.verified, true, "still our own B: the supervisor restarts it instead of leaving it as an unknown occupant");

  // A B that Market Runtime refused for a contract reason reports it; alive and our own, but not RUNNING.
  host.metricsAt = Date.now();
  host.latestMetrics = { type: "metrics", incompatible: "Market Runtime refused a projection item: unknown block" };
  const incompatible = await host.supervisorProbe();
  assert.strictEqual(incompatible.alive, true);
  assert.strictEqual(incompatible.verified, false, "not serviceable: the supervisor marks it DEGRADED");
  assert.strictEqual(incompatible.identity_verified, true, "still our own B");
  assert.match(incompatible.payload.runtime_state, /^INCOMPATIBLE: Market Runtime refused/);
  host.latestMetrics = { type: "metrics" };
  host.metricsAt -= 120000;

  const result = await host.ensure();
  assert.strictEqual(spawned.length, 2, "ensure replaced the wedged process");
  assert.strictEqual(spawned[0].exitCode, 1, "the wedged one was ended");
  assert.strictEqual(result.instance_id, "ar-1001");
  assert.strictEqual((await host.supervisorProbe()).alive, true);
  // The replacement is recorded with the old and new instance.
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].start.mechanismId, "analysis.wedged_replacement");
  assert.strictEqual(events[0].start.detail.old_instance, "ar-1000");
  assert.strictEqual(events[0].outcome, "succeeded");
  assert.strictEqual(events[0].extra.detail.new_instance, "ar-1001");

  // An old instance that does not exit is never replaced by a second one beside it.
  spawned[1].kill = () => {};          // ignores the kill
  host.metricsAt = Date.now() - 120000;
  host.helloAt = Date.now() - 120000;
  const realTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...rest) => realTimeout(fn, Math.min(ms, 10), ...rest);
  try {
    await assert.rejects(host.ensure(), /did not exit after it was ended; no replacement/);
  } finally {
    global.setTimeout = realTimeout;
  }
  assert.strictEqual(spawned.length, 2, "nothing spawned next to a live old instance");
  assert.strictEqual(events.at(-1).outcome, "failed");

  // A stop past its deadline: the forced end is awaited. A process that exits a moment after the kill is recorded as
  // exited; one that never exits keeps any replacement from starting beside it.
  const stopHost = (killBehaviour) => {
    const forced = [];
    const h = new AnalysisRuntimeHost({ fs, path, projectRoot: root, dataRoot: path.join(root, "data"), eventsDir: path.join(root, "storage", "analysis-events"), configRoot: root,
      logDir: path.join(root, "logs"), effective: { services: { market_runtime: { host: "127.0.0.1", port: 1 } } },
      tokenFile: "t", spawnImpl: (...args) => { const c = spawnImpl(...args); c.kill = () => killBehaviour(c); return c; },
      logger: { error() {} }, remediation: { emit: (event) => forced.push(event), begin: () => ({ finish() {} }) } });
    return { h, forced };
  };
  global.setTimeout = (fn, ms, ...rest) => realTimeout(fn, Math.min(ms, 20), ...rest);
  // The forced-end wait is an unref'd timer and these fake processes hold no handle: keep the test's loop alive.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const late = stopHost((c) => realTimeout(() => { c.exitCode = 0; c.emit("exit", 0, null); }, 5));
    await late.h.ensure();
    const lateStop = await late.h.stop("test");
    assert.strictEqual(lateStop.forced, true);
    assert.strictEqual(lateStop.exited, true, "the exit a few ms after the kill is seen");
    assert.strictEqual(late.forced.at(-1)?.detail?.exited, true);

    const stuck = stopHost(() => {});
    await stuck.h.ensure();
    const stuckStop = await stuck.h.stop("test");
    assert.strictEqual(stuckStop.exited, false);
    assert.match(stuckStop.error, /did not exit after it was terminated/);
    const before = spawned.length;
    await assert.rejects(stuck.h.ensure(), /was ended but has not exited/);
    assert.strictEqual(spawned.length, before, "no replacement beside it");
  } finally {
    global.setTimeout = realTimeout;
    clearInterval(keepAlive);
  }
  {
    // Codex 1022-ST-03: a B that said hello was READY although it had not reached Market Runtime yet. Without ready
    // the start fails, ended and recorded, instead of a READY service that receives nothing.
    const kills = [];
    spawnImpl.unsubscribed = true;
    const unsubscribed = new AnalysisRuntimeHost({ fs, path, projectRoot: root, dataRoot: path.join(root, "data"), eventsDir: path.join(root, "storage", "analysis-events"), configRoot: root,
      logDir: path.join(root, "logs"), effective: { services: { market_runtime: { host: "127.0.0.1", port: 1 } } },
      tokenFile: "t", spawnImpl, logger: { error() {} }, readyTimeoutMs: 200,
      remediation: { emit: (record) => kills.push(record), begin: () => ({ finish() {} }) } });
    await assert.rejects(unsubscribed.ensure(), /no ready in time \(not subscribed to Market Runtime\)/);
    spawnImpl.unsubscribed = false;
    assert.ok(kills.some((record) => record.mechanismId === "health.forced_termination" && /no ready in time/.test(record.detail.reason)),
      "the ended start is recorded");
  }
  fs.rmSync(root, { recursive: true, force: true });
  console.log("health_analysis_runtime_wedged_contract: ok");
}

main().catch((error) => { console.error(error); process.exit(1); });
