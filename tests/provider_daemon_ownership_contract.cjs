"use strict";

const { makeTempDir } = require("./support/temp_dirs.cjs");
// A provider daemon is started, attached to and stopped from its own durable
// owner record (pid + creation time, generation, STARTING/READY/STOPPING) and its instance-bound stop receipt -- never
// from port/HTTP/process-image guesses. Every wait on another owner and every forced termination is recorded.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createProviderDaemonOwnership } = require("../health/startup/provider_daemon_ownership");

const expected = { identity: "daemon", protocolVersion: 1, runtimeVersion: "v2" };
const healthOf = (instance, extra = {}) => ({ ok: true, identity: "daemon", protocol_version: 1, daemon_runtime_version: "v2",
  daemon_instance_id: instance, ...extra });

function world({ heldPid = null } = {}) {
  const dir = makeTempDir("daemon-owner-");
  const ownerFile = path.join(dir, "owner.json");
  const receiptFile = path.join(dir, "owner_stop_receipt.json");
  const w = {
    dir, alive: new Map(), created: new Map(), portOpen: false, health: null, spawns: [], stops: [], terminated: [], events: [],
    spawnState: { pid: null, exitCode: null }, onSpawn: null, onStop: null, createdQueries: [],
    writeOwner(record) { fs.writeFileSync(ownerFile, JSON.stringify({ generation: 1, ...record })); },
    clearOwner() { fs.rmSync(ownerFile, { force: true }); },
    writeReceipt(receipt) { fs.writeFileSync(receiptFile, JSON.stringify(receipt)); },
  };
  w.ownership = createProviderDaemonOwnership({
    label: "TEST DAEMON", serviceId: "provider_shioaji", daemonUrl: "http://daemon", expected,
    ownerPath: () => ownerFile, receiptPath: () => receiptFile,
    fetchImpl: async (url) => {
      if (url.includes("/v1/control/stop")) { w.stops.push(url); w.onStop?.(); return { ok: true, status: 200, json: async () => ({ ok: true, stopped: true }) }; }
      if (!w.health) throw new Error("no answer");
      return { ok: true, status: 200, json: async () => w.health };
    },
    isPortOpen: async () => w.portOpen,
    spawnDetached: () => { const pid = 500 + w.spawns.length; w.spawns.push(pid); w.spawnState = { pid, exitCode: null }; w.onSpawn?.(pid); return pid; },
    getSpawnState: () => ({ ...w.spawnState }),
    processAlive: (pid) => w.alive.get(Number(pid)) === true,
    createdMs: async (pid) => { w.createdQueries.push(Number(pid)); return w.created.get(Number(pid)) ?? null; },
    ...(heldPid ? { heldPid: () => heldPid(w) } : {}),
    terminate: async (pid) => { w.terminated.push(pid); w.alive.set(Number(pid), false); return true; },
    remediation: { emit: (event) => w.events.push(event) },
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
    logger: { log() {}, warn() {}, error() {} },
    budgets: { startingMs: 300, stoppingMs: 300, spawnReadyMs: 300, stopGraceMs: 300, exitAfterStopMs: 300, attachProbeMs: 300 },
    pollMs: 1,
  });
  return w;
}

const owner = (pid, lifecycle, instance = `i-${pid}`, createdMs = 1_000_000) =>
  ({ owner_pid: pid, owner_created_ns: createdMs * 1e6, lifecycle, daemon_instance_id: instance });

