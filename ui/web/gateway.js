"use strict";

// StockMonitor's web gateway: the desktop renderer (ui/renderer) served to a browser, for a server with no display
// (a Linux VM behind a Cloudflare Tunnel). It plays the part Electron main plays on the desktop:
//
//   - serves the renderer pages, with the CSP placeholder filled for this origin and the browser twin of preload.js
//     (ui/web/desktop_api.js) loaded first;
//   - forwards /svc/<service_id>/... to the business APIs and market_runtime's /live socket, attaching the client
//     and viewer tokens it reads like Electron main does (the browser never holds them; ui/web/proxy.js);
//   - answers the renderer's desktopAPI calls at /web/ipc/<channel> through the same handlers and the same channel
//     contract as Electron's IPC (ipc_registration.js, ipc_contract.js), and pushes main -> renderer events on
//     /web/events (server-sent events);
//   - lets a request in only with a valid Cloudflare Access assertion, or, loopback-only, with no check at all
//     (ui/web/access_auth.js).
//
// It does not start or stop the backend: Health does (`node health/main.js`), and the gateway is its client like
// Electron main is. Run: `node ui/web/gateway.js` (npm run web). Configuration (environment):
//   STOCK_MONITOR_WEB_HOST   listen address, default 127.0.0.1 (cloudflared on the same machine connects here)
//   STOCK_MONITOR_WEB_PORT   listen port, default 8080
//   STOCK_MONITOR_WEB_CF_TEAM_DOMAIN, STOCK_MONITOR_WEB_CF_AUD   Cloudflare Access (see access_auth.js)
//   STOCK_MONITOR_WEB_AUTH=none   no identity check; refused unless the listen address is loopback

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { AsyncLocalStorage } = require("node:async_hooks");

const { loadRuntime } = require("../../service/platform/js/launch_runtime.js");
const runtimeCredentials = require("../../service/platform/js/runtime_credentials.js");
const { sourceSettings, sourceEnabled } = require("../../config/js/source_settings.js");
const { createControllerClient } = require("../main/controller_client.js");
const { createApiEndpoints } = require("../main/api_endpoints.js");
const { createClientAuthentication } = require("../main/client_auth.js");
const { createProductCatalogStore } = require("../main/product_catalog_store.js");
const { createProductOperations } = require("../main/product_operations.js");
const { createWatchPageStore } = require("../main/watch_page_store.js");
const { createColorPreferenceStore } = require("../main/color_preference_store.js");
const { createTradeForm } = require("../main/trade_form.js");
const { createProviderSdk } = require("../main/provider_sdk.js");
const { StartupCoordinator, STARTUP_UNITS } = require("../main/startup_lifecycle.js");
const { createIpcRouter } = require("../main/ipc_router.js");
const { CHANNELS, channelRule, DETACHED_WINDOWS, PAGES } = require("../main/ipc_contract.js");
const { TRUSTED_PAGES } = require("../main/renderer_release_manager.js");
const {
  registerRuntimeIpc, registerWindowIpc, registerMonitoringIpc, registerTradeIpc, registerWatchPageIpc, registerSettingsIpc,
} = require("../main/ipc_registration.js");
const { MARKET_RUNTIME_START_MAX_MS, START_ALL_TIMEOUT_MS } = require("../../config/js/startup_budget.js");
const { AccessDenied, accessConfig, createAccessVerifier, sameOrigin, needsSameOrigin, requestHost } = require("./access_auth.js");
const { proxyHttp, proxyUpgrade } = require("./proxy.js");

const RENDERER_DIR = path.resolve(__dirname, "..", "renderer");
const SHIM_FILE = path.join(__dirname, "desktop_api.js");
const CSP_PLACEHOLDER = "__STOCKMONITOR_CONNECT_SOURCES__";
const PROXIED_SERVICES = new Set(["realtime_api", "app_api", "market_runtime"]);
const MAX_IPC_BODY = 256 * 1024;
const CLIENT_IDLE_MS = 10 * 60 * 1000;
const SSE_HEARTBEAT_MS = 20_000;
const CLIENT_ID = /^[A-Za-z0-9-]{8,64}$/;
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff",
  ".map": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
};
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
};

