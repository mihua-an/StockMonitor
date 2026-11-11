"use strict";

// Controlled network apply (docs/system-architecture/06 sections 5-6, 08 CFG-11..16, CFG-20).
//
// draft -> validate/preview -> saved revision (settings_api) -> Health operation -> verify each service -> effective
// or recovered. One operation at a time (serialized); a resend with the same operation_id returns the same record.
// The operation names the candidate revision and the active revision it expects; anything else is a conflict.
//
// Regular services: pre-check the new ports (not held by anything unknown, no duplicate binding), then stop the
// affected services dependents-first, verify each port was released, switch the effective config, start them
// dependencies-first, and verify service_id + config revision on every one. Any failure rolls back to the
// previous revision -- which itself must re-bind and verify, and can fail; that is recorded, never hidden.
//
// Health's or settings_api's own endpoint: the operation is persisted with its candidate and previous revisions and
// a handoff token; Health performs the full App shutdown, writes the shutdown receipt under that token into the
// operation, and exits with code 75. The local bootstrap restarts Health, which starts from the candidate only when
// that same operation holds a clean receipt for its token -- else from the previous revision. It verifies
// everything and completes, or, when the candidate cannot come up, starts the previous revision and records the
// operation as rolled back (or not).
//
// Across a Health restart: an operation that is not terminal is claimed before the control
// API listens, so no new apply runs until it is resumed to a terminal state. An apply interrupted by a Health crash
// resumes on the previous revision and is recorded as such.
//
// The active pointer is the one commit point: an operation whose pointer already names its candidate was
// committed, and a Health that restarts mid-way rolls it forward (starts the candidate and verifies it); before that
// it rolls back, and every rollback puts the pointer back. An interrupted apply's candidates -- recorded with their
// endpoint before each start and their pid/instance once verified -- are stopped and proven gone before the
// previous revision starts.
//
// Every rollback and self-endpoint restart is a `network.apply_recovery` remediation. A rollback starts the
// previous revision only after every candidate service is confirmed stopped -- no live instance, port released;
// otherwise it is ROLLBACK_FAILED with nothing started.

const { writeJsonAtomic } = require("../service/platform/js/atomic_files");
const fs = require("fs");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const networkConfig = require("../config/js/network_config.js");
const { probeTcpPort } = require("../service/platform/js/daemon_connection.js");
const { processAliveFast } = require("../service/platform/js/process_utils.js");
const { ConfigRevisionStore } = require("../config/js/config_revisions.js");
const { operation, recordStep, transition, verdict } = require("../config/js/observability_contract.js");

// The service graph comes from config/network_manifest.json alone (network_config.topology(), validated when the
// manifest loads): SELF_SERVICES moving their endpoint restart Health itself (app_api serves the settings part, the
// only writer of saved configuration); CLIENTS[sid] read sid's address once at start, so a change of it restarts
// them; START_ORDER is the dependency order of the managed services.
const TOPOLOGY = networkConfig.topology(networkConfig.loadManifest());
const SELF_SERVICES = Object.freeze(TOPOLOGY.selfServices);
const CLIENTS = Object.freeze(TOPOLOGY.clients);
const START_ORDER = Object.freeze(TOPOLOGY.startOrder);

// A bound host as written in a revision and as a listener reports it: "localhost" is the IPv4 loopback it resolves to.
function normalHost(value) {
  const text = String(value ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return text === "localhost" ? "127.0.0.1" : text;
}

// A port that nothing answers on (no connection within `timeoutMs`).
async function portFree(host, port, timeoutMs = 300) {
  return !(await probeTcpPort(net, port, timeoutMs, host));
}

// One atomic JSON write for every Node owner; this state must survive a power loss.
const atomicWrite = (file, value) => writeJsonAtomic(file, value, { durable: true });

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { /* absent is not an error: no such operation file */ if (error?.code !== "ENOENT") console.warn("[reading an operation record] failed", error); return null; }
}

