"use strict";

// Health's process supervision (docs/system-architecture/00 section 3, 04 sections 4-5).
//
// One exclusive operation per service at a time (ensure / stop / restart); a desired state per service; a watch
// loop that restarts a service that should run but is gone -- with backoff and a bounded budget, after which it
// stays FAILED(RESTART_LIMIT) until an explicit control request. Startup order is the dependency graph: a service
// starts once every service it names in `after` has an outcome, never earlier -- it does not reach for a dependency
// that is not up and retry. `after` is order only: a failed provider does not hold back what reads
// the other one. `requires` (a subset of `after`) is what the service cannot work without: it starts only once each
// of those is ready; otherwise it stays FAILED(BLOCKED) -- never started to rebuild later what it missed -- and the
// watch loop starts it as soon as every one is RUNNING.
//
// The restart budget is persisted (`budgetFile`): a Health restart does not hand a crash-looping service a
// fresh budget. Each automatic restart is a `health.service_restart` remediation naming the service, its old
// instance (the last verified one seen), the probe that found it gone, the attempt in the window and the new
// instance that came up.

const fs = require("fs");
const { writeJsonAtomic } = require("../service/platform/js/atomic_files");

const RESTART_BUDGET = 5;
const RESTART_WINDOW_MS = 5 * 60 * 1000;
const WATCH_MS = 3000;
const PROBE_TIMEOUT_MS = 5000;
const PROBE_TIMED_OUT = Symbol("probe timed out");

class Supervisor {
  constructor({ entries, logger = console, now = Date.now, probeTimeoutMs = PROBE_TIMEOUT_MS, remediation = null, budgetFile = null,
    startupObserver = null }) {
    // entries: service_id -> { host, enabled?(), autostart: bool, after?: service_id[], requires?: service_id[] }
    this.entries = entries;
    // (sid) -> { end(detail), fail(error) } | null: each ensure as a stage of Health's startup timeline.
    this.startupObserver = startupObserver;
    // The remediation ledger's emitter (health/remediation/ledger.js): every automatic restart is recorded.
    this.remediation = remediation;
    this.probeTimeoutMs = probeTimeoutMs;
    this.logger = logger;
    this.now = now;
    this.ops = new Map();
    this.desired = new Map();
    this.state = new Map();
    this.budgetFile = budgetFile;
    this.restarts = this.loadBudget();
    // service_id -> {instance_id, pid} of the last verified probe: the "old" identity of an automatic restart.
    this.lastSeen = new Map();
    // service_id -> the required services it waits for: never started, the watch loop starts it once they run.
    this.blocked = new Map();
    this.timer = null;
    this.stopping = false;
    this.startup = {};
    // The current start-all attempt: each outcome in `startup` names the attempt it belongs to, so a reader
    // takes exactly the attempt it asked for -- never a wall-clock guess at which outcome is recent.
    this.attempt = { generation: 0, started_at: null, reason: null };
    // Resolves when services may start (holdStarts); null when nothing holds them.
    this.startHold = null;
  }

  // No service starts until `released` resolves: Health moves the stored history to a new folder (storage_location)
  // after its control API listens, and every start -- start-all, a control request, a network operation, the watch
  // loop -- waits for that move instead of opening the store beside it. `released` must resolve, never reject.
  holdStarts(released) {
    const hold = Promise.resolve(released).then(() => { if (this.startHold === hold) this.startHold = null; });
    this.startHold = hold;
  }

  loadBudget() {
    if (!this.budgetFile) return new Map();
    try {
      const saved = JSON.parse(fs.readFileSync(this.budgetFile, "utf8"));
      return new Map(Object.entries(saved?.restarts || {}).map(([sid, list]) => [sid, (Array.isArray(list) ? list : []).filter(Number.isFinite)]));
    } catch (error) { /* absent is not an error: no restart budget yet */ if (error?.code !== "ENOENT") console.warn("[reading the restart budget] failed", error); return new Map(); }
  }

