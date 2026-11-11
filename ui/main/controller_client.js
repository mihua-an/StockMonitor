"use strict";

// Electron main's connection to a running Health (health/control_api.js): an HTTP client, never an owner. (The
// bootstrap that spawns Health makes its own startup calls, with this protocol and the same credential.) Every route
// needs the controller credential, which Electron main reads (never creates) and never hands to a renderer.
// Health decides and starts every service itself; Electron reads startup progress, the shared monitoring
// snapshot, renews the monitoring-detail scope while a monitoring page is visible, previews/applies network
// operations on the user's behalf, requests shutdown, and follows Health's announcement that a shutdown is about to
// stop the services the windows use.
//
// The controller address is the launch runtime's (runtime.network.controllerBaseUrl) unless a baseUrlProvider gives one: Electron
// main passes health_bootstrap's, which reads Health's own record (CONFIG_ROOT/bootstrap/health_endpoint.json), so a
// self-endpoint change is followed (06 section 6) -- never by scanning ports.

const { fetchJson: fetchJsonWithTimeout } = require("../../service/platform/js/fetch_timeout");
const http = require("http");
const path = require("path");
const { readControllerToken } = require("../../service/platform/js/daemon_auth.js");

const PROTOCOL = "stock-monitor-controller-v2";

function createControllerClient({ fs, env = process.env, baseUrl, baseUrlProvider = null }) {
  // With a bootstrap, its view of the Health process it spawned is authoritative (pid-matched record).
  const current = () => (baseUrlProvider ? (baseUrl = baseUrlProvider() || baseUrl) : baseUrl);

  function currentToken() {
    return readControllerToken({ fs, path, processRef: process });
  }

  async function fetchJson(pathname, { method = "GET", body, timeoutMs = 2000 } = {}) {
    const token = currentToken();
    if (!token) throw new Error("CONTROLLER_NOT_RUNNING: no controller auth token found yet");
    return fetchJsonWithTimeout(fetch, `${current()}${pathname}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, timeoutMs);
  }

  async function health(timeoutMs = 800) {
    try {
      const { response, payload } = await fetchJson("/health", { timeoutMs });
      return response.ok && payload?.ok === true && payload?.protocol === PROTOCOL ? payload : null;
    } catch (error) { console.warn("[CONTROLLER /health probe] failed", error); return null; }
  }

  async function shutdown(scope, timeoutMs = 10000) {
    const { payload } = await fetchJson("/control/shutdown", { method: "POST", body: { scope }, timeoutMs });
    return payload;
  }

  // Health's announcements to this UI (GET /control/ui-events, health/ui_closing_channel.js), held open while Health
  // runs: onOpened() once Health accepted the stream; onClosing({id, scope}) for each shutdown about to stop the
  // services the windows use, answered with acknowledgeUiClosing(id) once they stopped; onEnded(error, {opened}) once,
  // when the stream ends -- error null when Health ended it (Health is exiting), set when it broke or never opened.
  // Returns the function that stops following.
  //
  // The stream is silent by design (nothing to announce for hours), so it is read with node:http and no idle timer:
  // global fetch (undici) ends a response body that sends nothing for 300 s (bodyTimeout) -- the stream broke 300 s
  // after every start. Its own connection (agent: false) is never a pooled keep-alive socket Health already closed.
  function followUiEvents({ onOpened = () => {}, onClosing, onEnded }) {
    let stopped = false;
    let ended = false;
    let opened = false;
    let request = null;
    const end = (error) => {
      if (ended) return;
      ended = true;
      if (stopped) return;   // not an error: this UI stopped following
      onEnded(error, { opened });
    };
    const fail = (error) => end(error instanceof Error ? error : new Error(String(error)));
    let buffer = "";
    const consume = (chunk) => {
      buffer += chunk;
      for (let at = buffer.indexOf("\n\n"); at >= 0; at = buffer.indexOf("\n\n")) {
        const lines = buffer.slice(0, at).split("\n");
        buffer = buffer.slice(at + 2);
        const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
        const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
        if (event !== "closing") continue;
        let announcement = null;
        try { announcement = JSON.parse(data); } catch (error) { console.error(`[CONTROLLER ui event] not JSON: ${data.slice(0, 200)}`, error); continue; }
        Promise.resolve().then(() => onClosing(announcement))
          .catch((error) => console.error("[CONTROLLER ui closing announcement] handling failed", error));
      }
    };
    try {
      const token = currentToken();
      if (!token) throw new Error("CONTROLLER_NOT_RUNNING: no controller auth token found yet");
      request = http.request(`${current()}/control/ui-events`, { method: "GET", agent: false,
        headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream", "Cache-Control": "no-store" } }, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          fail(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        opened = true;
        try { onOpened(); } catch (error) { console.error("[CONTROLLER ui event stream opened] handling failed", error); }
        response.setEncoding("utf8");
        response.on("data", consume);
        // complete: Health ended the stream (its final chunk arrived); otherwise the connection broke mid-stream.
        response.on("end", () => (response.complete ? end(null) : fail(new Error("the stream broke before Health ended it"))));
        response.on("aborted", () => fail(new Error("the stream broke before Health ended it")));
        response.on("error", fail);
      });
      request.on("error", fail);
      request.end();
    } catch (error) {
      queueMicrotask(() => fail(error));
    }
    return () => { stopped = true; request?.destroy(); };
  }

  async function acknowledgeUiClosing(id, timeoutMs = 2000) {
    const { payload } = await fetchJson("/control/ui-closing-done", { method: "POST", body: { id }, timeoutMs });
    return payload?.ok === true;
  }

  async function getStatus(timeoutMs = 2000) {
    const { payload } = await fetchJson("/status", { timeoutMs });
    return payload;
  }

  // {attempt: {generation, health_instance, ...}, services: service_id -> {status, attempt, ms, error?}} as Health
  // records them.
  async function getStartupStatus(timeoutMs = 1500) {
    try {
      const { payload } = await fetchJson("/status/startup", { timeoutMs });
      return payload?.services ? { attempt: payload.attempt || null, services: payload.services, storage_move: payload.storage_move || null } : null;
    } catch (error) { console.warn("[CONTROLLER /status/startup read] failed", error); return null; }
  }

  // The shared monitoring snapshot (07): one read for every settings window, never a per-window service scan.
  let lastSnapshotFailure = null;
  // trendSince: the trend points Health sampled after this time (ms; 0 for all); null, no trend.
  async function getSnapshot({ trendSince = null, timeoutMs = 2500 } = {}) {
    try {
      const { payload } = await fetchJson(`/snapshot${trendSince === null ? "" : `?trend_since=${trendSince}`}`, { timeoutMs });
      lastSnapshotFailure = null;
      return payload || { ok: false, snapshot: null, stale: true };
    } catch (error) {
      // Read every few seconds while a monitoring page is open: a failure is logged when its reason changes.
      // not an error: the same reason again repeats one already logged (the page shows the snapshot as stale)
      const reason = String(error?.message || error);
      if (reason !== lastSnapshotFailure) console.warn(`[CONTROLLER /snapshot read] failed: ${reason}`);
      lastSnapshotFailure = reason;
      return { ok: false, snapshot: null, stale: true, error: reason };
    }
  }

  // Renewed while a monitoring page is visible; detail (metrics, OS resources) stops when renewals stop.
  // `appPids`: Electron's own process ids (main first) -- 系統 CPU counts them beside the services.
  async function requestMonitoringDetail({ appPids = null, timeoutMs = 1500 } = {}) {
    try {
      const body = appPids ? { monitoring_detail: true, app_pids: appPids } : { monitoring_detail: true };
      const { payload } = await fetchJson("/control/ui-scope", { method: "POST", body, timeoutMs });
      return Boolean(payload?.ok);
    } catch (error) { console.warn("[CONTROLLER monitoring-detail request] failed", error); return false; }
  }

  // Electron's own process ids on their own, page open or not: Health's background CPU / 記憶體 trend needs them for a
  // total, so a monitoring page that opens has the last minutes to draw. A failure is logged when its reason changes.
  let lastAppProcessFailure = null;
  async function reportAppProcesses(appPids, timeoutMs = 1500) {
    try {
      const { payload } = await fetchJson("/control/ui-scope", { method: "POST", body: { app_pids: appPids }, timeoutMs });
      lastAppProcessFailure = null;
      return Boolean(payload?.ok);
    } catch (error) {
      // not an error: the same reason again repeats one already logged (Health not up yet, or restarting)
      const reason = String(error?.message || error);
      if (reason !== lastAppProcessFailure) console.warn(`[CONTROLLER app-process report] failed: ${reason}`);
      lastAppProcessFailure = reason;
      return false;
    }
  }

  async function previewNetwork(candidateRevision, timeoutMs = 5000) {
    const { payload } = await fetchJson("/operations/network/preview", { method: "POST", body: { candidate_revision: candidateRevision }, timeoutMs });
    return payload;
  }

  // Long: Health drains, stops, rebinds and verifies every affected service before answering.
  async function applyNetwork({ operationId, candidateRevision, expectedActiveRevision }, timeoutMs = 180000) {
    const { payload } = await fetchJson("/operations/network/apply", {
      method: "POST", timeoutMs,
      body: { operation_id: operationId, candidate_revision: candidateRevision, expected_active_revision: expectedActiveRevision, requested_by: "settings" },
    });
    return payload;
  }

  // `waitMs`: Health holds the read until its effective endpoints settle (at most that long); 0 answers at once.
  async function getNetworkEffective(waitMs = 0) {
    const wait = Math.max(0, Math.floor(Number(waitMs) || 0));
    const { payload } = await fetchJson(wait ? `/network/effective?wait_ms=${wait}` : "/network/effective", { timeoutMs: wait + 2000 });
    return payload;
  }

  // The broker SDK install Health runs (health/provider_sdk_job.js): its status with the job's progress, and starting it.
  async function getProviderSdk(timeoutMs = 35000) {
    const { payload } = await fetchJson("/provider-sdk", { timeoutMs });
    return payload;
  }

  async function getProviderSdkJob(timeoutMs = 2000) {
    const { payload } = await fetchJson("/provider-sdk/job", { timeoutMs });
    return payload;
  }

  async function installProviderSdk(provider, timeoutMs = 5000) {
    const { payload } = await fetchJson("/provider-sdk/install", { method: "POST", body: { provider }, timeoutMs });
    return payload;
  }

  async function getOperations(timeoutMs = 2000) {
    const { payload } = await fetchJson("/operations", { timeoutMs });
    return payload;
  }

  return { health, shutdown, followUiEvents, acknowledgeUiClosing, getStatus, getStartupStatus, getSnapshot, requestMonitoringDetail, reportAppProcesses,
    previewNetwork, applyNetwork, getOperations, getNetworkEffective, getProviderSdk, getProviderSdkJob, installProviderSdk };
}

module.exports = { PROTOCOL, createControllerClient, PROTOCOL };
