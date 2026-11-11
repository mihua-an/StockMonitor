"use strict";

const { spawn } = require("child_process");
const pathModule = require("path");
const { resolveVarPaths } = require("../../config/js/var_paths.js");
const { createQuitWatchdog } = require("./windows_quit_watchdog.js");

// A forced quit leaves a marker the next start collects into the remediation ledger: the process
// doing the forcing cannot record it itself -- it is the one going away.
function forcedQuitMarkerDir(env = process.env) {
  return require("path").join(resolveVarPaths({ env }).state, "ui", "forced_quit");
}

// Remediation events Electron main could not hand to Health before it quit; the next UI forwards them
// (desktop_application.js collectPendingRemediation) and Health drops any it already has.
function pendingRemediationDir(env = process.env) {
  return require("path").join(resolveVarPaths({ env }).state, "ui", "pending_remediation");
}

// A collected file that could not be fully read or forwarded is kept, renamed out of the collected set (never deleted:
// it is the only copy of what failed), so it is neither lost nor read again at every start.
function setAsideFailedFile(file, reason) {
  const fs = require("fs");
  const kept = `${file}.failed-${Date.now()}`;
  try {
    fs.renameSync(file, kept);
    console.warn(`[SHUTDOWN ${reason}] failed; the file is kept as ${kept}`);
  } catch (error) {
    console.warn(`[SHUTDOWN ${reason}] failed, and setting ${file} aside failed too`, error);
  }
}

// At startup: forwarded as they were (their own event ids and process identity), then each file is removed.
function collectPendingRemediation(remediation, logger = console, env = process.env) {
  const fs = require("fs");
  const path = require("path");
  const dir = pendingRemediationDir(env);
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")); } catch (error) { /* absent is not an error: nothing was left pending */ if (error?.code !== "ENOENT") console.warn("[SHUTDOWN read pending remediation] failed", error); return; }
  for (const name of names) {
    const file = path.join(dir, name);
    let forwarded = 0;
    let failed = 0;
    try {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { remediation.forward(JSON.parse(line)); forwarded += 1; } catch (error) { failed += 1; console.warn(`[SHUTDOWN pending remediation line in ${name}] failed`, error); }
      }
      logger.warn?.(`[Shutdown] forwarded ${forwarded} remediation event(s) the previous UI left pending (${name}); ${failed} failed`);
    } catch (error) { console.warn("[SHUTDOWN read pending remediation file] failed", error); continue; }
    if (failed) { setAsideFailedFile(file, `forwarding ${failed} pending remediation line(s) of ${name}`); continue; }
    try { fs.unlinkSync(file); } catch (error) { console.warn("[SHUTDOWN remove pending remediation file] failed", error); }
  }
}

// This class holds no service supervisor, backend controller or daemon host and
// does not orchestrate their staged shutdown -- that whole
// sequence (health-observer handoff, staged stop with backend retry,
// observer stop, shutdown-handoff persistence) now lives in
// health/main.js's performShutdown(), reached only
// through ui/main/controller_client.js. What remains here is
// genuinely Electron's own: window-visible shutdown UI, the renderer
// teardown, the single-instance lock, and Electron's own quit/watchdog
// escalation (each guards a real live failure of Electron's own quit()
// behavior on Windows -- see the comments below).
const QUIT_WATCHDOG_MS = 5000;
const HARD_EXIT_WATCHDOG_MS = 3000;
const EXTERNAL_QUIT_WATCHDOG_MS = 10000;
// How long a closing window has to say its live transports stopped. A window that cannot answer in this time is
// hung; the shutdown goes on without it rather than wait on a page that may never answer.
const RENDERER_STOP_ANSWER_MS = 2000;

// A stream error with its cause (a socket error's code says which end closed: ECONNRESET, ECONNREFUSED, ...).
function describeStreamError(error) {
  const cause = error?.cause;
  const code = error?.code || cause?.code;
  const causeText = cause ? ` (${cause.code || cause.name || "cause"}: ${cause.message || cause})` : code ? ` (${code})` : "";
  return `${error?.message || error}${causeText}`.slice(0, 300);
}