// An operation id names a file under <config>/operations (and <config>/bootstrap): letters, digits, '.', '_', '-',
// at most 80, never "." / ".." / "active" ("../x" would read and write .json files outside the directory).
const OPERATION_ID = /^[A-Za-z0-9._-]{1,80}$/;
const TERMINAL = ["APPLIED", "FAILED", "ROLLED_BACK", "ROLLBACK_FAILED", "REJECTED", "CONFLICT"];
function validOperationId(id) {
  const text = String(id ?? "");
  return OPERATION_ID.test(text) && ![".", "..", "active"].includes(text) && !text.includes("..");
}
function operationFile(dir, id) {
  if (!validOperationId(id)) throw new Error("INVALID_OPERATION_ID");
  const file = path.resolve(dir, `${id}.json`);
  if (path.dirname(file) !== path.resolve(dir)) throw new Error("INVALID_OPERATION_ID");
  return file;
}

class NetworkOperations {
  constructor({ configRoot, manifest, supervisor, entries, effectiveRef, hosts, restartHealth, instanceId = null,
    remediation = null, onRunningChange = null, logger = console }) {
    Object.assign(this, { configRoot, manifest, supervisor, entries, effectiveRef, hosts, restartHealth, instanceId, remediation,
      onRunningChange, logger });
    this.store = new ConfigRevisionStore(configRoot, "network");
    this.dir = path.join(configRoot, "operations");
    this.running = null;
  }

  // The operation a starting Health must finish before anything else: any non-terminal one on disk. `useCandidate`
  // only for a self-endpoint handoff whose own token carries a clean shutdown receipt.
  static pendingBootstrap(configRoot) {
    const active = readJson(path.join(configRoot, "operations", "active.json"));
    if (!active || TERMINAL.includes(active.state)) return null;
    const store = new ConfigRevisionStore(configRoot, "network");
    // The bootstrap writes its own record when the candidate never came up (it never edits Health's operation).
    const bootstrapFlag = validOperationId(active.operation_id)
      ? readJson(path.join(configRoot, "bootstrap", `candidate_failed_${active.operation_id}.json`)) : null;
    const receipt = active.handoff_receipt;
    const cleanHandoff = Boolean(active.handoff?.token && receipt?.token === active.handoff.token && receipt.clean === true);
    // Committed: the pointer already names the candidate -- it is rolled forward, never left half-way.
    const committed = active.candidate_revision !== null && active.candidate_revision !== undefined
      && store.pointer().active === active.candidate_revision && active.phase !== "bootstrap_rollback";
    const useCandidate = !active.bootstrap_candidate_failed && !bootstrapFlag
      && (committed || (active.phase === "restarting_self" && cleanHandoff));
    let why = null;
    if (!useCandidate) {
      if (active.phase === "restarting_self") why = cleanHandoff ? "candidate marked failed" : "no clean shutdown receipt for this operation's handoff";
      else if (active.phase === "bootstrap_rollback") why = "candidate rolled back";
      else why = `Health restarted while the operation was ${active.state}`;
    }
    const revision = useCandidate ? active.candidate_revision : active.previous_revision;
    return { operation: active, useCandidate, why, startRevision: revision ? store.get(revision) : null };
  }

  // A starting Health claims the pending operation before its control API listens: until resumed to a
  // terminal state, a new apply answers OPERATION_IN_PROGRESS.
  claim(record) { this.setRunning(record); }

  release(record) { if (this.running?.operation_id === record?.operation_id) this.setRunning(null); }

  // The operation in progress; whoever waits for the endpoints to settle is told when it changes.
  setRunning(record) {
    this.running = record;
    try { this.onRunningChange?.(); } catch (error) { console.warn("[network operation: telling the endpoint waiters] failed", error); }
  }

  // One record per recovery outcome of a network operation.
  recordRecovery(op, trigger, outcome, reason = null) {
    try {
      this.remediation?.emit({ component: "network_operations", mechanismId: "network.apply_recovery", triggerReason: trigger, outcome,
        identity: {}, detail: { operation_id: op.operation_id, candidate_revision: op.candidate_revision ?? null,
          previous_revision: op.previous_revision ?? null, state: op.state, reason } });
    } catch (error) { console.warn("[recording the operation event] failed", error); }
  }