  saveBudget() {
    if (!this.budgetFile) return;
    try {
      writeJsonAtomic(this.budgetFile, { schema: "stock-monitor-restart-budget-v1", window_ms: RESTART_WINDOW_MS,
        restarts: Object.fromEntries(this.restarts) }, { indent: 0 });
    } catch (error) {
      this.logger.warn?.(`[HEALTH] restart budget not persisted: ${error?.message || error}`);
    }
  }

  entry(sid) {
    const e = this.entries[sid];
    if (!e) throw new Error(`unknown service ${sid}`);
    return e;
  }

  enabled(sid) {
    const e = this.entries[sid];
    return Boolean(e) && (e.enabled ? e.enabled() !== false : true);
  }

  setState(sid, state, reason = null) {
    this.state.set(sid, { state, reason, at: new Date(this.now()).toISOString() });
  }

  exclusive(sid, action, run) {
    const pending = this.ops.get(sid);
    if (pending) {
      if (pending.action === action) return pending.promise;
      return pending.promise.catch(() => { /* not an error: waits for the previous operation to settle; its failure is reported to its own caller */ }).then(() => this.exclusive(sid, action, run));
    }
    const promise = Promise.resolve().then(run).finally(() => this.ops.delete(sid));
    this.ops.set(sid, { action, promise });
    return promise;
  }

  ensure(sid, reason = "ensure") {
    this.blocked.delete(sid);
    return this.exclusive(sid, "ensure", async () => {
      if (!this.enabled(sid)) {
        this.setState(sid, "DISABLED", "disabled by policy");
        // Recorded like any other outcome, so a startup poller never waits for a service that will not start.
        this.startup[sid] = { status: "skipped", ms: 0, reason: "disabled by policy", started_at: this.now(), attempt: this.attempt.generation };
        return { ok: true, skipped: true, classification: "DISABLED_BY_POLICY" };
      }
      if (this.stopping) throw new Error("Health is shutting down");
      this.desired.set(sid, "running");
      this.setState(sid, "STARTING", reason);
      if (this.startHold) {
        this.setState(sid, "STARTING", "waiting for the history folder move");
        await this.startHold;
        if (this.stopping) throw new Error("Health is shutting down");
        this.setState(sid, "STARTING", reason);
      }
      const started = this.now();
      // started_at lets a UI that attached later tell this attempt from an outcome recorded before it started: a
      // stale "ready" FastAPI from Health's own boot would read as ready while start-all was still restarting it.
      this.startup[sid] = { status: "starting", started_at: started, attempt: this.attempt.generation };
      const span = this.startupObserver?.(sid) || null;
      try {
        // A host may report what a long start is doing (market_runtime: its WAL recovery progress).
        const result = await this.entry(sid).host.ensure({ report: (detail) => this.setState(sid, "STARTING", detail) });
        this.setState(sid, "RUNNING", result?.attached ? "attached to a verified instance" : null);
        this.startup[sid] = { status: "ready", ms: this.now() - started, attached: Boolean(result?.attached), pid: result?.pid ?? null,
          started_at: started, attempt: this.startup[sid]?.attempt ?? this.attempt.generation };
        span?.end({ attached: Boolean(result?.attached), pid: result?.pid ?? null });
        return { ok: true, ...result };
      } catch (error) {
        this.setState(sid, "FAILED", String(error?.message || error));
        this.startup[sid] = { status: "failed", ms: this.now() - started, error: String(error?.message || error), started_at: started,
          attempt: this.startup[sid]?.attempt ?? this.attempt.generation };
        span?.fail(error);
        throw error;
      }
    });
  }

  stop(sid, reason = "stop") {
    this.blocked.delete(sid);
    return this.exclusive(sid, "stop", async () => {
      this.desired.set(sid, "stopped");
      if (!this.enabled(sid)) return { ok: true, skipped: true };
      this.setState(sid, "STOPPING", reason);
      const result = await this.entry(sid).host.stop(reason);
      // The contract has no STOPPED state: a deliberately stopped service is DISABLED (desired=stopped says why).
      this.setState(sid, result?.ok ? "DISABLED" : "FAILED", result?.ok ? `stopped: ${reason}` : (result?.error || "stop not confirmed"));
      return result;
    });
  }

