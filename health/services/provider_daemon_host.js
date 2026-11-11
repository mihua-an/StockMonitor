"use strict";

// One host for a provider daemon (Shioaji, Futu): construction, the owner-record start/stop
// (health/startup/provider_daemon_ownership.js), ensure, probe, supervisor probe, the detached spawn, its log tail
// and address are all here, once. A source's host passes what is its own -- identity, script, environment flag,
// file names, budgets -- and overrides only the hooks where it differs (Shioaji: its passive heartbeat and its
// startup diagnostic). A fix to the shared lifecycle lands in both sources at once.

const net = require("net");
const path = require("path");
const { spawn } = require("child_process");
const { createProviderDaemonOwnership } = require("../startup/provider_daemon_ownership");
const { probeTcpPort, stoppable } = require("../../service/platform/js/daemon_connection");
const { terminateProcessTree } = require("../../service/platform/js/forced_termination");
const { processAliveFast, readUtf8FileTail } = require("../../service/platform/js/process_utils");
const { logSessionPath } = require("../../service/platform/js/log_session");
const { SpawnedDaemon } = require("./spawned_daemon");
const { spawnedStorageUser } = require("../startup/storage_users");
const { resolveVarPaths } = require("../../config/js/var_paths");
const { childEnv } = require("../../service/platform/js/child_env");

class ProviderDaemonHost {
  /**
   * @param {object} source what is this source's own:
   *   { name, label, serviceId, script: [path parts under the project], detachedFlag, logName, ownerFile,
   *     budgets?: object }
   * @param {object} options the runtime configuration health/main.js passes every host.
   */
  constructor(source, options = {}) {
    const {
      projectRoot, endpoint, expected,
      pythonExecutable = "python", enabled = true, fetchImpl = fetch, env = () => childEnv(process.env),
      remediation = null, logger = console,
    } = options;
    if (!projectRoot || typeof endpoint !== "function" || !expected) {
      throw new Error(`${source.label} host missing runtime configuration`);
    }
    this.source = source;
    this.projectRoot = projectRoot;
    // The daemon's address is read at each use, never captured at construction: an applied network revision
    // moves it, and the probe, the owner record's stop and the port check must follow it there.
    this.endpoint = endpoint;
    this.expected = expected;
    this.pythonExecutable = String(pythonExecutable || "python");
    this.enabled = Boolean(enabled);
    this.fetchImpl = fetchImpl;
    this.env = env;
    this.remediation = remediation;
    this.logger = logger;
    this.lastProbe = { reachable: false, compatible: false, payload: null };
    this.lastSpawnState = { pid: null, exitCode: null, signal: null, error: null, startedAt: 0 };
    this.spawned = new SpawnedDaemon({ label: source.label, serviceId: source.serviceId, remediation, logger });

    // Start and stop are decided from the daemon's own owner record.
    this.controller = createProviderDaemonOwnership({
      label: source.label,
      serviceId: source.serviceId,
      daemonUrl: () => this.daemonUrl,
      expected: this.expectedIdentity(),
      ownerPath: () => this.singletonOwnerPath(),
      receiptPath: () => this.singletonOwnerPath().replace(/\.json$/, "_stop_receipt.json"),
      fetchImpl: (...args) => this.fetchImpl(...args),
      spawnDetached: () => this.spawnDetached(),
      getSpawnState: () => ({ ...this.lastSpawnState }),
      // The daemon this host spawned, while its handle is held (its pid cannot name another process).
      heldPid: () => (this.spawned.alive() ? this.spawned.child.pid : null),
      isPortOpen: () => this.isPortOpen(),
      terminate: (pid) => terminateProcessTree(pid),
      remediation,
      readLogTail: () => this.logTail(),
      detachedLogPath: () => this.detachedLogPath(),
      logger,
      onAction: (event) => this.onAction(event),
      ...(source.budgets ? { budgets: source.budgets } : {}),
    });
  }

  expectedIdentity() {
    return { identity: this.expected.identity, protocolVersion: this.expected.protocolVersion,
      runtimeVersion: this.expected.runtimeVersion };
  }

  get probeSnapshot() { return { ...this.lastProbe }; }

  async probe(timeoutMs = 1000) {
    const probe = await this.controller.probeHealth(timeoutMs);
    this.lastProbe = probe;
    return probe;
  }

