"use strict";

const { makeTempDir } = require("./support/temp_dirs.cjs");
// Health's process supervision and controlled network apply (docs/system-architecture/04 sections 4-5,
// 06 sections 5-6, 08 CFG-11..16). Fake service hosts, a real revision store in a temp config root and the real
// manifest/resolver: what is pinned is the ORDER of stop/start, the per-service verification, the conflict and
// idempotency rules, rollback when a candidate cannot come up, refusal (nothing stopped) when a candidate port is
// held by something unknown, and the bootstrap path for Health's/app_api's own endpoint.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

delete process.env.STOCK_MONITOR_PORT_OVERRIDES;
delete process.env.STOCK_MONITOR_NETWORK_REVISION;

const networkConfig = require("../config/js/network_config.js");
const { ConfigRevisionStore } = require("../config/js/config_revisions.js");
const { Supervisor, RESTART_BUDGET, restartSummary } = require("../health/supervisor.js");
const { NetworkOperations } = require("../health/operations.js");

const manifest = networkConfig.loadManifest(networkConfig.manifestPath(process.env));
const BASE = 39000 + Math.floor(Math.random() * 400) * 2;

function freeLayout(offset = 0) {
  // Every listener away from the defaults: the machine running this test may be running the real App.
  const services = {};
  for (const spec of manifest.services) {
    if (spec.listener && spec.default_port && true) services[spec.service_id] = { port: BASE + offset + (spec.default_port % 1000) };
  }
  return { services };
}

class FakeHost {
  constructor(sid, log, effectiveRef) {
    Object.assign(this, { sid, log, effectiveRef, running: false, failStart: false, revision: undefined });
  }
  async ensure() {
    this.log.push(`start:${this.sid}`);
    if (this.failStart) throw new Error(`${this.sid} cannot bind`);
    this.running = true;
    this.revision = this.effectiveRef().revision;
    this.boundPort = this.effectiveRef().services[this.sid]?.port;
    this.boundHost = this.effectiveRef().services[this.sid]?.host;
    return { pid: 1 };
  }
  async stop() { this.log.push(`stop:${this.sid}`); this.running = false; return { ok: true }; }
  // Like every managed listener: its own revision and bound port.
  async supervisorProbe() {
    return { alive: this.running, verified: this.running, occupied: this.running, config_revision: this.revision,
      bound_host: this.boundHost, bound_port: this.boundPort };
  }
}

async function harness({ services = ["realtime_api", "app_api", "provider_shioaji", "market_runtime"] } = {}) {
  const root = makeTempDir("sm-ops-");
  const store = new ConfigRevisionStore(root, "network");
  const r1 = await store.save(freeLayout(), { source: "test", activate: true });
  const effective = networkConfig.resolve(manifest, { saved: r1, env: {} });
  assert.deepEqual(effective.problems, [], "the test layout itself is valid");
  const log = [];
  const effectiveRef = () => effective;
  const hosts = Object.fromEntries(services.map((sid) => [sid, new FakeHost(sid, log, effectiveRef)]));
  const entries = Object.fromEntries(services.map((sid) => [sid, { host: hosts[sid], autostart: true, after: sid === "market_runtime" ? [] : ["market_runtime"], watch: true }]));
  const supervisor = new Supervisor({ entries, logger: { warn() {}, error() {}, log() {} } });
  const restarts = [];
  const ops = new NetworkOperations({ configRoot: root, manifest, supervisor, entries, effectiveRef, hosts,
    restartHealth: (op) => restarts.push(op.candidate_revision), logger: { warn() {}, error() {}, log() {} } });
  return { root, store, r1, effective, log, hosts, entries, supervisor, ops, restarts };
}

async function candidate(store, mutate) {
  const values = JSON.parse(JSON.stringify(store.get(store.pointer().latest).values));
  mutate(values.services);
  return store.save(values, { expectedRevision: store.pointer().latest, source: "test" });
}

test("supervisor starts in dependency order, isolates a failure, and stops into a contract state", async () => {
  const h = await harness();
  h.hosts.app_api.failStart = true;
  const results = await h.supervisor.startAll();
  assert.equal(h.log[0], "start:market_runtime", "market_runtime (every other service depends on it) starts before everything else");
  assert.equal(results.app_api.ok, false);
  assert.equal(results.realtime_api.ok, true, "one service failing never stops the others");
  assert.equal(h.supervisor.stateOf("app_api"), "FAILED");
  await h.supervisor.stop("realtime_api", "test");
  assert.equal(h.supervisor.stateOf("realtime_api"), "DISABLED", "no STOPPED state exists in the contract");
  assert.match(h.supervisor.reasonOf("realtime_api"), /^stopped: test/);
});

