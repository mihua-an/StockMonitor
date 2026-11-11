"use strict";

// Host for one Python business API process (realtime_api, app_api; each serves several parts, see
// api/services/realtime_api.py and app_api.py) -- docs/system-architecture/00 sections 3-4, 06 section 5.
//
// * spawn `python -m api.services.<service_id> --port <effective> --config-revision <r>`;
// * a listener is ours only after /api/service/identity (service-management credential) names the same
//   service_id and protocol; an occupant that does not answer that way is never killed and never adopted;
// * stop = drain + stop over the service's own port, then wait for the owned process to exit; a hard kill only
//   for an owned child after the grace period.

const { fetchJson } = require("../../service/platform/js/fetch_timeout");
const { probeTcpPort } = require("../../service/platform/js/daemon_connection");
const { TRIGGERS, recordForcedTermination, forceEndChild } = require("../../service/platform/js/forced_termination");
const { createLogSink } = require("./log_sink");
const { spawnedStorageUser } = require("../startup/storage_users");
const { childEnv } = require("../../service/platform/js/child_env");
const net = require("net");
const { spawn, execFile } = require("child_process");

const SERVICE_PROTOCOL = "stock-monitor-service-v1";
const START_TIMEOUT_MS = 90000;
const STOP_GRACE_MS = 15000;
const KILL_WAIT_MS = 5000;

// The one TCP probe, here with this host's own default timeout.
function portOpen(host, port, timeoutMs = 250) {
  return probeTcpPort(net, port, timeoutMs, host);
}

class PythonServiceHost {
  // The child output log's own health: lost chunks, write failures, last error; null before a start.
  logSinkHealth() { return this.logSink ? this.logSink.health() : null; }

  constructor({ serviceId, effective, pythonExecutable, projectRoot, logDir, managementToken,
    env = () => childEnv(process.env), fs, path, logger = console, spawnImpl = spawn, fetchImpl = fetch, extraEnv = () => ({}),
    execFileImpl = execFile, platform = process.platform, remediation = null }) {
    this.remediation = remediation;
    this.serviceId = serviceId;
    this.effective = effective;
    this.pythonExecutable = pythonExecutable;
    this.projectRoot = projectRoot;
    this.logDir = logDir;
    this.managementToken = managementToken;
    // A function returning the allowlisted environment of this role, never the launcher's whole env.
    this.env = env;
    this.fs = fs;
    this.path = path;
    this.logger = logger;
    this.spawn = spawnImpl;
    this.execFile = execFileImpl;
    this.platform = platform;
    this.fetch = fetchImpl;
    this.extraEnv = extraEnv;
    this.child = null;
    this.instanceId = null;
    this.startedAt = null;
    this.lastExit = null;
  }

  get endpoint() {
    const entry = this.effective.services[this.serviceId];
    return { host: entry.host, port: Number(entry.port) };
  }

  baseUrl() { return `http://${this.endpoint.host}:${this.endpoint.port}`; }

  async management(pathname, { method = "GET", timeoutMs = 2000 } = {}) {
    const { response, payload } = await fetchJson(this.fetch, `${this.baseUrl()}${pathname}`, {
      method, headers: { Authorization: `Bearer ${this.managementToken}` },
    }, timeoutMs);
    return { status: response.status, body: payload };
  }

  // Identity of whatever answers on our port, or null. `verified` = it is this service.
  async identity(timeoutMs = 1500) {
    try {
      const { status, body } = await this.management("/api/service/identity", { timeoutMs });
      if (status !== 200 || !body) return { answered: true, verified: false, reason: `identity HTTP ${status}` };
      const verified = body.protocol === SERVICE_PROTOCOL && body.service_id === this.serviceId;
      return { answered: true, verified, body, reason: verified ? null : "identity does not match" };
    } catch (error) {
      // not an error: no answer on the port is what this reports (answered: false); the supervisor judges and logs it
      return { answered: false, verified: false, reason: String(error?.message || error) };
    }
  }

  // Whether anything listens on our port: the short TCP knock, before any authenticated request.
  portPresent() {
    const { host, port } = this.endpoint;
    return portOpen(host, port);
  }

  // A closed port is checked with the TCP knock alone: the identity request first waited its whole 1.5 s timeout
  // on a port nothing listened on (a Windows loopback connect to a closed port is retried, not refused at once) --
  // at every start of every service. An open port must still prove it is ours (identity) before it is adopted.
  // An instance verified at the last probe is asked directly; the knock runs again only when that identity fails.
  async supervisorProbe() {
    const { port } = this.endpoint;
    let id = null, present;
    if (this.lastVerified) {
      id = await this.identity();
      present = id.answered || await this.portPresent();
    } else {
      present = await this.portPresent();
      if (present) id = await this.identity();
    }
    if (!id) id = { answered: false, verified: false, reason: "port closed" };
    this.lastVerified = Boolean(id.verified);
    const occupied = present || id.answered;
    const pid = id.body?.pid || this.child?.pid || null;
    return {
      service_id: this.serviceId, alive: Boolean(id.verified), occupied, verified: Boolean(id.verified), identity_verified: Boolean(id.verified),
      instance_id: id.body?.instance_id || null, pid, owned: Boolean(this.child && this.child.exitCode === null),
      // As the process reports them: absent stays absent, never defaulted.
      config_revision: id.body?.config_revision, bound_host: id.body?.host, bound_port: id.body?.port,
      port, reason: id.reason, draining: Boolean(id.body?.draining),
    };
  }

