"use strict";

const path = require("path");
const fs = require("fs");
const { performance: nodePerformance } = require("perf_hooks");
const { logSessionPath, MAIN_ERROR_LOG } = require("../../service/platform/js/log_session.js");
const remediationContract = require("../../config/js/remediation_contract.js");
const { createRemediationClient } = require("../../service/platform/js/remediation_client.js");

const { createAppSingleInstanceController } = require("./app_single_instance");
const { createWatchPageStore } = require("./watch_page_store");
const { createColorPreferenceStore } = require("./color_preference_store");
const { createProductCatalogStore } = require("./product_catalog_store");
const { StartupCoordinator, STARTUP_UNITS } = require("./startup_lifecycle");
const { sourceSettings, sourceEnabled } = require("../../config/js/source_settings");
const { registerRuntimeIpc, registerWindowIpc, registerMonitoringIpc, registerTradeIpc, registerWatchPageIpc, registerSettingsIpc,
} = require("./ipc_registration");
const { createIpcRouter } = require("./ipc_router");
const { DETACHED_WINDOWS, PAGES } = require("./ipc_contract");
const { ShutdownController, setAsideFailedFile, forcedQuitMarkerDir } = require("./shutdown_controller");
const { AppLifecycleController } = require("./app_lifecycle_controller");
const { createControllerClient } = require("./controller_client");
const { createDesktopWindows } = require("./desktop_windows");
const { createRendererHealthRegistry } = require("./renderer_health");
const { createTradeForm } = require("./trade_form");
const { createProductOperations } = require("./product_operations");
const { createStartupMetricsRecorder } = require("./startup_metrics");
const { createStartupTestDelay } = require("./startup_test_delay");
const { createShutdownHandoffStore } = require("../../service/platform/js/shutdown_handoff");
const { createClientAuthentication } = require("./client_auth");
const { createIpcAuthorizer } = require("./ipc_security");
const { createApiEndpoints } = require("./api_endpoints");
const { TrayController } = require("./tray_controller");
const { createAutostart } = require("./autostart");
const { createProviderSdk } = require("./provider_sdk");
const { createAppUpdate } = require("./app_update");
const runtimeCredentials = require("../../service/platform/js/runtime_credentials");

const APP_PROCESS_LEASE_RENEW_MS = 60_000;

// Wires every Electron-side component together and hands back a single
// run() entry point.
//
// This module owns no process-lifecycle object (service supervisor, backend
// controller, daemon hosts, the write side of
// startup diagnostics); those belong to Health, and
// orchestrate their startup/shutdown directly. None of that lives here any
// more -- it all moved, largely verbatim, into the standalone
// health/ process (see health/main.js), which Electron
// reaches ONLY as an HTTP client through controller_client.js. What remains
// here is genuinely Electron's own: windows, renderer IPC, product-catalog
// UI-facing caches, trade forms, and the startup/shutdown UI sequencing that
// calls the Controller instead of owning services directly.
// The previous UI was ended by its quit watchdog: each marker it left is one recorded forced termination.
function collectForcedQuitMarkers(remediation, logger) {
  const { TRIGGERS, recordForcedTermination } = require("../../service/platform/js/forced_termination.js");
  const dir = forcedQuitMarkerDir(process.env);
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith(".json")); } catch (error) { /* absent is not an error: no forced-quit marker directory means no previous forced quit */ if (error?.code !== "ENOENT") console.warn("[SHUTDOWN read forced-quit markers] failed", error); return; }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const marker = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
      recordForcedTermination(remediation, { component: "shutdown_controller", serviceId: "electron_main", pid: Number(marker.pid) || null,
        trigger: TRIGGERS.SHUTDOWN_WATCHDOG, reason: String(marker.kind || "quit_watchdog"), graceMs: Number(marker.grace_ms) || null,
        // What the watchdog verified after its stop; a marker that does not say is not a success.
        exited: marker.exited === true, detail: { at: marker.at || null, created: marker.created || null, stop_error: marker.stop_error || null } });
      logger.warn?.(`[Shutdown] the previous UI pid ${marker.pid} was ended by its ${marker.kind} at ${marker.at}`);
    } catch (error) {
      console.warn("[SHUTDOWN read forced-quit marker] failed", error);
      setAsideFailedFile(file, `recording the forced-quit marker ${name}`);
      continue;
    }
    try { fs.unlinkSync(file); } catch (error) { console.warn("[SHUTDOWN remove forced-quit marker] failed", error); }
  }
}