test("the watch loop restarts a vanished service within a bounded budget and never touches an unverified occupant", async () => {
  const h = await harness({ services: ["realtime_api", "app_api"] });
  await h.supervisor.startAll();
  h.hosts.app_api.supervisorProbe = async () => ({ alive: false, occupied: true, verified: false });
  for (let i = 0; i < RESTART_BUDGET + 2; i += 1) {
    h.hosts.realtime_api.running = false;
    await h.supervisor.tick();
    await new Promise((r) => setImmediate(r));
  }
  const restarts = h.log.filter((l) => l === "start:realtime_api").length - 1;
  assert.equal(restarts, RESTART_BUDGET, "automatic restarts are capped");
  assert.match(h.supervisor.reasonOf("realtime_api"), /RESTART_LIMIT/);
  assert.equal(h.log.filter((l) => l === "start:app_api").length, 1, "an unverified occupant is never restarted over");
  assert.match(h.supervisor.reasonOf("app_api"), /unverified occupant/);
});

test("an alive but unverified service is never RUNNING (Codex R08-05)", async () => {
  const h = await harness({ services: ["realtime_api", "app_api"] });
  await h.supervisor.startAll();
  h.hosts.realtime_api.supervisorProbe = async () => ({ alive: true, verified: false, identity_verified: true,
    payload: { runtime_state: "DAEMON_HALF_DEAD" } });
  h.hosts.app_api.supervisorProbe = async () => ({ alive: true, verified: false, identity_verified: false });
  await h.supervisor.tick();
  assert.equal(h.supervisor.stateOf("realtime_api"), "DEGRADED");
  assert.match(h.supervisor.reasonOf("realtime_api"), /DAEMON_HALF_DEAD/);
  assert.equal(h.supervisor.stateOf("app_api"), "FAILED");
  assert.equal(h.log.filter((l) => l.startsWith("start:")).length, 2, "neither is restarted or killed on that evidence");
  h.hosts.realtime_api.supervisorProbe = async () => ({ alive: true, verified: true });
  await h.supervisor.tick();
  assert.equal(h.supervisor.stateOf("realtime_api"), "RUNNING");
});

test("a probe that does not answer is not a restart, and it does not hold up the other services' checks", async () => {
  const h = await harness({ services: ["realtime_api", "app_api"] });
  h.supervisor.probeTimeoutMs = 20;
  await h.supervisor.startAll();
  h.hosts.realtime_api.supervisorProbe = () => new Promise(() => {});   // busy, never answers
  h.hosts.app_api.running = false;                               // genuinely gone
  await h.supervisor.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.log.filter((l) => l === "start:realtime_api").length, 1, "an unanswered probe never restarts the service");
  assert.equal(h.log.filter((l) => l === "start:app_api").length, 2, "the next service is still checked and recovered");
});

test("a port change stops dependents-first, verifies every service, and activates only after all are verified", async () => {
  const h = await harness();
  await h.supervisor.startAll();
  h.log.length = 0;
  const r2 = await await candidate(h.store, (s) => { s.provider_shioaji.port += 50; });
  const preview = await h.ops.preview({ candidate_revision: r2.revision });
  assert.deepEqual(preview.plan.changed, ["provider_shioaji"]);
  const result = await h.ops.apply({ operation_id: "op-a", candidate_revision: r2.revision, expected_active_revision: h.r1.revision });
  assert.equal(result.ok, true, JSON.stringify(result.operation?.history));
  assert.equal(result.operation.state, "APPLIED");
  const stops = h.log.filter((l) => l.startsWith("stop:"));
  const starts = h.log.filter((l) => l.startsWith("start:"));
  assert.equal(stops.at(-1), "stop:provider_shioaji", "the changed service stops after its clients");
  assert.equal(starts[0], "start:provider_shioaji", "and starts before them");
  assert.ok(!h.log.includes("stop:market_runtime"), "a service the change does not affect is left running");
  for (const [sid, entry] of Object.entries(result.operation.services)) {
    assert.equal(entry.state, "APPLIED", `${sid} verified`);
  }
  assert.equal(h.store.pointer().active, r2.revision);
  assert.equal(h.hosts.realtime_api.revision, r2.revision, "restarted clients came up on the candidate revision");
  const again = await h.ops.apply({ operation_id: "op-a", candidate_revision: r2.revision, expected_active_revision: h.r1.revision });
  assert.equal(again.idempotent, true, "a resend with the same operation_id returns the same record");
});