  restart(sid, reason = "restart") {
    return this.exclusive(sid, "restart", async () => {
      // An explicit restart is the one thing that restores the automatic budget.
      this.restarts.set(sid, []);
      this.saveBudget();
      this.desired.set(sid, "running");
      this.setState(sid, "STOPPING", reason);
      const stopped = await this.entry(sid).host.stop(reason);
      if (!stopped?.ok) {
        this.setState(sid, "FAILED", stopped?.error || "stop not confirmed");
        return { ok: false, stop: stopped };
      }
      this.setState(sid, "STARTING", reason);
      try {
        if (this.startHold) await this.startHold;
        const result = await this.entry(sid).host.ensure({ report: (detail) => this.setState(sid, "STARTING", detail) });
        this.setState(sid, "RUNNING", null);
        return { ok: true, stop: stopped, start: result };
      } catch (error) {
        this.logger.warn?.(`[HEALTH] ${sid} start after its stop (${reason}) failed: ${error?.message || error}`);
        this.setState(sid, "FAILED", String(error?.message || error));
        return { ok: false, stop: stopped, error: String(error?.message || error) };
      }
    });
  }

  // Begins a new attempt synchronously (before any await), so a caller can name it in its reply at once.
  beginAttempt(reason) {
    this.attempt = { generation: this.attempt.generation + 1, started_at: this.now(), reason };
    return { ...this.attempt };
  }

  // `skip`: services that must not start now (an interrupted network operation's candidate not proven gone);
  // each is FAILED with that reason; what only follows it in `after` still starts, what `requires` it is BLOCKED.
  // One start-all at a time: a request while one runs is that attempt -- the caller is answered with its number
  // and waits for its outcome -- never a second generation whose services share the first one's pending ensures and
  // so never get an outcome of their own.
  startAll(reason = "startup", options = {}) {
    if (this.activeStartAll) return this.activeStartAll;
    this.activeStartAll = this._startAll(reason, options).finally(() => { this.activeStartAll = null; });
    return this.activeStartAll;
  }

  async _startAll(reason, { skip = [] } = {}) {
    const { generation } = this.beginAttempt(reason);
    const autostart = Object.entries(this.entries).filter(([, e]) => e.autostart).map(([sid]) => sid);
    const withheld = (sid) => {
      const why = "not started: a candidate of an interrupted network operation may still run";
      this.setState(sid, "FAILED", why);
      this.startup[sid] = { status: "failed", ms: 0, error: why, started_at: this.now(), attempt: this.attempt.generation };
      return { ok: false, error: why };
    };
    const settled = new Map();
    const start = (sid, path = []) => {
      if (settled.has(sid)) return settled.get(sid);
      if (path.includes(sid)) throw new Error(`startup dependency cycle: ${[...path, sid].join(" -> ")}`);
      // Only autostarted dependencies are waited for: one that does not start (disabled) has no outcome.
      const deps = this.dependencies(sid).filter((dep) => autostart.includes(dep));
      const outcome = Promise.allSettled(deps.map((dep) => start(dep, [...path, sid])))
        .then((outcomes) => {
          if (skip.includes(sid)) return withheld(sid);
          const missing = deps.filter((dep, i) => this.required(sid).includes(dep)
            && !(outcomes[i].status === "fulfilled" && outcomes[i].value?.ok && !outcomes[i].value?.skipped));
          return missing.length ? this.block(sid, missing) : this.ensure(sid, "startup");
        })
        .then((value) => value, (error) => ({ ok: false, error: String(error?.message || error) }))
        .then((value) => {
          // An ensure already in flight (a watch-loop recovery) was joined: its outcome is this attempt's outcome too.
          if (this.startup[sid] && this.startup[sid].attempt !== generation && this.startup[sid].status !== "starting") {
            this.startup[sid] = { ...this.startup[sid], attempt: generation };
          }
          return value;
        });
      settled.set(sid, outcome);
      return outcome;
    };
    const results = {};
    await Promise.all(autostart.map(async (sid) => { results[sid] = await start(sid); }));
    return results;
  }

  dependencies(sid) {
    const e = this.entries[sid];
    return [...new Set([...(e.after || []), ...(e.requires || [])])];
  }

  required(sid) { return this.entries[sid].requires || []; }