// The browser's view of the source selection: the same projection Electron hands its pages (desktop_application.js).
function rendererSourceProjection() {
  const startupSteps = Object.fromEntries(STARTUP_UNITS.filter((unit) => unit.source).map((unit) => [unit.id, unit.source]));
  return Object.freeze({ ...sourceSettings, startup_steps: Object.freeze(startupSteps) });
}

function sendJson(res, status, body, extra = {}) {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS, ...extra });
  res.end(JSON.stringify(body));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(Object.assign(new Error("request body too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// One renderer static file, confined to ui/renderer; HTML only for the trusted pages.
function rendererFile(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { /* not an error: an undecodable path names no renderer file (404) */ return null; }
  if (decoded.includes("\0")) return null;
  const relative = decoded.replace(/^\/+/, "");
  if (!relative || relative.split("/").some((part) => part.startsWith("."))) return null;
  const resolved = path.resolve(RENDERER_DIR, relative);
  if (!resolved.startsWith(RENDERER_DIR + path.sep)) return null;
  // Top-level HTML is a page and must be a trusted one; HTML below it (pages/*.html) is a fragment app.js fetches.
  if (resolved.endsWith(".html") && path.dirname(resolved) === RENDERER_DIR && !TRUSTED_PAGES.includes(path.basename(resolved))) return null;
  return resolved;
}

function createWebGateway({ env = process.env, logger = console, host, port } = {}) {
  const access = accessConfig(env, { host });
  const verifier = createAccessVerifier(access, { logger });
  const runtime = loadRuntime({ env });
  const controllerClient = createControllerClient({ fs, baseUrl: runtime.network.controllerBaseUrl });
  const apiEndpoints = createApiEndpoints({ logger });
  const clientAuthentication = createClientAuthentication({ apiOrigins: () => apiEndpoints.apiOrigins(), env });
  const authenticatedFetch = clientAuthentication.fetch;
  const urlFor = (pathname) => apiEndpoints.urlFor(pathname);
  // Read at each use, never created here: Health mints it and renews it on a full start.
  const clientToken = () => require("../../service/platform/js/daemon_auth.js")
    .readClientToken({ fs, path, processRef: { env, cwd: () => process.cwd() } });
  const colorPreferenceStore = createColorPreferenceStore(runtime.projectRoot);
  const sources = rendererSourceProjection();
  const clientContext = new AsyncLocalStorage();
  const clients = new Map();   // client id -> { id, page, coordinator, streams: Set<res>, lastSeen }

  // ---- main -> renderer events -------------------------------------------------------------------------------
  function pushTo(client, channel, payload) {
    const frame = `event: ${channel}\ndata: ${JSON.stringify(payload === undefined ? null : payload)}\n\n`;
    for (const res of client.streams) {
      try { res.write(frame); } catch (error) { logger.warn?.(`[WEB] pushing ${channel} failed: ${error.message}`); }
    }
  }
  function broadcast(channel, payload) {
    for (const client of clients.values()) pushTo(client, channel, payload);
  }

  // ---- Health's start outcome, the way app_lifecycle_controller.js waits for it --------------------------------
  async function waitForHealthStartup(serviceIds, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let last = {};
    while (Date.now() < deadline) {
      const snapshot = await controllerClient.getStartupStatus(Math.max(1, Math.min(1500, deadline - Date.now())));
      const wanted = snapshot?.attempt?.generation ?? null;
      const steps = serviceIds.map((sid) => [sid, snapshot?.services?.[sid]]);
      last = Object.fromEntries(steps);
      const current = (step) => wanted === null || Number(step.attempt) === Number(wanted);
      if (!snapshot?.storage_move && steps.every(([, step]) => step && ["ready", "skipped", "failed"].includes(step.status) && current(step))) {
        const failed = steps.filter(([, step]) => step.status === "failed");
        if (failed.length) return { status: "failed", detail: failed.map(([sid, step]) => `${sid}: ${step.error || "failed"}`).join("; ") };
        return { status: steps.every(([, step]) => step.status === "skipped") ? "skipped" : "ready", detail: "" };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { status: "timeout", detail: `Health startup status did not settle (${serviceIds.filter((sid) => !last[sid]).join(", ") || serviceIds.join(", ")})` };
  }
  const outcomes = new Map();
  function startOutcome(name, serviceIds, timeoutMs) {
    if (!outcomes.has(name)) {
      outcomes.set(name, waitForHealthStartup(serviceIds, timeoutMs).then((step) => {
        if (step.status !== "ready") outcomes.delete(name);
        return step;
      }, (error) => { outcomes.delete(name); throw error; }));
    }
    return outcomes.get(name);
  }

  // ---- the catalog, product operations, stores (the same modules Electron main composes) ------------------------
  const productCatalogStore = createProductCatalogStore({
    urlFor, fetchImpl: (...args) => authenticatedFetch(...args), logger,
    onRevision: (revision) => broadcast("product-catalog:changed", { revision }),
  });
  const productOperations = createProductOperations({ fetch: authenticatedFetch, urlFor, productCatalogStore, sourceEnabled });
  const watchPageStore = createWatchPageStore(runtime.projectRoot, { catalog: productCatalogStore });
  const { submitGoogleFormTrade } = createTradeForm({ fetch: authenticatedFetch });
  const providerSdk = createProviderSdk({ controllerClient, logger });

  // ---- one startup coordinator per page load: the overlay of each browser tab shows its own start ---------------
  // The backend units are settled from Health's start outcome (the backend was started by Health, not by this page);
  // the renderer units are the page's own reports, exactly as on the desktop.
  async function settleBackendUnits(coordinator, client) {
    coordinator.completeStep("electron_ready", "網頁閘道");
    coordinator.completeStep("window_shell", "瀏覽器分頁");
    const backend = await startOutcome("backend", ["app_api", "realtime_api"], START_ALL_TIMEOUT_MS);
    for (const id of ["fastapi_process", "fastapi_listener", "fastapi_api"]) {
      if (backend.status === "ready") coordinator.completeStep(id, "Health 已啟動");
      else coordinator.failStep(id, backend.detail || backend.status);
    }
    if (backend.status !== "ready") {
      coordinator.markProgress("BACKEND_FAILED", null, backend.detail || backend.status);
      return;
    }
    try {
      await productOperations.loadProductCatalogIndex();
      coordinator.completeStep("product_catalog_parquet");
      coordinator.completeStep("product_search_index");
    } catch (error) {
      logger.warn?.(`[WEB] loading the product catalog failed: ${error.message}`);
      coordinator.failStep("product_catalog_parquet", String(error.message || error));
      coordinator.failStep("product_search_index", "商品目錄未載入");
    }
    const provider = async (name, serviceIds, steps) => {
      const outcome = await startOutcome(name, serviceIds, START_ALL_TIMEOUT_MS);
      for (const id of steps) {
        if (outcome.status === "ready") coordinator.completeStep(id, "Health 已啟動");
        else if (outcome.status === "skipped") coordinator.skipStep(id, "來源未啟用");
        else coordinator.degradeStep(id, outcome.detail || outcome.status);
      }
    };
    await Promise.all([
      provider("shioaji", ["provider_shioaji"], ["shioaji_daemon", "shioaji_attach", "live_ingress"]),
      provider("futu", ["provider_futu"], ["moomoo_daemon", "moomoo_attach"]),
    ]);
    coordinator.skipStep("futu_catalog_refresh", "網頁版由後端維護商品主檔");
    coordinator.markProgress("BACKEND_READY", "backend_ready_at");
    pushTo(client, "backend-ready", null);
  }

  function clientFor(id, page) {
    let client = clients.get(id);
    if (!client) {
      const coordinator = new StartupCoordinator({ electronPid: process.pid, logger: { log() {}, warn: logger.warn, error: logger.error } });
      client = { id, page, coordinator, streams: new Set(), lastSeen: Date.now() };
      coordinator.subscribe((snapshot) => pushTo(client, "startup-progress", snapshot));
      clients.set(id, client);
      if (page === "index.html") {
        void settleBackendUnits(coordinator, client).catch((error) => {
          logger.error?.(`[WEB] settling the startup units failed: ${error.message}`);
          coordinator.markProgress("BACKEND_FAILED", null, String(error.message || error));
        });
      } else {
        // A secondary page (trade window, editors, detached views) never shows the startup overlay.
        coordinator.markProgress("RUNNING");
      }
    }
    client.lastSeen = Date.now();
    return client;
  }
  const sweep = setInterval(() => {
    const cutoff = Date.now() - CLIENT_IDLE_MS;
    for (const [id, client] of clients) {
      if (!client.streams.size && client.lastSeen < cutoff) { client.coordinator.stop(); clients.delete(id); }
    }
  }, 60_000);
  sweep.unref();

  // A coordinator stand-in for ipc_registration.js: each call goes to the coordinator of the page that asked.
  const currentCoordinator = () => {
    const client = clientContext.getStore();
    if (!client) throw new Error("no web client for this request");
    return client.coordinator;
  };
  const startupCoordinator = {
    snapshot: () => currentCoordinator().snapshot(),
    reportRendererStep: (payload) => currentCoordinator().reportRendererStep(payload),
  };

  // ---- the browser bootstrap (preload.js's runtime:get-bootstrap) --------------------------------------------------
  // Service addresses are this gateway's /svc/<service_id> paths; the shim makes them absolute for the page's origin.
  function webBootstrap(page) {
    const projection = apiEndpoints.served();
    const services = {};
    for (const [sid, entry] of Object.entries(projection.services || {})) {
      if (PROXIED_SERVICES.has(sid)) services[sid] = { ...entry, url: `/svc/${sid}` };
    }
    const viewer = PAGES.LIVE_VIEWER.includes(page) && services.market_runtime && runtimeCredentials.readToken("viewer", env);
    return {
      ok: true,
      schema: "stock-monitor-renderer-bootstrap-v1",
      web: true,
      sourceSettings: sources,
      colorPreferences: colorPreferenceStore.current(),
      detachedWindows: DETACHED_WINDOWS,
      liveEngineConnection: viewer ? {
        url: "/svc/market_runtime/live", revision: projection.revision ?? null,
        expected: { service_id: "market_runtime", protocol: runtime.backend.rendererProtocolVersion },
      } : null,
      networkManifest: {
        schema: "stock-monitor-renderer-network-v2", revision: projection.revision ?? null,
        authority: apiEndpoints.authority(), services, routes: apiEndpoints.routes(),
        apiBaseUrl: services.realtime_api?.url || null,
      },
    };
  }

  // ---- IPC: the desktop handlers on a web transport ------------------------------------------------------------
  const handlers = new Map();
  const transport = {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => handlers.set(channel, fn),
  };
  const authorize = (event, channel, payload) => {
    const rule = channelRule(channel);
    return Boolean(rule && rule.pages.includes(event.page) && rule.schema(payload) === true);
  };
  const router = createIpcRouter({ transport, authorize, logger });
  const clientSide = (what) => () => { throw new Error(`${what} is handled in the browser (ui/web/desktop_api.js)`); };
  const unavailable = { ok: false, error: "網頁版不提供此功能" };

  registerRuntimeIpc(router, { rendererBootstrap: (event) => webBootstrap(event.page) });
  registerWindowIpc(router, {
    fitWindowToRendererContent: () => ({ ok: true, web: true }),
    releasePageContentWidthLock: () => ({ ok: true, web: true }),
    pickFolder: clientSide("pickFolder"),
    confirmQuestion: clientSide("confirm"),
    openDetachedView: clientSide("openDetachedView"),
    openWorkspaceView: clientSide("openWorkspaceView"),
    openLayoutEditor: clientSide("openLayoutEditor"),
  });
  registerMonitoringIpc(router, {
    startupCoordinator,
    marketRuntimeReady: () => startOutcome("market_runtime", ["market_runtime"], MARKET_RUNTIME_START_MAX_MS)
      .then((step) => ({ status: step.status, detail: step.detail || "" })),
    futuProviderReady: () => startOutcome("futu", ["provider_futu"], START_ALL_TIMEOUT_MS)
      .then((step) => ({ status: step.status, detail: step.detail || "" })),
    readExternalHealthSupervisor: async () => {
      const status = await controllerClient.getStatus(1500).catch((error) => { logger.warn?.("[WEB] Health status read failed", error); return null; });
      return status ? { schema: "stock-monitor-external-health-v2", healthy: status.ok === true, state: status.stopping ? "STOPPING" : "RUNNING",
        services: status.services }
        : { schema: "stock-monitor-external-health-v2", healthy: false, state: "UNREACHABLE" };
    },
    reportRendererHealth: (event, payload) => {
      const level = String(payload?.level || payload?.kind || "");
      if (/error|crash|hang/i.test(level)) logger.warn?.(`[WEB RENDERER ${event.page}] ${JSON.stringify(payload).slice(0, 2000)}`);
    },
    reportRemediation: (event, payload) => logger.log?.(`[WEB REMEDIATION ${event.page}] ${JSON.stringify(payload).slice(0, 2000)}`),
    rendererStopped: () => {},
  });
  registerTradeIpc(router, {
    submitGoogleFormTrade,
    openTradeWindow: clientSide("openTradeWindow"),
    closeTradeWindow: clientSide("closeTradeWindow"),
    notifyTradeChanged: clientSide("notifyTradeWindowChanged"),
    fitTradeWindowToContent: () => ({ ok: true, web: true }),
  });
  registerWatchPageIpc(router, {
    watchPageStore, sourceEnabled, productCatalogStore, loadProductCatalogIndex: productOperations.loadProductCatalogIndex,
    openWatchPageEditor: clientSide("openWatchPageEditor"),
    notifyWatchPagesChanged: clientSide("notifyWatchPagesChanged"),
  });
  registerSettingsIpc(router, {
    controllerClient, apiEndpoints, appProcessIds: () => [process.pid],
    autostart: {
      status: () => ({ available: false, enabled: false, reason: "網頁版由伺服器的 systemd 負責開機啟動" }),
      set: () => unavailable, launcher: { script: "" },
    },
    providerSdk, colorPreferenceStore,
    broadcastColors: (colors) => broadcast("preferences:colors-changed", colors),
    appUpdate: { state: () => ({ enabled: false, available: false }), pageToOpen: () => null },
    openExternal: async () => {}, logger,
  });
  router.assertComplete();

  async function handleIpc(req, res, channel, url) {
    const rule = Object.hasOwn(CHANNELS, channel) ? CHANNELS[channel] : null;
    const fn = handlers.get(channel);
    if (!rule || rule.kind === "push" || !fn) return sendJson(res, 404, { ok: false, error: "IPC_UNKNOWN_CHANNEL" });
    const id = String(req.headers["x-stockmonitor-client"] || "");
    const page = String(req.headers["x-stockmonitor-page"] || "");
    if (!CLIENT_ID.test(id) || !TRUSTED_PAGES.includes(page)) return sendJson(res, 400, { ok: false, error: "IPC_CLIENT_REQUIRED" });
    let payload;
    try {
      const text = await readBody(req, MAX_IPC_BODY);
      const body = text ? JSON.parse(text) : {};
      payload = body && typeof body === "object" && Object.hasOwn(body, "payload") ? body.payload : undefined;
    } catch (error) {   // not an error: an unreadable body is the caller's, answered with its reason
      return sendJson(res, error.status || 400, { ok: false, error: error.status === 413 ? "IPC_PAYLOAD_TOO_LARGE" : "IPC_BAD_JSON" });
    }
    const client = clientFor(id, page);
    const event = {
      page, client: id, senderFrame: { url: page },
      sender: {
        send: (pushChannel, value) => pushTo(client, pushChannel, value),
        isDestroyed: () => false, once() {}, removeListener() {},
      },
    };
    try {
      const value = await clientContext.run(client, async () => {
        if (rule.kind === "invoke") return fn(event, payload);
        fn(event, payload);
        return rule.kind === "sync" ? event.returnValue : undefined;
      });
      if (value?.ok === false && value?.error === "IPC_UNAUTHORIZED") return sendJson(res, 403, { ok: false, error: "IPC_UNAUTHORIZED" });
      return sendJson(res, 200, { ok: true, value: value === undefined ? null : value });
    } catch (error) {
      const message = String(error?.message || error);
      // not an error: an unauthorized call was already recorded by the router (ipc_router.js) and is answered 403
      if (message === "IPC_UNAUTHORIZED") return sendJson(res, 403, { ok: false, error: message });
      logger.warn?.(`[WEB IPC] ${channel} failed: ${message}`);
      return sendJson(res, 500, { ok: false, error: message });
    }
  }

  function handleEvents(req, res, url) {
    const id = String(url.searchParams.get("client") || "");
    const page = String(url.searchParams.get("page") || "");
    if (!CLIENT_ID.test(id) || !TRUSTED_PAGES.includes(page)) return sendJson(res, 400, { ok: false, error: "EVENTS_CLIENT_REQUIRED" });
    const client = clientFor(id, page);
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no",
      ...SECURITY_HEADERS });
    res.write(": connected\n\n");
    client.streams.add(res);
    pushTo(client, "startup-progress", client.coordinator.snapshot());
    const heartbeat = setInterval(() => { try { res.write(": keepalive\n\n"); } catch { /* not an error: the close handler below cleans up */ } }, SSE_HEARTBEAT_MS);
    req.on("close", () => { clearInterval(heartbeat); client.streams.delete(res); client.lastSeen = Date.now(); });
  }

  function serveShim(res, url) {
    const page = String(url.searchParams.get("page") || "");
    if (!TRUSTED_PAGES.includes(page)) return sendJson(res, 400, { ok: false, error: "SHIM_PAGE_REQUIRED" });
    const boot = JSON.stringify({ page, bootstrap: webBootstrap(page) }).replace(/</g, "\\u003c");
    const source = fs.readFileSync(SHIM_FILE, "utf8");
    res.writeHead(200, { "content-type": CONTENT_TYPES[".js"], "cache-control": "no-store", ...SECURITY_HEADERS });
    res.end(`window.__STOCKMONITOR_WEB_BOOT__ = ${boot};\n${source}`);
  }

  function serveStatic(req, res, urlPath) {
    const file = rendererFile(urlPath);
    if (!file) return sendJson(res, 404, { ok: false, error: "NOT_FOUND" });
    let bytes;
    try { bytes = fs.readFileSync(file); }
    catch (error) {   // not an error: a missing file is answered 404; anything else is raised
      if (error.code === "ENOENT" || error.code === "EISDIR") return sendJson(res, 404, { ok: false, error: "NOT_FOUND" });
      throw error;
    }
    const ext = path.extname(file).toLowerCase();
    const headers = { "content-type": CONTENT_TYPES[ext] || "application/octet-stream", "cache-control": "no-cache", ...SECURITY_HEADERS };
    if (ext === ".html" && path.dirname(file) === RENDERER_DIR) {
      const hostName = requestHost(req);
      const page = path.basename(file);
      let html = bytes.toString("utf8").split(CSP_PLACEHOLDER).join(`ws://${hostName} wss://${hostName}`);
      const shim = `<script src="/web/desktop_api.js?page=${encodeURIComponent(page)}"></script>`;
      html = html.includes("</head>") ? html.replace("</head>", `  ${shim}\n</head>`) : `${shim}\n${html}`;
      bytes = Buffer.from(html, "utf8");
      headers["content-security-policy"] = "frame-ancestors 'none'";
      headers["cache-control"] = "no-store";
    }
    if (req.method === "HEAD") { res.writeHead(200, headers); res.end(); return; }
    res.writeHead(200, headers);
    res.end(bytes);
  }

  function proxyTarget(urlPath) {
    const match = /^\/svc\/([a-z_]+)(\/.*)?$/.exec(urlPath);
    if (!match || !PROXIED_SERVICES.has(match[1])) return null;
    return { serviceId: match[1], rest: match[2] || "/" };
  }

  async function admit(req) {
    try { return await verifier.verify(req); }
    catch (error) {   // not an error: a denied request is answered 403; a failed check is recorded below
      if (!(error instanceof AccessDenied)) logger.error?.(`[WEB ACCESS] check failed: ${error.message}`);
      return null;
    }
  }

  async function onRequest(req, res) {
    let url;
    try { url = new URL(req.url, "http://gateway.invalid"); } catch { /* not an error: a malformed URL is answered 400 */ return sendJson(res, 400, { ok: false, error: "BAD_URL" }); }
    if (url.pathname === "/web/healthz") return sendJson(res, 200, { ok: true });   // liveness only: no data, no auth
    if (!(await admit(req))) return sendJson(res, 403, { ok: false, error: "ACCESS_DENIED" });
    if (needsSameOrigin(req) && !sameOrigin(req)) return sendJson(res, 403, { ok: false, error: "CROSS_ORIGIN_REFUSED" });
    try {
      if (url.pathname === "/" || url.pathname === "/index") {
        res.writeHead(302, { location: "/index.html", ...SECURITY_HEADERS }); res.end(); return;
      }
      if (url.pathname === "/web/desktop_api.js" && req.method === "GET") return serveShim(res, url);
      if (url.pathname === "/web/events" && req.method === "GET") return handleEvents(req, res, url);
      if (url.pathname.startsWith("/web/ipc/") && req.method === "POST") {
        return await handleIpc(req, res, decodeURIComponent(url.pathname.slice("/web/ipc/".length)), url);
      }
      const target = proxyTarget(url.pathname);
      if (target) {
        if (target.serviceId === "market_runtime") return sendJson(res, 404, { ok: false, error: "NOT_FOUND" });
        let baseUrl;
        try { baseUrl = apiEndpoints.serviceUrl(target.serviceId); }
        catch (error) { /* not an error: endpoints Health has not confirmed yet are answered 503 (api_endpoints.js logs it) */ return sendJson(res, 503, { ok: false, error: "ENDPOINTS_NOT_CONFIRMED", detail: error.message }); }
        return proxyHttp(req, res, { baseUrl, pathAndQuery: `${target.rest}${url.search}`, token: clientToken(), logger });
      }
      if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, url.pathname);
      return sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
    } catch (error) {
      logger.error?.(`[WEB] ${req.method} ${url.pathname} failed: ${error.stack || error.message}`);
      return sendJson(res, 500, { ok: false, error: "WEB_GATEWAY_ERROR" });
    }
  }

  async function onUpgrade(req, socket, head) {
    const refuse = (status, text) => { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    let url;
    try { url = new URL(req.url, "http://gateway.invalid"); } catch { /* not an error: a malformed URL is answered 400 */ return refuse(400, "Bad Request"); }
    if (!(await admit(req))) return refuse(403, "Forbidden");
    if (!sameOrigin(req)) return refuse(403, "Forbidden");
    const target = proxyTarget(url.pathname);
    if (!target) return refuse(404, "Not Found");
    let baseUrl;
    try { baseUrl = apiEndpoints.serviceUrl(target.serviceId); } catch { /* not an error: unconfirmed endpoints are answered 503 */ return refuse(503, "Service Unavailable"); }
    // market_runtime's /live takes the viewer credential (read only); the business APIs the client token.
    const token = target.serviceId === "market_runtime" ? runtimeCredentials.readToken("viewer", env) : clientToken();
    if (target.serviceId === "market_runtime" && target.rest !== "/live") return refuse(404, "Not Found");
    if (!token) return refuse(503, "Service Unavailable");
    proxyUpgrade(req, socket, head, { baseUrl, pathAndQuery: `${target.rest}${url.search}`, token, logger });
  }

  const server = http.createServer((req, res) => { void onRequest(req, res); });
  server.on("upgrade", (req, socket, head) => { void onUpgrade(req, socket, head); });
  server.headersTimeout = 30_000;
  server.requestTimeout = 0;   // event streams stay open

  return {
    server, access, apiEndpoints, controllerClient, clients,
    async start() {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
      logger.log?.(`[WEB] gateway on http://${host}:${server.address().port} (access: ${access.mode})`);
      void apiEndpoints.refreshFromHealth(controllerClient, "web_gateway")
        .catch((error) => logger.error?.(`[WEB] reading Health's endpoints failed: ${error.message}`));
      return server.address();
    },
    async stop() {
      clearInterval(sweep);
      for (const client of clients.values()) { for (const res of client.streams) res.end(); client.coordinator.stop(); }
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function main() {
  const host = String(process.env.STOCK_MONITOR_WEB_HOST || "127.0.0.1").trim();
  const port = Number(process.env.STOCK_MONITOR_WEB_PORT || 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid STOCK_MONITOR_WEB_PORT: ${process.env.STOCK_MONITOR_WEB_PORT}`);
  const gateway = createWebGateway({ host, port });
  await gateway.start();
  const stop = (signal) => {
    console.log(`[WEB] ${signal}: stopping`);
    gateway.stop().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

if (require.main === module) {
  main().catch((error) => { console.error(`[WEB] gateway failed to start: ${error.message}`); process.exit(1); });
}

module.exports = { createWebGateway, rendererFile, CLIENT_ID };
