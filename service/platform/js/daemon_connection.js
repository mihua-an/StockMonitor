"use strict";

// Shared by BOTH ui/main (Electron, for the direct-to-daemon trade-detail
// read path) and health/ (the Service Controller, which owns
// daemon lifecycle). No process-lifecycle authority lives here -- pure wire
// checks. Owner/PID/project validation and upgrade policy stay in the source
// controllers; this module cannot spawn, stop or recover a process.

const fs = require("fs");
const path = require("path");
const { resolveVarPaths } = require("../../../config/js/var_paths");

function ownIdentity(payload, expected) {
  return Boolean(payload && String(payload.identity || "") === String(expected.identity || ""));
}
function probeTcpPort(net, port, timeoutMs = 300, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const done = (value) => { if (settled) return; settled = true; socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

// Post-stop verification only (does the OS-level port actually go away);
// owns no stop decision or retry-the-stop-request policy of its own.
function compatible(payload, expected) {
  const state = String(payload?.runtime_state || payload?.state || "").toUpperCase();
  const version = payload?.protocol_version;
  return Boolean(payload?.ok === true && ownIdentity(payload, expected)
    && ["number", "string"].includes(typeof version)
    && String(version) === String(expected.protocolVersion)
    && String(payload.daemon_runtime_version || "") === String(expected.runtimeVersion || "")
    && !["DAEMON_HALF_DEAD", "STOPPING", "STOPPED"].includes(state)
    && payload.server_accepting_clients !== false);
}

// Identity-only gate for a STOP decision.
//
// compatible() above answers "may I ATTACH to this daemon?", so it also requires the daemon to
// be serviceable: ok === true, still accepting clients, and not DAEMON_HALF_DEAD / STOPPING /
// STOPPED. Reusing it as the gate for "may I STOP this daemon?" inverts the logic -- the states
// where stopping matters most are exactly the ones it refuses. Measured effect: a full shutdown
// answered ok:false with `Unverified or incompatible stop target` for both provider daemons and
// took ~25s of timeout instead of a graceful stop.
//
// Every identity condition is kept, so a foreign process or a different build on the same port
// is still never touched; only the serviceability conditions are dropped.
function stoppable(payload, expected) {
  const version = payload?.protocol_version;
  return Boolean(payload && ownIdentity(payload, expected)
    && ["number", "string"].includes(typeof version)
    && String(version) === String(expected.protocolVersion)
    && String(payload.daemon_runtime_version || "") === String(expected.runtimeVersion || ""));
}

// Same schema/path/interval as service/market/shared/dataflow_health.py's
// DataFlowHealthLedger/DataFlowSnapshotPublisher: a daemon's own dedicated
// background thread (not the asyncio event loop, and lock-free with respect
// to any request-handling lock) writes this file roughly once per second.
// Reading it here is a push/heartbeat check -- it answers "is this exact
// PID/instance alive and identity-compatible" without any HTTP round trip,
// so it stays correct even when the daemon's HTTP layer itself is wedged
// (a real, reproduced incident: a synchronous lock held across slow disk I/O
// in one route handler blocked the single asyncio event loop thread, making
// every HTTP probe -- including /health, whose own handler is lock-light --
// hang indefinitely because the thread that would run it never got control
// back). A mutating action (stop/reconnect) still has to go over HTTP/RPC,
// since only the live process can actually cooperate with a graceful stop;
// this function only ever answers the identity/liveness question.
const DATAFLOW_HEALTH_SCHEMA = "stock-monitor-dataflow-health-v1";

function dataflowHeartbeatPath(component) {
  const normalized = String(component || "process").replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(resolveVarPaths({ env: process.env }).state, "health", `${normalized}.json`);
}

function readPassiveDaemonHeartbeat(component, { maxAgeSeconds = 5, fsImpl = fs } = {}) {
  const filePath = dataflowHeartbeatPath(component);
  if (!filePath) return { fresh: false, producer: null, process: null, ageSeconds: null };
  let snapshot;
  try {
    snapshot = JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
  } catch (error) {
    // absent is not an error: no heartbeat written yet
    if (error?.code !== "ENOENT") console.warn(`[dataflow heartbeat] reading ${filePath} failed`, error);
    return { fresh: false, producer: null, process: null, ageSeconds: null };
  }
  if (!snapshot || snapshot.schema !== DATAFLOW_HEALTH_SCHEMA) {
    return { fresh: false, producer: null, process: null, ageSeconds: null };
  }
  const generatedNs = Number(snapshot.generated_epoch_ns || 0);
  const ageSeconds = generatedNs > 0 ? Math.max(0, (Date.now() * 1e6 - generatedNs) / 1e9) : null;
  const fresh = ageSeconds !== null && ageSeconds <= Math.max(1, Number(maxAgeSeconds) || 5);
  const producer = snapshot.producer && typeof snapshot.producer === "object" ? snapshot.producer : null;
  const processInfo = snapshot.process && typeof snapshot.process === "object" ? snapshot.process : null;
  return { fresh, producer, process: processInfo, ageSeconds };
}

async function fetchDaemonJson(fetchImpl, url, { timeoutMs = 1000, ...options } = {}) {
  const controller = new AbortController();
  const bounded = Math.max(100, Number(timeoutMs) || 1000);
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(url, { ...options, signal: controller.signal });
        let payload = null;
        try { payload = await response.json(); }
        catch (error) { console.warn(`[daemon HTTP] ${url} answered ${response.status} with a body that is not JSON: ${error?.message || error}`); }
        return { response, payload };
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`Daemon HTTP timed out after ${bounded}ms`);
          error.name = "AbortError";
          reject(error);
          controller.abort();
        }, bounded);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

module.exports = {
  compatible, stoppable, ownIdentity, fetchDaemonJson, probeTcpPort,
  readPassiveDaemonHeartbeat, dataflowHeartbeatPath,
};