class ShutdownController {
  constructor({
    electron,
    node,
    controllerClient,
    startupCoordinator,
    rendererHealth,
    remediationClient = null,
    appSingleInstance,
    desktopWindows,
    healthBootstrap = null,
    logger = console,
    quitWatchdogMs = QUIT_WATCHDOG_MS,
    hardExitWatchdogMs = HARD_EXIT_WATCHDOG_MS,
    externalQuitWatchdogMs = EXTERNAL_QUIT_WATCHDOG_MS,
    rendererStopAnswerMs = RENDERER_STOP_ANSWER_MS,
    spawnImpl = spawn,
    quitWatchdog = null,
    // The log-session file each shutdown stage is appended to (null: console only).
    timelinePath = null,
  }) {
    this.timelinePath = timelinePath;
    this.quitStartedAt = null;
    this.electron = electron;
    this.node = node;
    this.controllerClient = controllerClient;
    this.startupCoordinator = startupCoordinator;
    this.rendererHealth = rendererHealth;
    this.remediationClient = remediationClient;
    // The follow again of Health's UI event stream under way after a break ({record}: its remediation operation).
    this.healthRefollow = null;
    this.appSingleInstance = appSingleInstance;
    this.desktopWindows = desktopWindows;
    this.healthBootstrap = healthBootstrap;
    this.logger = logger;
    this.quitWatchdogMs = quitWatchdogMs;
    this.hardExitWatchdogMs = hardExitWatchdogMs;
    this.externalQuitWatchdogMs = externalQuitWatchdogMs;
    this.rendererStopAnswerMs = rendererStopAnswerMs;
    // The windows told the App is closing that have not yet said their live transports stopped: webContents id ->
    // resolve.
    this.closingWindows = new Map();
    this.quitWatchdog = quitWatchdog || createQuitWatchdog({ platform: node?.processRef?.platform, spawn: spawnImpl,
      fs: node?.fs, path: node?.path || pathModule, logger });
    this.quitting = false;
    // Whether the shutdown under way stops the market services too (it can widen while it runs).
    this.fullRequested = false;
    this.quitDone = null;
    // The stages that stop this UI before the services its windows use stop (stopUiBeforeBackend), once started.
    this.uiStopped = null;
    // The shutdown was asked of Health by someone else (healthClosing / quitAfterHealthEnded), not by this UI.
    this.healthInitiated = false;
    this.healthEnded = false;
    this.stopFollowingHealth = null;
    this.relaunchRequested = false;
    this.startupCoordinatorStarted = false;
  }

  // One line per shutdown stage, appended at once (the process may end right after it): wall-clock time and the ms
  // since the quit was asked for. Electron main logged only to its console window, so a close taking ~10 s from the
  // user's 完全關閉 to the launcher window closing could not be attributed to any stage.
  trace(stage, detail = null) {
    const now = this.node.performance.now();
    if (this.quitStartedAt === null) this.quitStartedAt = now;
    const line = `[Shutdown timeline] +${Math.round(now - this.quitStartedAt)} ms ${stage}${detail ? ` ${JSON.stringify(detail)}` : ""}`;
    this.logger.log?.(line);
    if (!this.timelinePath) return;
    try { this.node.fs.appendFileSync(this.timelinePath, `${new Date().toISOString()} ${line}\n`); }
    catch (error) { console.warn("[SHUTDOWN writing the shutdown timeline] failed", error); }
  }

  // The stages after app.quit(): Electron's own quit events and the process's end.
  traceQuitEvents() {
    for (const name of ["before-quit", "will-quit", "quit"]) this.electron.app.once?.(name, () => this.trace(`app:${name}`));
    this.node.processRef.once?.("exit", (code) => this.trace("process_exit", { code }));
  }

  requestRelaunchAfterShutdown() {
    if (!this.quitting) return false;
    this.relaunchRequested = true;
    return true;
  }

  markStartupCoordinatorStarted() {
    this.startupCoordinatorStarted = true;
  }

  writeForcedQuitMarker(kind, graceMs) {
    try {
      const dir = forcedQuitMarkerDir(this.node.processRef.env);
      this.node.fs.mkdirSync(dir, { recursive: true });
      const pid = Number(this.node.processRef.pid);
      this.node.fs.writeFileSync(this.node.path.join(dir, `${kind}-${pid}.json`), JSON.stringify({
        schema: "stock-monitor-forced-quit-v1", kind, pid, grace_ms: graceMs, at: new Date().toISOString() }));
    } catch (error) { console.warn("[SHUTDOWN write forced-quit marker] failed", error); }
  }

