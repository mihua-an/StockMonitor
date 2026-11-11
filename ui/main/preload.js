const { contextBridge, ipcRenderer } = require("electron");

// The one synchronous read before the page's own scripts run (ui/main/ipc_contract.js "runtime:get-bootstrap"): mode,
// sources, quote colors, detachable components, endpoint projection and the live connection. A page main does not
// trust gets {ok:false}; it then has no endpoints, no connection and the CSS default colors.
const bootstrap = ipcRenderer.sendSync("runtime:get-bootstrap");
const booted = bootstrap?.ok === true;
if (!booted) console.warn(`[PRELOAD] runtime bootstrap refused: ${bootstrap?.error || "no answer"}`);

// Apply the saved market-quote color preference to :root before first paint, so there is no flash of the hardcoded
// CSS defaults. document.documentElement already exists this early in a preload script even though the body has not
// parsed yet.
const colorPreferences = booted ? bootstrap.colorPreferences : null;
function applyColorPreferences(colors) {
  if (!colors || typeof colors !== "object") return;
  const root = document.documentElement;
  if (!root) return;
  if (colors.priceUpColor) root.style.setProperty("--price-up-color", colors.priceUpColor);
  if (colors.priceDownColor) root.style.setProperty("--price-down-color", colors.priceDownColor);
  if (colors.priceFlatColor) root.style.setProperty("--price-flat-color", colors.priceFlatColor);
}
applyColorPreferences(colorPreferences);
ipcRenderer.on("preferences:colors-changed", (_event, colors) => applyColorPreferences(colors));

// The App is closing (ShutdownController): every live transport registered here stops, then main is told
// (app:closing-done) -- main waits for that answer before it asks Health to stop the backend under them.
const appClosingListeners = new Set();
ipcRenderer.on("app:closing", (_event, payload) => {
  for (const listener of [...appClosingListeners]) {
    try { listener(payload || {}); } catch (error) { console.error("[PRELOAD] an app:closing listener failed", error); }
  }
  ipcRenderer.send("app:closing-done");
});