// The renderer reaches market_runtime directly with the VIEWER credential (docs/system-architecture/01): read
// views, snapshots and latency reports only -- it can never ingest, publish or stop anything. Health mints the
// role tokens (and the digest file market_runtime checks); Electron main only READS the viewer one (minting it
// when absent would make a token market_runtime's digest file does not know). The page gets the
// URL only: main attaches the credential to the handshake (client_auth.js).
function liveEngineUrl(apiEndpoints) {
  return `${apiEndpoints.serviceUrl("market_runtime")}/live`;
}

// `expected`: who must answer on the socket and the wire protocol it must speak (the runtime contract's
// backend.renderer_protocol_version); the page checks it on the first serving health.
function liveEngineConnection(apiEndpoints, runtime) {
  if (!runtimeCredentials.readToken("viewer", process.env)) return null;
  return {
    url: liveEngineUrl(apiEndpoints), revision: apiEndpoints.projection().revision ?? null,
    expected: { service_id: "market_runtime", protocol: runtime.backend.rendererProtocolVersion },
  };
}

// The renderer's view of the source selection: the selection as loaded (never modified here) plus, from
// STARTUP_UNITS, which startup step belongs to which source. Built once; every page gets the same frozen object.
function rendererSourceProjection() {
  const startupSteps = Object.fromEntries(STARTUP_UNITS.filter((unit) => unit.source).map((unit) => [unit.id, unit.source]));
  return Object.freeze({ ...sourceSettings, startup_steps: Object.freeze(startupSteps) });
}

// Remediation events of this process and of every renderer go to Health's ledger. The pipe is
// derived from the same logs root and mode Health derives it from, so a re-opened UI reaches the Health that outlived
// the previous one.
function createUiRemediation({ runtime, healthBootstrap, logger, trustedRendererPage }) {
  const remediationClient = createRemediationClient({
    process: { service_id: "electron_main", instance_id: `electron-${process.pid}-${Date.now()}`, pid: process.pid, runtime: "node" },
    pipePath: remediationContract.pipePath({ logsRoot: runtime.varPaths.logs }),
    logger,
  });
  healthBootstrap?.setRemediation?.(remediationClient);
  collectForcedQuitMarkers(remediationClient, logger);
  require("./shutdown_controller.js").collectPendingRemediation(remediationClient, logger);
  // A renderer never names its own process: the page and OS process come from the sender, and Health checks the rest.
  function reportRemediation(event, payload) {
    const { page_instance_id: pageInstanceId, ...fields } = payload || {};
    const page = trustedRendererPage(event.senderFrame?.url) || "unknown";
    let pid = null;
    try { pid = event.sender.getOSProcessId() || null; } catch (_error) { /* not an error: a destroyed renderer has no OS process id; the event is forwarded without one */ }
    remediationClient.forward({ ...fields, process: { service_id: `renderer:${page}`, instance_id: String(pageInstanceId),
      pid, runtime: "renderer" } });
  }
  return { remediationClient, reportRemediation };
}

// The one snapshot a preload reads before its page runs (runtime:get-bootstrap; the router has already checked that
// the sender is a trusted page of a live window). Only the pages that open a live market view -- index,
// workspace_view and detached_view (ipc_contract.js LIVE_VIEWER) -- get the viewer connection; every other page, and
// any page while Health has not minted the token yet, gets null (realtime.js stays idle). The endpoint projection is
// service_id -> URL (effective, from Health) plus the path -> service_id route table, with no credential in it (the
// client token is attached by this process's session hook) and no addresses while Health has not confirmed them (the
// window is reloaded once it does). Colors are applied before first paint; the store keeps the saved value in memory.
function createRendererBootstrap({ runtime, apiEndpoints, desktopWindows, colorPreferenceStore }) {
  const sources = rendererSourceProjection();
  return function rendererBootstrap(event) {
    const page = desktopWindows.trustedRendererPage(event.senderFrame?.url);
    const projection = apiEndpoints.served();
    return {
      ok: true,
      schema: "stock-monitor-renderer-bootstrap-v1",
      sourceSettings: sources,
      colorPreferences: colorPreferenceStore.current(),
      detachedWindows: DETACHED_WINDOWS,
      liveEngineConnection: PAGES.LIVE_VIEWER.includes(page) ? liveEngineConnection(apiEndpoints, runtime) : null,
      networkManifest: {
        schema: "stock-monitor-renderer-network-v2", revision: projection.revision ?? null,
        // Whose projection this is and whether it is confirmed: effective / pending / unavailable.
        authority: apiEndpoints.authority(),
        services: projection.services, routes: apiEndpoints.routes(), apiBaseUrl: projection.services.realtime_api?.url || null,
      },
    };
  };
}

