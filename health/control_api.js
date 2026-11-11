"use strict";

// Health's control API on its own resolved port (service_id service_controller) -- docs/system-architecture/00
// sections 3-4, 06 sections 5-6, 07. Loopback only. Every route needs the controller credential, which only
// Electron main holds (renderers never get it). Management requests are narrow: identity, status, the shared
// monitoring snapshot, per-service ensure/stop/restart, the demand status, network apply operations, the broker SDK
// install, UI scope, the UI's event stream and shutdown. No shell, no paths, no client-declared role.

const http = require("http");
const crypto = require("crypto");
const { createUiClosingChannel } = require("./ui_closing_channel.js");

const PROTOCOL = "stock-monitor-controller-v2";

function readJsonBody(request, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error("Request body too large")); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
    });
    request.on("error", reject);
  });
}

function createControllerHttpApi({ host, port, token, identity, supervisor, collector, performShutdown, onFullShutdown = () => {},
  operations = null, providerSdk = null, demandStatus = async () => null, uiScope = () => ({}), network = () => null,
  waitNetwork = async () => {}, storageMove = () => null, logger = console }) {
  // The UI's event stream: a shutdown is announced on it before any service stops (ui_closing_channel.js).
  const uiChannel = createUiClosingChannel({ logger });
  // The attempt each recent start-all request id began (bounded, oldest dropped first).
  const startAllRequests = new Map();
  function send(response, status, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
    response.end(body);
  }

  function authorized(request) {
    const presented = String(request.headers.authorization || "");
    const expected = `Bearer ${token}`;
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async function route(request, response) {
    const url = new URL(request.url, `http://${host}:${port}`);
    if (!authorized(request)) return send(response, 401, { ok: false, error: "CONTROLLER_AUTH_REQUIRED" });
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return send(response, 200, { ok: true, protocol: PROTOCOL, ...identity(), stopping: supervisor.stopping });
      }
      if (request.method === "GET" && url.pathname === "/status") {
        return send(response, 200, { ok: true, protocol: PROTOCOL, ...identity(), services: supervisor.status(), stopping: supervisor.stopping,
          operations: operations ? operations.summary() : null });
      }
      if (request.method === "GET" && url.pathname === "/status/startup") {
        return send(response, 200, { ok: true, schema: "stock-monitor-startup-status-v3",
          attempt: { ...supervisor.attempt, health_instance: identity().instance_id }, services: supervisor.startup, supervisor: supervisor.status(),
          // The history folder move that holds every service start (health/main.js), while it runs; null otherwise.
          storage_move: storageMove() });
      }
      if (request.method === "GET" && url.pathname === "/snapshot") {
        // `trend_since` (ms): the trend points sampled after it -- 0 for all of them; absent, no trend.
        const since = url.searchParams.get("trend_since");
        const trendSince = since === null || since === "" || !(Number(since) >= 0) ? null : Number(since);
        const snapshot = collector.current({ trendSince });
        return send(response, 200, { ok: Boolean(snapshot), snapshot, stale: !snapshot });
      }
      if (request.method === "GET" && url.pathname === "/network/effective") {
        // The addresses the running services were actually started with (Health's live effective config): what
        // Electron main hands to renderers. During an apply this can differ from the active pointer on disk.
        // `wait_ms`: a read made while they are not settled is held until they are (at most that long, 30 s).
        const waitMs = Math.min(30000, Math.max(0, Math.floor(Number(url.searchParams.get("wait_ms")) || 0)));
        if (waitMs && network()?.effective !== true) await waitNetwork(waitMs);
        return send(response, 200, { ok: true, ...network() });
      }
      if (request.method === "GET" && url.pathname === "/demand") {
        return send(response, 200, { ok: true, demand: await demandStatus() });
      }
      if (request.method === "POST" && url.pathname === "/control/service") {
        const body = await readJsonBody(request);
        const sid = String(body.service_id || "");
        const action = String(body.action || "");
        if (!supervisor.entries[sid] || !["ensure", "stop", "restart"].includes(action)) {
          return send(response, 400, { ok: false, error: "service_id and action (ensure|stop|restart) are required" });
        }
        // A supervisor exception reaches this route's error handler (logged with an error_id, HTTP 500); an action the
        // service reports as not done is logged here and answered 409.
        const result = await supervisor[action](sid, `control request: ${action}`);
        if (result?.ok === false) {
          logger.warn(`[HEALTH API] control ${action} ${sid} not completed: ${String(result.error || "no reason given").slice(0, 300)}`);
          return send(response, 409, { ok: false, service_id: sid, action, result });
        }
        return send(response, 200, { ok: true, service_id: sid, action, result });
      }
      if (request.method === "POST" && url.pathname === "/control/start-all") {
        // A UI attaching to a Health that outlived an earlier UI: bring every autostart service back (idempotent --
        // a running, verified service is attached, not restarted). Answered at once with the attempt it began; its
        // outcome is that attempt in /status/startup. A repeat of the same request id (a retry whose first answer was
        // lost) is answered with the attempt the first one began, never a new one.
        const body = await readJsonBody(request);
        const requestId = typeof body?.request_id === "string" && body.request_id.length <= 64 ? body.request_id : null;
        const seen = requestId ? startAllRequests.get(requestId) : null;
        if (seen) return send(response, 202, { ok: true, accepted: true, repeated: true, attempt: seen });
        const running = supervisor.startAll("control_start_all");
        const attempt = { ...supervisor.attempt, health_instance: identity().instance_id };
        if (requestId) {
          startAllRequests.set(requestId, attempt);
          while (startAllRequests.size > 32) startAllRequests.delete(startAllRequests.keys().next().value);
        }
        void running.then((results) => {
          const failed = Object.entries(results).filter(([, r]) => r?.ok === false).map(([sid]) => sid);
          if (failed.length) console.warn(`[HEALTH] start-all attempt ${attempt.generation}: failed ${failed.join(", ")}`);
        }, (error) => console.error(`[HEALTH] start-all attempt ${attempt.generation} failed: ${error?.message || error}`));
        return send(response, 202, { ok: true, accepted: true, attempt });
      }
      if (operations && url.pathname.startsWith("/operations")) {
        if (request.method === "GET" && url.pathname === "/operations") return send(response, 200, { ok: true, ...operations.summary() });
        if (request.method === "GET" && url.pathname.startsWith("/operations/")) {
          const op = operations.get(decodeURIComponent(url.pathname.slice("/operations/".length)));
          return send(response, op ? 200 : 404, op ? { ok: true, operation: op } : { ok: false, error: "UNKNOWN_OPERATION" });
        }
        if (request.method === "POST" && url.pathname === "/operations/network/preview") {
          return send(response, 200, await operations.preview(await readJsonBody(request)));
        }
        if (request.method === "POST" && url.pathname === "/operations/network/apply") {
          const result = await operations.apply(await readJsonBody(request));
          return send(response, result.ok === false && result.http ? result.http : 200, result);
        }
      }
      if (providerSdk && request.method === "GET" && url.pathname === "/provider-sdk") {
        return send(response, 200, { ok: true, ...(await providerSdk.status()) });
      }
      if (providerSdk && request.method === "GET" && url.pathname === "/provider-sdk/job") {
        return send(response, 200, { ok: true, job: providerSdk.job() });
      }
      if (providerSdk && request.method === "POST" && url.pathname === "/provider-sdk/install") {
        const result = providerSdk.install(String((await readJsonBody(request)).provider || ""));
        return send(response, result.ok ? 202 : result.http, result);
      }
      if (request.method === "POST" && url.pathname === "/control/ui-scope") {
        const body = await readJsonBody(request);
        return send(response, 200, { ok: true, ...uiScope(body) });
      }
      if (request.method === "GET" && url.pathname === "/control/ui-events") {
        uiChannel.attach(request, response);
        return undefined;
      }
      if (request.method === "POST" && url.pathname === "/control/ui-closing-done") {
        const body = await readJsonBody(request);
        return send(response, 200, { ok: uiChannel.acknowledge(body.id) });
      }
      if (request.method === "POST" && url.pathname === "/control/shutdown") {
        const body = await readJsonBody(request);
        const scope = String(body.scope || "full");
        const result = await performShutdown(scope);
        send(response, 200, result);
        if (scope === "full") onFullShutdown(result);
        return undefined;
      }
      return send(response, 404, { ok: false, error: "NOT_FOUND" });
    } catch (error) {
      // The caller gets a fixed message and an id to find the full error in the Health log, never the exception text
      // (paths, host names, internals).
      const errorId = crypto.randomBytes(6).toString("hex");
      logger.error(`[HEALTH API] ${request.method} ${url.pathname} failed (error_id=${errorId}): ${error?.stack || error?.message || error}`);
      return send(response, 500, { ok: false, error: "INTERNAL_ERROR", error_id: errorId });
    }
  }

  const server = http.createServer((request, response) => { void route(request, response); });
  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => { server.removeListener("error", reject); resolve(); });
      });
    },
    // Before any service stops: the UI's windows stop their live transports (ui_closing_channel.js announce).
    announceUiClosing: (scope) => uiChannel.announce(scope),
    close() {
      uiChannel.close();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { createControllerHttpApi, PROTOCOL };