  static async markCandidateFailed(configRoot, op, reason) {
    const file = operationFile(path.join(configRoot, "operations"), op.operation_id);
    const record = readJson(file) || op;
    record.bootstrap_candidate_failed = true;
    record.phase = "bootstrap_rollback";
    transition(record, "ROLLING_BACK", { reason });
    await NetworkOperations.restorePointer(new ConfigRevisionStore(configRoot, "network"), record);
    atomicWrite(file, record);
    atomicWrite(path.join(configRoot, "operations", "active.json"), record);
  }

  // The pointer back to the revision the operation replaced, if it names the candidate, read back after the write.
  // True only when the pointer now names that revision; the outcome is recorded on the operation either way.
  static async restorePointer(store, record) {
    const previous = record.previous_revision ?? null;
    const at = new Date().toISOString();
    try {
      const before = store.pointer().active ?? null;
      if (before !== previous && before === (record.candidate_revision ?? null)) {
        await store.restoreActive(previous, { expectedActive: record.candidate_revision });
      }
      const after = store.pointer().active ?? null;
      if (after !== previous) throw new Error(`the active pointer names ${after}, not ${previous}`);
      record.pointer_restored = { ok: true, to: previous, at };
      return true;
    } catch (error) {
      record.pointer_restored = { ok: false, to: previous, failed: String(error?.message || error), at };
      console.warn("[network operation: putting the active pointer back] failed", error);
      return false;
    }
  }

  file(id) { return operationFile(this.dir, id); }

  persist(op) {
    atomicWrite(this.file(op.operation_id), op);
    if (TERMINAL.includes(op.state)) {
      try { fs.unlinkSync(path.join(this.dir, "active.json")); } catch (error) { /* absent is not an error: already removed */ if (error?.code !== "ENOENT") console.warn("[removing the active operation pointer] failed", error); }
    } else {
      atomicWrite(path.join(this.dir, "active.json"), op);
    }
  }

  get(id) { return validOperationId(id) ? readJson(this.file(id)) : null; }