// The App's own processes for 系統 CPU: Electron main first (Health needs it sampled to give a total), then every
// renderer, GPU and utility process.
function appProcessIds(app) {
  const metrics = app?.getAppMetrics?.() || [];
  const others = metrics.map((m) => m.pid).filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  return [process.pid, ...new Set(others)];
}

// A saved color preference is told to every open window, each on its own: a window that cannot be told (destroyed
// mid-broadcast) is recorded and the others are still told. The save is already committed either way.
/** package.json's `repository` (where the 新版提示 asks for releases), or null when it cannot be read. */
function readPackageRepository(appPath, logger = console) {
  try { return JSON.parse(fs.readFileSync(path.join(appPath, "package.json"), "utf8")).repository || null; }
  catch (error) { logger.warn?.("[APP UPDATE] reading package.json's repository failed: no update check", error); return null; }
}

function broadcastColors(BrowserWindow, colors, logger = console) {
  const failures = [];
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) win.webContents.send("preferences:colors-changed", colors);
    } catch (error) {
      failures.push(win.id);
      logger.warn?.(`[COLOR PREFERENCES] window ${win.id} could not be told the saved colors`, error);
    }
  }
  return failures;
}

async function pickFolder(BrowserWindow, dialog, sender) {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(sender), {
    title: "選擇歷史資料資料夾", properties: ["openDirectory", "createDirectory"] });
  return result.canceled ? null : (result.filePaths[0] || null);
}

// A yes/no question asked from main, attached to the asking window. The renderer's own window.confirm() is
// synchronous, and on Windows the page's inputs cannot take focus after it closes until the window loses and
// regains focus; this one is asynchronous and leaves the page's focus alone.
async function confirmQuestion(BrowserWindow, dialog, sender, { message }) {
  const result = await dialog.showMessageBox(BrowserWindow.fromWebContents(sender), {
    type: "question", buttons: ["確定", "取消"], defaultId: 0, cancelId: 1, noLink: true, message });
  return result.response === 0;
}

// Every web contents: no new windows, webviews, cross-page navigation or redirects; API requests carry the client
// credential only from a trusted page's main frame.
function secureWebContents({ app, BrowserWindow, desktopWindows, clientAuthentication }) {
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("will-navigate", (event, url) => {
      const page = desktopWindows.trustedRendererPage(url);
      if (!page || page !== desktopWindows.trustedRendererPage(contents.getURL())) event.preventDefault();
    });
    contents.on("will-redirect", (event) => event.preventDefault());
    contents.on("will-frame-navigate", (event) => {
      const page = desktopWindows.trustedRendererPage(event.url);
      if (!event.isMainFrame || !page || page !== desktopWindows.trustedRendererPage(contents.getURL())) event.preventDefault();
    });
    clientAuthentication.secureSession(contents.session, (details) => {
      const window = BrowserWindow.getAllWindows().find((item) => item.webContents.id === details.webContentsId);
      if (!window || window.isDestroyed()) return false;
      const owner = window.webContents;
      return details.frame === owner.mainFrame && Boolean(desktopWindows.trustedRendererPage(details.frame?.url));
    }, (details) => PAGES.LIVE_VIEWER.includes(desktopWindows.trustedRendererPage(details.frame?.url)));
  });
}

// Every App renderer -- the main window, the trade and watch-page editors, the workspace, detached views -- sends its
// console warnings and errors, hangs and crashes to this run's error.log. Registered where every web contents is
// created, so no window-creation path can leave one out (the registry ignores a contents it already has).
function observeEveryRenderer({ app, BrowserWindow, rendererHealth }) {
  app.on("web-contents-created", (_event, contents) => rendererHealth.observe(contents));
  for (const window of BrowserWindow.getAllWindows()) rendererHealth.observe(window.webContents);
}

