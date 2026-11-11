"use strict";
// A provider daemon Health spawned that never served (startup failed or timed out), or that released
// its port on stop and then never exited, was invisible to every port-based stop and outlived Health.
const assert = require("assert");
const { EventEmitter } = require("events");
const { SpawnedDaemon } = require("../health/services/spawned_daemon.js");
const { FutuDaemonHost } = require("../health/services/futu_daemon_host.js");

function fakeChild(pid, { exitsOnKill = true } = {}) {
  const child = new EventEmitter();
  Object.assign(child, { pid, exitCode: null, signalCode: null });
  child.exit = (code = 1) => { child.exitCode = code; child.emit("exit", code, null); };
  child.kill = () => { if (exitsOnKill) child.exit(1); };
  return child;
}

(async () => {
  const logger = { error() {}, warn() {}, log() {} };

  // 1. Nothing tracked, or already exited: nothing to reap.
  const idle = new SpawnedDaemon({ label: "T", logger, execFileImpl: () => assert.fail("no taskkill") });
  assert.strictEqual(await idle.reap("x", 0), false);
  const gone = fakeChild(10);
  gone.exit(0);
  idle.track(gone);
  assert.strictEqual(await idle.reap("x", 0), false);

  // 2. One that leaves within the grace period is not killed.
  const leaving = fakeChild(11);
  const graceful = new SpawnedDaemon({ label: "T", logger, execFileImpl: () => assert.fail("no taskkill") });
  graceful.track(leaving);
  setTimeout(() => leaving.exit(0), 20);
  assert.strictEqual(await graceful.reap("stop", 500), false);

  // 3. One that stays is terminated as a tree, by the pid its handle holds.
  const stuck = fakeChild(12);
  const kills = [];
  const reaper = new SpawnedDaemon({ label: "T", logger,
    execFileImpl: (file, args, _options, done) => { kills.push([file, ...args]); stuck.exit(1); done(null); } });
  reaper.track(stuck);
  assert.strictEqual(await reaper.reap("stop", 10), true);
  assert.deepStrictEqual(kills, [["taskkill.exe", "/PID", "12", "/T", "/F"]]);

  // 4. FutuDaemonHost: a start that spawned a daemon and then failed reaps it; one that failed before spawning
  //    anything leaves the existing process alone.
  const host = new FutuDaemonHost({ projectRoot: "C:/Project", endpoint: () => ({ host: "127.0.0.1", port: 18101 }),
    expected: { identity: "futu-test", protocolVersion: 1, runtimeVersion: "v1" }, providerMode: "live", callbackSource: "sdk",
    enabled: true, fetchImpl: async () => { throw new Error("unreachable"); }, logger });
  const spawned = fakeChild(13);
  const reaped = [];
  host.spawned.reap = async (reason, grace) => { reaped.push([reason, grace]); return true; };
  host.controller.ensure = async () => {
    host.spawned.track(spawned);
    host.lastSpawnState = { ...host.lastSpawnState, pid: 13, startedAt: Date.now() + 1 };
    throw new Error("Moomoo Daemon 啟動逾時");
  };
  await assert.rejects(host.ensure(), /啟動逾時/);
  assert.deepStrictEqual(reaped, [["a failed start", 0]]);
  host.controller.ensure = async () => { throw new Error("8011 port 已被非相容程序占用"); };
  await assert.rejects(host.ensure(), /非相容/);
  assert.strictEqual(reaped.length, 1, "no spawn in this attempt: nothing reaped");

  console.log("health spawned daemon reap contract passed");
})().catch((error) => { console.error(error); process.exit(1); });
