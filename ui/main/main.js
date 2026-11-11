const { app, BrowserWindow, dialog, Menu, screen, ipcMain, Tray, nativeImage, net, shell } = require("electron");
const path = require("path");
const { performance } = require("perf_hooks");
const { loadRuntime } = require("../../service/platform/js/launch_runtime");

// The packaged asar mirrors the repo layout (ui/main, ui/renderer, health,
// config/js), so every relative require resolves identically in dev and
// packaged runs.
function requireMain(name) {
  return require(`./${name}`);
}
const { createAppSingleInstanceController } = requireMain("app_single_instance");

// Errors before the application's error log exists go to this run's error log of Electron main from here on.
const earlyErrors = requireMain("early_error_sink").installEarlyErrorSink({
  resolvePrimary: () => {
    const { logSessionPath, MAIN_ERROR_LOG } = require("../../service/platform/js/log_session.js");
    return logSessionPath(MAIN_ERROR_LOG);
  },
  fallbackFile: path.join(app.getPath("appData"), "StockMonitor", "startup_errors.log"),
});
// A launcher that closed its end of stdout/stderr turns the next console line into EPIPE; that is recorded in the
// same error log instead of becoming an uncaught exception dialog.
require("../../service/platform/js/stdio_guard.js").installStdioGuard({
  onLost: (stream, error) => require("fs").appendFileSync(earlyErrors.file,
    `[${new Date().toISOString()}] [MAIN] ${stream} reader is gone (${error?.code || error?.message || error}); console output to it is dropped from here on\n`, "utf8"),
});

// Every launcher shares one Electron singleton/profile: a second normal/hidden
// launcher focuses the already-running primary window and exits before any
// process-spawning code is even loaded.
//
// service/platform/js/launch_runtime.js is now also used, unchanged, by the standalone
// health/main.js process (Part 2 Service Controller
// split) -- so it never calls into Electron itself, and Electron's own
// isPackaged/resourcesPath/userDataPath are passed in explicitly here rather
// than the module defaulting them from `require("electron").app`.
// The flavor's own userData (config/var_layout.json "flavors"), never Electron's app-name default: an installed app
// and the source checkout each keep their own window layout and data, and Health resolves the same directory.
{
  const { userDataDir } = require("../../config/js/var_paths.js");
  const { flavorOf } = require("../../service/platform/js/launch_runtime.js");
  app.setPath("userData", userDataDir({ flavor: flavorOf(app.isPackaged), env: process.env }));
}

let runtime = null;
try {
  runtime = loadRuntime({
    env: process.env,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath("userData"),
  });
} catch (error) {
  const detail = error?.code === "RUNTIME_CONFIGURATION_INVALID"
    ? String(error.message || error)
    : `StockMonitor 無法載入執行環境：${String(error?.message || error)}`;
  console.error("[STARTUP] runtime configuration failed", error);
  dialog.showErrorBox("StockMonitor 無法啟動", detail);
  app.quit();
}

const isPrimaryInstance = runtime ? app.requestSingleInstanceLock() : false;

if (!runtime) {
  // The error was already shown above. Do not import the application graph or
  // create a window after a malformed/missing runtime contract.
} else if (!isPrimaryInstance) {
  createAppSingleInstanceController({ app, getMainWindow: () => null, logger: console }).rejectSecondary();
  app.quit();
} else {
  // Electron bootstraps Health itself (see docs/system-architecture/README.md:
  // "Electron -> bootstrap Health -> Health starts/manages services").
  // scripts/launch_desktop.js and packaging/launch_stock_monitor.ps1 no
  // longer spawn Health -- this is the one place that owns it now.
  const { createHealthBootstrap } = requireMain("health_bootstrap");
  const healthBootstrap = createHealthBootstrap({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    uiMainDir: __dirname,
    path,
    healthBaseUrl: runtime.network.controllerBaseUrl,
    logger: console,
  });
  // Every failure of this startup, thrown or an unhandled rejection, ends in fatal_startup.js's one terminal path.
  const fatalStartup = requireMain("fatal_startup").createFatalStartup({ app, dialog, logger: console });
  void fatalStartup.run(async (enter) => {
    enter("Health 服務未能啟動");
    await healthBootstrap.start();
    enter("桌面程式未能建立");
    const { createDesktopApplication } = requireMain("desktop_application");
    const desktop = createDesktopApplication({
      runtime, app, BrowserWindow, dialog, Menu, screen, ipcMain, Tray, nativeImage, net, shell, performance,
      uiMainDir: __dirname, logger: console, healthBootstrap, earlyErrors,
    });
    enter("桌面程式啟動未完成");
    await desktop.run();
  });
}