  // Not started: a required service is not ready. Recorded as this attempt's failed outcome (a startup poller needs
  // one), with the services it waits for; the watch loop starts it once they run.
  block(sid, missing) {
    const why = `BLOCKED: waiting for ${missing.join(", ")} to be ready`;
    this.blocked.set(sid, missing);
    this.setState(sid, "FAILED", why);
    this.startup[sid] = { status: "failed", ms: 0, error: why, blocked_by: missing, started_at: this.now(), attempt: this.attempt.generation };
    this.logger.warn?.(`[HEALTH] ${sid} not started: ${why}`);
    return { ok: false, blocked: true, error: why };
  }

  // A blocked service starts once every service it requires is RUNNING (and not when Health is stopping).
  startUnblocked() {
    for (const sid of [...this.blocked.keys()]) {
      if (this.stopping || this.ops.has(sid) || !this.enabled(sid)) continue;
      if (!this.required(sid).every((dep) => !this.enabled(dep) || this.stateOf(dep) === "RUNNING")) continue;
      this.blocked.delete(sid);
      this.logger.warn?.(`[HEALTH] ${sid}: every required service is running; starting`);
      this.ensure(sid, "required services ready").catch((error) => {
        this.logger.warn?.(`[HEALTH] ${sid} start after its dependencies failed: ${error?.message || error}`);
      });
    }
  }

  budgetLeft(sid) {
    const list = (this.restarts.get(sid) || []).filter((t) => this.now() - t < RESTART_WINDOW_MS);
    this.restarts.set(sid, list);
    return list.length < RESTART_BUDGET;
  }

