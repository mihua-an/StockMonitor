"use strict";

// Start and stop of a provider daemon (Shioaji, Futu), decided from the daemon's own durable owner record
// -- never from a combination of port probes, HTTP timeouts and process-image guesses.
//
// The owner record (service/market/shared/daemon_singleton.py, written under the daemon's OS lifetime lock) names the
// owning process (pid + its OS creation time), its generation and its lifecycle: STARTING -> READY -> STOPPING. When
// the owner ends it leaves a stop receipt bound to its instance and generation.
//
// ensure():
//   live owner, STOPPING -> wait for that exact process to exit, then decide again;
//   live owner, STARTING -> wait for it to leave STARTING (READY, STOPPING or gone), then decide again;
//   live owner, READY    -> its health must answer compatibly as that instance: attach. Our own daemon of another
//                           runtime is stopped for an upgrade (and waited out); anything else fails closed -- a
//                           second owner is never started beside a live one;
//   no live owner        -> a port still held is not ours (PORT_CONFLICT, nothing is sent to it); otherwise spawn and
//                           wait for the spawned pid to own the record and be READY. A peer that won the lock instead
//                           is decided on like any live owner.
// stop(): ask the owner to stop, wait for its exact process to exit; clean only on its stop receipt saying so. Past
// the grace the same owner -- and only it -- is terminated, and that is recorded.
//
// Every wait on another owner's state is a `provider.daemon_ownership_wait` remediation.

const fs = require("fs");
const { compatible, ownIdentity, fetchDaemonJson } = require("../../service/platform/js/daemon_connection");
const { processAliveFast, processCreatedMsAsync } = require("../../service/platform/js/process_utils");
const { readJsonObject } = require("../../service/platform/js/atomic_files");
const { TRIGGERS, recordForcedTermination } = require("../../service/platform/js/forced_termination");

const CREATED_TOLERANCE_MS = 1000;
// stopGraceMs bounds the stop request itself (Shioaji drains its sources inside it); exitAfterStopMs is how long the
// process then has to exit before it is terminated.
// attachProbeMs: how long a READY owner's health may take to answer as that instance. A daemon publishes READY only
// once it serves (backend/shared/daemon_server.py), so any wait here is a fault: bounded, and recorded either way.
const DEFAULT_BUDGETS = Object.freeze({ startingMs: 120000, stoppingMs: 200000, spawnReadyMs: 60000, stopGraceMs: 180000,
  exitAfterStopMs: 30000, attachProbeMs: 10000 });

