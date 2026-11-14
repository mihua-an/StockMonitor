// The browser twin of ui/main/preload.js: the same window.desktopAPI, for a renderer page served by the web gateway
// (ui/web/gateway.js) instead of loaded by Electron. The gateway prepends window.__STOCKMONITOR_WEB_BOOT__ (this
// page's bootstrap, preload's runtime:get-bootstrap) and loads this script before the page's own modules.
//
// Where the desktop goes through Electron main, this goes:
//   - invoke/send channels -> POST /web/ipc/<channel> (the same handlers and channel contract as Electron's IPC);
//   - main -> renderer pushes <- /web/events (server-sent events), one stream per page load;
//   - window-to-window notices (a trade saved in the trade window, product pages edited) -> BroadcastChannel;
//   - secondary windows (trade, editors, workspace, detached views) -> window.open, their payload in the URL hash.
// Window sizing, autostart, the SDK installer and the update notice have no browser meaning and answer accordingly.
(function installWebDesktopApi() {
  "use strict";

  const boot = window.__STOCKMONITOR_WEB_BOOT__ || {};
  const page = String(boot.page || "index.html");
  const bootstrap = boot.bootstrap && boot.bootstrap.ok === true ? boot.bootstrap : null;
  if (!bootstrap) console.warn("[WEB] runtime bootstrap missing: the page has no endpoints");

  const clientId = (window.crypto && typeof window.crypto.randomUUID === "function")
    ? window.crypto.randomUUID()
    : Array.from(window.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const origin = window.location.origin;
  const wsOrigin = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;

  // ---- the bootstrap, with the gateway's relative service paths made absolute for this origin -------------------
  function absoluteManifest(manifest) {
    if (!manifest) return null;
    const services = {};
    for (const [sid, entry] of Object.entries(manifest.services || {})) services[sid] = { ...entry, url: `${origin}${entry.url}` };
    return { ...manifest, services, apiBaseUrl: manifest.apiBaseUrl ? `${origin}${manifest.apiBaseUrl}` : null };
  }
  const networkManifest = absoluteManifest(bootstrap && bootstrap.networkManifest);
  const liveEngineConnection = bootstrap && bootstrap.liveEngineConnection
    ? { ...bootstrap.liveEngineConnection, url: `${wsOrigin}${bootstrap.liveEngineConnection.url}` } : null;
  const colorPreferences = bootstrap ? bootstrap.colorPreferences : null;

  function applyColorPreferences(colors) {
    if (!colors || typeof colors !== "object") return;
    const root = document.documentElement;
    if (!root) return;
    if (colors.priceUpColor) root.style.setProperty("--price-up-color", colors.priceUpColor);
    if (colors.priceDownColor) root.style.setProperty("--price-down-color", colors.priceDownColor);
    if (colors.priceFlatColor) root.style.setProperty("--price-flat-color", colors.priceFlatColor);
  }
  applyColorPreferences(colorPreferences);

  // ---- IPC over HTTP -------------------------------------------------------------------------------------------
  const ipcHeaders = { "content-type": "application/json", "x-stockmonitor-client": clientId, "x-stockmonitor-page": page };
  async function invoke(channel, payload) {
    const response = await fetch(`/web/ipc/${encodeURIComponent(channel)}`, {
      method: "POST", headers: ipcHeaders, cache: "no-store", credentials: "same-origin",
      body: JSON.stringify(payload === undefined ? {} : { payload }),
    });
    let body = null;
    try { body = await response.json(); } catch (_error) { /* not an error: an unreadable body is reported just below */ }
    if (!response.ok || !body || body.ok !== true) {
      throw new Error(body && body.error ? String(body.error) : `${channel}: HTTP ${response.status}`);
    }
    return body.value;
  }
  function send(channel, payload) {
    invoke(channel, payload).catch((error) => console.warn(`[WEB ${channel}] failed`, error));
  }

  // ---- main -> renderer pushes (server-sent events) --------------------------------------------------------------
  const pushListeners = new Map();
  function onPush(channel, callback) {
    if (typeof callback !== "function") return () => {};
    if (!pushListeners.has(channel)) {
      pushListeners.set(channel, new Set());
      events.addEventListener(channel, (message) => {
        let value = null;
        try { value = JSON.parse(message.data); } catch (error) { console.warn(`[WEB] unreadable ${channel} event`, error); return; }
        for (const listener of [...(pushListeners.get(channel) || [])]) {
          try { listener(value); } catch (error) { console.error(`[WEB] a ${channel} listener failed`, error); }
        }
      });
    }
    pushListeners.get(channel).add(callback);
    return () => pushListeners.get(channel)?.delete(callback);
  }
  const events = new EventSource(`/web/events?client=${encodeURIComponent(clientId)}&page=${encodeURIComponent(page)}`);
  events.addEventListener("error", () => { /* not an error: EventSource reconnects by itself */ });
  onPush("preferences:colors-changed", (colors) => applyColorPreferences(colors));

  // ---- window-to-window notices within this browser --------------------------------------------------------------
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("stockmonitor-web") : null;
  const localListeners = new Map();
  function onLocal(name, callback) {
    if (typeof callback !== "function") return () => {};
    if (!localListeners.has(name)) localListeners.set(name, new Set());
    localListeners.get(name).add(callback);
    return () => localListeners.get(name)?.delete(callback);
  }
  if (channel) {
    channel.onmessage = (message) => {
      const data = message.data || {};
      if (data.from === clientId) return;
      for (const listener of [...(localListeners.get(data.channel) || [])]) {
        try { listener(data.payload || {}); } catch (error) { console.error(`[WEB] a ${data.channel} listener failed`, error); }
      }
    };
  }
  function postLocal(name, payload) {
    try { channel?.postMessage({ channel: name, payload: payload || {}, from: clientId }); }
    catch (error) { console.warn(`[WEB] telling the other windows ${name} failed`, error); }
  }

  // ---- secondary windows --------------------------------------------------------------------------------------
  // The payload travels in the URL hash (#sm=<json>): never sent to the server, read once by the opened page.
  const HASH_PREFIX = "#sm=";
  function openWindow(file, name, payload, size) {
    const hash = payload === undefined ? "" : `${HASH_PREFIX}${encodeURIComponent(JSON.stringify(payload))}`;
    const features = size ? `popup,width=${Math.round(size.width)},height=${Math.round(size.height)}` : "";
    const opened = window.open(`${file}${hash}`, name, features);
    if (!opened) return { ok: false, error: "瀏覽器擋下了彈出視窗：請允許此網站開啟彈出視窗後再試一次" };
    try { opened.focus(); } catch (_error) { /* not an error: focusing is best effort */ }
    return { ok: true };
  }
  function hashPayload() {
    const hash = window.location.hash || "";
    if (!hash.startsWith(HASH_PREFIX)) return undefined;
    try { return JSON.parse(decodeURIComponent(hash.slice(HASH_PREFIX.length))); }
    catch (error) { console.warn("[WEB] unreadable window payload", error); return undefined; }
  }
  // A page opened with a payload hands it to the first listener (and again on a later reopen with a new one).
  const payloadListeners = new Set();
  let pendingPayload = hashPayload();
  function deliverPayload() {
    if (pendingPayload === undefined || !payloadListeners.size) return;
    const value = pendingPayload;
    pendingPayload = undefined;
    for (const listener of [...payloadListeners]) {
      try { listener(value); } catch (error) { console.error("[WEB] a window payload listener failed", error); }
    }
  }
  window.addEventListener("hashchange", () => { pendingPayload = hashPayload(); deliverPayload(); });
  function onPayload(callback, transform) {
    if (typeof callback !== "function") return () => {};
    const listener = (value) => callback(transform(value));
    payloadListeners.add(listener);
    setTimeout(deliverPayload, 0);
    return () => payloadListeners.delete(listener);
  }

  const detachedSizes = (bootstrap && bootstrap.detachedWindows) || {};
  function detachedWindowName(descriptor) {
    const key = [descriptor.componentId, descriptor.contextMode, descriptor.contextId, descriptor.symbolMode, descriptor.symbol || ""]
      .join("-").replace(/[^A-Za-z0-9_-]/g, "_");
    return `stockmonitor-detached-${key}`;
  }

  // ---- startup -------------------------------------------------------------------------------------------------
  function onBackendReady(callback) {
    if (typeof callback !== "function") return () => {};
    let fired = false;
    let disposed = false;
    let unsubscribe = () => {};
    const fire = () => {
      if (disposed || fired) return;
      fired = true;
      unsubscribe();
      callback();
    };
    unsubscribe = onPush("backend-ready", fire);
    invoke("startup:get-state").then((snapshot) => {
      const state = String(snapshot?.state || "").toUpperCase();
      if (state === "BACKEND_READY" || state === "RUNNING") fire();
    }).catch((error) => console.warn("[WEB startup progress wait] failed", error));
    return () => { disposed = true; unsubscribe(); };
  }

  const resolved = (value) => Promise.resolve(value);

  window.desktopAPI = Object.freeze({
    web: true,
    sourceSettings: bootstrap ? bootstrap.sourceSettings : null,
    appName: "StockMonitor",
    liveEngineConnection,
    networkManifest,
    detachedWindows: detachedSizes,
    colorPreferences,
    setColorPreferences: (payload) => invoke("preferences:set-colors", payload || {}),
    onColorPreferencesChanged: (callback) => onPush("preferences:colors-changed", (colors) => callback(colors || {})),
    fitPageContent: () => resolved({ ok: true, web: true }),
    releasePageWidthLock: () => resolved({ ok: true, web: true }),
    // The server's folders, not this computer's: the path is typed, and settings_api validates it as before.
    pickFolder: () => {
      const value = window.prompt("請輸入伺服器上的資料夾絕對路徑（例如 /srv/stockmonitor/history）：", "");
      return resolved(value && value.trim() ? value.trim() : null);
    },
    confirm: (message) => resolved(window.confirm(String(message || ""))),
    getStartupState: () => invoke("startup:get-state"),
    waitForMarketRuntime: () => invoke("startup:market-runtime"),
    waitForFutuProvider: () => invoke("startup:futu-provider"),
    getExternalHealth: () => invoke("health-supervisor:get"),
    getMonitoringSnapshot: (options = {}) => invoke("monitoring:snapshot",
      options?.trendSince === undefined ? {} : { trendSince: options.trendSince }),
    requestMonitoringDetail: () => invoke("monitoring:request-detail"),
    previewNetworkApply: (candidateRevision) => invoke("network:preview", { candidate_revision: candidateRevision }),
    applyNetworkRevision: (payload) => invoke("network:apply", payload || {}),
    getNetworkOperations: () => invoke("network:operations"),
    getAutostart: () => invoke("autostart:get"),
    setAutostart: (enabled) => invoke("autostart:set", { enabled: Boolean(enabled) }),
    getProviderSdkStatus: () => invoke("provider-sdk:status"),
    installProviderSdk: (provider) => invoke("provider-sdk:install", { provider: String(provider || "") }),
    onProviderSdkProgress: (callback) => onPush("provider-sdk:progress", callback),
    getAppUpdate: () => invoke("app-update:get"),
    openAppUpdate: () => invoke("app-update:open"),
    onAppUpdateChanged: (callback) => onPush("app-update:changed", (state) => callback(state || {})),
    reportRendererHealth: (payload) => send("renderer:health", payload),
    reportRemediation: (payload) => send("remediation:report", payload),
    // A browser tab is not told the App is closing: the backend outlives every page.
    onAppClosing: () => () => {},
    reportStartupStep: (payload) => invoke("startup:renderer-step", payload || {}),
    openDetachedView: (payload) => {
      const descriptor = payload || {};
      const size = detachedSizes[descriptor.componentId];
      if (!size) return resolved({ ok: false, errors: ["component_not_allowed"] });
      return resolved(openWindow("detached_view.html", detachedWindowName(descriptor), descriptor,
        { width: Math.max(size.defaultWidth, size.minWidth), height: Math.max(size.defaultHeight, size.minHeight) }));
    },
    submitGoogleFormTrade: (payload) => invoke("google-form:submit-trade", payload),
    openTradeWindow: (payload) => resolved(openWindow("trade_window.html", "stockmonitor-trade", payload || {}, { width: 560, height: 760 })),
    openWatchPageEditor: () => resolved(openWindow("watch_pages_window.html", "stockmonitor-watch-pages", undefined, { width: 1100, height: 760 })),
    openLayoutEditor: () => resolved(openWindow("index.html#layout-editor", "stockmonitor-layout-editor", undefined, { width: 1280, height: 860 })),
    openWorkspaceView: (seedSymbol = "") => resolved(openWindow("workspace_view.html", "stockmonitor-workspace", String(seedSymbol || ""),
      { width: 1400, height: 900 })),
    loadWatchPagesLocal: () => invoke("watch-pages:load-local"),
    searchProductCatalogLocal: (source, query, market = "", limit = 50) => invoke("product-catalog:search-local", { source, query, market, limit }),
    productCatalogNames: (source, codes) => invoke("product-catalog:names", { source, codes }),
    notifyWatchPagesChanged: (payload) => { postLocal("watch-pages-window:changed", payload); return resolved(true); },
    closeTradeWindow: () => { window.close(); return resolved({ ok: true }); },
    fitTradeWindow: () => resolved({ ok: true, web: true }),
    notifyTradeWindowChanged: (payload) => { postLocal("trade-window:changed", payload); return resolved(true); },
    onWorkspaceSeed: (callback) => onPayload(callback, (value) => String(value || "")),
    onDetachedViewDescriptor: (callback) => onPayload(callback, (value) => value || {}),
    onTradeWindowPayload: (callback) => onPayload(callback, (value) => value || {}),
    onProductCatalogChanged: (callback) => onPush("product-catalog:changed", (payload) => callback(payload || {})),
    onWatchPagesChanged: (callback) => onLocal("watch-pages-window:changed", callback),
    onTradeWindowChanged: (callback) => onLocal("trade-window:changed", callback),
    onBackendReady,
    onStartupProgress: (callback) => onPush("startup-progress", (payload) => callback(payload || {})),
  });
}());