test("a stale expected active revision is a conflict and nothing is stopped", async () => {
  const h = await harness();
  await h.supervisor.startAll();
  h.log.length = 0;
  const r2 = await await candidate(h.store, (s) => { s.realtime_api.port += 50; });
  const result = await h.ops.apply({ operation_id: "op-c", candidate_revision: r2.revision, expected_active_revision: 99 });
  assert.equal(result.ok, false);
  assert.equal(result.operation.state, "CONFLICT");
  assert.deepEqual(h.log, []);
  assert.equal(h.store.pointer().active, h.r1.revision);
});

test("a candidate port held by an unknown process is rejected before anything stops", async () => {
  const h = await harness();
  await h.supervisor.startAll();
  h.log.length = 0;
  const squatter = net.createServer();
  await new Promise((r) => squatter.listen(0, "127.0.0.1", r));
  try {
    const port = squatter.address().port;
    const r2 = await await candidate(h.store, (s) => { s.realtime_api.port = port; });
    const result = await h.ops.apply({ operation_id: "op-u", candidate_revision: r2.revision, expected_active_revision: h.r1.revision });
    assert.equal(result.operation.state, "REJECTED");
    assert.equal(result.operation.problems[0].code, "PORT_OCCUPIED_BY_UNKNOWN");
    assert.deepEqual(h.log, [], "pre-check failure stops nothing");
  } finally {
    squatter.close();
  }
});

test("a candidate that cannot come up rolls back to the previous revision and keeps it active", async () => {
  const h = await harness();
  await h.supervisor.startAll();
  const r2 = await await candidate(h.store, (s) => { s.realtime_api.port += 50; });
  let attempts = 0;
  const original = h.hosts.realtime_api.ensure.bind(h.hosts.realtime_api);
  h.hosts.realtime_api.ensure = async () => { attempts += 1; if (attempts === 1) throw new Error("bind failed"); return original(); };
  const result = await h.ops.apply({ operation_id: "op-r", candidate_revision: r2.revision, expected_active_revision: h.r1.revision });
  assert.equal(result.ok, false);
  assert.equal(result.operation.state, "ROLLED_BACK");
  assert.equal(h.store.pointer().active, h.r1.revision, "the previous revision stays active");
  assert.equal(h.effective.revision, h.r1.revision, "and effective");
  assert.equal(h.hosts.realtime_api.revision, h.r1.revision, "the service is back on the previous revision");
});

test("changing app_api's own endpoint goes through the bootstrap restart", async () => {
  const h = await harness();
  await h.supervisor.startAll();
  h.log.length = 0;
  const r2 = await await candidate(h.store, (s) => { s.app_api.port += 50; });
  const result = await h.ops.apply({ operation_id: "op-s", candidate_revision: r2.revision, expected_active_revision: h.r1.revision });
  assert.equal(result.pending_restart, true);
  assert.equal(result.operation.state, "RUNNING");
  assert.equal(result.operation.phase, "restarting_self");
  assert.deepEqual(h.restarts, [r2.revision]);
  assert.equal(NetworkOperations.pendingBootstrap(h.root).useCandidate, false, "no shutdown receipt yet: never the candidate (S2d-02)");
  h.ops.recordHandoff(result.operation, { ok: true, receipts: {} });
  const pending = NetworkOperations.pendingBootstrap(h.root);
  assert.equal(pending.useCandidate, true);
  assert.equal(pending.startRevision.revision, r2.revision, "the restarted Health starts from the candidate");
  await NetworkOperations.markCandidateFailed(h.root, pending.operation, "could not bind");
  const fallback = NetworkOperations.pendingBootstrap(h.root);
  assert.equal(fallback.useCandidate, false);
  assert.equal(fallback.startRevision.revision, h.r1.revision, "after a failed candidate the bootstrap starts the previous revision");
  const record = await h.ops.resumeAfterBootstrap(fallback);
  assert.equal(record.state, "ROLLED_BACK");
  assert.equal(NetworkOperations.pendingBootstrap(h.root), null, "a terminal operation leaves no pending bootstrap");
});