function sleepDefault(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

class DaemonStartupError extends Error {
  constructor(decision, message, detail = {}) {
    super(message);
    this.marketDaemonDecision = decision;
    this.decision = decision;
    this.detail = detail;
  }
}

function createProviderDaemonOwnership({
  label, serviceId, daemonUrl, expected, ownerPath, receiptPath, fetchImpl, isPortOpen, spawnDetached, getSpawnState,
  terminate, fsImpl = fs, processAlive = processAliveFast, createdMs = processCreatedMsAsync, heldPid = () => null,
  remediation = null, sleep = sleepDefault, now = Date.now, logger = console, readLogTail = () => "", detachedLogPath = () => "",
  budgets = {}, onAction = () => {}, pollMs = 250,
}) {
  const limits = { ...DEFAULT_BUDGETS, ...budgets };
  // Read at each request: an applied network revision moves the daemon, and its owner follows it.
  const urlOf = typeof daemonUrl === "function" ? daemonUrl : () => daemonUrl;

  // The process this host spawned and still holds a handle to (heldPid): while the handle is open Windows does not give
  // its pid to another process, so a record naming that pid was written by it -- no creation-time query is needed.
  // Every wait for a spawned daemon to become READY queried it ~4 times a second, each a ~0.5 s CIM query.
  const held = (pid) => { const own = Number(heldPid() || 0); return own > 0 && own === pid; };

  // The record and whether its process is still the one that wrote it.
  async function currentOwner() {
    const record = readJsonObject(ownerPath(), { fsImpl, label: "a provider daemon owner record" });
    const pid = Number(record?.owner_pid || 0);
    if (!record || !(pid > 0)) return { state: "NONE", record: null };
    if (held(pid)) return { state: "LIVE", record, lifecycle: String(record.lifecycle || "READY") };
    if (!processAlive(pid)) return { state: "GONE", record };
    // A pid alone is not the owner: without both creation times -- the record's and the OS's -- the process
    // cannot be proven to be the one that wrote the record, and nothing attaches to, stops or terminates it.
    const recorded = Number(record.owner_created_ns || 0);
    if (!(recorded > 0)) return { state: "UNVERIFIED", record, reason: "the owner record states no creation time" };
    const created = await createdMs(pid);
    if (created === null) return { state: "UNVERIFIED", record, reason: `the creation time of pid ${pid} could not be read` };
    if (Math.abs(created - recorded / 1e6) > CREATED_TOLERANCE_MS) return { state: "REPLACED", record };
    return { state: "LIVE", record, lifecycle: String(record.lifecycle || "READY") };
  }

  const sameOwner = (a, b) => Boolean(a && b && Number(a.owner_pid) === Number(b.owner_pid) && a.generation === b.generation);

  // The exact process that wrote `record` has exited (its record is removed just before it exits, so the record
  // alone is no proof).
  async function processGone(record) {
    const pid = Number(record?.owner_pid || 0);
    if (held(pid)) return false;
    if (!(pid > 0) || !processAlive(pid)) return true;
    const recorded = Number(record.owner_created_ns || 0);
    if (!(recorded > 0)) return false;
    const created = await createdMs(pid);
    return created !== null && Math.abs(created - recorded / 1e6) > CREATED_TOLERANCE_MS;
  }

  function action(name, detail = {}) {
    const event = { timestamp: new Date(now()).toISOString(), action: name, ...detail };
    try { onAction(event); } catch (error) { console.warn("[reporting a provider daemon startup action] failed", error); }
    logger.log?.(`[${label} STARTUP] ${name} ${JSON.stringify(detail)}`);
  }

  function recordWait(trigger, record, outcome, startedAt, detail = {}) {
    try {
      remediation?.emit({ component: "provider_daemon_ownership", mechanismId: "provider.daemon_ownership_wait", triggerReason: trigger,
        outcome, identity: { source: serviceId === "provider_futu" ? "futu" : "shioaji" },
        detail: { owner_pid: record?.owner_pid ?? null, instance_id: record?.daemon_instance_id ?? null,
          generation: record?.generation ?? null, waited_ms: now() - startedAt, ...detail } });
    } catch (error) { console.warn("[recording a provider daemon takeover] failed", error); }
  }

  // Until `done(owner)` holds or the budget ends; resolves the last owner seen and whether it held.
  async function waitFor(done, budgetMs) {
    const deadline = now() + budgetMs;
    let owner = await currentOwner();
    while (!(await done(owner))) {
      if (now() >= deadline) return { held: false, owner };
      await sleep(pollMs);
      owner = await currentOwner();
    }
    return { held: true, owner };
  }

  async function probeHealth(timeoutMs = 1000) {
    if (!(await isPortOpen())) return { reachable: false, compatible: false, classification: "PORT_CLOSED", payload: null };
    try {
      const { response, payload } = await fetchDaemonJson(fetchImpl, `${urlOf()}/health`, { cache: "no-store", timeoutMs });
      return { reachable: true, compatible: Boolean(response.ok && compatible(payload, expected)), statusCode: response.status,
        payload: payload || null, classification: response.ok ? "HEALTHY" : "HTTP_ERROR" };
    } catch (error) {
      logger.warn?.(`[${label} STARTUP] /health probe failed: ${error?.message || error}`);
      return { reachable: true, compatible: false, payload: null, error: String(error?.message || error),
        classification: error?.name === "AbortError" ? "TIMEOUT" : "INVALID_RESPONSE" };
    }
  }

  async function requestStop(reason, timeoutMs) {
    const { response, payload } = await fetchDaemonJson(fetchImpl, `${urlOf()}/v1/control/stop?reason=${encodeURIComponent(reason)}`,
      { method: "POST", timeoutMs });
    return { status: response.status, payload: payload || null };
  }

  function receiptFor(record) {
    const receipt = readJsonObject(receiptPath(), { fsImpl, label: "a provider daemon stop receipt" });
    return receipt && receipt.daemon_instance_id === record?.daemon_instance_id && receipt.generation === record?.generation ? receipt : null;
  }

  function fail(decision, message, detail = {}) {
    action("START_FAILED", { decision, reason: message, ...detail });
    return new DaemonStartupError(decision, message, detail);
  }

  // The owner's health until it answers -- as that instance or as our own daemon of another runtime -- or the budget
  // is spent; an owner that left READY or exited ends the wait (the caller decides again).
  async function probeOwner(record) {
    const startedAt = now();
    const deadline = startedAt + limits.attachProbeMs;
    let probe = await probeHealth();
    let waited = false;
    while (!(probe.reachable && probe.payload) && now() < deadline) {
      const current = await currentOwner();
      if (current.state !== "LIVE" || current.record?.daemon_instance_id !== record.daemon_instance_id || current.lifecycle !== "READY") break;
      waited = true;
      await sleep(pollMs);
      probe = await probeHealth();
    }
    if (waited) {
      recordWait("owner_ready_unanswered", record, probe.reachable && probe.payload ? "succeeded" : "failed", startedAt,
        { classification: probe.classification });
    }
    return probe;
  }

  async function attachTo(owner) {
    const record = owner.record;
    const probe = await probeOwner(record);
    if (probe.compatible && probe.payload?.daemon_instance_id === record.daemon_instance_id) {
      action("ATTACH_EXISTING", { pid: record.owner_pid, instance_id: record.daemon_instance_id, generation: record.generation });
      return { result: { ok: true, action: "reuse", decision: "ATTACHED_EXISTING", health: probe.payload } };
    }
    if (probe.reachable && probe.payload && ownIdentity(probe.payload, expected) && !probe.compatible) {
      // Our own daemon of another runtime: replaced through its own stop, never beside it.
      const startedAt = now();
      action("STOP_INCOMPATIBLE", { pid: record.owner_pid, runtime: probe.payload.daemon_runtime_version ?? null });
      await requestStop("incompatible_upgrade", limits.stopGraceMs).catch((error) => { console.warn("[asking the incompatible provider daemon to stop] failed", error); return null; });
      const gone = await waitFor(() => processGone(record), limits.stoppingMs);
      const receipt = receiptFor(record);
      recordWait("incompatible_upgrade", record, gone.held ? "succeeded" : "failed", startedAt,
        { clean_stop: receipt?.clean ?? null, runtime: probe.payload.daemon_runtime_version ?? null });
      if (!gone.held) throw fail("UPGRADE_HANDOFF_TIMEOUT", `${label} pid ${record.owner_pid} did not exit after its upgrade stop`);
      return { again: true };
    }
    throw fail("HEALTH_PROBE_FAILED",
      `${label} pid ${record.owner_pid} owns the daemon (READY) but its health does not answer as that instance (${probe.classification}); no second owner is started`,
      { probe: { classification: probe.classification, instance_id: probe.payload?.daemon_instance_id ?? null } });
  }

  async function ensure() {
    for (let round = 0; round < 4; round += 1) {
      const owner = await currentOwner();
      if (owner.state === "UNVERIFIED") {
        throw fail("OWNER_UNVERIFIED", `${label} pid ${owner.record.owner_pid} holds the owner record but cannot be verified as its writer (${owner.reason}); nothing is attached, started or stopped`);
      }
      if (owner.state === "LIVE") {
        const record = owner.record;
        if (owner.lifecycle === "STOPPING" || owner.lifecycle === "STARTING") {
          const trigger = owner.lifecycle === "STOPPING" ? "owner_stopping" : "owner_starting";
          const startedAt = now();
          action("WAIT_HANDOFF", { reason: trigger, pid: record.owner_pid, generation: record.generation });
          // STOPPING: until that process has exited. STARTING: until it is READY, stopping or gone.
          const waited = owner.lifecycle === "STOPPING"
            ? await waitFor(() => processGone(record), limits.stoppingMs)
            : await waitFor(async (o) => (await processGone(record)) || !(o.state === "LIVE" && sameOwner(o.record, record) && o.lifecycle === "STARTING"),
              limits.startingMs);
          recordWait(trigger, record, waited.held ? "succeeded" : "failed", startedAt);
          if (!waited.held) {
            throw fail(owner.lifecycle === "STOPPING" ? "UPGRADE_HANDOFF_TIMEOUT" : "OWNER_STARTING_TIMEOUT",
              `${label} pid ${record.owner_pid} stayed ${owner.lifecycle} past its budget; no second owner is started`);
          }
          continue;
        }
        const attached = await attachTo(owner);
        if (attached.result) return attached.result;
        continue;
      }
      if (await isPortOpen()) {
        throw fail("PORT_CONFLICT", `${label} port is held, but no live ${label} owns it; nothing is sent to or stopped on an unknown process`);
      }
      action("START_NEW", { reason: owner.state === "NONE" ? "no_owner" : `previous_owner_${owner.state.toLowerCase()}` });
      const pid = spawnDetached();
      const startedAt = now();
      const spawned = await waitFor((o) => {
        if (o.state === "LIVE" && Number(o.record.owner_pid) !== Number(pid)) return true;      // a peer won the lock
        if (o.state === "LIVE" && o.lifecycle === "READY") return true;
        const state = getSpawnState();
        return state?.pid === pid && (state.error || state.exitCode !== null);
      }, limits.spawnReadyMs);
      const after = spawned.owner;
      if (after.state === "LIVE" && Number(after.record.owner_pid) !== Number(pid)) {
        recordWait("singleton_race", after.record, "succeeded", startedAt, { spawned_pid: pid });
        continue;
      }
      if (after.state === "LIVE" && after.lifecycle === "READY") {
        const attached = await attachTo(after);
        if (attached.result) {
          action("START_SUCCESS", { pid, instance_id: after.record.daemon_instance_id, generation: after.record.generation });
          return { ...attached.result, action: "start", decision: "STARTED_NEW", spawned_pid: pid };
        }
        continue;
      }
      const tail = readLogTail();
      if (tail) logger.error?.(`[${label} STARTUP LOG TAIL]\n${tail}`);
      const state = getSpawnState();
      const logPath = detachedLogPath();
      if (!spawned.held) {
        throw fail("CHILD_STARTUP_FAILED", `${label} pid ${pid} was not READY within ${limits.spawnReadyMs} ms${logPath ? `；診斷：${logPath}` : ""}`,
          { child_pid: pid });
      }
      throw fail("CHILD_STARTUP_FAILED", `${label} pid ${pid} exited before it was READY (${state?.error ? `spawn error=${state.error}` : `exit code=${state?.exitCode}`})${logPath ? `；診斷：${logPath}` : ""}`,
        { child_pid: pid, child_exit_code: state?.exitCode ?? null });
    }
    throw fail("OWNERSHIP_UNSETTLED", `${label} ownership did not settle`);
  }

  async function stop(reason) {
    const owner = await currentOwner();
    if (owner.state === "UNVERIFIED") {
      return { ok: false, stopped: false, reason, error: `${label} pid ${owner.record.owner_pid} cannot be verified as the owner (${owner.reason}); not stopped` };
    }
    if (owner.state !== "LIVE") {
      if (await isPortOpen()) return { ok: false, stopped: false, reason, error: `${label} port is held, but no live ${label} owns it; not stopped` };
      return { ok: true, stopped: true, already_exited: true, reason };
    }
    const target = owner.record;
    const reply = await requestStop(reason, limits.stopGraceMs).catch((error) => {
      logger.warn?.(`[${label}] stop request (${reason}) failed: ${error?.message || error}; waiting for pid ${target.owner_pid} to exit`);
      return { error: String(error?.message || error) };
    });
    const exited = await waitFor(() => processGone(target), limits.exitAfterStopMs);
    if (!exited.held) {
      // The same owner, past its grace: only that exact process is terminated, and that is recorded. It is
      // verified again right before: the record may have gone, or the pid been reused, during the grace.
      const still = await currentOwner();
      if (!(still.state === "LIVE" && sameOwner(still.record, target) && still.record.daemon_instance_id === target.daemon_instance_id)) {
        if (await processGone(target)) return { ok: false, stopped: true, reason, error: `${label} exited past its grace without a stop receipt` };
        return { ok: false, stopped: false, reason,
          error: `${label} pid ${target.owner_pid} did not exit within ${limits.exitAfterStopMs} ms and can no longer be verified as the owner (${still.reason || still.state}); not terminated` };
      }
      const gone = await terminate(Number(target.owner_pid));
      recordForcedTermination(remediation, { component: "provider_daemon_ownership", serviceId, pid: target.owner_pid,
        instanceId: target.daemon_instance_id, trigger: TRIGGERS.STOP_GRACE_EXCEEDED, reason, graceMs: limits.exitAfterStopMs, exited: gone,
        detail: { stop_reply: reply?.status ?? reply?.error ?? null } });
      return { ok: false, stopped: gone, forced: true, reason, error: `${label} did not exit within ${limits.exitAfterStopMs} ms of its stop; terminated` };
    }
    const receipt = receiptFor(target);
    if (!receipt) return { ok: false, stopped: true, reason, reply: reply?.payload ?? null, error: `${label} exited without a stop receipt` };
    return { ok: receipt.clean === true, stopped: true, reason, receipt, reply: reply?.payload ?? null,
      ...(receipt.clean === true ? {} : { error: receipt.error || "its stop was not clean" }) };
  }

  return { ensure, stop, probeHealth, currentOwner };
}

module.exports = { createProviderDaemonOwnership, DaemonStartupError, DEFAULT_BUDGETS };