contextBridge.exposeInMainWorld("desktopAPI", {
  sourceSettings: booted ? bootstrap.sourceSettings : null,
  appName: "StockMonitor",
  liveEngineConnection: booted ? bootstrap.liveEngineConnection : null,
  networkManifest: booted ? bootstrap.networkManifest : null,
  // The components a detached window can host, with their window sizes (ui/main/detached_windows.json).
  detachedWindows: booted ? bootstrap.detachedWindows : {},
  colorPreferences,
  setColorPreferences: (payload) => ipcRenderer.invoke("preferences:set-colors", payload || {}),
  onColorPreferencesChanged: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, colors) => callback(colors || {});
    ipcRenderer.on("preferences:colors-changed", listener);
    return () => ipcRenderer.removeListener("preferences:colors-changed", listener);
  },
  fitPageContent: (payload) => ipcRenderer.invoke("window:fit-page-content", payload || {}),
  releasePageWidthLock: () => ipcRenderer.invoke("window:release-page-width-lock"),
  pickFolder: () => ipcRenderer.invoke("dialog:pick-folder"),
  confirm: (message) => ipcRenderer.invoke("dialog:confirm", { message: String(message || "") }),
  getStartupState: () => ipcRenderer.invoke("startup:get-state"),
  waitForMarketRuntime: () => ipcRenderer.invoke("startup:market-runtime"),
  waitForFutuProvider: () => ipcRenderer.invoke("startup:futu-provider"),
  getExternalHealth: () => ipcRenderer.invoke("health-supervisor:get"),
  // Settings page (06, 07): Health's shared monitoring snapshot and network operations, through Electron main
  // (which holds the controller credential; the renderer never does).
  // trendSince: the time of the last trend point the page holds (0 for none) -- Health answers the points after it.
  getMonitoringSnapshot: (options = {}) => ipcRenderer.invoke("monitoring:snapshot",
    options?.trendSince === undefined ? {} : { trendSince: options.trendSince }),
  requestMonitoringDetail: () => ipcRenderer.invoke("monitoring:request-detail"),
  previewNetworkApply: (candidateRevision) => ipcRenderer.invoke("network:preview", { candidate_revision: candidateRevision }),
  applyNetworkRevision: (payload) => ipcRenderer.invoke("network:apply", payload || {}),
  getNetworkOperations: () => ipcRenderer.invoke("network:operations"),
  // 設定 → 系統: 開機自動啟動 ({ available, enabled, reason }).
  getAutostart: () => ipcRenderer.invoke("autostart:get"),
  setAutostart: (enabled) => ipcRenderer.invoke("autostart:set", { enabled: Boolean(enabled) }),
  // 設定 → 券商帳號: broker SDK status / install (installed App only), with its progress lines.
  getProviderSdkStatus: () => ipcRenderer.invoke("provider-sdk:status"),
  installProviderSdk: (provider) => ipcRenderer.invoke("provider-sdk:install", { provider: String(provider || "") }),
  onProviderSdkProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("provider-sdk:progress", listener);
    return () => ipcRenderer.removeListener("provider-sdk:progress", listener);
  },
  // 新版提示 (installed App only): { enabled, current, latest, available, name, notes, ... }, opening the release page.
  getAppUpdate: () => ipcRenderer.invoke("app-update:get"),
  openAppUpdate: () => ipcRenderer.invoke("app-update:open"),
  onAppUpdateChanged: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, state) => callback(state || {});
    ipcRenderer.on("app-update:changed", listener);
    return () => ipcRenderer.removeListener("app-update:changed", listener);
  },
  reportRendererHealth: (payload) => ipcRenderer.send("renderer:health", payload),
  reportRemediation: (payload) => ipcRenderer.send("remediation:report", payload),
  // The App is closing (ShutdownController): live transports stop instead of reconnecting to a backend stopped by design.
  onAppClosing: (callback) => {
    if (typeof callback !== "function") return () => {};
    appClosingListeners.add(callback);
    return () => appClosingListeners.delete(callback);
  },
  reportStartupStep: (payload) => ipcRenderer.invoke("startup:renderer-step", payload || {}),
  openDetachedView: (payload) => ipcRenderer.invoke("detached-view:open", payload || {}),
  submitGoogleFormTrade: (payload) => ipcRenderer.invoke("google-form:submit-trade", payload),
  openTradeWindow: (payload) => ipcRenderer.invoke("trade-window:open", payload || {}),
  openWatchPageEditor: () => ipcRenderer.invoke("watch-pages-window:open"),
  openLayoutEditor: () => ipcRenderer.invoke("layout-editor:open", {}),
  openWorkspaceView: (seedSymbol = "") => ipcRenderer.invoke("workspace-view:open", { seedSymbol: String(seedSymbol || "") }),
  loadWatchPagesLocal: () => ipcRenderer.invoke("watch-pages:load-local"),
  searchProductCatalogLocal: (source, query, market = "", limit = 50) => ipcRenderer.invoke("product-catalog:search-local", { source, query, market, limit }),
  productCatalogNames: (source, codes) => ipcRenderer.invoke("product-catalog:names", { source, codes }),
  notifyWatchPagesChanged: (payload) => ipcRenderer.invoke("watch-pages-window:changed", payload || {}),
  closeTradeWindow: () => ipcRenderer.invoke("trade-window:close"),
  fitTradeWindow: (payload) => ipcRenderer.invoke("trade-window:fit-content", payload || {}),
  notifyTradeWindowChanged: (payload) => ipcRenderer.invoke("trade-window:changed", payload || {}),
  onWorkspaceSeed: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, code) => callback(String(code || ""));
    ipcRenderer.on("workspace-view:seed", listener);
    return () => ipcRenderer.removeListener("workspace-view:seed", listener);
  },
  onDetachedViewDescriptor: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on("detached-view:descriptor", listener);
    return () => ipcRenderer.removeListener("detached-view:descriptor", listener);
  },
  onTradeWindowPayload: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on("trade-window:payload", listener);
    return () => ipcRenderer.removeListener("trade-window:payload", listener);
  },
  onProductCatalogChanged: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on("product-catalog:changed", listener);
    return () => ipcRenderer.removeListener("product-catalog:changed", listener);
  },
  onWatchPagesChanged: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on("watch-pages-window:changed", listener);
    return () => ipcRenderer.removeListener("watch-pages-window:changed", listener);
  },
  onTradeWindowChanged: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on("trade-window:changed", listener);
    return () => ipcRenderer.removeListener("trade-window:changed", listener);
  },
  onBackendReady: (callback) => {
    if (typeof callback !== "function") return () => {};
    // "backend-ready" is a one-shot main->renderer push with no replay: a
    // listener attached after the event already fired (e.g. while this
    // renderer's module graph was still loading) would otherwise wait forever.
    // Fire immediately if the coordinator is already past BACKEND_READY/RUNNING.
    let fired = false;
    let disposed = false;
    const fire = () => {
      if (disposed || fired) return;
      fired = true;
      ipcRenderer.removeListener("backend-ready", listener);
      callback();
    };
    const listener = () => fire();
    ipcRenderer.on("backend-ready", listener);
    ipcRenderer.invoke("startup:get-state").then((snapshot) => {
      const state = String(snapshot?.state || "").toUpperCase();
      if (state === "BACKEND_READY" || state === "RUNNING") fire();
    }).catch((error) => console.warn("[PRELOAD startup progress wait] failed", error));
    return () => {
      disposed = true;
      ipcRenderer.removeListener("backend-ready", listener);
    };
  },
  onStartupProgress: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on("startup-progress", listener);
    return () => ipcRenderer.removeListener("startup-progress", listener);
  },
});
