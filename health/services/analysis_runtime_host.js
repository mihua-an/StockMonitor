"use strict";

// Host for analysis_runtime (Rust B) -- docs/system-architecture/00 section 3, 02 section 1, 04 section 5.
//
// Rust B has no listening port. Health is its parent: it spawns it with the market_runtime address, the
// analysis_runtime role token file, its data dir, the config root (flow/event rules) and the inference dir, and
// talks to it over stdio: JSON lines out (hello, metrics every 2 s, stopped), commands in (shutdown, reload). B exits
// on stdin EOF, so it can never outlive the Health that manages it. B is the model-signal authority itself:
// it reads the inference config model_api writes into <data dir>/inference and publishes its signals
// to market_runtime, so stopping the FastAPI processes never stops model signals.

const { TRIGGERS, killChildAndRecord, waitChildExit } = require("../../service/platform/js/forced_termination");
const { createLogSink } = require("./log_sink");
const { dataChild } = require("../../config/js/system_contract.js");
const { spawnedStorageUser } = require("../startup/storage_users");
const { spawn } = require("child_process");
const { childEnv } = require("../../service/platform/js/child_env");
const readline = require("readline");

const START_TIMEOUT_MS = 20000;
// After hello, until B says `ready`: it connected to Market Runtime (already READY: B requires it) and A confirmed its
// durable subscription. A B that never gets there is a failed start, not a READY service that receives nothing.
const READY_TIMEOUT_MS = 30000;
// B prints metrics every 2 s from its own thread, even during a long catch-up. None for this long after hello means
// the process is wedged: it is then not serviceable, and ensure() replaces it.
//
// The probe reports the process and the metrics channel separately (`process_alive`, `metrics_fresh`, `wedged`).
// A replacement is fenced: the exact old child must be confirmed exited -- its own exit event -- before a new
// one is spawned; not confirmed, nothing is spawned and the start fails. Each replacement is an
// `analysis.wedged_replacement` remediation with the old instance, how long it was silent and the result.
const WEDGED_AFTER_MS = 60000;
const STOP_TIMEOUT_MS = 15000;

class AnalysisRuntimeHost {
  // The child output log's own health: lost chunks, write failures, last error; null before a start.
  logSinkHealth() { return this.logSink ? this.logSink.health() : null; }

  // eventsDir: B's rule-event archive under the active storage location (config/js/storage_settings.js storagePaths);
  // it and dailySummaryDir may be functions, resolved at each start, because Health can switch the location after this
  // host is built.
  // dailySummaryDir (same location) and securityMaster: what the model features' day context reads
  // (native/analysis_runtime/src/day_context.rs), the same files the training export is given.
  // historicalDir: the raw-history store B manages (設定 → 資料儲存, read when B starts).
  constructor({ isPackaged = false, resourcesPath, fs, path, projectRoot, dataRoot, eventsDir, dailySummaryDir = null, securityMaster = null,
    historicalDir = null, configRoot, logDir, effective,
    tokenFile, logger = console, spawnImpl = spawn, publishIntervalMs = 250, env = () => childEnv(process.env), remediation = null,
    readyTimeoutMs = READY_TIMEOUT_MS }) {
    if (!eventsDir) throw new Error("AnalysisRuntimeHost needs eventsDir (the storage location's analysis_events)");
    Object.assign(this, { isPackaged, resourcesPath, fs, path, projectRoot, dataRoot, eventsDir, dailySummaryDir, securityMaster, configRoot, logDir, effective,
      tokenFile, logger, publishIntervalMs, remediation, readyTimeoutMs });
    this.historicalDir = typeof historicalDir === "function" ? historicalDir : () => historicalDir || path.join(dataRoot, "historical");
    this.spawn = spawnImpl;
    this.env = env;
    this.child = null;
    this.hello = null;
    this.latestMetrics = null;
    this.metricsAt = null;
    this.helloAt = null;
    this.lastExit = null;
    this.stoppedReport = null;
  }

  binaryPath() {
    return this.isPackaged
      ? this.path.join(this.resourcesPath, "native", "analysis_runtime.exe")
      : this.path.join(this.projectRoot, "native", "analysis_runtime", "target", "release", "analysis_runtime.exe");
  }