test("two concurrent applies: the second is refused before anything is stopped (Codex R9-9)", async () => {
  const h = await harness();
  await h.supervisor.startAll();
  h.log.length = 0;
  const r2 = await await candidate(h.store, (s) => { s.provider_shioaji.port += 50; });
  const first = h.ops.apply({ operation_id: "op-1", candidate_revision: r2.revision, expected_active_revision: h.r1.revision });
  const second = await h.ops.apply({ operation_id: "op-2", candidate_revision: r2.revision, expected_active_revision: h.r1.revision });
  assert.equal(second.ok, false);
  assert.equal(second.error, "OPERATION_IN_PROGRESS");
  assert.equal((await first).ok, true);
  assert.equal(h.log.filter((l) => l === "stop:provider_shioaji").length, 1, "the service was restarted once");
});

test("a bootstrap resume does not accept an alive service of the wrong revision (Codex R9-10)", async () => {
  const h = await harness();
  await h.supervisor.startAll();
  const r2 = await await candidate(h.store, (s) => { s.app_api.port += 50; });
  const applied = await h.ops.apply({ operation_id: "op-r", candidate_revision: r2.revision, expected_active_revision: h.r1.revision });
  h.ops.recordHandoff(applied.operation, { ok: true, receipts: {} });
  const pending = NetworkOperations.pendingBootstrap(h.root);
  assert.equal(pending.useCandidate, true);
  // Everything answers alive and verified, but the services still run the previous revision.
  for (const host of Object.values(h.hosts)) host.revision = h.r1.revision;
  const record = await h.ops.resumeAfterBootstrap(pending);
  assert.notEqual(record.state, "APPLIED", "an old-revision occupant is not the applied candidate");
  assert.ok(Object.values(record.services).some((e) => e.steps.some((s) => s.step === "identity_verified" && s.ok === false)));
});

test("each startup outcome carries when its attempt began, and a new attempt is visible as starting (10-05)", async () => {
  let clock = 1000;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const host = { calls: 0, async ensure() { this.calls += 1; if (this.calls === 2) await gate; return { pid: 7 }; } };
  const supervisor = new Supervisor({ entries: { app_api: { host, autostart: true } }, logger: { log() {}, warn() {}, error() {} }, now: () => clock });
  await supervisor.startAll();
  assert.deepEqual([supervisor.startup.app_api.status, supervisor.startup.app_api.started_at], ["ready", 1000]);
  // A UI attaches later and asks for start-all: until that attempt settles, the old "ready" must not show.
  clock = 5000;
  const again = supervisor.startAll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([supervisor.startup.app_api.status, supervisor.startup.app_api.started_at], ["starting", 5000]);
  release();
  await again;
  assert.deepEqual([supervisor.startup.app_api.status, supervisor.startup.app_api.started_at], ["ready", 5000]);
});

test("an unclean shutdown before the handoff turns the operation to rollback before Health exits (S2d-02)", async () => {
  const h = await harness();
  await h.supervisor.startAll();
  const r2 = await await candidate(h.store, (s) => { s.app_api.port += 50; });
  const applied = await h.ops.apply({ operation_id: "op-h", candidate_revision: r2.revision, expected_active_revision: h.r1.revision });
  const record = h.ops.recordHandoff(applied.operation, { ok: false, receipts: { provider_shioaji: { ok: false } } });
  assert.equal(record.phase, "bootstrap_rollback");
  assert.deepEqual(record.handoff_receipt.failed_services, ["provider_shioaji"]);
  const pending = NetworkOperations.pendingBootstrap(h.root);
  assert.equal(pending.useCandidate, false);
  assert.equal(pending.startRevision.revision, h.r1.revision);
  // A receipt under another token is not this operation's.
  const file = path.join(h.root, "operations", "active.json");
  const forged = JSON.parse(fs.readFileSync(file, "utf8"));
  Object.assign(forged, { phase: "restarting_self", state: "RUNNING", handoff_receipt: { token: "other", clean: true } });
  fs.writeFileSync(file, JSON.stringify(forged));
  assert.equal(NetworkOperations.pendingBootstrap(h.root).useCandidate, false);
});