// Electron main's stdout is not kept anywhere: its warnings and errors are also written to this run's error.log.
// The console keeps printing as before.
function teeMainConsole(rendererHealth) {
  for (const level of ["warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      try { rendererHealth.reportMain(level, args); } catch (error) { original("[MAIN] error log unavailable", error); }
    };
  }
}

function sendToMainWindow(desktopWindows, channel, payload) {
  const mainWindow = desktopWindows.getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  return true;
}

// The product pages or the 訂閱偏好 were saved in one window (設定 → 訂閱管理, 商品頁設定): every other window reads
// them again (the sender already has the saved state). A window that cannot be told is recorded; the save stands.
function broadcastWatchPagesChanged(BrowserWindow, payload, sender, logger = console) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed() && win.webContents !== sender) win.webContents.send("watch-pages-window:changed", payload);
    } catch (error) {
      logger.warn?.(`[WATCH PAGES] window ${win.id} could not be told the pages changed`, error);
    }
  }
  return true;
}

// Electron main's catalog copy now holds another revision: every window's name cache (instrument_names.js) and product
// pages read it again. A window that cannot be told is recorded; it reads the new revision on its next request.
function broadcastCatalogRevision(BrowserWindow, revision, logger = console) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) win.webContents.send("product-catalog:changed", { revision });
    } catch (error) {
      logger.warn?.(`[PRODUCT CATALOG] window ${win.id} could not be told of revision ${revision}`, error);
    }
  }
}

