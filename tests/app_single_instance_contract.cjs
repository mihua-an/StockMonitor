"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createAppSingleInstanceController } = require("../ui/main/app_single_instance");

class FakeApp extends EventEmitter {
  constructor() {
    super();
    this.releaseCount = 0;
  }

  releaseSingleInstanceLock() {
    this.releaseCount += 1;
  }
}

const app = new FakeApp();
const controller = createAppSingleInstanceController({
  app,
  getMainWindow: () => null,
  logger: { log() {} },
});

assert.equal(controller.registerPrimary(), true);
assert.equal(app.listenerCount("second-instance"), 1);
assert.equal(controller.releasePrimary(), true);
assert.equal(app.releaseCount, 1);
assert.equal(app.listenerCount("second-instance"), 0);
assert.deepEqual(controller.status(), {
  registered_primary: false,
  primary_lock_released: true,
  pending_second_instance_focus: false,
  duplicate_launch_count: 0,
});
assert.equal(controller.releasePrimary(), false, "the UI lock is released at most once");
assert.equal(app.releaseCount, 1);

const { ShutdownController } = require("../ui/main/shutdown_controller");

// Drives a real ShutdownController through requestGracefulQuit() and records
// the order its collaborators are actually invoked in, rather than grepping
// the source text for a hardcoded call shape.
async function captureShutdownCallOrder() {
  const callOrder = [];
  const fakeMainWindow = { isDestroyed: () => false, destroy() {} };
  const controller = new ShutdownController({
    electron: {
      app: { quit: () => callOrder.push("app.quit"), exit: () => {}, once: () => {} },
      dialog: { showErrorBox() {} },
      BrowserWindow: { getAllWindows: () => [fakeMainWindow] },
    },
    node: { performance: { now: () => 0 }, processRef: { pid: 1234 } },
    controllerClient: {
      shutdown: async () => {
        callOrder.push("serviceSupervisor.shutdown");
        return { ok: true, receipts: {} };
      },
    },
    startupCoordinator: { markProgress() {}, stop() {} },
    rendererHealth: { close: async () => {} },
    appSingleInstance: {
      releasePrimary: () => {
        callOrder.push("appSingleInstance.releasePrimary");
        return true;
      },
    },
    desktopWindows: {
      getMainWindow: () => fakeMainWindow,
      setMainWindow() {},
      saveWindowState() {},
      showShutdownState() { callOrder.push("showShutdownState"); },
    },
    reopenMainWindow: () => null,
    logger: { log() {}, warn() {}, error() {} },
  });
  const disconnectRendererWindows = controller.disconnectRendererWindows.bind(controller);
  controller.disconnectRendererWindows = async (...args) => {
    callOrder.push("disconnectRendererWindows");
    return disconnectRendererWindows(...args);
  };
  await controller.requestGracefulQuit({ stopPersistentDaemons: true, reason: "test" });
  return callOrder;
}

async function verifyShutdownOrdering() {
  const callOrder = await captureShutdownCallOrder();
  assert.deepEqual(
    callOrder,
    ["showShutdownState", "serviceSupervisor.shutdown", "disconnectRendererWindows", "appSingleInstance.releasePrimary", "app.quit"],
    "shutdown remains visible until backend/daemon handoff completes, then the window and UI lock close"
  );
}

(async () => {
  await verifyShutdownOrdering();
  console.log("app single-instance UI-lock lifetime contract passed");

  const warmApp = new FakeApp();
  let reopened = 0;
  const warmController = createAppSingleInstanceController({
    app: warmApp,
    getMainWindow: () => null,
    reopenMainWindow: () => {
      reopened += 1;
      return { isDestroyed: () => false, isMinimized: () => false, isVisible: () => true, focus() {} };
    },
    logger: { log() {} },
  });
  warmController.registerPrimary();
  const reopenResult = warmController.handleSecondInstance();
  assert.equal(reopened, 1);
  assert.equal(reopenResult.reopened, true);
  assert.equal(warmController.status().duplicate_launch_count, 1);

  let relaunchRequests = 0;
  const closingController = createAppSingleInstanceController({
    app: new FakeApp(),
    getMainWindow: () => ({ isDestroyed: () => false, focus() { throw new Error("must not focus closing window"); } }),
    isShuttingDown: () => true,
    onLaunchDuringShutdown: () => { relaunchRequests += 1; },
    logger: { log() {} },
  });
  closingController.registerPrimary();
  const deferredResult = closingController.handleSecondInstance();
  assert.equal(deferredResult.relaunchScheduled, true);
  assert.equal(relaunchRequests, 1, "a launch during durable shutdown must automatically reopen after teardown");

  // The close scopes, driven through the real AppLifecycleController and TrayController.
  {
    const { AppLifecycleController } = require("../ui/main/app_lifecycle_controller");
    const { TrayController } = require("../ui/main/tray_controller");
    const quits = [];
    const dialogs = [];
    const electronApp = new EventEmitter();
    const mainWindow = new EventEmitter();
    const lifecycle = new AppLifecycleController({
      electron: { app: electronApp, screen: new EventEmitter(), BrowserWindow: { getAllWindows: () => [mainWindow] },
        dialog: { showMessageBox: (...args) => { dialogs.push(args); }, showErrorBox: (...args) => { dialogs.push(args); } } },
      node: { processRef: new EventEmitter() },
      shutdownController: { quitting: false, requestGracefulQuit: (options) => { quits.push(options); return Promise.resolve(); } },
      desktopWindows: { createWindow: () => mainWindow, applyAdaptiveUiScale() {} },
      logger: { log() {}, warn() {}, error() {} },
    });
    lifecycle.registerShellEvents();
    lifecycle.createWindow();
    // X closes the window only: no question, no shutdown, and the last window closing leaves the process alive.
    let prevented = false;
    mainWindow.emit("close", { preventDefault: () => { prevented = true; } });
    mainWindow.emit("closed");
    electronApp.emit("window-all-closed");
    assert.equal(prevented, false);
    assert.deepEqual(quits, [], "closing the window stops nothing");
    assert.deepEqual(dialogs, [], "closing the window asks nothing");
    // The tray menu holds the two wider scopes.
    let template = null;
    const tray = new TrayController({
      electron: { Tray: class { setToolTip() {} setContextMenu() {} on() {} }, Menu: { buildFromTemplate: (t) => { template = t; return t; } },
        nativeImage: { createFromPath: () => ({ isEmpty: () => false }) } },
      iconPath: "icon.ico", onOpen() {}, onCloseUiAndBackend: () => lifecycle.closeUiAndBackend(), onFullShutdown: () => lifecycle.fullShutdown(),
      logger: { warn() {} },
    });
    tray.start();
    const item = (label) => template.find((entry) => entry.label === label);
    item("關閉介面與 FastAPI").click();
    item("完整關閉（含行情服務）").click();
    assert.deepEqual(quits, [{ stopPersistentDaemons: false, reason: "user_close_ui_backend" },
      { stopPersistentDaemons: true, reason: "user_full_shutdown" }]);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