  // What the UI's own log and telemetry sinks lost or failed to write, at their close: one recorded
  // sink.observability_loss per sink that did, before the ledger is flushed -- never awaited and dropped.
  // A sink that lost records, is not OK, or failed to rotate its file counts -- each is a write that did not happen.
  recordSinkLoss(sinks) {
    for (const [name, health] of Object.entries(sinks || {})) {
      const rotationFailures = Number(health?.rotation?.failures) || 0;
      if (!health || (!(health.lost_records > 0) && health.state === "OK" && !rotationFailures)) continue;
      this.logger.error?.(`[Shutdown] ${name} sink lost ${health.lost_records || 0} record(s), ${rotationFailures} rotation failure(s) `
        + `(${health.state}${health.last_error ? `: ${health.last_error.message}` : ""})`);
      try {
        // Scalars only: the event detail keeps no nested objects.
        this.remediationClient?.emit({ component: "ui_sinks", mechanismId: "sink.observability_loss", triggerReason: "records_lost",
          outcome: "failed", identity: {}, detail: { sink: name, state: health.state ?? null, lost_records: health.lost_records ?? 0,
            write_failures: health.write_failures ?? 0, unstated_loss: health.unstated_loss ?? 0,
            last_error: health.last_error?.message ?? null, last_error_code: health.last_error?.code ?? null,
            rotation_failures: rotationFailures, rotation_last_error: health.rotation?.last_error?.message ?? null } });
      } catch (error) { console.warn("[recording a UI sink loss] failed", error); }
    }
  }

  // Right before this process quits: whatever Health has not acknowledged (it already exited, or did not answer in
  // time) is written to a pending file for the next UI to forward, and the client stops sending -- never left in a
  // queue that ends with the process.
  async spoolUndeliveredRemediation(waitMs) {
    const client = this.remediationClient;
    if (!client?.undelivered) return 0;
    if (waitMs > 0) await client.flush(waitMs);
    const events = client.undelivered();
    client.close?.();
    if (!events.length) return 0;
    try {
      const dir = pendingRemediationDir(this.node.processRef.env);
      this.node.fs.mkdirSync(dir, { recursive: true });
      const file = this.node.path.join(dir, `pending-${Number(this.node.processRef.pid)}-${Date.now()}.jsonl`);
      this.node.fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
      this.logger.warn?.(`[Shutdown] ${events.length} remediation event(s) not acknowledged by Health; kept for the next start in ${file}`);
    } catch (error) {
      this.logger.error?.(`[Shutdown] ${events.length} remediation event(s) not acknowledged by Health could not be kept: ${error?.message || error}`);
    }
    return events.length;
  }

  // Arms windows_quit_watchdog.js for this process: what it watches (the main process, each Chromium helper, the
  // launcher) is Electron's to say; the script, the PID re-check and the marker are the adapter's.
  spawnExternalQuitWatchdog() {
    const pid = Number(this.node.processRef.pid);
    let watched = [];
    try {
      watched = (this.electron.app.getAppMetrics?.() || []).map((m) => ({ pid: Number(m.pid), type: String(m.type || "unknown") }));
    } catch (error) { this.logger.warn(`[Shutdown] reading the UI's processes failed: ${error?.message || error}`); }
    if (!watched.some((w) => w.pid === pid)) watched.unshift({ pid, type: "Browser" });
    const parent = Number(this.node.processRef.ppid || 0);
    if (parent > 0) watched.push({ pid: parent, type: "launcher" });
    const markerDir = forcedQuitMarkerDir(this.node.processRef.env);
    return this.quitWatchdog.arm({
      pid, execPath: String(this.node.processRef.execPath || ""), watched, timelinePath: this.timelinePath,
      tempDir: String(this.node.processRef.env?.TEMP || this.node.processRef.env?.TMP || "").trim(),
      graceMs: this.externalQuitWatchdogMs, markerDir, markerPath: pathModule.join(markerDir, `external-${pid}.json`),
    });
  }