function createDesktopApplication({
  runtime,
  app,
  BrowserWindow,
  dialog,
  Menu,
  screen,
  ipcMain,
  Tray = null,
  nativeImage = null,
  net = null,
  shell = null,
  performance = nodePerformance,
  uiMainDir,
  logger = console,
  healthBootstrap = null,
  // main.js's early error sink: handed over to the error log below
  earlyErrors = null,
}) {
  // Where each business API / market_runtime listens: seeded from the resolver, then taken from Health (the
  // addresses the running services were actually started with). Every API request is addressed by path through
  // config/api_routes.json, never to one "backend".
  // The remediation client is built below; it is read only when a refresh runs, after it exists.
  const apiEndpoints = createApiEndpoints({ logger, remediation: () => remediationClient, isClosing: () => Boolean(shutdownController?.quitting) });
  const clientAuthentication = createClientAuthentication({ apiOrigins: () => apiEndpoints.apiOrigins(),
    liveUrl: () => liveEngineUrl(apiEndpoints), viewerToken: () => runtimeCredentials.readToken("viewer", process.env) });
  const fetch = clientAuthentication.fetch;
  const urlFor = (pathname) => apiEndpoints.urlFor(pathname);


  const electron = { app, BrowserWindow, dialog, Menu, screen, Tray, nativeImage };
  const node = { fs, path, performance, processRef: process };

  const { remediationClient, reportRemediation } = createUiRemediation({ runtime, healthBootstrap, logger,
    trustedRendererPage: (url) => desktopWindows.trustedRendererPage(url) });

  const startupMetrics = createStartupMetricsRecorder({ electronPid: process.pid });
  const applyStartupTestDelay = createStartupTestDelay({ logger });
  const shutdownHandoff = createShutdownHandoffStore(runtime.projectRoot, { logger });
  const controllerClient = createControllerClient({ fs, baseUrl: runtime.network.controllerBaseUrl, baseUrlProvider: healthBootstrap ? () => healthBootstrap.baseUrl() : null });

  let shutdownController = null;
  let appLifecycle = null;

  const desktopWindows = createDesktopWindows({
    app, BrowserWindow, screen, uiMainDir, getProjectRoot: () => runtime.projectRoot,
    connectSources: () => apiEndpoints.connectSources(),
    onMainWindowCreated: (window) => appSingleInstance.onMainWindowCreated(window),
  });
  const ipcAuthorizer = createIpcAuthorizer({
    trustedRendererPage: desktopWindows.trustedRendererPage,
    fromWebContents: (sender) => BrowserWindow.fromWebContents(sender),
  });
  const ipcRouter = createIpcRouter({ transport: ipcMain, authorize: ipcAuthorizer, logger });
  // 設定 → 系統: 開機自動啟動 (off by default); Windows' login item is the state.
  const autostart = createAutostart({ app, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, projectRoot: runtime.projectRoot });
  // 設定 → 券商帳號: the broker SDKs, installed by Health from inside the installed App (provider_sdk.js).
  const providerSdk = createProviderSdk({ controllerClient, logger });
  const colorPreferenceStore = createColorPreferenceStore(runtime.projectRoot);
  // 新版提示: the installed App asks GitHub a minute after start and daily for a newer release (app_update.js); the
  // main window is told when one appears.
  const appUpdate = createAppUpdate({
    enabled: app.isPackaged, currentVersion: app.getVersion(), repository: readPackageRepository(app.getAppPath(), logger),
    fetchImpl: net ? (url, options) => net.fetch(url, options) : null, logger,
    onChange: (state) => {
      const win = desktopWindows.getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send("app-update:changed", state);
    },
  });
  registerRuntimeIpc(ipcRouter, { rendererBootstrap: createRendererBootstrap({ runtime, apiEndpoints, desktopWindows, colorPreferenceStore }) });
  registerSettingsIpc(ipcRouter, {
    controllerClient, apiEndpoints, appProcessIds: () => appProcessIds(app), autostart, providerSdk, colorPreferenceStore,
    appUpdate, openExternal: (url) => shell.openExternal(url),
    broadcastColors: (colors) => broadcastColors(BrowserWindow, colors, logger),
    isClosing: () => Boolean(shutdownController?.quitting), logger,
  });
  // Returned to api_endpoints, which records the windows that failed to reload with the rediscovery.
  apiEndpoints.onChange(() => desktopWindows.reloadForEndpointChange());
  healthBootstrap?.onRestarted?.(async () => { await apiEndpoints.refreshFromHealth(controllerClient, "health_restart"); });

  secureWebContents({ app, BrowserWindow, desktopWindows, clientAuthentication });

  const { fitWindowToRendererContent, releasePageContentWidthLock, createOrShowTradeWindow,
    fitTradeWindowToContent, createOrShowWatchPageEditor, createOrShowWorkspaceWindow, createOrShowLayoutEditor,
    getDetachedViewManager } = desktopWindows;

  const appSingleInstance = createAppSingleInstanceController({
    app,
    getMainWindow: () => desktopWindows.getMainWindow(),
    reopenMainWindow: () => appLifecycle?.reopenMainWindow() || null,
    isShuttingDown: () => Boolean(shutdownController?.quitting),
    onLaunchDuringShutdown: () => shutdownController?.requestRelaunchAfterShutdown(),
    logger,
  });
  appSingleInstance.registerPrimary();

  startupMetrics.markTrace("APP_START");

  const startupCoordinator = new StartupCoordinator({ electronPid: process.pid, logger });
  const productCatalogStore = createProductCatalogStore({
    urlFor,
    fetchImpl: (...args) => fetch(...args),
    logger,
    isClosing: () => Boolean(shutdownController?.quitting),
    remediation: () => remediationClient,
    onRevision: (revision) => broadcastCatalogRevision(BrowserWindow, revision, logger),
  });
  startupCoordinator.subscribe((snapshot) => {
    const mainWindow = desktopWindows.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    try { mainWindow.webContents.send("startup-progress", snapshot); } catch (error) { console.warn("[STARTUP send startup progress to the main window] failed", error); }
  });

  const rendererHealth = createRendererHealthRegistry({
    fs, path, outputDir: runtime.varPaths.output,
    electronPid: process.pid,
    // Renderer errors belong in this run's error log of Electron main: one file per process (Python providers write
    // their own error-<source>.log), so this process alone appends to and rotates it.
    errorLogPath: logSessionPath(MAIN_ERROR_LOG),
  });
  startupMetrics.setPersistHandler(rendererHealth.observeStartup);
  earlyErrors?.handOff();
  teeMainConsole(rendererHealth);
  observeEveryRenderer({ app, BrowserWindow, rendererHealth });

  const { submitGoogleFormTrade } = createTradeForm({ fetch, unconfirmedPagePath: (name) => logSessionPath(name) });
  const productOperations = createProductOperations({
    fetch, urlFor, productCatalogStore, sourceEnabled,
  });
  const { loadProductCatalogIndex } = productOperations;

  const watchPageStore = createWatchPageStore(runtime.projectRoot, { catalog: productCatalogStore });

  registerWindowIpc(ipcRouter, {
    fitWindowToRendererContent, releasePageContentWidthLock,
    pickFolder: (sender) => pickFolder(BrowserWindow, dialog, sender),
    confirmQuestion: (sender, payload) => confirmQuestion(BrowserWindow, dialog, sender, payload),
    openDetachedView: (payload) => getDetachedViewManager().open(payload),
    openWorkspaceView: (seedSymbol) => createOrShowWorkspaceWindow(seedSymbol),
    openLayoutEditor: () => createOrShowLayoutEditor(),
  });
  registerMonitoringIpc(ipcRouter, {
    startupCoordinator,
    marketRuntimeReady: () => appLifecycle.marketRuntimeReady(),
    futuProviderReady: () => appLifecycle.futuProviderReady(),
    readExternalHealthSupervisor: async () => {
      const status = await controllerClient.getStatus(1500).catch((error) => { console.warn("[HEALTH external supervisor status read] failed", error); return null; });
      return status ? { schema: "stock-monitor-external-health-v2", healthy: status.ok === true, state: status.stopping ? "STOPPING" : "RUNNING",
        services: status.services }
        : { schema: "stock-monitor-external-health-v2", healthy: false, state: "UNREACHABLE" };
    },
    reportRendererHealth: rendererHealth.report,
    reportRemediation,
    rendererStopped: (event) => shutdownController?.rendererStopped(event),
  });
  registerTradeIpc(ipcRouter, {
    submitGoogleFormTrade,
    openTradeWindow: createOrShowTradeWindow,
    closeTradeWindow: desktopWindows.closeTradeWindow,
    notifyTradeChanged: (payload) => sendToMainWindow(desktopWindows, "trade-window:changed", payload),
    fitTradeWindowToContent,
  });
  registerWatchPageIpc(ipcRouter, {
    watchPageStore, sourceEnabled, productCatalogStore, loadProductCatalogIndex,
    openWatchPageEditor: createOrShowWatchPageEditor,
    notifyWatchPagesChanged: (payload, sender) => broadcastWatchPagesChanged(BrowserWindow, payload, sender, logger),
  });
  // Every renderer -> main channel of ipc_contract.js has its handler, or the App does not start.
  ipcRouter.assertComplete();

  shutdownController = new ShutdownController({
    electron, node, controllerClient, startupCoordinator, rendererHealth, appSingleInstance, remediationClient,
    desktopWindows, healthBootstrap,
    logger, timelinePath: logSessionPath("shutdown_timeline.log"),
  });
  healthBootstrap.onHealthEndedApp?.(() => shutdownController.quitAfterHealthEnded());
  // A restarted Health is a new announcement stream (the first is followed once Health answers, app_lifecycle_controller.js).
  healthBootstrap?.onRestarted?.(() => shutdownController.followHealth());

  // The tray icon: how the App is reached, and closed further, once its window is closed (tray_controller.js).
  const tray = new TrayController({ electron, iconPath: node.path.join(__dirname, "assets", "tray.png"), logger,
    onOpen: () => { const win = appLifecycle?.reopenMainWindow(); if (win && !win.isDestroyed()) { win.show(); win.focus(); } },
    onCloseUiAndBackend: () => void appLifecycle?.closeUiAndBackend(),
    onFullShutdown: () => void appLifecycle?.fullShutdown() });
  appLifecycle = new AppLifecycleController({
    healthBootstrap, tray,
    electron, node, runtime,
    startupCoordinator, controllerClient, fetchImpl: fetch, apiEndpoints,
    shutdownController, desktopWindows, rendererHealth,
    appSingleInstance,
    applyStartupTestDelay, startupMetrics, shutdownHandoff, productOperations, logger,
  });

  // Electron's processes for Health's 系統 CPU / 記憶體 trend, renewed well inside Health's 5-minute lease whether or not
  // a monitoring page is open, and again right after Health restarts (a new Health starts with none).
  const reportAppProcesses = () => {
    if (!shutdownController?.quitting) void controllerClient.reportAppProcesses(appProcessIds(app));
  };
  const appProcessLease = setInterval(reportAppProcesses, APP_PROCESS_LEASE_RENEW_MS);
  appProcessLease.unref?.();
  healthBootstrap?.onRestarted?.(reportAppProcesses);

  return {
    run() {
      reportAppProcesses();
      appUpdate.start();
      return appLifecycle.bind();
    },
  };
}

module.exports = { createDesktopApplication, createRendererBootstrap, broadcastColors, appProcessIds, observeEveryRenderer };
