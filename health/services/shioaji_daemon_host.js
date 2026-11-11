"use strict";

// The Shioaji provider daemon: the shared provider host (provider_daemon_host.js) plus what is Shioaji's own -- its
// passive heartbeat as the identity witness, its startup decision record and its startup-progress reporting.
const path = require("path");
const { writeJsonAtomic } = require("../../service/platform/js/atomic_files");
const { compatible, readPassiveDaemonHeartbeat } = require("../../service/platform/js/daemon_connection");
const { resolveVarPaths } = require("../../config/js/var_paths");
const { ProviderDaemonHost } = require("./provider_daemon_host");

const SHIOAJI = Object.freeze({
  name: "shioaji",
  label: "MARKET DAEMON",
  serviceId: "provider_shioaji",
  script: ["backend", "shioaji", "run_shioaji_daemon.py"],
  detachedFlag: "MARKET_DAEMON_DETACHED",
  logName: "market_daemon.log",
  ownerFile: "market_daemon_owner.json",
});

class ShioajiDaemonHost extends ProviderDaemonHost {
  // `userDataPath` is the Electron-compatible userData directory Health resolves itself (config/js/var_paths.js
  // userDataDir()), so both processes' diagnostic files land in the same directory.
  constructor(options = {}) {
    super(SHIOAJI, options);
    const { userDataPath, startupCoordinator = null, markStartupTrace = () => {} } = options;
    this.userDataPath = userDataPath;
    this.startupCoordinator = startupCoordinator;
    this.markStartupTrace = markStartupTrace;
    this.startupDiagnostic = {
      schema: "market-daemon-startup-decision-v3",
      process_started_at: new Date().toISOString(),
      health_pid: process.pid,
      expected_identity: this.expected.identity,
      expected_protocol_version: this.expected.protocolVersion,
      expected_runtime_version: this.expected.runtimeVersion,
      actions: [],
      startup_daemon_action: "UNSTARTED",
      decision: null,
      spawn_count: 0,
    };
    this.persistStartupDiagnostic();
  }

  afterEnsure(result) {
    this.startupDiagnostic.decision = result.decision || null;
    if (result.health) {
      this.startupDiagnostic.existing_pid = result.health.daemon_pid ?? null;
      this.startupDiagnostic.existing_instance_id = result.health.daemon_instance_id ?? null;
      this.startupDiagnostic.existing_runtime_version = result.health.daemon_runtime_version ?? null;
      this.startupDiagnostic.health_status = "HEALTHY";
    }
    this.persistStartupDiagnostic();
  }

  // Identity/liveness is checked against the daemon's own passive heartbeat file first (written every ~1s by a
  // background thread independent of the asyncio event loop /health's live HTTP probe depends on), falling back to
  // the HTTP probe when the heartbeat is missing or stale (e.g. the first moment after spawn). This is what tells
  // "the daemon is genuinely gone" from "the daemon is alive but its HTTP layer is wedged by an unrelated blocking
  // lock elsewhere", where every HTTP probe -- /health included -- hangs and would read as an unverified port owner.
  identityWitness(probe) {
    const heartbeat = readPassiveDaemonHeartbeat("market_daemon");
    const heartbeatCompatible = Boolean(heartbeat.fresh && heartbeat.producer && compatible(heartbeat.producer, this.expectedIdentity()));
    return {
      payload: heartbeatCompatible ? heartbeat.producer : (probe.payload || {}),
      verified: probe.compatible || heartbeatCompatible,
      occupied: probe.reachable || Boolean(heartbeat.producer),
      extra: { heartbeat_fresh: heartbeat.fresh, heartbeat_age_seconds: heartbeat.ageSeconds },
    };
  }

  onSpawned(pid) {
    this.markStartupTrace("DAEMON_PROCESS_STARTED", { pid });
  }

  startupDiagnosticPath() {
    return path.join(resolveVarPaths({ env: process.env }).state, "market_daemon_startup.json");
  }

  persistStartupDiagnostic(event = null) {
    if (event && typeof event === "object") {
      this.startupDiagnostic.actions.push(event);
      if (this.startupDiagnostic.actions.length > 120) {
        this.startupDiagnostic.actions = this.startupDiagnostic.actions.slice(-120);
      }
      this.startupDiagnostic.startup_daemon_action = String(event.action || this.startupDiagnostic.startup_daemon_action);
      if (event.decision) this.startupDiagnostic.decision = event.decision;
      if (event.pid != null) this.startupDiagnostic.existing_pid = event.pid;
      if (event.instance_id != null) this.startupDiagnostic.existing_instance_id = event.instance_id;
      if (event.runtime != null) this.startupDiagnostic.existing_runtime_version = event.runtime;
      if (event.health != null) this.startupDiagnostic.health_status = event.health;
      if (event.child_pid != null) this.startupDiagnostic.child_pid = event.child_pid;
      if (event.child_exit_code != null) this.startupDiagnostic.child_exit_code = event.child_exit_code;
      if (event.owner != null) this.startupDiagnostic.port_owner = event.owner;
      if (event.singleton_owner != null) this.startupDiagnostic.singleton_owner = event.singleton_owner;
      if (event.known_daemon_owner != null) this.startupDiagnostic.known_daemon_owner = Boolean(event.known_daemon_owner);
    }
    const filePath = this.startupDiagnosticPath();
    if (!filePath) return;
    try {
      writeJsonAtomic(filePath, { ...this.startupDiagnostic, updated_at: new Date().toISOString() }, { indent: 2 });
    } catch (error) {
      this.logger.warn(`[DAEMON STARTUP] diagnostic persist failed: ${error?.message || error}`);
    }
  }

  onAction(event) {
    if (event?.action === "START_NEW") {
      this.startupDiagnostic.spawn_count += 1;
      this.markStartupTrace("DAEMON_SPAWN_START", { source: event?.source || "startup_controller" });
    }
    this.persistStartupDiagnostic(event);
  }

  onProgress({ pid, elapsedMs }) {
    const detail = `waiting daemon pid=${pid || "?"} elapsed=${elapsedMs}ms`;
    const lifecycleState = String(this.startupCoordinator?.snapshot?.().state || "");
    if (["STARTING", "WINDOW_CREATED", "DAEMON_CHECKING"].includes(lifecycleState)) {
      this.startupCoordinator?.markProgress?.("DAEMON_CHECKING", null, detail);
    } else {
      this.markStartupTrace("DAEMON_WAIT_PROGRESS", { pid: pid || null, elapsed_ms: elapsedMs });
    }
  }
}

module.exports = { ShioajiDaemonHost };
