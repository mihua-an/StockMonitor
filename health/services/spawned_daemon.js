"use strict";

// The provider daemon process a host spawned, held by its ChildProcess handle. While Node holds that handle the pid
// cannot be reused by another process, so terminating it needs no command-line check.
//
// Why: a daemon that was started but never served -- its startup timed out, or it released its
// port and then never exited (a non-daemon SDK thread) -- was invisible to every port-based stop and outlived Health.
// The host reaps it after a failed start that spawned it (a stop waits for the owner process itself to exit:
// health/startup/provider_daemon_ownership.js).

const { execFile } = require("child_process");
const { TRIGGERS, recordForcedTermination, forceEndChild, waitChildExit } = require("../../service/platform/js/forced_termination");

const EXIT_WAIT_MS = 10000;

class SpawnedDaemon {
  constructor({ label, serviceId = null, remediation = null, logger = console, execFileImpl = execFile }) {
    this.label = label;
    this.serviceId = serviceId;
    this.remediation = remediation;
    this.logger = logger;
    this.execFile = execFileImpl;
    this.child = null;
  }

  track(child) { this.child = child || null; }

  alive() {
    const child = this.child;
    return Boolean(child && child.pid && child.exitCode === null && child.signalCode === null);
  }

  waitExit(timeoutMs) {
    return this.alive() ? waitChildExit(this.child, timeoutMs) : Promise.resolve(true);
  }

  // Gives the process `graceMs` to leave on its own, then terminates its tree. Resolves whether one was reaped.
  async reap(reason, graceMs = EXIT_WAIT_MS) {
    if (!this.alive()) return false;
    if (graceMs > 0 && await this.waitExit(graceMs)) return false;
    const pid = this.child.pid;
    this.logger.error?.(`[${this.label}] spawned pid=${pid} still running after ${reason}; terminating it`);
    let exited = await forceEndChild(this.child, { execFileImpl: this.execFile, logger: this.logger });
    if (!exited) {
      try { this.child.kill(); } catch (error) { console.warn("[stopping a provider daemon] failed", error); }
      exited = await this.waitExit(2000);
    }
    // Every forced end is recorded: this child never kept its stop contract.
    recordForcedTermination(this.remediation, { component: "spawned_daemon", serviceId: this.serviceId, pid, trigger: TRIGGERS.START_FAILED,
      reason, graceMs, exited });
    return true;
  }
}

module.exports = { SpawnedDaemon };