  runtimeUrl() {
    const entry = this.effective.services.market_runtime;
    return `ws://${entry.host}:${entry.port}/live`;
  }

  running() { return Boolean(this.child && this.child.exitCode === null && this.child.signalCode === null); }

  wedged(now = Date.now()) {
    if (!this.running() || !this.hello || this.helloAt === null) return false;
    const lastSign = Math.max(this.helloAt, this.metricsAt || 0);
    return now - lastSign > WEDGED_AFTER_MS;
  }

  async supervisorProbe() {
    const wedged = this.wedged();
    const alive = this.running() && Boolean(this.hello) && !wedged;
    const fresh = this.metricsAt !== null && Date.now() - this.metricsAt < 10000;
    // B incompatible with this Market Runtime (a projection item refused for a contract reason): alive and our
    // own, but not serviceable -- DEGRADED with B's reason, never RUNNING over a partial projection.
    const incompatible = this.latestMetrics?.incompatible || null;
    return {
      // verified = it is our own B (identity); a wedged one stays verified so the supervisor replaces it rather than
      // treating it as an unknown occupant it must not touch.
      service_id: "analysis_runtime", alive, occupied: this.running(), verified: this.running() && Boolean(this.hello) && !incompatible,
      identity_verified: this.running() && Boolean(this.hello),
      payload: incompatible ? { runtime_state: `INCOMPATIBLE: ${incompatible}` } : undefined,
      instance_id: this.hello?.instance_id || null, pid: this.child?.pid || null, owned: this.running(),
      listener: false, process_alive: this.running(), metrics_fresh: fresh, wedged,
      reason: wedged ? `no metrics for ${Math.round((Date.now() - Math.max(this.helloAt, this.metricsAt || 0)) / 1000)} s` : null,
      stream: this.latestMetrics?.stream || null, last_exit: this.lastExit,
    };
  }

  // Replace a wedged B: end the exact child, confirm it exited, and only then may a new one start.
  async replaceWedged() {
    const old = this.child;
    const silentMs = Date.now() - Math.max(this.helloAt, this.metricsAt || 0);
    const operation = this.remediation?.begin({ component: "analysis_runtime_host", mechanismId: "analysis.wedged_replacement",
      triggerReason: "metrics_silent", identity: {}, detail: { old_instance: this.hello?.instance_id || null, old_pid: old?.pid ?? null, silent_ms: silentMs } });
    this.logger.error(`[HEALTH] analysis_runtime stopped reporting metrics for ${Math.round(silentMs / 1000)} s; replacing pid ${old?.pid}`);
    const exited = waitChildExit(old, STOP_TIMEOUT_MS);
    try { old.kill(); } catch (error) { console.warn("[stopping the old analysis_runtime] failed", error); }
    if (!(await exited)) {
      operation?.finish("failed", { detail: { old_pid: old.pid, result: "old instance not confirmed exited; nothing spawned" } });
      throw new Error(`analysis_runtime pid ${old.pid} did not exit after it was ended; no replacement is started next to it`);
    }
    if (this.child === old) this.child = null;
    return operation;
  }

  async ensure() {
    // A child that was ended but never proven gone holds the same data root: no replacement starts beside it.
    if (this.unexited) {
      if (this.unexited.exitCode !== null || this.unexited.signalCode) this.unexited = null;
      else throw new Error(`analysis_runtime pid ${this.unexited.pid} was ended but has not exited; no replacement is started beside it`);
    }
    const replacement = this.wedged() ? await this.replaceWedged() : null;
    if (this.running() && this.ready) return { ok: true, pid: this.child.pid, instance_id: this.hello.instance_id };
    // A child that is still running but never said ready is not replaced by a second one beside it.
    if (this.running()) throw new Error(`analysis_runtime pid ${this.child.pid} is running without a ready; not starting another`);
    try {
      const started = await this.spawnAndWait();
      replacement?.finish("succeeded", { detail: { new_instance: started.instance_id, new_pid: started.pid } });
      return started;
    } catch (error) {
      replacement?.finish("failed", { detail: { result: String(error?.message || error) } });
      throw error;
    }
  }