  // Before the backend is asked to stop: every window stops its live transports and says so (app:closing-done), so
  // a connection the close itself ends is not taken for a failure. Only telling them was not enough: Health stopped
  // app_api ~100 ms later and a window busy at that moment read the EOF before the message, recording a
  // renderer.sse_reconnect / live_ws_reconnect for its own App's close.
  async notifyRenderersClosing(scope) {
    const answers = [];
    let notified = 0;
    for (const win of this.electron.BrowserWindow.getAllWindows()) {
      if (!win || win.isDestroyed()) continue;
      const id = win.webContents.id;
      try {
        answers.push(new Promise((resolve) => this.closingWindows.set(id, resolve)));
        win.webContents.send("app:closing", { scope });
        notified += 1;
      } catch (error) {
        this.closingWindows.get(id)?.(false);
        this.logger.warn(`[Shutdown] telling a window the App is closing failed: ${error?.message || error}`);
      }
    }
    let timer = null;
    const deadline = new Promise((resolve) => { timer = setTimeout(resolve, this.rendererStopAnswerMs); });
    await Promise.race([Promise.all(answers), deadline]);
    clearTimeout(timer);
    const unanswered = this.closingWindows.size;
    if (unanswered) {
      this.logger.warn(`[Shutdown] ${unanswered} window(s) did not say their live transports stopped within ${this.rendererStopAnswerMs} ms; the shutdown goes on`);
    }
    for (const resolve of this.closingWindows.values()) resolve(false);
    this.closingWindows.clear();
    return { notified, unanswered };
  }

  // A window's answer to app:closing: its live transports are stopped.
  rendererStopped(event) {
    const id = event?.sender?.id;
    const resolve = this.closingWindows.get(id);
    if (!resolve) return;
    this.closingWindows.delete(id);
    resolve(true);
  }

  async disconnectRendererWindows() {
    const startedAt = this.node.performance.now();
    const mainWindow = this.desktopWindows.getMainWindow();
    const windows = this.electron.BrowserWindow.getAllWindows().filter((win) => win && !win.isDestroyed());
    for (const win of windows) {
      try {
        if (win === mainWindow) this.desktopWindows.saveWindowState();
        win.destroy();
      } catch (error) {
        this.logger.warn(`[Shutdown] renderer disconnect failed: ${error?.message || error}`);
      }
    }
    this.desktopWindows.setMainWindow(null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      windows_closed: windows.length,
      elapsed_ms: Math.round(this.node.performance.now() - startedAt),
    };
  }

  // Health's announcements (health/ui_closing_channel.js), followed from Health's first answer until it ends, and
  // again for a restarted Health (desktop_application.js). A full shutdown announced and then the stream's end is
  // Health ending the App -- whether this UI spawned that Health or attached to it.
  //
  // A stream that breaks while Health runs leaves this UI deaf to every later announcement (a tool's or Windows'
  // shutdown would stop the services under live windows), so it is followed again at once: one
  // ui.health_events_refollow operation from the break until Health accepts the stream again (succeeded). A follow
  // again that Health does not accept means Health is not answering: the operation fails and the bootstrap follows the
  // Health it restarts. Health ending the stream itself is Health exiting (a network handoff restart), not a break.
  followHealth() {
    this.stopFollowingHealth?.();
    let announcedFull = false;
    this.stopFollowingHealth = this.controllerClient.followUiEvents({
      onOpened: () => this.finishHealthRefollow("succeeded", {}),
      onClosing: async (announcement) => {
        if (announcement?.scope === "full") announcedFull = true;
        await this.healthClosing(announcement);
        try {
          if (!(await this.controllerClient.acknowledgeUiClosing(announcement?.id))) {
            this.logger.warn(`[Shutdown] Health did not take the answer to its ${announcement?.scope} announcement (it stopped waiting)`);
          }
        } catch (error) {
          this.logger.warn(`[Shutdown] answering Health's ${announcement?.scope} announcement failed: ${error?.message || error}`);
        }
      },
      onEnded: (error, { opened }) => {
        if (announcedFull) { void this.quitAfterHealthEnded(); return; }
        // not an error when quitting: this UI's own close ends Health's stream
        if (this.quitting) { this.finishHealthRefollow("abandoned", { reason: "the App closed first" }); return; }
        if (!error) {
          // not an error: Health ended the stream because it is exiting unannounced, which only a network handoff
          // restart does; the bootstrap follows the restarted Health
          this.logger.info?.("[Shutdown] Health ended its UI event stream without a shutdown announcement (restarting); following resumes once it is back");
          this.finishHealthRefollow("abandoned", { reason: "Health is restarting" });
          return;
        }
        const reason = describeStreamError(error);
        if (this.healthRefollow) {
          this.logger.warn(`[Shutdown] following Health's UI events again failed: ${reason}; following resumes when the bootstrap restarts Health`);
          this.finishHealthRefollow("failed", { error: reason });
          return;
        }
        this.logger.warn(`[Shutdown] Health's UI event stream ${opened ? "broke" : "did not open"}: ${reason}; following it again`);
        // One follow again per break: set even when the record could not be started, so a Health that refuses never
        // turns into a loop.
        this.healthRefollow = { record: null };
        try {
          this.healthRefollow.record = this.remediationClient?.begin({ component: "shutdown_controller", mechanismId: "ui.health_events_refollow",
            triggerReason: opened ? "stream_broken" : "stream_not_opened", identity: {}, detail: { error: reason } }) || null;
        } catch (recordError) {
          this.logger.warn(`[Shutdown] remediation record failed: ${recordError?.message || recordError}`);
        }
        this.followHealth();
      },
    });
  }