  async ensure() {
    if (!this.enabled) return { ok: true, skipped: true, source: this.source.name };
    const spawnedBefore = this.lastSpawnState.startedAt;
    let result;
    try {
      result = await this.controller.ensure();
    } catch (error) {
      // A daemon this attempt spawned that never came up is not left behind (an orphan that never served).
      if (this.lastSpawnState.startedAt !== spawnedBefore) await this.spawned.reap("a failed start", 0);
      throw error;
    }
    if (result.health) this.lastProbe = { reachable: true, compatible: true, payload: result.health };
    this.afterEnsure(result);
    // The verified daemon's pid is this service's pid in Health's startup record, like every other service's.
    return { ...result, pid: result.pid ?? result.health?.daemon_pid ?? null };
  }

  /** The identity a supervisor probe judges by: the HTTP probe's payload, unless a source has a better witness. */
  identityWitness(probe) {
    return { payload: probe.payload || {}, verified: probe.compatible, occupied: probe.reachable, extra: {} };
  }

  async supervisorProbe() {
    const probe = await this.probe();
    const witness = this.identityWitness(probe);
    const payload = witness.payload;
    const pid = Number(payload.daemon_pid || 0);
    return {
      ...probe,
      pid,
      alive: processAliveFast(pid),
      occupied: witness.occupied || await this.isPortOpen(),
      verified: witness.verified,
      // Identity without the serviceability conditions -- what a STOP is allowed to act on
      // (service/platform/js/daemon_connection.js stoppable()): a daemon that is not serviceable (DAEMON_HALF_DEAD,
      // STOPPING) must still be stoppable.
      identity_verified: stoppable(payload, this.expectedIdentity()),
      instance_id: payload.daemon_instance_id,
      // As the daemon reports them: absent stays absent, never defaulted.
      config_revision: payload.config_revision, bound_host: payload.host, bound_port: payload.port,
      ...witness.extra,
    };
  }

  // Clean only on this daemon's own stop receipt; past its grace the same owner alone is terminated.
  async stop(reason) {
    return this.controller.stop(reason);
  }

  get daemonUrl() {
    const { host, port } = this.endpoint();
    return `http://${host}:${port}`;
  }

  get daemonPort() { return Number(this.endpoint().port); }

  isPortOpen(timeoutMs = 300) {
    return probeTcpPort(net, this.daemonPort, timeoutMs);
  }

  spawnDetached() {
    const { label, serviceId, script, detachedFlag } = this.source;
    const daemon = spawn(this.pythonExecutable, [path.join(this.projectRoot, ...script)], {
      cwd: this.projectRoot,
      shell: false,
      windowsHide: true,
      detached: true,
      stdio: "ignore",
      env: { ...this.env(), [detachedFlag]: "1", STOCK_MONITOR_SERVICE_ID: serviceId },
    });
    this.spawned.track(daemon);
    const pid = daemon.pid || null;
    spawnedStorageUser(serviceId, pid);
    this.onSpawned(pid);
    this.lastSpawnState = { pid, exitCode: null, signal: null, error: null, startedAt: Date.now() };
    daemon.once("error", (error) => {
      this.lastSpawnState = { ...this.lastSpawnState, error: String(error?.message || error || "spawn error") };
      this.logger.error(`[${label}] detached spawn error pid=${pid || "?"}: ${this.lastSpawnState.error}`);
    });
    daemon.once("exit", (code, signal) => {
      this.lastSpawnState = { ...this.lastSpawnState, exitCode: code, signal: signal || null };
      if (code !== 0) this.logger.error(`[${label}] detached process exited pid=${pid || "?"} code=${code} signal=${signal || ""}`);
    });
    daemon.unref();
    this.logger.log(`[${label}] starting new detached pid=${pid}`);
    return pid;
  }

  // The daemon writes its detached log into this run's log directory (backend/shared/detached_output.py), the same
  // one this process logs to.
  detachedLogPath() {
    return logSessionPath(this.source.logName);
  }

  logTail(maxChars = 5000) {
    return readUtf8FileTail(this.detachedLogPath(), maxChars);
  }

  singletonOwnerPath() {
    return path.join(resolveVarPaths({ env: process.env }).state, this.source.ownerFile);
  }

  // Hooks a source overrides where it differs.
  afterEnsure(_result) {}

  onSpawned(_pid) {}

  onAction(_event) {}
}

module.exports = { ProviderDaemonHost };