  summary() {
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json") && f !== "active.json"); } catch (error) { /* absent is not an error: no operations yet */ if (error?.code !== "ENOENT") console.warn("[listing operations] failed", error); }
    const ops = files.map((f) => readJson(path.join(this.dir, f))).filter(Boolean).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 20);
    return { running: this.running?.operation_id || null, active: readJson(path.join(this.dir, "active.json")), operations: ops,
      pointer: this.store.pointer() };
  }

  resolve(revisionDoc) {
    return networkConfig.resolve(this.manifest, { saved: revisionDoc, env: process.env });
  }

  plan(current, candidate) {
    const changed = Object.keys(candidate.services).filter((sid) => {
      const a = current.services[sid];
      const b = candidate.services[sid];
      return a && b && (a.port !== b.port || a.host !== b.host);
    });
    const affected = new Set(changed);
    for (const sid of changed) for (const client of CLIENTS[sid] || []) affected.add(client);
    const managed = [...affected].filter((sid) => this.entries[sid] && this.supervisor.enabled(sid));
    const startOrder = START_ORDER.filter((sid) => managed.includes(sid));
    return { changed, affected: managed, stop_order: [...startOrder].reverse(), start_order: startOrder,
      self: changed.filter((sid) => SELF_SERVICES.includes(sid)), renderer_reconnect: changed.some((s) => current.services[s]?.renderer_client === true) };
  }

  async preview({ candidate_revision: candidateRevision }) {
    const doc = this.store.get(candidateRevision);
    if (!doc) return { ok: false, error: "UNKNOWN_REVISION" };
    const candidate = this.resolve(doc);
    if (candidate.problems.length) return { ok: false, error: "INVALID_CANDIDATE", problems: candidate.problems };
    return { ok: true, candidate_revision: candidateRevision, active_revision: this.store.pointer().active, plan: this.plan(this.effectiveRef(), candidate) };
  }

  async precheck(plan, candidate) {
    const problems = [];
    for (const sid of plan.changed) {
      const entry = candidate.services[sid];
      if (!entry.listener || entry.kind === "external" || SELF_SERVICES.includes(sid)) continue;
      const holder = Object.values(this.effectiveRef().services).find((s) => s.port === entry.port && s.host === entry.host && s.service_id !== sid && s.listener);
      const releasedByPlan = holder && plan.affected.includes(holder.service_id);
      if (holder && !releasedByPlan) problems.push({ code: "PORT_IN_USE_BY_SERVICE", service_id: sid, port: entry.port, holder: holder.service_id });
      else if (!holder && !(await portFree(entry.host, entry.port))) problems.push({ code: "PORT_OCCUPIED_BY_UNKNOWN", service_id: sid, port: entry.port });
    }
    return problems;
  }

  async apply({ operation_id: requestedId, candidate_revision: candidateRevision, expected_active_revision: expectedActive, requested_by: requestedBy = "settings" }) {
    const operationId = String(requestedId || "") || `op-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    if (!validOperationId(operationId)) return { ok: false, http: 400, error: "INVALID_OPERATION_ID" };
    const existing = this.get(operationId);
    if (existing) return { ok: existing.state === "APPLIED", idempotent: true, operation: existing };
    if (this.running) return { ok: false, http: 409, error: "OPERATION_IN_PROGRESS", running: this.running.operation_id };
    const pointer = this.store.pointer();
    const op = operation({ operationId, kind: "network", expectedActiveRevision: expectedActive ?? null, candidateRevision,
      previousRevision: pointer.active ?? null, requestedBy });
    // Claimed before the first await: set only after `await precheck()`, two concurrent applies both passed the
    // check above and stopped/started (or rolled back) services at the same time.
    this.setRunning(op);
    try {
      return await this.applyClaimed(op, { candidateRevision, expectedActive, pointer });
    } finally {
      this.setRunning(null);
    }
  }

  async applyClaimed(op, { candidateRevision, expectedActive, pointer }) {
    const doc = this.store.get(candidateRevision);
    if (!doc) { transition(op, "REJECTED", { reason: "UNKNOWN_REVISION" }); this.persist(op); return { ok: false, operation: op }; }
    if ((expectedActive ?? null) !== (pointer.active ?? null)) {
      transition(op, "CONFLICT", { reason: `expected active ${expectedActive ?? null}, current ${pointer.active ?? null}` });
      this.persist(op);
      return { ok: false, error: "ACTIVE_REVISION_CONFLICT", operation: op };
    }
    const candidate = this.resolve(doc);
    if (candidate.problems.length) {
      transition(op, "REJECTED", { reason: "INVALID_CANDIDATE" });
      op.problems = candidate.problems;
      this.persist(op);
      return { ok: false, operation: op };
    }
    // A copy: effectiveRef() is the live object switchEffective() rewrites in place, and the rollback target must
    // survive that.
    const current = JSON.parse(JSON.stringify(this.effectiveRef()));
    const plan = this.plan(current, candidate);
    op.preview = plan;
    if (!plan.changed.length) {
      await this.store.setActive(candidateRevision, { verified: true, expectedActive: pointer.active ?? null });
      transition(op, "APPLIED", { reason: "no endpoint changes" });
      this.persist(op);
      return { ok: true, operation: op };
    }
    const precheck = await this.precheck(plan, candidate);
    if (precheck.length) {
      op.problems = precheck;
      transition(op, "REJECTED", { reason: "pre-check failed; nothing was stopped" });
      this.persist(op);
      return { ok: false, operation: op };
    }
    if (plan.self.length) return await this.applySelf(op, plan);
    return await this.applyRegular(op, plan, current, candidate, pointer.active ?? null);
  }

  switchEffective(target, revision) {
    const effective = this.effectiveRef();
    for (const key of Object.keys(effective)) delete effective[key];
    Object.assign(effective, JSON.parse(JSON.stringify(target)));
    if (revision !== null && revision !== undefined) process.env.STOCK_MONITOR_NETWORK_REVISION = String(revision);
    else delete process.env.STOCK_MONITOR_NETWORK_REVISION;
  }

  async stopAll(op, order, reason) {
    for (const sid of order) {
      const entry = this.entries[sid];
      if (!entry || !this.supervisor.enabled(sid)) continue;
      if (entry.host.drain) {
        const drained = await entry.host.drain()
          .catch((error) => ({ ok: false, error: String(error?.message || error) })); /* not an error: recorded -- recordStep() writes it into the persisted operation */
        recordStep(op, sid, "drain", { ok: drained?.ok !== false, detail: drained?.error || null });
      }
      const stopped = await this.supervisor.stop(sid, reason)
        .catch((error) => ({ ok: false, error: String(error?.message || error) })); /* not an error: recorded -- recordStep() writes it into the persisted operation */
      recordStep(op, sid, "stop", { ok: stopped?.ok === true, detail: stopped?.error || null });
      if (stopped?.ok !== true) return { ok: false, service_id: sid, error: stopped?.error || "stop not confirmed" };
      const listener = this.effectiveRef().services[sid];
      if (listener?.listener) {
        const released = await portFree(listener.host, listener.port, 300);
        recordStep(op, sid, "release_verified", { ok: released, detail: released ? null : `port ${listener.port} still held` });
        if (!released) return { ok: false, service_id: sid, error: "port not released" };
      }
      this.persist(op);
    }
    return { ok: true };
  }

  async startAll(op, order, revision) {
    const candidate = revision === op.candidate_revision;
    for (const sid of order) {
      if (!this.entries[sid] || !this.supervisor.enabled(sid)) continue;
      // Where each candidate starts, persisted before it starts: a Health that dies right after the spawn
      // still knows which endpoint to stop and prove free.
      if (candidate) {
        const at = this.effectiveRef().services[sid] || {};
        op.candidates = { ...(op.candidates || {}), [sid]: { revision, host: at.host ?? null, port: at.port ?? null, pid: null, instance_id: null } };
        this.persist(op);
      }
      const started = await this.supervisor.ensure(sid, `network operation ${op.operation_id}`).then((r) => ({ ok: true, r }), (error) => ({ ok: false, error: String(error?.message || error) }));
      recordStep(op, sid, "bind", { ok: started.ok, detail: started.error || null });
      if (!started.ok) return { ok: false, service_id: sid, error: started.error };
      const probe = await this.entries[sid].host.supervisorProbe().catch((error) => { console.warn(`[network operation] ${sid} readiness probe failed`, error); return {}; });
      recordStep(op, sid, "readiness", { ok: Boolean(probe.alive), detail: probe.reason || null });
      const problem = this.identityProblem(sid, probe, revision);
      recordStep(op, sid, "identity_verified", { ok: !problem, detail: problem });
      if (candidate) Object.assign(op.candidates[sid], { pid: probe.pid ?? started.r?.pid ?? null, instance_id: probe.instance_id ?? null });
      if (problem) { this.persist(op); return { ok: false, service_id: sid, error: "identity or config revision not verified" }; }
      recordStep(op, sid, "effective_recorded", { ok: true, detail: { revision, port: this.effectiveRef().services[sid]?.port ?? null } });
      this.persist(op);
    }
    return { ok: true };
  }

  // The started service is ours (verified), runs the revision being applied and is bound where that revision says.
  // Shared by a regular apply and the bootstrap path. Every managed listener reports its own config revision and
  // bound endpoint; one that reports none is not verified -- no compatibility allowance.
  // A service with no listener (Rust B) has no endpoint to verify. Returns null when verified, else why not.
  identityProblem(sid, probe, revision) {
    if (!probe?.verified) return "identity not verified";
    const expected = this.effectiveRef().services[sid];
    if (!expected?.listener) return null;
    if (probe.config_revision === undefined) return "identity reports no config revision";
    if ((probe.config_revision ?? null) !== (revision ?? null)) return `config revision ${probe.config_revision} != ${revision ?? null}`;
    if (probe.bound_port === undefined || Number(probe.bound_port) !== Number(expected.port)) {
      return `bound port ${probe.bound_port} != ${expected.port}`;
    }
    // The address too: a listener on 0.0.0.0 with the right port is exposed beyond the loopback asked for.
    if (probe.bound_host === undefined || probe.bound_host === null || normalHost(probe.bound_host) !== normalHost(expected.host)) {
      return `bound host ${probe.bound_host} != ${expected.host}`;
    }
    return null;
  }

  // Rollback precondition: every candidate service is gone -- no live or verified instance, nothing on its
  // port. Any one not confirmed and the previous revision is not started.
  async fenceCandidates(op, order) {
    for (const sid of order) {
      if (!this.entries[sid] || !this.supervisor.enabled(sid)) continue;
      const probe = await this.entries[sid].host.supervisorProbe()
        .catch((error) => ({ unknown: String(error?.message || error) })); /* not an error: recorded -- recordStep() writes it into the persisted operation */
      const live = probe.unknown ? `probe failed: ${probe.unknown}`
        : probe.alive || probe.verified ? `instance ${probe.instance_id ?? "?"} pid ${probe.pid ?? "?"} (revision ${probe.config_revision ?? "?"}) still running`
          : probe.occupied ? "its port is still held" : null;
      recordStep(op, sid, "candidate_fenced", { ok: !live, detail: live });
      if (live) return { ok: false, service_id: sid, error: live };
    }
    return { ok: true };
  }

  // A starting Health, before it starts anything: an interrupted apply's candidate services are stopped on the
  // candidate endpoints and proven gone -- nothing answers there, the port is free, no recorded candidate pid lives.
  // Returns the services not proven gone; those are not started, and the operation ends ROLLBACK_FAILED.
  async fenceInterrupted({ operation: op }) {
    const record = this.get(op.operation_id) || op;
    const doc = record.candidate_revision !== null && record.candidate_revision !== undefined ? this.store.get(record.candidate_revision) : null;
    const services = [...new Set([...(record.preview?.stop_order || []), ...Object.keys(record.candidates || {})])]
      .filter((sid) => this.entries[sid] && this.supervisor.enabled(sid));
    if (!services.length) return { ok: true, unfenced: [] };
    const current = JSON.parse(JSON.stringify(this.effectiveRef()));
    // The candidate endpoints: from its revision, or -- when that revision cannot be read or no longer resolves --
    // from the endpoints persisted on the operation before each candidate started. A service with neither cannot be
    // fenced and is reported unfenced: the previous revision is never started on an unproven endpoint.
    const resolved = doc ? this.resolve(doc) : null;
    const candidate = resolved && !resolved.problems.length ? resolved : JSON.parse(JSON.stringify(current));
    const unknown = [];
    if (candidate !== resolved) {
      for (const sid of services) {
        const at = record.candidates?.[sid];
        if (at && at.host && at.port) candidate.services[sid] = { ...(candidate.services[sid] || {}), host: at.host, port: at.port };
        else unknown.push(sid);
      }
    }
    const revisionProblem = candidate === resolved ? null
      : doc ? `candidate revision ${record.candidate_revision} no longer resolves` : `candidate revision ${record.candidate_revision} unreadable`;
    const order = [...START_ORDER].reverse().filter((sid) => services.includes(sid));
    const unfenced = [];
    this.switchEffective(candidate, record.candidate_revision);
    try {
      for (const sid of order) {
        if (unknown.includes(sid)) {
          recordStep(record, sid, "candidate_fenced", { ok: false, detail: "candidate endpoint unknown: the revision is unreadable and none was persisted" });
          unfenced.push(sid);
          continue;
        }
        const host = this.entries[sid].host;
        // A failed probe counts as a live candidate: it is stopped, and the probe after the stop is recorded.
        const before = await host.supervisorProbe().catch((error) => {
          this.logger.warn(`[HEALTH] fencing ${record.operation_id}: probing ${sid} failed: ${error?.message || error}`);
          return { unknown: String(error?.message || error) };
        });
        const there = before.unknown || before.alive || before.verified || before.occupied;
        // An instance of the revision being restored on a shared endpoint is not the candidate: it stays.
        const previousOne = before.verified && before.config_revision !== undefined && before.config_revision === (current.revision ?? null);
        if (there && !previousOne) {
          const stopped = await host.stop(`fencing interrupted operation ${record.operation_id}`)
            .catch((error) => ({ ok: false, error: String(error?.message || error) })); /* not an error: recorded -- recordStep() writes it into the persisted operation */
          recordStep(record, sid, "stop", { ok: stopped?.ok === true, detail: stopped?.error || null });
        }
        const after = previousOne ? { alive: false } : await host.supervisorProbe()
          .catch((error) => ({ unknown: String(error?.message || error) })); /* not an error: recorded -- recordStep() writes it into the persisted operation */
        const pid = record.candidates?.[sid]?.pid;
        const live = after.unknown ? `probe failed: ${after.unknown}`
          : after.alive || after.verified ? `instance ${after.instance_id ?? "?"} still running`
            : after.occupied ? "its candidate port is still held"
              : processAliveFast(pid) ? `recorded candidate pid ${pid} still alive` : null;
        recordStep(record, sid, "candidate_fenced", { ok: !live, detail: live });
        if (live) unfenced.push(sid);
      }
    } finally {
      this.switchEffective(current, current.revision ?? null);
    }
    record.fence = { ok: !unfenced.length, unfenced, at: new Date().toISOString(),
      ...(revisionProblem ? { candidate_endpoints: "persisted on the operation", candidate_revision_problem: revisionProblem } : {}) };
    this.persist(record);
    return record.fence;
  }

  async applyRegular(op, plan, current, candidate, previousActive) {
    transition(op, "RUNNING");
    this.persist(op);
    const stopped = await this.stopAll(op, plan.stop_order, `network operation ${op.operation_id}`);
    let failure = stopped.ok ? null : stopped;
    if (!failure) {
      this.switchEffective(candidate, op.candidate_revision);
      const started = await this.startAll(op, plan.start_order, op.candidate_revision);
      if (started.ok) {
        await this.store.setActive(op.candidate_revision, { verified: true, expectedActive: previousActive });
        transition(op, "APPLIED");
        op.result = { verdict: verdict(op) };
        this.persist(op);
        return { ok: true, operation: op };
      }
      failure = started;
    }
    // Recover to the previous revision; this can fail too and is recorded as such.
    op.failure = failure;
    transition(op, "ROLLING_BACK", { reason: `${failure.service_id}: ${failure.error}` });
    this.persist(op);
    const stoppedAgain = await this.stopAll(op, plan.stop_order, `rollback of ${op.operation_id}`)
      .catch((error) => ({ ok: false, service_id: null, error: String(error?.message || error) }));   /* not an error: recorded -- it becomes the ROLLBACK_FAILED reason persisted on the operation */
    const fence = stoppedAgain.ok ? await this.fenceCandidates(op, plan.stop_order) : stoppedAgain;
    if (!fence.ok) {
      // Nothing of the previous revision is started next to a candidate that may still run.
      transition(op, "ROLLBACK_FAILED", { reason: `candidate not fenced: ${fence.service_id}: ${fence.error}` });
      op.result = { verdict: verdict(op), partially_applied: true };
      this.persist(op);
      this.recordRecovery(op, "candidate_failed", "failed", `candidate not fenced: ${fence.service_id}: ${fence.error}`);
      return { ok: false, operation: op };
    }
    this.switchEffective(current, op.previous_revision);
    const restored = await this.startAll(op, plan.start_order, op.previous_revision);
    transition(op, restored.ok ? "ROLLED_BACK" : "ROLLBACK_FAILED", { reason: restored.ok ? null : `${restored.service_id}: ${restored.error}` });
    op.result = { verdict: verdict(op), partially_applied: verdict(op) === "PARTIALLY_APPLIED" };
    this.persist(op);
    this.recordRecovery(op, "candidate_failed", restored.ok ? "succeeded" : "failed", restored.ok ? null : `${restored.service_id}: ${restored.error}`);
    return { ok: false, operation: op };
  }

  async applySelf(op, plan) {
    // Contract states only (RUNNING); `phase` says which step of the bootstrap path the operation is in.
    op.phase = "restarting_self";
    transition(op, "RUNNING", { reason: `own endpoint change: ${plan.self.join(",")}; full restart through the bootstrap` });
    op.bootstrap = { instructions: "restart Health from the candidate revision; on failure start the previous revision", attempts: 0, max_attempts: 2 };
    // The next Health starts the candidate only on a clean shutdown receipt carrying this token.
    op.handoff = { token: crypto.randomUUID(), health_instance: this.instanceId };
    this.persist(op);
    this.restartHealth(op);
    return { ok: true, pending_restart: true, operation: op };
  }

  // Health's full shutdown before a handoff restart finished: its receipt goes into the operation under the
  // handoff token. Not clean -- the operation turns to bootstrap_rollback before Health exits.
  recordHandoff(op, result) {
    const record = this.get(op.operation_id) || op;
    if (record.phase !== "restarting_self" || !record.handoff?.token) return record;
    const failed = Object.entries(result?.receipts || {}).filter(([, r]) => r?.ok !== true).map(([sid]) => sid);
    record.handoff_receipt = { token: record.handoff.token, health_instance: this.instanceId, clean: result?.ok === true,
      failed_services: failed, error: result?.error || null, at: new Date().toISOString() };
    if (result?.ok !== true) {
      record.phase = "bootstrap_rollback";
      transition(record, "ROLLING_BACK", { reason: `shutdown before the handoff was not clean${failed.length ? `: ${failed.join(",")}` : ""}` });
    }
    this.persist(record);
    return record;
  }

  async resumeAfterBootstrap({ operation: op, useCandidate, why = null }) {
    const record = this.get(op.operation_id) || op;
    const trigger = record.phase === "restarting_self" || record.phase === "bootstrap_rollback"
      ? (useCandidate ? "self_endpoint_change" : "bootstrap_candidate_failed") : "interrupted_operation";
    const probeAll = await Promise.all(Object.keys(this.entries).filter((sid) => this.entries[sid].autostart && this.supervisor.enabled(sid))
      .map(async (sid) => [sid, await this.entries[sid].host.supervisorProbe().catch((error) => { console.warn(`[network operation] ${sid} probe failed`, error); return { alive: false }; })]));
    const revision = useCandidate ? record.candidate_revision : this.effectiveRef().revision;
    const failed = [];
    for (const [sid, p] of probeAll) {
      recordStep(record, sid, "readiness", { ok: Boolean(p.alive), detail: p.reason || null });
      const problem = p.alive ? this.identityProblem(sid, p, revision) : "not alive";
      if (p.alive) recordStep(record, sid, "identity_verified", { ok: !problem, detail: problem });
      if (problem) { failed.push(sid); continue; }
      recordStep(record, sid, "effective_recorded", { ok: true, detail: { revision: this.effectiveRef().revision } });
    }
    if (useCandidate && !failed.length) {
      await this.store.setActive(record.candidate_revision, { verified: true });
      transition(record, "APPLIED", { reason: "verified after the bootstrap restart" });
    } else if (useCandidate) {
      record.bootstrap_candidate_failed = true;
      record.phase = "bootstrap_rollback";
      transition(record, "ROLLING_BACK", { reason: `candidate did not come up: ${failed.join(",")}` });
      await NetworkOperations.restorePointer(this.store, record);
      this.persist(record);
      this.restartHealth(record);
      return record;
    } else {
      const pointerBack = await NetworkOperations.restorePointer(this.store, record);
      const unfenced = record.fence?.ok === false ? record.fence.unfenced : [];
      transition(record, failed.length || unfenced.length || !pointerBack ? "ROLLBACK_FAILED" : "ROLLED_BACK", {
        reason: unfenced.length ? `candidate not fenced: ${unfenced.join(",")} (not started)`
          : failed.length ? `previous revision also failed: ${failed.join(",")}`
            : !pointerBack ? `the active pointer could not be put back: ${record.pointer_restored?.failed}`
              : `previous revision restored (${why || "rollback"})` });
    }
    if (["APPLIED", "ROLLED_BACK", "ROLLBACK_FAILED"].includes(record.state)) record.phase = "completed";
    this.persist(record);
    this.recordRecovery(record, trigger, record.state === "ROLLBACK_FAILED" ? "failed" : "succeeded", why);
    this.release(record);
    return record;
  }
}

module.exports = { validOperationId, NetworkOperations, CLIENTS, START_ORDER };