  watch() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), WATCH_MS);
    this.timer.unref?.();
  }

  async tick() {
    // One pass at a time: a slow pass must not overlap the next interval's and double-count restarts.
    if (this.stopping || this.ticking) return;
    this.ticking = true;
    try { await this.tickOnce(); } finally { this.ticking = false; }
  }

  async tickOnce() {
    this.startUnblocked();
    for (const [sid, e] of Object.entries(this.entries)) {
      if (this.desired.get(sid) !== "running" || this.ops.has(sid) || !this.enabled(sid) || !e.watch) continue;
      let probe;
      let timer;
      try {
        probe = await Promise.race([e.host.supervisorProbe(), new Promise((resolve) => {
          timer = setTimeout(() => resolve(PROBE_TIMED_OUT), this.probeTimeoutMs);
          timer.unref?.();
        })]);
      } catch (error) {
        // not an error: recorded -- a not-alive probe is logged with its reason by the restart below, or by the restart-budget remediation
        probe = { alive: false, reason: String(error?.message || error) };
      }
      finally { clearTimeout(timer); }
      // A probe that does not answer in time proves nothing either way: a service busy under load is not a dead
      // one. It is never restarted on that evidence, and it does not hold up the other services' checks.
      if (probe === PROBE_TIMED_OUT) {
        this.logger.warn?.(`[HEALTH] ${sid} probe did not answer within ${this.probeTimeoutMs} ms; no action this pass`);
        continue;
      }
      // RUNNING means alive AND verified (never a live process on its PID alone, however
      // incompatible or half-dead). Alive but not serviceable is DEGRADED when it is our own daemon (its own state
      // says why; never killed on that evidence), and a
      // failure when its identity cannot be verified either.
      if (probe.alive && probe.verified !== false) {
        if (this.state.get(sid)?.state !== "RUNNING") this.setState(sid, "RUNNING", null);
        this.lastSeen.set(sid, { instance_id: probe.instance_id ?? null, pid: probe.pid ?? null });
        continue;
      }
      if (probe.alive) {
        const payload = probe.payload || {};
        const why = String(payload.runtime_state || payload.state || probe.reason || "not serviceable");
        if (probe.identity_verified) this.setState(sid, "DEGRADED", `alive but not serviceable: ${why}`);
        else this.setState(sid, "FAILED", `alive but its identity is not verified (${why}); not restarted, not killed`);
        continue;
      }
      if (probe.occupied && !probe.verified) {
        this.setState(sid, "FAILED", "port held by an unverified occupant; not restarted, not killed");
        continue;
      }
      if (!this.budgetLeft(sid)) {
        const already = String(this.state.get(sid)?.reason || "").startsWith("RESTART_LIMIT");
        this.setState(sid, "FAILED", `RESTART_LIMIT: ${RESTART_BUDGET} automatic restarts within ${RESTART_WINDOW_MS / 60000} min; waiting for an explicit restart`);
        // Recorded once, when the budget runs out -- not on every later pass that finds it still out.
        if (!already) {
          this.remediation?.emit({ component: "supervisor", mechanismId: "health.service_restart", triggerReason: "restart_budget_exhausted",
            identity: {}, outcome: "abandoned", detail: { service_id: sid, restart_budget: RESTART_BUDGET, window_ms: RESTART_WINDOW_MS,
              probe_reason: probe.reason || null } });
        }
        continue;
      }
      this.restarts.get(sid).push(this.now());
      this.saveBudget();
      const attempt = this.restarts.get(sid).length;
      const old = this.lastSeen.get(sid) || { instance_id: null, pid: null };
      this.logger.warn(`[HEALTH] ${sid} is not running (${probe.reason || "gone"}); restarting`);
      const operation = this.remediation?.begin({ component: "supervisor", mechanismId: "health.service_restart",
        triggerReason: "service_not_alive", identity: {}, detail: { service_id: sid, probe_reason: probe.reason || null,
          probe_occupied: Boolean(probe.occupied), old_instance: old.instance_id, old_pid: old.pid, exit_code: probe.exit_code ?? null,
          restarts_in_window: attempt, restart_budget: RESTART_BUDGET } });
      this.ensure(sid, "automatic recovery")
        .then(async (result) => {
          const fresh = await e.host.supervisorProbe()
            .catch((error) => ({ probe_error: String(error?.message || error) }));   /* not an error: recorded -- not proven, so logged below and finished as failed */
          // Succeeded only on a fresh probe that proves the new instance alive and verified, with its identity.
          const proven = Boolean(fresh?.alive && fresh?.verified && fresh?.instance_id);
          if (proven) this.lastSeen.set(sid, { instance_id: fresh.instance_id, pid: fresh.pid ?? null });
          else this.logger.warn(`[HEALTH] ${sid} restarted but not proven running: ${fresh?.probe_error || fresh?.reason || "not alive and verified"}`);
          operation?.finish(proven ? "succeeded" : "failed", { attempt, detail: { service_id: sid, new_instance: fresh?.instance_id ?? null,
            new_pid: fresh?.pid ?? result?.pid ?? null, attached: Boolean(result?.attached),
            probe: proven ? null : { alive: Boolean(fresh?.alive), verified: Boolean(fresh?.verified), reason: fresh?.probe_error || fresh?.reason || null } } });
        })
        .catch((error) => {
          operation?.finish("failed", { attempt, detail: { service_id: sid, error: String(error?.message || error) } });
          this.logger.warn(`[HEALTH] ${sid} recovery failed: ${error?.message || error}`);
        });
    }
  }

  status() {
    return Object.fromEntries(Object.keys(this.entries).map((sid) => [sid, {
      ...(this.state.get(sid) || { state: this.enabled(sid) ? "UNKNOWN" : "DISABLED" }),
      desired: this.desired.get(sid) || null, operation: this.ops.get(sid)?.action || null,
    }]));
  }

  stateOf(sid) { return this.state.get(sid)?.state || null; }
  reasonOf(sid) { return this.state.get(sid)?.reason || null; }
}

// Health's automatic restarts as 系統拓樸 shows them (user 10-19): today, 7 days and which services over 7 days, read
// from the remediation ledger's status. The supervisor owns its mechanism, so the screen never names it.
function restartSummary(remediationStatus) {
  const m = (remediationStatus?.mechanisms || []).find((x) => x.mechanism_id === "health.service_restart");
  return m ? { today: m.today || 0, last_7_days: m.last_7_days || 0, last_7_days_by_service: m.last_7_days_by_service || {} } : null;
}

module.exports = { Supervisor, RESTART_BUDGET, RESTART_WINDOW_MS, restartSummary };