test("a pending operation is claimed: no new apply until it is resumed, then it is finished and recorded (S2d-03, S1-54)", async () => {
  const h = await harness();
  await h.supervisor.startAll();
  const r2 = await await candidate(h.store, (s) => { s.provider_shioaji.port += 50; });
  // A Health that crashed mid-apply left a RUNNING operation behind.
  const op = { operation_id: "op-x", kind: "network", state: "RUNNING", candidate_revision: r2.revision, previous_revision: h.r1.revision,
    services: {}, history: [] };
  fs.mkdirSync(path.join(h.root, "operations"), { recursive: true });
  fs.writeFileSync(path.join(h.root, "operations", "active.json"), JSON.stringify(op));
  fs.writeFileSync(path.join(h.root, "operations", "op-x.json"), JSON.stringify(op));
  const pending = NetworkOperations.pendingBootstrap(h.root);
  assert.equal(pending.useCandidate, false);
  assert.equal(pending.startRevision.revision, h.r1.revision);
  const events = [];
  h.ops.remediation = { emit: (event) => events.push(event) };
  h.ops.claim(pending.operation);
  const refused = await h.ops.apply({ operation_id: "op-y", candidate_revision: r2.revision, expected_active_revision: h.r1.revision });
  assert.equal(refused.error, "OPERATION_IN_PROGRESS");
  const record = await h.ops.resumeAfterBootstrap(pending);
  assert.equal(record.state, "ROLLED_BACK");
  assert.equal(h.ops.running, null, "released once terminal");
  assert.deepEqual(events.map((e) => [e.mechanismId, e.triggerReason, e.outcome]), [["network.apply_recovery", "interrupted_operation", "succeeded"]]);
  assert.equal(NetworkOperations.pendingBootstrap(h.root), null);
});

test("a rollback starts nothing while a candidate instance is still running (S2d-01)", async () => {
  const h = await harness();
  await h.supervisor.startAll();
  const r2 = await await candidate(h.store, (s) => { s.realtime_api.port += 50; });
  h.hosts.realtime_api.ensure = async () => { throw new Error("bind failed"); };
  // The failed candidate realtime_api does not go away on its second stop (the rollback's).
  const host = h.hosts.realtime_api;
  const realStop = host.stop.bind(host);
  let stops = 0;
  host.stop = async () => { stops += 1; const r = await realStop(); if (stops > 1) host.running = true; return r; };
  h.log.length = 0;
  const result = await h.ops.apply({ operation_id: "op-f", candidate_revision: r2.revision, expected_active_revision: h.r1.revision });
  assert.equal(result.operation.state, "ROLLBACK_FAILED");
  assert.match(JSON.stringify(result.operation), /candidate not fenced: realtime_api/);
  assert.equal(h.store.pointer().active, h.r1.revision);
  const afterFailure = h.log.slice(h.log.lastIndexOf("start:realtime_api") + 1);
  assert.ok(!afterFailure.some((l) => l.startsWith("start:")), "the previous revision is not started next to a live candidate");
});

test("a listener that reports no config revision or another bound port is not verified (S2d-06)", async () => {
  const h = await harness();
  const port = h.effective.services.realtime_api.port;
  assert.equal(h.ops.identityProblem("realtime_api", { verified: true, bound_port: port }, h.r1.revision), "identity reports no config revision");
  assert.match(h.ops.identityProblem("realtime_api", { verified: true, config_revision: h.r1.revision, bound_port: port + 1 }, h.r1.revision), /bound port/);
  const host = h.effective.services.realtime_api.host;
  assert.equal(h.ops.identityProblem("realtime_api", { verified: true, config_revision: h.r1.revision, bound_host: host, bound_port: port }, h.r1.revision), null);
  // The address is part of it -- the right port on every interface is not the loopback asked for.
  assert.match(h.ops.identityProblem("realtime_api", { verified: true, config_revision: h.r1.revision, bound_host: "0.0.0.0", bound_port: port }, h.r1.revision), /bound host/);
  assert.match(h.ops.identityProblem("realtime_api", { verified: true, config_revision: h.r1.revision, bound_port: port }, h.r1.revision), /bound host/);
});

test("the active pointer is the commit point: a committed operation rolls forward, a rollback puts it back (CX-62)", async () => {
  const h = await harness();
  await h.supervisor.startAll();
  const r2 = await await candidate(h.store, (s) => { s.provider_shioaji.port += 50; });
  const op = { operation_id: "op-c", kind: "network", state: "RUNNING", candidate_revision: r2.revision, previous_revision: h.r1.revision,
    services: {}, history: [] };
  fs.mkdirSync(path.join(h.root, "operations"), { recursive: true });
  fs.writeFileSync(path.join(h.root, "operations", "active.json"), JSON.stringify(op));
  fs.writeFileSync(path.join(h.root, "operations", "op-c.json"), JSON.stringify(op));
  // Health died between switching the pointer and writing APPLIED.
  await h.store.setActive(r2.revision, { verified: true, expectedActive: h.r1.revision });
  const committed = NetworkOperations.pendingBootstrap(h.root);
  assert.equal(committed.useCandidate, true, "committed: rolled forward");
  assert.equal(committed.startRevision.revision, r2.revision);
  // The candidate does not come up after the restart: the pointer goes back before the rollback restart.
  h.ops.claim(committed.operation);
  const record = await h.ops.resumeAfterBootstrap(committed);
  assert.equal(record.phase, "bootstrap_rollback");
  assert.equal(h.store.pointer().active, h.r1.revision, "the pointer names the previous revision again");
  assert.equal(h.store.pointer().last_good, h.r1.revision);
  const next = NetworkOperations.pendingBootstrap(h.root);
  assert.equal(next.useCandidate, false);
  assert.equal(next.startRevision.revision, h.r1.revision);
});

