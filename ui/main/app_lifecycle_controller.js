"use strict";

const { clamp } = require("./numbers");
const { fetchJson } = require("../../service/platform/js/fetch_timeout");
const { installReloadInputGuard } = require("./reload_input_guard");

// This class does not reach into any service supervisor, backend controller, daemon host, live engine or
// startup diagnostics: all of that lifecycle authority lives in the standalone health/ process, and this class is
// only ever an HTTP client of it (ui/main/controller_client.js). The StartupCoordinator/STARTUP_UNITS state machine
// in ./startup_lifecycle.js drives the startup UI; the leaf callbacks passed into its run() below are controllerClient
// HTTP calls.
// Electron's startup units -> the service_ids Health records startup outcomes under (health/supervisor.js).
// "backend" is the seven business APIs: the renderer needs all of them addressable before it bootstraps.
const STARTUP_SERVICES = {
  backend: ["app_api", "realtime_api"],
  shioaji: ["provider_shioaji"],
  futu: ["provider_futu"],
  market_runtime: ["market_runtime"],
  analysis_runtime: ["analysis_runtime"],
};

const { MARKET_RUNTIME_START_MAX_MS, START_ALL_TIMEOUT_MS } = require("../../config/js/startup_budget.js");

const STORAGE_MOVE_STATES = { sizing: "準備", scanning: "比對", copying: "複製", verifying: "核對", placing: "放入新資料夾", activating: "啟用",
  deleting_source: "刪除舊資料夾", rolling_back: "還原" };

// The startup screen's line for Health's history folder move (/status/startup `storage_move`).
function storageMoveText(move) {
  const gb = (bytes) => (Number(bytes) / 1024 ** 3).toFixed(1);
  const head = `搬移資料到 ${move.to}：${STORAGE_MOVE_STATES[move.state] || move.state}`;
  if (move.state === "copying" && Number(move.bytes_total) > 0) {
    const percent = Math.floor((Number(move.bytes_done) / Number(move.bytes_total)) * 100);
    return `${head} ${gb(move.bytes_done)} / ${gb(move.bytes_total)} GB（${percent}%，${move.files_done} / ${move.files_total} 檔）`;
  }
  if (move.state === "placing" && move.entries_total) return `${head} ${move.entries_done} / ${move.entries_total}`;
  return head;
}

class AppLifecycleController {
  constructor({
    electron,
    node,
    runtime,
    startupCoordinator,
    controllerClient,
    fetchImpl = fetch,
    apiEndpoints,
    shutdownController,
    desktopWindows,
    appSingleInstance,
    applyStartupTestDelay,
    startupMetrics,
    shutdownHandoff,
    productOperations,
    healthBootstrap = null,
    tray = null,
    logger = console,
  }) {
    Object.assign(this, {
      electron,
      node,
      runtime,
      startupCoordinator,
      controllerClient,
      fetchImpl,
      apiEndpoints,
      shutdownController,
      desktopWindows,
      appSingleInstance,
      applyStartupTestDelay,
      startupMetrics,
      shutdownHandoff,
      productOperations,
      logger,
      tray,
    });
    this.closeChoiceInProgress = false;
    this.suppressCloseChoice = false;
    // Cached from the most recent startup-unit callbacks below, purely for
    // diagnostics (acceptance report, failure dialog): this process owns no
    // backend or daemon host to read them from.
    this._lastBackendPid = null;
    this._lastDaemonPid = null;
    this._lastBackendReadinessFailure = { reason: "", detail: "" };
    this._lastBackendProbe = {};
    this.healthBootstrap = healthBootstrap;
    // Startup unit -> the pending or ready outcome of waiting for it (_startOutcome).
    this._startOutcomes = new Map();
  }