  async ensure() {
    const probe = await this.supervisorProbe();
    if (probe.verified) {
      this.instanceId = probe.instance_id;
      return { ok: true, attached: !probe.owned, pid: probe.pid, instance_id: probe.instance_id };
    }
    if (probe.occupied) {
      throw new Error(`${this.serviceId}: port ${probe.port} is held by an unverified occupant (${probe.reason}); not started, not killed`);
    }
    const { port } = this.endpoint;
    const logFile = this.path.join(this.logDir, `${this.serviceId}.log`);
    const log = createLogSink(this.fs, logFile);
    this.logSink = log;
    this.fs.mkdirSync(this.logDir, { recursive: true });
    const args = ["-m", `api.services.${this.serviceId}`, "--port", String(port)];
    if (this.effective.revision !== null && this.effective.revision !== undefined) args.push("--config-revision", String(this.effective.revision));
    const child = this.spawn(this.pythonExecutable, args, {
      cwd: this.projectRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...this.env(), PYTHONUNBUFFERED: "1", STOCK_MONITOR_SERVICE_ID: this.serviceId,
        STOCK_MONITOR_MANAGED_BY_HEALTH: "1", ...this.extraEnv() },
    });
    child.stdout?.on("data", (chunk) => log.write(chunk));
    child.stderr?.on("data", (chunk) => log.write(chunk));
    this.child = child;
    spawnedStorageUser(this.serviceId, child.pid);
    this.startedAt = Date.now();
    // A failed spawn (missing executable, bad cwd) emits "error", never "exit": unhandled it was an uncaught
    // exception in Health, and exitCode stayed null so the start waited out its whole timeout.
    child.once("error", (error) => {
      child.spawnError = error;
      this.lastExit = { code: null, signal: null, error: String(error?.message || error), at: new Date().toISOString() };
      if (this.child === child) this.child = null;
      this.logger.error(`[HEALTH] ${this.serviceId} could not be started: ${error?.message || error}`);
    });
    child.once("exit", (code, signal) => {
      this.lastExit = { code, signal, at: new Date().toISOString() };
      if (this.child === child) this.child = null;
    });
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.spawnError) throw new Error(`${this.serviceId} could not be started: ${child.spawnError.message || child.spawnError}`);
      if (child.exitCode !== null) throw new Error(`${this.serviceId} exited with code ${child.exitCode} before it was ready (see ${logFile})`);
      // Until the child binds, the knock answers in at most its 250 ms; the identity request would wait out its timeout.
      const id = (await this.portPresent()) ? await this.identity(1000) : { verified: false };
      if (id.verified) {
        this.instanceId = id.body.instance_id;
        return { ok: true, pid: child.pid, instance_id: this.instanceId, ready_ms: Date.now() - this.startedAt };
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const killed = await this.killOwned(child);
    recordForcedTermination(this.remediation, { component: "python_service_host", serviceId: this.serviceId, pid: child.pid,
      trigger: TRIGGERS.START_FAILED, reason: "not ready in time", graceMs: START_TIMEOUT_MS, exited: killed });
    throw new Error(`${this.serviceId} did not become ready within ${START_TIMEOUT_MS} ms`
      + (killed ? "" : `; pid ${child.pid} did not exit after a kill`));
  }

  // Kill an OWNED child with everything it started, then confirm it exited. child.kill() alone ended only the direct
  // process and nothing checked it was gone, so orphans could keep the port. The services are Health's
  // own non-detached children, so the tree is theirs alone.
  async killOwned(child) {
    return forceEndChild(child, { platform: this.platform, execFileImpl: this.execFile, logger: this.logger, waitMs: KILL_WAIT_MS });
  }

  async drain() {
    const { status, body } = await this.management("/api/service/drain", { method: "POST", timeoutMs: 15000 });
    return { ok: status === 200 && body?.ok !== false, receipt: body };
  }

  async stop(reason = "health_stop") {
    const probe = await this.supervisorProbe();
    if (!probe.occupied) return { ok: true, stopped: true, reason };
    if (!probe.verified) return { ok: false, reason, error: `${this.serviceId}: refusing to stop an unverified occupant` };
    let receipt = null;
    try {
      const response = await this.management("/api/service/stop", { method: "POST", timeoutMs: 20000 });
      receipt = response.body;
    } catch (error) {
      this.logger.warn(`[HEALTH] ${this.serviceId} stop request (${reason}) failed: ${error?.message || error}; waiting for its port to close`);
      receipt = { error: String(error?.message || error) };
    }
    const deadline = Date.now() + STOP_GRACE_MS;
    const { host, port } = this.endpoint;
    while (Date.now() < deadline) {
      if (this.child && this.child.exitCode !== null) this.child = null;
      if (!(await portOpen(host, port, 150))) return { ok: true, reason, receipt, released: true };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.child && this.child.exitCode === null) {
      this.logger.warn(`[HEALTH] ${this.serviceId} did not exit in ${STOP_GRACE_MS} ms; terminating owned pid ${this.child.pid}`);
      const pid = this.child.pid;
      const exited = await this.killOwned(this.child);
      recordForcedTermination(this.remediation, { component: "python_service_host", serviceId: this.serviceId, pid,
        instanceId: this.instanceId ?? null, trigger: TRIGGERS.STOP_GRACE_EXCEEDED, reason, graceMs: STOP_GRACE_MS, exited });
      const released = !(await portOpen(host, port, 150));
      return { ok: exited && released, reason, receipt, forced: true, exited, released };
    }
    return { ok: false, reason, receipt, error: "listener still open after stop and the process is not ours to kill" };
  }

  async metrics() {
    const { status, body } = await this.management("/api/service/metrics", { timeoutMs: 1500 });
    if (status !== 200) throw new Error(`metrics HTTP ${status}`);
    return body;
  }
}

module.exports = { PythonServiceHost, portOpen, SERVICE_PROTOCOL };