  finishHealthRefollow(outcome, detail) {
    const recovery = this.healthRefollow;
    if (!recovery) return;
    this.healthRefollow = null;
    try { recovery.record?.finish(outcome, { attempt: 1, detail }); } catch (error) { this.logger.warn(`[Shutdown] remediation record failed: ${error?.message || error}`); }
  }

  // Health is about to stop the services this UI's windows use. A close this UI started stopped them before it asked
  // Health; one asked of Health by anyone else (a tool, a signal, Windows' session end) stops them now, in the same
  // order as the tray's close, and Health is answered only then (followHealth).
  async healthClosing({ scope } = {}) {
    if (!this.quitting) {
      this.quitting = true;
      this.healthInitiated = true;
      this.fullRequested = scope === "full";
      const shutdownScope = this.fullRequested ? "full" : "ui_backend";
      this.trace("requested", { reason: "health_shutdown", scope: shutdownScope });
      this.uiStopped = this.stopUiBeforeBackend(shutdownScope);
      // Health ends a full shutdown by exiting, and its stream's end quits the App; a UI-only one leaves Health
      // running with nothing for the UI to use, so the UI quits once its windows stopped.
      if (!this.fullRequested) {
        this.quitDone = this.uiStopped.then(() => this.closeAndQuit({ reason: "health_shutdown", scope: shutdownScope,
          spoolWaitMs: 500, controller: null }));
      }
    }
    await this.uiStopped;
  }

  // Health completed a full shutdown and ended. Announced, its windows already stopped (healthClosing); unannounced
  // -- Health ended before this UI followed it -- they are told now. Nothing is left to ask Health.
  async quitAfterHealthEnded() {
    // not an error: this UI's own close ends the App itself
    if (this.quitting && !this.healthInitiated) return;
    if (this.healthEnded) return;
    this.healthEnded = true;
    if (!this.quitting) {
      this.quitting = true;
      this.healthInitiated = true;
      this.fullRequested = true;
      this.trace("requested", { reason: "health_full_shutdown", announced: false });
      this.uiStopped = this.stopUiBeforeBackend("full", { healthAnswering: false });
    }
    try {
      await this.runStage("ui_stopped", () => this.uiStopped);
    } finally {
      // Health has exited: nothing more can be acknowledged.
      this.quitDone = this.closeAndQuit({ reason: "health_full_shutdown", scope: "full", spoolWaitMs: 0, controller: null });
      await this.quitDone;
    }
  }

  // What the UI stops before the services its windows use stop -- the same stages whoever asked for the shutdown:
  // startup ended, the shutdown shown, every window's live transports stopped, the renderer sinks closed and this
  // process's remediation flushed (a full shutdown ends the ledger's writer). `healthAnswering`: false once Health
  // has already exited (nothing can be flushed to it).
  async stopUiBeforeBackend(shutdownScope, { healthAnswering = true } = {}) {
    const full = shutdownScope === "full";
    // Electron's own process (and the health_bootstrap watchdog living in it) is going away regardless of scope:
    // Health's own expected self-exit (full scope) is not a crash needing a restart it could never deliver on.
    await this.runStage("mark_health_bootstrap", () => this.healthBootstrap?.markShuttingDown());
    await this.runStage("startup_progress", () => {
      if (this.startupCoordinatorStarted) {
        this.startupCoordinator.markProgress(
          "SHUTTING_DOWN", null,
          full ? "full shutdown" : "UI + FastAPI shutdown; market daemons, Rust A/B and model signals retained"
        );
      }
      this.startupCoordinator.stop();
    });
    await this.runStage("shutdown_state_shown", () => this.desktopWindows.showShutdownState?.(
      full
        ? "正在請求 Service Controller 保存資料並停止 Shioaji／Futu 行情服務。"
        : "正在請求 Service Controller 停止介面與 FastAPI；行情服務與模型訊號會保留。"
    ));
    const told = await this.runStage("renderers_told", () => this.notifyRenderersClosing(shutdownScope), { notified: 0, unanswered: 0 });
    this.trace("renderers_told", { windows: told.notified, unanswered: told.unanswered });
    await this.runStage("renderer_health_closed", async () => this.recordSinkLoss(await this.rendererHealth.close()));
    this.trace("renderer_health_closed");
    if (!healthAnswering) return;
    await this.runStage("remediation_flushed", () => this.remediationClient?.flush(1500));
    this.trace("remediation_flushed");
  }

