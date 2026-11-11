"use strict";

const { sourceDisabledResponse } = require("./source_disabled_response");

// Renderer -> main handlers, one function per domain. Each installs its channels through the router
// (ipc_router.js), which authorizes every event by ipc_contract.js before the handler runs: a payload a handler
// receives has already passed its channel's schema. desktop_application.js composes the domains.

// The preload's one synchronous read: everything a page needs before its scripts run.
function registerRuntimeIpc(router, { rendererBootstrap }) {
  router.sync("runtime:get-bootstrap", (event) => rendererBootstrap(event));
}

function registerWindowIpc(router, {
  fitWindowToRendererContent, releasePageContentWidthLock, pickFolder, confirmQuestion, openDetachedView, openWorkspaceView, openLayoutEditor,
}) {
  router.handle("dialog:confirm", (event, payload) => confirmQuestion(event.sender, payload));
  router.handle("window:fit-page-content", (_event, payload) => fitWindowToRendererContent(payload || {}));
  router.handle("window:release-page-width-lock", () => releasePageContentWidthLock());
  // 設定 → 資料儲存: pick the raw-history folder. Only a path comes back; settings_api validates and saves it.
  router.handle("dialog:pick-folder", (event) => pickFolder(event.sender));
  router.handle("detached-view:open", (_event, payload) => openDetachedView(payload));
  router.handle("workspace-view:open", (_event, payload) => openWorkspaceView(payload?.seedSymbol || ""));
  router.handle("layout-editor:open", () => openLayoutEditor());
}

function registerMonitoringIpc(router, {
  startupCoordinator, marketRuntimeReady, futuProviderReady, readExternalHealthSupervisor, reportRendererHealth, reportRemediation, rendererStopped,
}) {
  router.handle("startup:get-state", () => startupCoordinator.snapshot());
  router.handle("startup:market-runtime", () => marketRuntimeReady());
  router.handle("startup:futu-provider", () => futuProviderReady());
  router.handle("startup:renderer-step", (_event, payload) => startupCoordinator.reportRendererStep(payload || {}));
  router.handle("health-supervisor:get", () => readExternalHealthSupervisor());
  router.send("renderer:health", (event, payload) => reportRendererHealth(event, payload));
  router.send("remediation:report", (event, payload) => reportRemediation(event, payload));
  router.send("app:closing-done", (event) => rendererStopped(event));
}

function registerTradeIpc(router, {
  submitGoogleFormTrade, openTradeWindow, closeTradeWindow, notifyTradeChanged, fitTradeWindowToContent,
}) {
  router.handle("google-form:submit-trade", (_event, payload) => submitGoogleFormTrade(payload));
  router.handle("trade-window:open", (_event, payload) => openTradeWindow(payload || {}));
  router.handle("trade-window:close", (event) => closeTradeWindow(event));
  router.handle("trade-window:changed", (_event, payload) => notifyTradeChanged(payload || {}));
  router.handle("trade-window:fit-content", (event, payload) => fitTradeWindowToContent(event, payload || {}));
}

function registerWatchPageIpc(router, {
  watchPageStore, sourceEnabled, productCatalogStore, loadProductCatalogIndex,
  openWatchPageEditor, notifyWatchPagesChanged,
}) {
  // Read only: settings_api writes the product pages (POST /api/subscriptions/ops), with the background list they make.
  router.handle("watch-pages:load-local", () => watchPageStore.load());
  // "is this source enabled, and is the local catalog loaded" is checked on one path. A load failure rejects the
  // invoke() promise rather than falling through to a search against a stale/empty catalog; callers (e.g.
  // watch_pages_window.js's fetchSearchItems) catch and surface it.
  router.handle("product-catalog:search-local", async (_event, payload) => {
    const source = String(payload?.source || "shioaji").toLowerCase();
    if (!sourceEnabled(source)) return sourceDisabledResponse(source, { items: [] });
    if (!productCatalogStore.snapshot().status?.loaded) await loadProductCatalogIndex();
    return productCatalogStore.search({ source, query: payload?.query, market: payload?.market, limit: payload?.limit });
  });
  // The renderer's one name source (instrument_names.js): catalog names of codes, with the catalog revision.
  router.handle("product-catalog:names", async (_event, payload) => {
    if (!sourceEnabled(payload.source)) return sourceDisabledResponse(payload.source, { items: [] });
    if (!productCatalogStore.snapshot().status?.loaded) await loadProductCatalogIndex();
    return productCatalogStore.names(payload.source, payload.codes);
  });
  router.handle("watch-pages-window:open", () => openWatchPageEditor());
  router.handle("watch-pages-window:changed", (event, payload) => notifyWatchPagesChanged(payload || {}, event?.sender));
}