  // Polls Health's own read-only startup-sequencing snapshot (GET
  // /status/startup, health/main.js's trackedEnsure()) until the named
  // service settles, instead of Electron deciding to call ensure() itself --
  // Health already started ensuring every service on its own, unconditionally,
  // before Electron ever attached (see this file's header comment).
  // One wall-clock deadline, not an attempt count: 480 attempts of up to a 1.5 s request plus the 0.25 s pause would
  // stretch the nominal 120 s to ~14 minutes against a slow Health.
  // While Health moves the stored history to a new folder no service starts yet: the services' budget begins once the
  // move ends, and `onStorageMove(progress)` gets each progress read meanwhile.
  async _waitForHealthStartup(name, { timeoutMs = 120000, intervalMs = 250, onStorageMove = null } = {}) {
    const serviceIds = STARTUP_SERVICES[name] || [name];
    let deadline = Date.now() + timeoutMs;
    let last = {};
    while (Date.now() < deadline) {
      const requestMs = Math.max(1, Math.min(1500, deadline - Date.now()));
      const snapshot = await this.controllerClient.getStartupStatus(requestMs).catch((error) => { console.warn("[STARTUP status poll] failed", error); return null; });
      if (snapshot?.storage_move) {
        deadline = Date.now() + timeoutMs;
        onStorageMove?.(snapshot.storage_move);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }
      const steps = serviceIds.map((sid) => [sid, snapshot?.services?.[sid]]);
      last = Object.fromEntries(steps);
      // An outcome counts only when it belongs to the start-all attempt this UI waits for: attached to a
      // Health that outlived an earlier UI, the record still holds that boot's outcomes until the new attempt redoes
      // them. Without a named attempt, Health's current one.
      const expected = this.healthBootstrap?.expectedStartupAttempt?.() || null;
      const sameHealth = !expected?.instance || snapshot?.attempt?.health_instance === expected.instance;
      const wanted = expected?.generation ?? snapshot?.attempt?.generation ?? null;
      // Exactly that attempt: a later one is someone else's.
      const current = (step) => sameHealth && wanted !== null && Number(step.attempt) === wanted;
      if (steps.every(([, step]) => step && ["ready", "skipped", "failed"].includes(step.status) && current(step))) {
        const failed = steps.filter(([, step]) => step.status === "failed");
        if (failed.length) {
          return { status: "failed", services: last, detail: failed.map(([sid, step]) => `${sid}: ${step.error || "failed"}`).join("; ") };
        }
        const allSkipped = steps.every(([, step]) => step.status === "skipped");
        return { status: allSkipped ? "skipped" : "ready", services: last, pid: steps[0][1]?.pid ?? null };
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    const pending = serviceIds.filter((sid) => !last[sid]).join(", ");
    return { status: "timeout", services: last, detail: `Health startup status did not settle within timeout (${pending || name})` };
  }

  // Market Runtime's start outcome, for the renderer's /live connection: it connects once Health says A serves, not
  // before and then by retrying (the startup order; A may still be replaying its WAL when the APIs are up).
  marketRuntimeReady() {
    return this._startOutcome("market_runtime", MARKET_RUNTIME_START_MAX_MS);
  }

  // The Futu provider's start outcome, for the renderer's Futu product store: every /api/futu/* call is proxied to it,
  // so the store reads once Health says it serves. Health starts it after Market Runtime, so the wait is bounded by
  // the whole start-all.
  futuProviderReady() {
    return this._startOutcome("futu", START_ALL_TIMEOUT_MS);
  }

  // A ready answer is kept for the process; a failed or timed-out start is asked again by the next caller, and
  // callers that come together share one wait.
  _startOutcome(name, timeoutMs) {
    if (!this._startOutcomes.has(name)) {
      this._startOutcomes.set(name, this._waitForHealthStartup(name, { timeoutMs })
        .then((step) => {
          if (step.status !== "ready") this._startOutcomes.delete(name);
          return { status: step.status, detail: step.detail || "" };
        }, (error) => {
          this._startOutcomes.delete(name);
          throw error;
        }));
    }
    return this._startOutcomes.get(name);
  }

  // Closing the window closes the window only (user decision): Health, the market services and the recording keep
  // running, and the tray icon (tray_controller.js) reopens it or closes more. The three scopes are the tray's menu.
  closeUiAndBackend() {
    return this.shutdownController.requestGracefulQuit({ stopPersistentDaemons: false, reason: "user_close_ui_backend" });
  }

  fullShutdown() {
    return this.shutdownController.requestGracefulQuit({ stopPersistentDaemons: true, reason: "user_full_shutdown" });
  }

  createWindow() {
    const windowRef = this.desktopWindows.createWindow();
    windowRef.on("close", (event) => {
      if (this.shutdownController.quitting) {
        // Full shutdown may need tens of seconds to durably flush broker data.
        // Keep the progress surface visible until ShutdownController destroys
        // it after the service receipts are complete.
        event.preventDefault();
        return;
      }
      this.logger.log("[APP UI] main window closed; Service Controller/Backend/market daemons retained");
    });
    windowRef.once("closed", () => this.tray?.windowClosed());
    this.tray?.windowOpened();
    return windowRef;
  }

  reopenMainWindow() {
    if (this.shutdownController.quitting) return null;
    const existing = this.electron.BrowserWindow.getAllWindows().find((win) => win && !win.isDestroyed());
    return existing || this.createWindow();
  }

  // Direct Electron -> FastAPI HTTP calls. These are explicitly still
  // allowed under the Part 2 architecture ("Electron --HTTP--> FastAPI for
  // everything else") -- readiness/heartbeat polling is not a
  // process-lifecycle decision, so it does not go through the Controller.
  async fetchBackendJson(pathname, timeoutMs = 800) {
    const url = this.apiEndpoints.urlFor(pathname);
    return fetchJson(this.fetchImpl, url, { cache: "no-store" }, Math.max(100, Number(timeoutMs) || 800));
  }

  async runAutomatedStartupAcceptance() {
    const reportPath = String(this.node.processRef.env.STOCK_MONITOR_ACCEPTANCE_REPORT || "").trim();
    const mainWindow = this.desktopWindows.getMainWindow();
    if (!reportPath || !mainWindow || mainWindow.isDestroyed()) return;
    const timeoutMs = clamp(
      Number(this.node.processRef.env.STOCK_MONITOR_ACCEPTANCE_TIMEOUT_MS) || 20000,
      3000,
      120000
    );
    const startedAt = this.node.performance.now();
    const deadline = Date.now() + timeoutMs;
    let snapshot = { ok: false, checks: {}, error: "renderer acceptance surface unavailable" };
    let futuresViewPrepared = false;
    while (Date.now() < deadline && !mainWindow.isDestroyed()) {
      try {
        if (!futuresViewPrepared) {
          futuresViewPrepared = Boolean(await mainWindow.webContents.executeJavaScript(
            "(() => { const button = document.querySelector('button[data-panel-tab-key=\"futuresTrend\"]'); if (!button) return false; button.click(); return true; })()",
            true
          ));
          if (futuresViewPrepared) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        snapshot = await mainWindow.webContents.executeJavaScript(
          "window.__stockMonitorStartupAcceptance?.() || ({ok:false,checks:{}})",
          true
        );
        if (snapshot?.ok) break;
      } catch (error) {
        snapshot = { ok: false, checks: {}, error: String(error?.message || error) };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const row = {
      at: new Date().toISOString(),
      ok: Boolean(snapshot?.ok),
      elapsed_ms: Math.round(this.node.performance.now() - startedAt),
      electron_pid: this.node.processRef.pid,
      backend_pid: this._lastBackendPid || null,
      daemon_pid: this._lastDaemonPid || null,
      snapshot,
    };
    try {
      this.node.fs.mkdirSync(this.node.path.dirname(reportPath), { recursive: true });
      this.node.fs.appendFileSync(reportPath, `${JSON.stringify(row)}\n`, "utf8");
    } catch (error) {
      this.logger.error(`[ACCEPTANCE] report write failed: ${error?.message || error}`);
    }
    this.logger.log(`[ACCEPTANCE] ok=${row.ok} elapsed_ms=${row.elapsed_ms}`);
    await this.shutdownController.requestGracefulQuit({
      stopPersistentDaemons: true,
      reason: "automated_acceptance_complete",
    });
  }

  handleBackendStartupFailure() {
    // Populated synchronously by the startPythonBackend() callback below at
    // the moment ensure("backend") failed -- see its comment for why this is
    // cached rather than re-fetched here (a second Controller round trip for
    // the same snapshot would be redundant and racier).
    const rawProbe = this._lastBackendProbe || {};
    const readinessFailure = this._lastBackendReadinessFailure || {};
    const detectedArchitecture = String(rawProbe.architecture || "");
    let staleDetail = "";
    if (rawProbe.reachable && !rawProbe.childAlive) {
      staleDetail = `\n偵測到 ${this.runtime.network.endpoint("realtime_api").port} port 已被其他／殘留 backend 使用${detectedArchitecture ? `：${detectedArchitecture}` : ""}。\n預期：${this.runtime.backend.architecture}\n請先關閉殘留的舊 Python/FastAPI 程序後再重新開啟。`;
    } else if (detectedArchitecture && detectedArchitecture !== this.runtime.backend.architecture) {
      staleDetail = `\n偵測到不相容 backend：${detectedArchitecture}\n預期：${this.runtime.backend.architecture}\n請重新啟動程式。`;
    } else if (readinessFailure.reason === "port_occupied") {
      staleDetail = `\n${readinessFailure.detail || `${this.runtime.network.endpoint("realtime_api").port} port 已被其他 backend 使用`}`;
    } else if (readinessFailure.reason === "stale_reclaim_failed") {
      staleDetail = `\n殘留 FastAPI 清理失敗：${readinessFailure.detail || "unknown"}`;
    } else if (readinessFailure.reason === "spawn_error") {
      staleDetail = `\nFastAPI Python process 無法建立（${readinessFailure.detail || "unknown"}）。\n診斷紀錄：var\\logs\\${this.runtime.logSession}\\`;
    } else if (readinessFailure.reason === "process_exited") {
      staleDetail = `\nFastAPI Python process 在 readiness 前已退出（${readinessFailure.detail || "unknown"}）。\n診斷紀錄：var\\logs\\${this.runtime.logSession}\\`;
    } else if (readinessFailure.reason === "timeout") {
      staleDetail = `\nFastAPI process 仍存活，但在 readiness deadline 內未完成：${readinessFailure.detail || ""}`;
    } else if (readinessFailure.reason === "controller_unreachable") {
      staleDetail = `\n無法聯絡 Service Controller：${readinessFailure.detail || "unknown"}`;
    }
    this.electron.dialog.showErrorBox(
      "Python API 啟動失敗",
      `無法啟動並驗證本次程式所需的 FastAPI backend。${staleDetail}\n請確認 Python、uvicorn、fastapi 都已安裝。`
    );
  }

  registerShellEvents() {
    const refreshUiScaleForDisplayChange = () => {
      setTimeout(() => this.desktopWindows.applyAdaptiveUiScale(true), 100);
    };
    this.electron.screen.on("display-metrics-changed", refreshUiScaleForDisplayChange);
    this.electron.screen.on("display-added", refreshUiScaleForDisplayChange);
    this.electron.screen.on("display-removed", refreshUiScaleForDisplayChange);
    this.electron.app.on("activate", () => {
      if (!this.shutdownController.quitting && this.electron.BrowserWindow.getAllWindows().length === 0) this.createWindow();
    });
    this.electron.app.on("before-quit", (event) => {
      if (this.shutdownController.quitting) return;
      event.preventDefault();
      void this.shutdownController.requestGracefulQuit({ stopPersistentDaemons: true, reason: "explicit_app_quit" });
    });
    this.electron.app.on("window-all-closed", () => {
      // UI-only close intentionally leaves the primary Electron process alive.
    });
    this.node.processRef.on("SIGINT", () => {
      void this.shutdownController.requestGracefulQuit({ stopPersistentDaemons: true, reason: "sigint" });
    });
    this.node.processRef.on("SIGTERM", () => {
      void this.shutdownController.requestGracefulQuit({ stopPersistentDaemons: true, reason: "sigterm" });
    });
    this.node.processRef.on("uncaughtException", (error) => {
      this.logger.error("[UNCAUGHT EXCEPTION]", error);
      void this.shutdownController.requestGracefulQuit({ stopPersistentDaemons: true, reason: "uncaught_exception" });
    });
  }

  // Electron has no service-lifecycle authority of its own any more, so
  // before it can do anything it must confirm the Service Controller is up.
  async ensureControllerAvailable() {
    return Boolean(await this.controllerClient.health(800));
  }

  async start() {
    const controllerReady = await this.ensureControllerAvailable();
    if (!controllerReady) {
      this.electron.dialog.showErrorBox(
        "Service Controller 無法啟動",
        "找不到執行中的 Service Controller。請透過 StockMonitor 捷徑或正式啟動器開啟程式。"
      );
      this.electron.app.quit();
      return { ok: false, backendReady: false };
    }
    this.shutdownController.markStartupCoordinatorStarted();
    this.electron.Menu.setApplicationMenu(null);
    // Menu removal alone is not a complete reload policy: Chromium can still
    // receive reload accelerators directly. Guard every current/future
    // webContents at the app boundary before the first BrowserWindow exists.
    installReloadInputGuard(this.electron.app);
    const previousShutdownHandoff = this.shutdownHandoff.load();
    if (previousShutdownHandoff) {
      this.startupMetrics.markTrace("PREVIOUS_SHUTDOWN_HANDOFF", {
        clean: Boolean(previousShutdownHandoff.clean),
        shutdown_elapsed_ms: previousShutdownHandoff.shutdown_elapsed_ms || null,
        daemon_instance_id: previousShutdownHandoff.daemon_instance_id || null,
      });
    }
    this.registerShellEvents();
    this.tray?.start();
    // The endpoints Health started the services with, before the first window asks for them: nothing is handed out
    // until Health confirms them (a window that loads before that is reloaded once it does).
    await this.apiEndpoints.refreshFromHealth(this.controllerClient, "startup");
    // From here Health announces any shutdown to this UI before it stops the services the windows will use.
    this.shutdownController.followHealth();

    const startupResult = await this.startupCoordinator.run({
      applyStartupTestDelay: this.applyStartupTestDelay,
      createWindow: () => this.createWindow(),
      onRendererReady: () => this.desktopWindows.applyAdaptiveUiScale(true),
      startPythonBackend: async () => {
        // Health already decided to ensure("backend") on its own, before
        // Electron was even attached (health/main.js's own boot sequence) --
        // this only waits for that outcome and reads it back for the UI/
        // diagnostics fields. See this file's header comment.
        const step = await this._waitForHealthStartup("backend", {
          onStorageMove: (move) => this.startupCoordinator.updateStep("fastapi_process", storageMoveText(move)) });
        if (step.status !== "ready" && step.status !== "skipped") {
          this._lastBackendReadinessFailure = {
            reason: step.status === "timeout" ? "timeout" : "ensure_failed",
            detail: step.detail || "backend ensure failed",
          };
          this._lastBackendProbe = {};
          throw new Error(this._lastBackendReadinessFailure.detail);
        }
        this._lastBackendReadinessFailure = { reason: "", detail: "" };
        this._lastBackendPid = step.services?.realtime_api?.pid || this._lastBackendPid || null;
        this._lastBackendProbe = {};
        // The addresses the services were really started with (they can differ from the resolver's view at launch,
        // e.g. while a network operation is being completed after a Health bootstrap restart).
        await this.apiEndpoints.refreshFromHealth(this.controllerClient, "startup");
        return { ok: true, pid: this._lastBackendPid };
      },
      getBackendPid: () => this._lastBackendPid,
      getBackendReadinessFailure: () => ({ ...this._lastBackendReadinessFailure }),
      getBackendProbe: () => ({ ...this._lastBackendProbe }),
      fetchBackendReadiness: () => this.fetchBackendJson("/api/diagnostics/readiness", 500),
      ensureMarketDaemon: async () => {
        const step = await this._waitForHealthStartup("shioaji");
        if (step.status === "failed") throw new Error(step.detail || "shioaji ensure failed");
        this._lastDaemonPid = step.services?.provider_shioaji?.pid || this._lastDaemonPid || null;
        return { ok: step.status !== "failed", health: { daemon_pid: this._lastDaemonPid } };
      },
      fetchBackendHeartbeat: (timeoutMs = 800) => this.fetchBackendJson("/api/diagnostics/heartbeat", timeoutMs),
      ensureMoomooDaemon: async () => {
        const step = await this._waitForHealthStartup("futu");
        if (step.status === "failed") throw new Error(step.detail || "futu ensure failed");
        return { ok: step.status !== "failed" };
      },
      previousShutdownHandoff,
      markStartupTrace: this.startupMetrics.markTrace,
      markStartupMetric: this.startupMetrics.mark,
      // A reload after a provider master refresh: the catalog rebuilds itself when its source masters changed.
      loadProductCatalogIndex: () => this.productOperations.loadProductCatalogIndex(),
      reloadProductCatalogIndex: () => this.productOperations.loadProductCatalogIndex(),
      refreshFutuCatalog: this.productOperations.refreshFutuProductCatalog,
      runAutomatedStartupAcceptance: () => this.runAutomatedStartupAcceptance(),
      electronProcessStartedAt: this.startupMetrics.electronProcessStartedAt,
      onBackendReady: async () => {
        // Recovery-request handling is now entirely owned by
        // health/main.js's own recoveryConsumer,
        // started unconditionally at Controller startup -- Electron no
        // longer creates or gates one on backend readiness.
        const mainWindow = this.desktopWindows.getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("backend-ready");
      },
      onBackendFailed: () => this.handleBackendStartupFailure(),
    });
    return startupResult;
  }

  // The whole startup, for main.js to await inside fatal_startup.js: a failure here ends the process there (logged,
  // shown once, singleton released), never a dialog over a process left holding the lock without a window.
  bind() {
    return this.electron.app.whenReady().then(() => this.start());
  }
}

module.exports = { AppLifecycleController };