test("a service that requires another starts only once it is ready, and the watch loop starts it then (CX-149)", async () => {
  const log = [];
  const host = (sid, { fail = false } = {}) => ({
    running: false, fail,
    async ensure() { log.push(`start:${sid}`); if (this.fail) throw new Error(`${sid} cannot start`); this.running = true; return { pid: 1 }; },
    async stop() { this.running = false; return { ok: true }; },
    async supervisorProbe() { return { alive: this.running, verified: this.running, instance_id: this.running ? `${sid}-1` : null }; },
  });
  const hosts = { market_runtime: host("market_runtime"), app_api: host("app_api", { fail: true }), analysis_runtime: host("analysis_runtime"),
    reader: host("reader") };
  const entries = {
    market_runtime: { host: hosts.market_runtime, autostart: true, watch: true },
    app_api: { host: hosts.app_api, autostart: true, watch: true },
    analysis_runtime: { host: hosts.analysis_runtime, autostart: true, after: ["market_runtime", "app_api"], requires: ["market_runtime", "app_api"], watch: true },
    reader: { host: hosts.reader, autostart: true, after: ["app_api"], watch: true },
  };
  const supervisor = new Supervisor({ entries, logger: { warn() {}, error() {}, log() {} } });
  const results = await supervisor.startAll();
  assert.equal(results.analysis_runtime.ok, false);
  assert.ok(results.analysis_runtime.blocked);
  assert.ok(!log.includes("start:analysis_runtime"), "not started while app_api, which it requires, failed");
  assert.equal(supervisor.stateOf("analysis_runtime"), "FAILED");
  assert.match(supervisor.reasonOf("analysis_runtime"), /^BLOCKED: waiting for app_api/);
  assert.equal(supervisor.startup.analysis_runtime.status, "failed", "a startup poller gets an outcome");
  assert.deepEqual(supervisor.startup.analysis_runtime.blocked_by, ["app_api"]);
  assert.equal(results.reader.ok, true, "`after` alone is order: a failed predecessor does not hold it back");

  // The watch loop's own recovery of app_api runs in the background; wait for it before the next step.
  const idle = async () => { while (supervisor.ops.size) await Promise.allSettled([...supervisor.ops.values()].map((op) => op.promise)); };
  await supervisor.tickOnce();
  await idle();
  assert.ok(!log.includes("start:analysis_runtime"), "still blocked while app_api is not running");
  hosts.app_api.fail = false;
  await supervisor.ensure("app_api", "test");
  await supervisor.tickOnce();
  await idle();
  assert.ok(log.includes("start:analysis_runtime"), "started once every required service runs");
  assert.equal(supervisor.stateOf("analysis_runtime"), "RUNNING");
  assert.equal(supervisor.blocked.size, 0);
});