  async spawnAndWait() {
    const binary = this.binaryPath();
    if (!this.fs.existsSync(binary)) throw new Error(`analysis_runtime binary missing: ${binary}`);
    const dataDir = this.path.join(this.dataRoot, dataChild("analysis_runtime"));
    this.fs.mkdirSync(dataDir, { recursive: true });
    this.fs.mkdirSync(this.logDir, { recursive: true });
    const logFile = this.path.join(this.logDir, "analysis_runtime.log");
    const log = createLogSink(this.fs, logFile);
    this.logSink = log;
    const args = ["--runtime-url", this.runtimeUrl(), "--token-file", this.tokenFile, "--data-dir", dataDir, "--events-dir", typeof this.eventsDir === "function" ? this.eventsDir() : this.eventsDir,
      "--config-root", this.configRoot, "--publish-interval-ms", String(this.publishIntervalMs)];
    // The inference config model_api writes, and B's inference status beside it (service/analysis/inference_files.py).
    args.push("--inference-dir", this.path.join(dataDir, "inference"));
    // 量變's previous-session baselines: <root>/<source>/volume_baseline, published by the close-of-day materialization
    // (native/analysis_runtime/src/baseline_publish.rs, materializer_job_runner.js).
    args.push("--volume-baseline-root", this.path.join(this.dataRoot, "market"));
    // 量變 compares a Shioaji day with its previous TWSE session: the same holiday file as Market Runtime.
    args.push("--market-holidays", this.path.join(this.projectRoot, "config", "market_holidays.json"));
    // ...with the closures Market Runtime observed (a typhoon day), read again whenever A rewrites the file.
    args.push("--market-sessions", this.path.join(this.dataRoot, ...dataChild("market_sessions").split("/")));
    // ...and the US half days Market Runtime splits by: OpenD's calendar the Futu provider writes, over the NYSE days.
    args.push("--us-trading-calendar", this.path.join(this.dataRoot, ...dataChild("us_trading_calendar").split("/")));
    // Market Runtime's void-event list (native/market_runtime/src/voided.rs): the durable events B's fold leaves out.
    args.push("--voided-events", this.path.join(this.dataRoot, ...dataChild("voided_events").split("/")));
    // 模擬下單: the orders paper_account_api writes and the matching results B writes (docs/system-architecture/11).
    args.push("--paper-dir", this.path.join(this.dataRoot, ...dataChild("paper_matching").split("/")));
    // B manages the historical store (native/market_runtime/src/historical_store.rs): pruned at its start and at each
    // rollover against A's cutoffs, the storage_retention revision and the codes the account ledgers traded.
    args.push("--historical-dir", this.historicalDir(),
      "--rollover-cutoffs", this.path.join(this.dataRoot, ...dataChild("rollover_cutoffs").split("/")),
      "--traded-codes-dir", this.path.join(this.dataRoot, ...dataChild("traded_codes").split("/")));
    // The model features' day context: the previous sessions' daily summaries and each stock's industry index.
    if (this.dailySummaryDir) args.push("--daily-summary-dir", typeof this.dailySummaryDir === "function" ? this.dailySummaryDir() : this.dailySummaryDir);
    if (this.securityMaster) {
      args.push("--industry-indexes", this.path.join(this.projectRoot, "config", "tw_industry_indexes.json"), "--security-master", this.securityMaster);
    }
    const child = this.spawn(binary, args, { cwd: this.projectRoot, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: this.env() });
    this.child = child;
    // B prunes the raw-history store: a pending folder change waits for this process to be gone too.
    spawnedStorageUser("analysis_runtime", child.pid);
    this.hello = null;
    this.helloAt = null;
    this.ready = null;
    this.metricsAt = null;
    this.stoppedReport = null;
    child.stderr?.on("data", (chunk) => log.write(chunk));
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch (_error) { log.write(`${line}\n`); return; }
      if (message.type === "hello") { this.hello = message; this.helloAt = Date.now(); }
      else if (message.type === "ready") this.ready = message;
      else if (message.type === "metrics") { this.latestMetrics = message; this.metricsAt = Date.now(); }
      else if (message.type === "stopped") this.stoppedReport = message;
    });
    // A failed spawn (missing executable, bad cwd) emits "error", never "exit": unhandled it was an uncaught
    // exception in Health, and exitCode stayed null so the start waited out its whole timeout.
    child.once("error", (error) => {
      child.spawnError = error;
      this.lastExit = { code: null, signal: null, error: String(error?.message || error), at: new Date().toISOString() };
      if (this.child === child) this.child = null;
      this.logger.error(`[HEALTH] analysis_runtime could not be started: ${error?.message || error}`);
    });
    child.once("exit", (code, signal) => {
      this.lastExit = { code, signal, at: new Date().toISOString() };
      if (this.child === child) this.child = null;
      if (code) this.logger.error(`[HEALTH] analysis_runtime exited code=${code}`);
    });
    // hello (the process and its restored state) within START_TIMEOUT_MS, then ready (Market Runtime confirmed B's
    // durable subscription) within READY_TIMEOUT_MS of it.
    const deadline = Date.now() + START_TIMEOUT_MS;
    let readyDeadline = null;
    for (;;) {
      if (child.spawnError) throw new Error(`analysis_runtime could not be started: ${child.spawnError.message || child.spawnError}`);
      if (child.exitCode !== null) throw new Error(`analysis_runtime exited with code ${child.exitCode} during start (see ${logFile})`);
      if (this.ready) return { ok: true, pid: child.pid, instance_id: this.hello.instance_id, restored_cursor: this.hello.restored_cursor };
      if (this.hello && readyDeadline === null) readyDeadline = Date.now() + this.readyTimeoutMs;
      const missing = readyDeadline === null ? (Date.now() >= deadline ? "hello" : null) : (Date.now() >= readyDeadline ? "ready" : null);
      if (missing) {
        const lastError = this.latestMetrics?.stream?.last_error || null;
        const reason = missing === "hello" ? "no hello in time" : `no ready in time (not subscribed to Market Runtime${lastError ? `: ${lastError}` : ""})`;
        const exited = await killChildAndRecord(child, this.remediation, { component: "analysis_runtime_host", serviceId: "analysis_runtime",
          trigger: TRIGGERS.START_FAILED, reason, graceMs: missing === "hello" ? START_TIMEOUT_MS : this.readyTimeoutMs });
        if (!exited) this.unexited = child;
        throw new Error(`analysis_runtime ${reason}${exited ? "" : "; it did not exit when ended"} (see ${logFile})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  send(message) {
    if (!this.running()) return false;
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`); return true; } catch (error) { console.warn("[sending to analysis_runtime] failed", error); return false; }
  }

  reload() { return this.send({ type: "reload" }); }

  async metrics() {
    if (!this.latestMetrics) throw new Error("no metrics line yet");
    return { ...this.latestMetrics, age_ms: Date.now() - this.metricsAt };
  }

  async stop(reason = "health_stop") {
    const child = this.child;
    if (!child) return { ok: true, stopped: true, reason };
    // B answers within this (its final checkpoint included), so its report arrives before the kill below.
    this.send({ type: "shutdown", deadline_ms: STOP_TIMEOUT_MS });
    const exited = await waitChildExit(child, STOP_TIMEOUT_MS);
    if (!exited) {
      this.logger.error(`[HEALTH] analysis_runtime did not stop in ${STOP_TIMEOUT_MS} ms; terminating pid ${child.pid}`);
      // Recorded with whether that exact process then exited -- awaited, not read the instant after the kill.
      const ended = await killChildAndRecord(child, this.remediation, { component: "analysis_runtime_host", serviceId: "analysis_runtime",
        instanceId: this.hello?.instance_id ?? null, trigger: TRIGGERS.STOP_GRACE_EXCEEDED, reason, graceMs: STOP_TIMEOUT_MS });
      if (!ended) this.unexited = child;
      return { ok: false, reason, forced: true, exited: ended,
        error: ended ? "checkpoint on stop not confirmed; B resumes from its last checkpoint"
          : `pid ${child.pid} did not exit after it was terminated; no replacement is started beside it` };
    }
    // B reports whether its final checkpoint was written; an exit without that report is not clean.
    const report = this.stoppedReport;
    const clean = report?.clean === true;
    return { ok: clean, reason, checkpoint: report?.checkpoint ?? report?.metrics?.checkpoint ?? null,
      ...(clean ? {} : { error: report ? `final checkpoint failed: ${JSON.stringify(report.checkpoint)}` : "exited without a stop report" }) };
  }
}

module.exports = { AnalysisRuntimeHost };