  // One shutdown stage: its failure is recorded (log and timeline) and the shutdown goes on with the next one, so no
  // rejection leaves the App "closing" with its windows' close refused and app.quit() never called.
  async runStage(stage, task, fallback = null) {
    try {
      return await task();
    } catch (error) {
      this.logger.error?.(`[Shutdown] stage ${stage} failed; the shutdown continues: ${error?.stack || error?.message || error}`);
      this.trace("stage_failed", { stage, error: String(error?.message || error) });
      return fallback;
    }
  }

  // A close already under way still takes a wider one: 完整關閉 clicked in the tray while 關閉介面與 FastAPI runs
  // makes this shutdown a full one (Health is asked for "full" before the App quits), never a dropped click that
  // leaves the market services running.
  async requestGracefulQuit({ stopPersistentDaemons = false, reason = "explicit_quit" } = {}) {
    if (this.quitting) {
      if (stopPersistentDaemons && !this.fullRequested) {
        this.fullRequested = true;
        this.trace("widened_to_full", { reason });
        await this.runStage("shutdown_state_shown", () => this.desktopWindows.showShutdownState?.(
          "正在請求 Service Controller 保存資料並停止 Shioaji／Futu 行情服務。"));
      } else {
        // not an error: the shutdown under way already covers this request
        this.trace("repeat_request", { reason, scope: stopPersistentDaemons ? "full" : "ui_backend" });
      }
      return this.quitDone;
    }
    this.quitting = true;
    this.fullRequested = stopPersistentDaemons;
    this.quitDone = this.runGracefulQuit(reason);
    return this.quitDone;
  }

  async runGracefulQuit(reason) {
    const shutdownScope = this.fullRequested ? "full" : "ui_backend";
    this.trace("requested", { reason, scope: shutdownScope });
    let controller = null;
    let asked = null;
    try {
      // Before Health is asked: Health announces the shutdown to this UI before it stops anything (followHealth), and
      // that announcement is answered once these stages are done.
      this.uiStopped = this.stopUiBeforeBackend(shutdownScope);
      await this.uiStopped;
      asked = this.fullRequested ? "full" : "ui_backend";
      controller = await this.askController(asked, reason);
    } finally {
      // A UI-only close leaves Health running and still answering; after a full one it has exited. closeAndQuit asks
      // Health for "full" itself when 完整關閉 arrived after the UI-only request went out.
      await this.closeAndQuit({ reason, scope: asked ?? shutdownScope, spoolWaitMs: asked === "full" ? 0 : 500, controller });
    }
  }

  // "UI closing must not affect background services": Electron has nothing left to shut those services down with.
  // The Controller is asked and the UI quits regardless of the result, so an unreachable Controller degrades to "the
  // UI closes but nothing was told to stop", surfaced to the user instead of silently retried.
  async askController(shutdownScope, reason) {
    let unreachable = false;
    let stillStopping = false;
    let result;
    try {
      result = await this.controllerClient.shutdown(shutdownScope, 60000);
      if (!result) throw new Error("empty response");
    } catch (error) {
      result = { ok: false, error: String(error?.message || error) };
      if (error?.name === "AbortError") {
        // Health's full shutdown is bounded well past 60 s (the Shioaji daemon alone may take 180 s) and keeps
        // going after this request gives up. That is not "unreachable": the UI leaves, Health finishes, and a
        // relaunch meanwhile waits for it (health_bootstrap), so no unreachable error box is raised.
        stillStopping = true;
        this.logger.warn(`[Shutdown] Service Controller still stopping after 60 s, reason=${reason}; it continues in the background`);
      } else {
        unreachable = true;
        this.logger.error(`[Shutdown] Service Controller unreachable, reason=${reason}: ${result.error}`);
      }
    }
    this.trace("controller_answered", { ok: result.ok === true, health_duration_ms: result.duration_ms ?? null,
      unreachable, still_stopping: stillStopping });
    if (!result.ok) {
      this.logger.warn(`[Shutdown] controller shutdown reported problems: ${JSON.stringify(result.warnings || result.error || "unknown")}`);
    }
    return { ok: result.ok === true, unreachable, stillStopping };
  }