test("an interrupted apply's candidate is stopped and proven gone before the previous revision starts (CX-61)", async () => {
  const h = await harness();
  await h.supervisor.startAll();
  const r2 = await await candidate(h.store, (s) => { s.realtime_api.port += 50; });
  const op = { operation_id: "op-i", kind: "network", state: "RUNNING", candidate_revision: r2.revision, previous_revision: h.r1.revision,
    preview: { stop_order: ["realtime_api"] }, services: {}, history: [] };
  fs.mkdirSync(path.join(h.root, "operations"), { recursive: true });
  fs.writeFileSync(path.join(h.root, "operations", "active.json"), JSON.stringify(op));
  fs.writeFileSync(path.join(h.root, "operations", "op-i.json"), JSON.stringify(op));
  // The candidate realtime_api survived the Health that started it: running, on the candidate revision.
  const host = h.hosts.realtime_api;
  Object.assign(host, { running: true, revision: r2.revision });
  const pending = NetworkOperations.pendingBootstrap(h.root);
  assert.equal(pending.useCandidate, false);
  h.log.length = 0;
  const fence = await h.ops.fenceInterrupted(pending);
  assert.deepEqual(fence, { ok: true, unfenced: [], at: fence.at }, "resolved from its revision: no problem recorded");
  assert.deepEqual(h.log, ["stop:realtime_api"], "the candidate is stopped; nothing is started");
  assert.equal(h.effective.revision, h.r1.revision, "the effective config is the previous one again");

  // One that does not go away is not started over: the operation ends ROLLBACK_FAILED.
  const stuck = { ...op, operation_id: "op-j" };
  fs.writeFileSync(path.join(h.root, "operations", "active.json"), JSON.stringify(stuck));
  fs.writeFileSync(path.join(h.root, "operations", "op-j.json"), JSON.stringify(stuck));
  Object.assign(host, { running: true, revision: r2.revision });
  host.stop = async () => ({ ok: false, error: "still there" });
  const pendingJ = NetworkOperations.pendingBootstrap(h.root);
  const fenceJ = await h.ops.fenceInterrupted(pendingJ);
  assert.deepEqual(fenceJ.unfenced, ["realtime_api"]);
  h.log.length = 0;
  const results = await h.supervisor.startAll("startup", { skip: fenceJ.unfenced });
  assert.equal(results.realtime_api.ok, false);
  assert.ok(!h.log.includes("start:realtime_api"), "withheld, not started beside the candidate");
  h.ops.claim(pendingJ.operation);
  const record = await h.ops.resumeAfterBootstrap(pendingJ);
  assert.equal(record.state, "ROLLBACK_FAILED");
  assert.match(JSON.stringify(record.history), /candidate not fenced: realtime_api/);
});

test("a candidate whose revision cannot be read is fenced on its persisted endpoint; one with none stays unfenced", async () => {
  const h = await harness();
  await h.supervisor.startAll();
  const at = h.effective.services.realtime_api;
  fs.mkdirSync(path.join(h.root, "operations"), { recursive: true });
  const write = (op) => {
    fs.writeFileSync(path.join(h.root, "operations", "active.json"), JSON.stringify(op));
    fs.writeFileSync(path.join(h.root, "operations", `${op.operation_id}.json`), JSON.stringify(op));
  };
  // Revision 999 does not exist (lost, or written by another build): its endpoints come from the operation itself.
  const op = { operation_id: "op-u", kind: "network", state: "RUNNING", candidate_revision: 999, previous_revision: h.r1.revision,
    preview: { stop_order: ["realtime_api"] }, candidates: { realtime_api: { revision: 999, host: at.host, port: at.port + 50, pid: null } },
    services: {}, history: [] };
  write(op);
  Object.assign(h.hosts.realtime_api, { running: true, revision: 999 });
  h.log.length = 0;
  const fence = await h.ops.fenceInterrupted(NetworkOperations.pendingBootstrap(h.root));
  assert.equal(fence.ok, true);
  assert.deepEqual(h.log, ["stop:realtime_api"], "stopped on the persisted candidate endpoint");
  assert.equal(fence.candidate_revision_problem, "candidate revision 999 unreadable");

  // No revision and no persisted endpoint: nothing proves the candidate gone, so it is unfenced -- never "ok".
  const blind = { ...op, operation_id: "op-v", candidates: undefined };
  write(blind);
  Object.assign(h.hosts.realtime_api, { running: true, revision: 999 });
  const fenceV = await h.ops.fenceInterrupted(NetworkOperations.pendingBootstrap(h.root));
  assert.deepEqual(fenceV.unfenced, ["realtime_api"]);
  assert.equal(fenceV.ok, false);
});

test("a rollback whose active pointer cannot be put back is ROLLBACK_FAILED, not ROLLED_BACK", async () => {
  const h = await harness();
  await h.supervisor.startAll();
  const r2 = await await candidate(h.store, (s) => { s.realtime_api.port += 50; });
  await h.store.setActive(r2.revision, { verified: true, expectedActive: h.r1.revision });
  const op = { operation_id: "op-p", kind: "network", state: "ROLLING_BACK", phase: "bootstrap_rollback", candidate_revision: r2.revision,
    previous_revision: h.r1.revision, bootstrap_candidate_failed: true, services: {}, history: [] };
  fs.mkdirSync(path.join(h.root, "operations"), { recursive: true });
  fs.writeFileSync(path.join(h.root, "operations", "op-p.json"), JSON.stringify(op));
  h.ops.store.restoreActive = async () => { throw new Error("pointer file locked"); };
  h.ops.claim(op);
  const record = await h.ops.resumeAfterBootstrap({ operation: op, useCandidate: false });
  assert.equal(record.state, "ROLLBACK_FAILED");
  assert.equal(record.pointer_restored.ok, false);
  assert.match(JSON.stringify(record.history), /active pointer could not be put back: pointer file locked/);
  assert.equal(h.store.pointer().active, r2.revision, "the pointer really still names the candidate");
});