(async () => {
  // 1. Nobody owns it: spawn, and succeed once the spawned pid owns the record READY and answers as that instance.
  {
    const w = world();
    w.onSpawn = (pid) => setTimeout(() => {
      w.alive.set(pid, true); w.created.set(pid, 2_000_000); w.writeOwner(owner(pid, "READY", "fresh", 2_000_000));
      w.portOpen = true; w.health = healthOf("fresh");
    }, 5);
    const result = await w.ownership.ensure();
    assert.deepEqual([result.decision, result.action, w.spawns.length], ["STARTED_NEW", "start", 1]);
  }
  // 1b. The daemon this host spawned and still holds a handle to needs no creation-time query (~0.5 s of CIM each,
  // four times a second while it started): its pid cannot name another process while the handle is open.
  {
    const w = world({ heldPid: (world) => world.spawnState.pid });
    w.onSpawn = (pid) => setTimeout(() => {
      w.alive.set(pid, true); w.writeOwner(owner(pid, "STARTING", "fresh", 2_000_000));
      setTimeout(() => { w.writeOwner(owner(pid, "READY", "fresh", 2_000_000)); w.portOpen = true; w.health = healthOf("fresh"); }, 5);
    }, 5);
    assert.equal((await w.ownership.ensure()).decision, "STARTED_NEW");
    assert.deepEqual(w.createdQueries, [], "no creation-time query for a held child");
    // A record naming another pid is still proven by its creation time.
    w.alive.set(10, true); w.created.set(10, 9_999_999); w.writeOwner(owner(10, "READY"));
    assert.equal((await w.ownership.currentOwner()).state, "REPLACED");
    assert.deepEqual(w.createdQueries, [10]);
  }
  // 2. A live READY owner that answers as itself: attached, nothing spawned.
  {
    const w = world();
    w.alive.set(10, true); w.created.set(10, 1_000_000); w.writeOwner(owner(10, "READY", "running"));
    w.portOpen = true; w.health = healthOf("running");
    assert.equal((await w.ownership.ensure()).decision, "ATTACHED_EXISTING");
    assert.equal(w.spawns.length, 0);
  }
  // 3. A live READY owner whose health does not answer: fail closed -- no second owner, nothing stopped or killed.
  {
    const w = world();
    w.alive.set(10, true); w.created.set(10, 1_000_000); w.writeOwner(owner(10, "READY"));
    w.portOpen = true; w.health = null;
    await assert.rejects(w.ownership.ensure(), (error) => error.decision === "HEALTH_PROBE_FAILED");
    assert.deepEqual([w.spawns.length, w.stops.length, w.terminated.length], [0, 0, 0]);
    assert.equal(w.events.find((e) => e.triggerReason === "owner_ready_unanswered")?.outcome, "failed");
  }
  // 3b. READY is published only once the daemon serves, so a READY owner whose first /health answers late is a fault:
  //     attached once it answers within the attach budget -- never force-terminated and started again -- and the
  //     wait is recorded (succeeded here; the unanswered owner of 3 records a failed one).
  {
    const w = world();
    w.alive.set(10, true); w.created.set(10, 1_000_000); w.writeOwner(owner(10, "READY", "cold"));
    w.portOpen = true; w.health = null;
    setTimeout(() => { w.health = healthOf("cold"); }, 20);
    assert.equal((await w.ownership.ensure()).decision, "ATTACHED_EXISTING");
    assert.deepEqual([w.spawns.length, w.stops.length, w.terminated.length], [0, 0, 0]);
    const wait = w.events.find((e) => e.triggerReason === "owner_ready_unanswered");
    assert.equal(wait?.outcome, "succeeded");
  }
  {
    const w = world();
    w.alive.set(10, true); w.created.set(10, 1_000_000); w.writeOwner(owner(10, "READY", "running"));
    w.portOpen = true; w.health = healthOf("running");
    await w.ownership.ensure();
    assert.ok(!w.events.some((e) => e.triggerReason === "owner_ready_unanswered"), "an owner that answers at once records nothing");
  }
  // 3c. An owner whose creation time is missing, or cannot be read, is not proven: nothing is attached, started,
  //     stopped or terminated -- a reused pid is never treated as the daemon.
  {
    const w = world();
    w.alive.set(10, true); w.writeOwner({ owner_pid: 10, lifecycle: "READY", daemon_instance_id: "x" });
    w.portOpen = true; w.health = healthOf("x");
    await assert.rejects(w.ownership.ensure(), (error) => error.decision === "OWNER_UNVERIFIED");
    w.writeOwner(owner(10, "READY", "x"));                   // a creation time recorded, but the OS answer unreadable
    const stopped = await w.ownership.stop("test");
    assert.equal(stopped.ok, false);
    assert.match(stopped.error, /cannot be verified/);
    assert.deepEqual([w.spawns.length, w.stops.length, w.terminated.length], [0, 0, 0]);
  }
  // 4. A STARTING owner is waited for (recorded), then attached once READY.
  {
    const w = world();
    w.alive.set(10, true); w.created.set(10, 1_000_000); w.writeOwner(owner(10, "STARTING", "booting"));
    w.portOpen = true; w.health = healthOf("booting");
    setTimeout(() => w.writeOwner(owner(10, "READY", "booting")), 5);
    assert.equal((await w.ownership.ensure()).decision, "ATTACHED_EXISTING");
    assert.deepEqual(w.events.map((e) => [e.mechanismId, e.triggerReason, e.outcome]), [["provider.daemon_ownership_wait", "owner_starting", "succeeded"]]);
  }
  // 5. A STOPPING owner is waited out -- its exact process, not just its record -- then a new one starts.
  {
    const w = world();
    w.alive.set(10, true); w.created.set(10, 1_000_000); w.writeOwner(owner(10, "STOPPING"));
    w.portOpen = true;
    setTimeout(() => w.clearOwner(), 2);                        // the record goes first...
    setTimeout(() => { w.alive.set(10, false); w.portOpen = false; }, 15);   // ...the process after it
    w.onSpawn = (pid) => { w.alive.set(pid, true); w.created.set(pid, 3_000_000); w.writeOwner(owner(pid, "READY", "next", 3_000_000)); w.portOpen = true; w.health = healthOf("next"); };
    assert.equal((await w.ownership.ensure()).decision, "STARTED_NEW");
    assert.equal(w.events[0].triggerReason, "owner_stopping");
  }
  // 6. Our own daemon of another runtime: stopped for the upgrade, waited out, replaced once.
  {
    const w = world();
    w.alive.set(10, true); w.created.set(10, 1_000_000); w.writeOwner(owner(10, "READY", "old"));
    w.portOpen = true; w.health = healthOf("old", { daemon_runtime_version: "v1" });
    w.onStop = () => setTimeout(() => { w.alive.set(10, false); w.clearOwner(); w.portOpen = false; w.health = null; }, 2);
    w.onSpawn = (pid) => { w.alive.set(pid, true); w.created.set(pid, 3_000_000); w.writeOwner(owner(pid, "READY", "new", 3_000_000)); w.portOpen = true; w.health = healthOf("new"); };
    assert.equal((await w.ownership.ensure()).decision, "STARTED_NEW");
    assert.deepEqual([w.stops.length, w.spawns.length], [1, 1]);
    assert.equal(w.events[0].triggerReason, "incompatible_upgrade");
  }
  // 7. No live owner but the port is held: not ours -- nothing is sent to it, nothing spawned.
  {
    const w = world();
    w.portOpen = true; w.health = healthOf("foreign");
    await assert.rejects(w.ownership.ensure(), (error) => error.decision === "PORT_CONFLICT");
    assert.equal(w.spawns.length, 0);
  }
  // 8. A recorded pid that now names another process (created at another time) is no owner.
  {
    const w = world();
    w.alive.set(10, true); w.created.set(10, 9_999_999); w.writeOwner(owner(10, "READY"));
    assert.equal((await w.ownership.currentOwner()).state, "REPLACED");
  }
  // 9. A spawned child that exits before READY, with no owner, fails the start (with its exit code).
  {
    const w = world();
    w.onSpawn = () => setTimeout(() => { w.spawnState = { ...w.spawnState, exitCode: 1 }; }, 2);
    await assert.rejects(w.ownership.ensure(), (error) => error.decision === "CHILD_STARTUP_FAILED" && /exit code=1/.test(error.message));
  }
  // 10. A peer that won the lock instead: decided on like any owner (attached), recorded as a race.
  {
    const w = world();
    w.onSpawn = (pid) => setTimeout(() => {
      w.alive.set(77, true); w.created.set(77, 4_000_000); w.writeOwner(owner(77, "READY", "peer", 4_000_000));
      w.spawnState = { pid, exitCode: 3 }; w.portOpen = true; w.health = healthOf("peer");
    }, 2);
    assert.equal((await w.ownership.ensure()).decision, "ATTACHED_EXISTING");
    assert.equal(w.events[0].triggerReason, "singleton_race");
  }
  // 11. Stop: clean only on the receipt of that instance and generation; past the grace only that owner is ended.
  {
    const w = world();
    w.alive.set(10, true); w.created.set(10, 1_000_000); w.writeOwner(owner(10, "READY", "run"));
    w.onStop = () => setTimeout(() => { w.writeReceipt({ daemon_instance_id: "run", generation: 1, clean: true }); w.clearOwner(); w.alive.set(10, false); }, 2);
    const clean = await w.ownership.stop("full_shutdown");
    assert.deepEqual([clean.ok, clean.stopped], [true, true]);

    w.alive.set(11, true); w.created.set(11, 1_000_000); w.writeOwner(owner(11, "READY", "run2"));
    w.onStop = () => setTimeout(() => { w.writeReceipt({ daemon_instance_id: "someone-else", generation: 1, clean: true }); w.alive.set(11, false); }, 2);
    const unbound = await w.ownership.stop("full_shutdown");
    assert.deepEqual([unbound.ok, unbound.error], [false, "TEST DAEMON exited without a stop receipt"]);

    w.alive.set(12, true); w.created.set(12, 1_000_000); w.writeOwner(owner(12, "READY", "stuck"));
    w.onStop = null;
    const forced = await w.ownership.stop("full_shutdown");
    assert.deepEqual([forced.ok, forced.forced, w.terminated], [false, true, [12]]);
    const record = w.events.find((e) => e.mechanismId === "health.forced_termination");
    assert.deepEqual([record.triggerReason, record.detail.pid, record.detail.instance_id], ["stop_grace_exceeded", 12, "stuck"]);
  }
  // 12. Health probe: the expected identity and protocol, bounded.
  {
    const w = world();
    w.portOpen = true;
    w.health = healthOf("x", { protocol_version: {} });
    assert.equal((await w.ownership.probeHealth()).compatible, false);
    w.health = healthOf("x");
    assert.equal((await w.ownership.probeHealth()).compatible, true);
  }
  console.log("provider daemon ownership contract passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