// Settings page: workload monitoring, network apply (06, 07), autostart, broker SDKs and quote colors. The controller
// credential stays in this process; the renderer only asks through these channels.
function registerSettingsIpc(router, {
  controllerClient, apiEndpoints, appProcessIds, autostart, providerSdk, colorPreferenceStore, broadcastColors,
  appUpdate, openExternal, isClosing = () => false, logger = console,
}) {
  router.handle("monitoring:snapshot", (_event, payload) => controllerClient.getSnapshot({ trendSince: payload?.trendSince ?? null }));
  router.handle("monitoring:request-detail", () => controllerClient.requestMonitoringDetail({ appPids: appProcessIds() }));
  router.handle("network:preview", (_event, payload) => controllerClient.previewNetwork(payload.candidate_revision));
  router.handle("network:operations", () => controllerClient.getOperations().catch((error) => {
    logger.warn?.("[SETTINGS network:operations: reading Health's network operations] failed", error);
    return { ok: false, error: String(error?.message || error) };
  }));
  router.handle("network:apply", async (_event, payload) => {
    const revision = payload.candidate_revision;
    const expected = payload.expected_active_revision ?? null;
    const operationId = payload.operation_id || `ui-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const result = await controllerClient.applyNetwork({ operationId, candidateRevision: revision, expectedActiveRevision: expected })
      .catch((error) => {
        logger.error?.(`[SETTINGS network:apply: applying revision ${revision} (operation ${operationId})] failed`, error);
        return { ok: false, error: String(error?.message || error) };
      });
    // A regular apply answers after every service is verified; a self-endpoint apply answers before Health's
    // planned restart and the bootstrap's restart listener refreshes the endpoints once Health is back.
    // The rediscovery starts at once: Health's effective-endpoint read is the readiness signal -- it reports
    // `effective: true` only once no network operation is open, and a read made before that is held by Health until
    // the endpoints settle (refreshFromHealth keeps asking with held reads). No fixed delay guesses at it.
    if (result?.ok && !result?.pending_restart) {
      void apiEndpoints.refreshFromHealth(controllerClient, "network_apply")
        .catch((error) => logger.error?.("[SETTINGS network:apply: rediscovering the endpoints] failed", error));
    }
    return result;
  });
  // 設定 → 系統: 開機自動啟動 (off by default); Windows' login item is the state.
  router.handle("autostart:get", () => autostart.status());
  router.handle("autostart:set", (_event, payload) => {
    const result = autostart.set(payload.enabled);
    logger.log?.(`[AUTOSTART] ${payload.enabled ? "enabled" : "disabled"} (${autostart.launcher.script})`);
    return result;
  });
  // 設定 → 券商帳號: the broker SDKs, installed by Health (provider_sdk.js). Following the job ends when the asking
  // window is gone or the App closes; the install itself goes on in Health.
  router.handle("provider-sdk:status", () => providerSdk.status());
  router.handle("provider-sdk:install", (event, payload) => {
    const sender = event.sender;
    const following = new AbortController();
    const stop = () => following.abort(new Error("the settings window closed"));
    sender.once?.("destroyed", stop);
    return providerSdk.install(payload.provider, {
      signal: following.signal, isClosing,
      onLine: (line) => { if (!sender.isDestroyed()) sender.send("provider-sdk:progress", { provider: payload.provider, line: String(line).slice(0, 500) }); },
    }).finally(() => sender.removeListener?.("destroyed", stop));
  });
  // 新版提示 (app_update.js): the state, and the newest release's page in the browser -- only that page, only when it
  // is newer (pageToOpen checks it is this repository's release on github.com).
  router.handle("app-update:get", () => appUpdate.state());
  router.handle("app-update:open", async () => {
    const page = appUpdate.pageToOpen();
    if (!page) return { ok: false, error: "沒有更新的版本" };
    await openExternal(page);
    logger.log?.(`[APP UPDATE] opened ${page}`);
    return { ok: true };
  });
  // Saved first, then every open window is told; a window that cannot be told does not make the committed save a
  // failure (broadcastColors records each one). The answer is only {ok:true}: the broadcast is what every window --
  // the one that saved included -- draws the saved colors from, so an answer arriving late cannot draw an older save.
  router.handle("preferences:set-colors", (_event, payload) => {
    broadcastColors(colorPreferenceStore.save(payload || {}));
    return { ok: true };
  });
}

module.exports = {
  registerRuntimeIpc, registerWindowIpc, registerMonitoringIpc, registerTradeIpc, registerWatchPageIpc, registerSettingsIpc,
};
