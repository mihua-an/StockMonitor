"use strict";
// Every IPC domain of ui/main/ipc_registration.js installed on one router, each dependency a stub that counts its
// calls (`effects`); a test overrides the ones it looks at. Mirrors desktop_application.js's composition.
const registration = require("../../ui/main/ipc_registration");
const { createIpcRouter } = require("../../ui/main/ipc_router");

function installAllDomains({ authorize, overrides = {}, logger = console } = {}) {
  const handlers = new Map();
  const transport = {
    on: (channel, fn) => { if (handlers.has(channel)) throw new Error(`${channel} twice`); handlers.set(channel, fn); },
    handle: (channel, fn) => { if (handlers.has(channel)) throw new Error(`${channel} twice`); handlers.set(channel, fn); },
  };
  const router = createIpcRouter({ transport, authorize, logger });
  const counter = { effects: 0 };
  const effect = (value = true) => () => { counter.effects += 1; return value; };
  const deps = {
    rendererBootstrap: effect({ ok: true }),
    fitWindowToRendererContent: effect(), releasePageContentWidthLock: effect(), pickFolder: effect(null),
    openDetachedView: effect({ ok: true }), openWorkspaceView: effect(), openLayoutEditor: effect(),
    startupCoordinator: { snapshot: effect({}), reportRendererStep: effect() },
    readExternalHealthSupervisor: effect({}), reportRendererHealth: effect(), reportRemediation: effect(),
    submitGoogleFormTrade: effect({ ok: true }), openTradeWindow: effect(), closeTradeWindow: effect(), notifyTradeChanged: effect(),
    fitTradeWindowToContent: effect(),
    watchPageStore: { load: effect({ ok: true, pages: [] }) },
    sourceEnabled: () => true,
    productCatalogStore: { snapshot: () => ({ status: { loaded: true } }), search: effect({ ok: true, items: [] }) },
    loadProductCatalogIndex: async () => ({}), openWatchPageEditor: effect(), notifyWatchPagesChanged: effect(),
    controllerClient: {
      getSnapshot: effect({}), requestMonitoringDetail: effect({}), previewNetwork: effect({}),
      getOperations: async () => { counter.effects += 1; return {}; }, applyNetwork: async () => { counter.effects += 1; return { ok: true }; },
    },
    apiEndpoints: { refreshFromHealth: async () => true }, appProcessIds: () => [1],
    autostart: { status: effect({}), set: effect({}), launcher: { script: "x" } },
    providerSdk: { status: effect({}), install: async () => { counter.effects += 1; return { ok: true }; } },
    colorPreferenceStore: { save: (v) => { counter.effects += 1; return v; } }, broadcastColors: () => [],
    logger,
    ...overrides,
  };
  registration.registerRuntimeIpc(router, deps);
  registration.registerWindowIpc(router, deps);
  registration.registerMonitoringIpc(router, deps);
  registration.registerTradeIpc(router, deps);
  registration.registerWatchPageIpc(router, deps);
  registration.registerSettingsIpc(router, deps);
  return { handlers, router, counter, deps };
}

module.exports = { installAllDomains };