test("the restart budget survives a Health restart, and each restart names the old and new instance (S2d-15)", async () => {
  const budgetFile = path.join(makeTempDir("sm-budget-"), "restart_budget.json");
  const log = [];
  const effective = { services: {}, revision: null };
  const make = () => {
    const host = new FakeHost("realtime_api", log, () => effective);
    let instance = 0;
    host.ensure = async function ensure() { this.running = true; instance += 1; this.instance = `i${instance}`; return { pid: instance }; };
    host.supervisorProbe = async function probe() { return { alive: this.running, verified: this.running, instance_id: this.instance, pid: 7 }; };
    return host;
  };
  const events = [];
  const remediation = { begin: (start) => ({ finish: (outcome, extra) => events.push({ start, outcome, extra }) }) };
  let host = make();
  let supervisor = new Supervisor({ entries: { realtime_api: { host, autostart: true, watch: true } }, logger: { warn() {}, log() {}, error() {} }, remediation, budgetFile });
  await supervisor.startAll();
  for (let i = 0; i < 3; i += 1) {
    await supervisor.tick();
    host.running = false;
    await supervisor.tick();
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(JSON.parse(fs.readFileSync(budgetFile, "utf8")).restarts.realtime_api.length, 3);
  const first = events[0];
  assert.equal(first.start.detail.old_instance, "i1");
  assert.equal(first.extra.detail.new_instance, "i2");
  assert.equal(first.extra.attempt, 1);
  // A new Health: the same three restarts are still counted against the budget.
  host = make();
  supervisor = new Supervisor({ entries: { realtime_api: { host, autostart: true, watch: true } }, logger: { warn() {}, log() {}, error() {} }, remediation, budgetFile });
  assert.equal((supervisor.restarts.get("realtime_api") || []).length, 3);
  await supervisor.restart("realtime_api", "explicit");
  assert.deepEqual(JSON.parse(fs.readFileSync(budgetFile, "utf8")).restarts.realtime_api, [], "only an explicit restart restores it");
});

test("a start-all while one runs is that attempt; every service's outcome names it (CX-73)", async () => {
  const h = await harness({ services: ["realtime_api", "app_api"] });
  const first = h.supervisor.startAll("startup");
  const generation = h.supervisor.attempt.generation;
  const second = h.supervisor.startAll("control_start_all");
  assert.equal(second, first, "the same run");
  assert.equal(h.supervisor.attempt.generation, generation, "no second generation");
  await first;
  for (const sid of ["realtime_api", "app_api"]) assert.equal(h.supervisor.startup[sid].attempt, generation);
  await h.supervisor.startAll("again");
  assert.equal(h.supervisor.attempt.generation, generation + 1, "a later request is a new attempt");
});

test("an automatic restart whose fresh probe does not prove the new instance is recorded failed (CX-75)", async () => {
  const h = await harness({ services: ["realtime_api"] });
  await h.supervisor.startAll();
  const events = [];
  h.supervisor.remediation = { begin: (f) => ({ finish: (outcome, extra) => events.push([f.mechanismId, outcome, extra?.detail?.probe?.alive]) }),
    emit: () => {} };
  const host = h.hosts.realtime_api;
  host.running = false;
  host.ensure = async () => ({ pid: 9 });          // claims a start, but nothing is running afterwards
  await h.supervisor.tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(events, [["health.service_restart", "failed", false]]);
});

test("Health's restart summary for 系統拓樸: today, 7 days and which services, from the remediation ledger's status", () => {
  const status = { mechanisms: [{ mechanism_id: "other.thing", today: 9, last_7_days: 9 },
    { mechanism_id: "health.service_restart", today: 1, last_7_days: 3, last_7_days_by_service: { market_runtime: 2, provider_futu: 1 } }] };
  assert.deepEqual(restartSummary(status), { today: 1, last_7_days: 3, last_7_days_by_service: { market_runtime: 2, provider_futu: 1 } });
  assert.equal(restartSummary({ mechanisms: [] }), null, "not registered: no summary, not zeros");
  assert.equal(restartSummary(null), null);
});