  // The end every shutdown reaches, whatever failed before it: windows destroyed, the singleton lock released,
  // undelivered remediation spooled, the external watchdog armed, app.quit() called with its own watchdog set. Each
  // step is its own stage; none keeps the next from running. `controller`: what Health answered (null when it was not
  // asked, or asking it failed).
  async closeAndQuit({ reason, scope, spoolWaitMs, controller }) {
    const renderer = await this.runStage("windows_destroyed", () => this.disconnectRendererWindows(), { windows_closed: 0 });
    this.trace("windows_destroyed", { windows: renderer.windows_closed });
    const lockReleased = await this.runStage("instance_lock_released", () => this.appSingleInstance.releasePrimary(), false);
    this.logger.log(
      `[Shutdown] reason=${reason} scope=${scope} controller_ok=${controller ? controller.ok : "not_asked"} `
      + `controller_unreachable=${Boolean(controller?.unreachable)} controller_still_stopping=${Boolean(controller?.stillStopping)} `
      + `renderer_windows_closed=${renderer.windows_closed} `
      + `ui_instance_lock_released=${lockReleased}`
    );
    if (controller?.unreachable) {
      await this.runStage("unreachable_dialog", () => this.electron.dialog.showErrorBox(
        "無法聯絡 Service Controller",
        "介面即將關閉，但無法確認 Backend／行情服務是否已收到關閉請求。請檢查 Service Controller 是否仍在執行。"
      ));
    }
    await this.runStage("remediation_spooled", () => this.spoolUndeliveredRemediation(spoolWaitMs));
    this.trace("remediation_spooled");
    // 完整關閉 that arrived after Health was asked for the UI-only scope: the last point the App can still ask it.
    if (this.fullRequested && scope !== "full") {
      const widened = await this.askController("full", reason);
      this.logger.log(`[Shutdown] widened to full: controller_ok=${widened.ok} controller_unreachable=${widened.unreachable}`);
      if (widened.unreachable) {
        await this.runStage("unreachable_dialog", () => this.electron.dialog.showErrorBox(
          "無法聯絡 Service Controller",
          "介面即將關閉，但無法確認行情服務是否已收到完整關閉請求。請檢查 Service Controller 是否仍在執行。"
        ));
      }
    }
    await this.runStage("external_watchdog", () => this.spawnExternalQuitWatchdog());
    await this.runStage("quit_event_trace", () => this.traceQuitEvents());
    this.trace("app_quit");
    await this.runStage("relaunch", () => {
      if (this.relaunchRequested && typeof this.electron.app.relaunch === "function") this.electron.app.relaunch();
    });
    const watchdog = setTimeout(() => {
      this.logger.error(
        `[Shutdown] app.quit() did not terminate the process within ${this.quitWatchdogMs}ms; forcing app.exit(0)`
      );
      this.writeForcedQuitMarker("app_exit_watchdog", this.quitWatchdogMs);
      this.electron.app.exit(0);
      const hardExit = setTimeout(() => {
        this.logger.error(
          `[Shutdown] app.exit(0) also did not terminate the process within ${this.hardExitWatchdogMs}ms; `
          + "forcing process.exit(0)"
        );
        this.node.processRef.exit(0);
      }, this.hardExitWatchdogMs);
      hardExit.unref?.();
    }, this.quitWatchdogMs);
    watchdog.unref?.();
    this.electron.app.once("quit", () => clearTimeout(watchdog));
    this.electron.app.quit();
  }
}

module.exports = { ShutdownController, forcedQuitMarkerDir, pendingRemediationDir, collectPendingRemediation, setAsideFailedFile };
