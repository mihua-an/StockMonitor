"use strict";

// Host for market_runtime (Rust A) -- docs/system-architecture/00 sections 3-4, 04 section 4.
//
// Started with the RESOLVED endpoint, the config revision it came from, the digest-only role credential file and
// the data/config roots; it never reads network settings itself. Health talks to it under the controller role:
// `health` for identity (service_id + wall clock + instance), `metrics` for monitoring, `shutdown` for the durable
// stop (stop admission, commit the WAL, checkpoint, clean marker). A listener that does not prove it is the App's
// market_runtime is never adopted and never killed.
//
// A's stdout is a line protocol beside its log: `ready`, `stopped` and `session_ending` -- Windows is shutting down or
// logging off, which of the App's processes only A is told (native/market_runtime/src/server/session_end.rs); the
// line goes to `onSessionEnding`, and Health runs its full shutdown (docs/system-architecture/04 section 2.1).

const { probeTcpPort } = require("../../service/platform/js/daemon_connection");
const { TRIGGERS, killChildAndRecord } = require("../../service/platform/js/forced_termination");
const { createLogSink } = require("./log_sink");
const { spawnedStorageUser } = require("../startup/storage_users");
const net = require("net");
const readline = require("readline");
const { spawn } = require("child_process");
const { childEnv } = require("../../service/platform/js/child_env");
const { dataChild } = require("../../config/js/system_contract.js");

// A listens at once and, while it scans and replays its WAL, answers `health` with status "recovering" and its
// progress. A fixed start timeout cannot tell a long recovery from a hang: at 90 s it killed a full
// replay that needed ~2 min and restarted it from zero, forever. So the wait follows the progress instead, within the
// limits Electron's waits share (config/js/startup_budget.js).
const {
  MARKET_RUNTIME_FIRST_ANSWER_MS: FIRST_ANSWER_TIMEOUT_MS,
  MARKET_RUNTIME_SCAN_LIMIT_MS: SCAN_LIMIT_MS,
  MARKET_RUNTIME_RECOVERY_STALL_MS: RECOVERY_STALL_MS,
  MARKET_RUNTIME_RECOVERY_LIMIT_MS: RECOVERY_LIMIT_MS,
} = require("../../config/js/startup_budget.js");
const STOP_TIMEOUT_MS = 10000;

// The one TCP probe, here with this host's own default timeout.
function portOpen(host, port, timeoutMs = 200) {
  return probeTcpPort(net, port, timeoutMs, host);
}

class MarketRuntimeHost {
  // The child output log's own health: lost chunks, write failures, last error; null before a start.
  logSinkHealth() { return this.logSink ? this.logSink.health() : null; }

  constructor({ isPackaged = false, resourcesPath, fs, path, projectRoot, dataRoot, configRoot, logDir, effective,
    credentialsFile, controllerToken, logger = console, spawnImpl = spawn, timing = {}, env = () => childEnv(process.env),
    historicalDir = null, evidenceRoot = null, remediation = null, onSessionEnding = () => {} }) {
    this.remediation = remediation;
    this.onSessionEnding = onSessionEnding;
    this.isPackaged = isPackaged;
    this.resourcesPath = resourcesPath;
    this.fs = fs;
    this.path = path;
    this.projectRoot = projectRoot;
    this.dataRoot = dataRoot;
    // The raw-history folder (設定 → 資料儲存, config/js/storage_settings.js), resolved at each start.
    this.historicalDir = typeof historicalDir === "function" ? historicalDir : () => historicalDir || path.join(dataRoot, "historical");
    // Where A writes each partition's session evidence (native/market_runtime/src/evidence.rs); the session owners, the
    // 收盤進度 and the WAL retention read it there. Health names it (main.js); without one A keeps it in memory only.
    this.evidenceRoot = evidenceRoot;
    this.configRoot = configRoot;
    this.logDir = logDir;
    this.effective = effective;
    this.credentialsFile = credentialsFile;
    this.controllerToken = controllerToken;
    this.logger = logger;
    this.spawn = spawnImpl;
    this.env = env;
    this.timing = { firstAnswerMs: FIRST_ANSWER_TIMEOUT_MS, scanLimitMs: SCAN_LIMIT_MS, stallMs: RECOVERY_STALL_MS,
      limitMs: RECOVERY_LIMIT_MS, pollMs: 250, ...timing };
    this.child = null;
    this.instanceId = null;
    this.lastExit = null;
  }

  get endpoint() {
    const entry = this.effective.services.market_runtime;
    return { host: entry.host, port: Number(entry.port) };
  }

  binaryPath() {
    return this.isPackaged
      ? this.path.join(this.resourcesPath, "native", "market_runtime_daemon.exe")
      : this.path.join(this.projectRoot, "native", "market_runtime", "target", "release", "market_runtime_daemon.exe");
  }

  dataDir() { return this.path.join(this.dataRoot, dataChild("market_runtime")); }

  control(type, payload = {}, timeoutMs = 1500, replyType = type) {
    const { host, port } = this.endpoint;
    return new Promise((resolve, reject) => {
      // The credential goes in a header, never in the URL.
      const ws = new WebSocket(`ws://${host}:${port}/live`, { headers: { Authorization: `Bearer ${this.controllerToken}` } });
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch (error) { console.warn("[closing the market_runtime health socket] failed", error); }
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error(`market_runtime ${type} timed out`)), timeoutMs);
      ws.addEventListener("open", () => ws.send(JSON.stringify({ type, payload })));
      ws.addEventListener("message", async (event) => {
        try {
          const text = typeof event.data === "string" ? event.data : Buffer.from(await event.data.arrayBuffer()).toString("utf8");
          const message = JSON.parse(text);
          if (message.type === replyType || message.type === "error") finish(null, message);
        } catch (error) { finish(error); }
      });
      ws.addEventListener("error", () => finish(new Error("market_runtime control socket failed")));
      ws.addEventListener("close", () => finish(new Error("market_runtime closed the control socket")));
    });
  }

  async health(timeoutMs = 1500) {
    try {
      const reply = await this.control("health", {}, timeoutMs);
      const payload = reply?.payload || {};
      return reply?.type === "health" ? payload : null;
    } catch (_error) { /* not an error: an unanswered health probe is the "not healthy yet" answer the caller waits on */ return null; }
  }

  verifiedHealth(health) {
    // A test instance (`--clock exchange`, native/market_runtime/src/server/hub.rs MarketClock) on this port is not the App's.
    return Boolean(health && health.service_id === "market_runtime" && health.clock === "wall" && health.instance_id);
  }

  // Whether anything listens on A's port: the short TCP knock, before any authenticated request.
  portPresent() { return portOpen(this.endpoint.host, this.endpoint.port); }

  // A closed port is checked with the TCP knock alone (the authenticated WebSocket health waited its whole timeout on
  // a port nothing listened on); an open one must still prove it is the App's market_runtime.
  // An instance verified at the last probe is asked directly (the knock tells nothing new there, and A logged every
  // knock as a failed handshake, every 2 s); the knock runs again only when that health fails.
  async supervisorProbe() {
    let health = this.lastVerified ? await this.health() : null;
    const present = health ? true : await this.portPresent();
    if (!health && present && !this.lastVerified) health = await this.health();
    const verified = this.verifiedHealth(health);
    this.lastVerified = verified;
    const occupied = present || Boolean(health);
    return {
      service_id: "market_runtime", alive: verified, occupied, verified, identity_verified: verified,
      instance_id: health?.instance_id || null, pid: health?.pid || this.child?.pid || null,
      owned: Boolean(this.child && this.child.exitCode === null),
      // As the process reports them: absent stays absent, never defaulted.
      config_revision: health?.config_revision, bound_host: health?.host, bound_port: health?.port,
      status: health?.status || null, runtime_epoch: health?.runtime_epoch ?? null, durable_stream_id: health?.durable_stream_id || null,
      port: this.endpoint.port, health,
    };
  }

  /** "行情引擎復原中 42%（2,812,331 / 6,640,360）" for a recovering health, "" otherwise. */
  static recoveryText(health) {
    const r = health?.recovery || {};
    if (health?.status !== "recovering") return "";
    const total = Number(r.total) || 0, replayed = Number(r.replayed) || 0;
    if (r.phase !== "replaying" || total <= 0) return "行情引擎復原中（掃描 WAL）";
    return `行情引擎復原中 ${Math.floor(replayed / total * 100)}%（${replayed.toLocaleString("en-US")} / ${total.toLocaleString("en-US")}）`;
  }

  /**
   * Wait until A serves. While it answers "recovering" the wait lasts as long as it advances: the scan gets
   * SCAN_LIMIT_MS, the replay fails only after RECOVERY_STALL_MS without progress, and nothing past RECOVERY_LIMIT_MS.
   */
  async waitServing(child, report) {
    const { firstAnswerMs, scanLimitMs, stallMs, limitMs, pollMs } = this.timing;
    const started = Date.now();
    let answered = false, lastMark = null, lastProgressAt = started, lastReport = "";
    // The start fails only once the child it spawned has exited (or is known not to have, and is then kept from a
    // replacement): never returned to the caller with the old A still cleaning the data root.
    const fail = async (message) => {
      if (child && child.exitCode === null && !child.signalCode) {
        const exited = await killChildAndRecord(child, this.remediation, { component: "market_runtime_host", serviceId: "market_runtime",
          trigger: TRIGGERS.START_FAILED, reason: message, graceMs: null });
        if (!exited) {
          this.unexited = child;
          return new Error(`${message}; pid ${child.pid} did not exit when ended`);
        }
      }
      return new Error(message);
    };
    for (;;) {
      if (child?.spawnError) throw new Error(`market_runtime could not be started: ${child.spawnError.message || child.spawnError}`);
      if (child && child.exitCode !== null) throw new Error(`market_runtime exited with code ${child.exitCode} during start`);
      // Until A binds, the knock answers in at most its 200 ms; the WebSocket health would wait out its timeout.
      const health = (await this.portPresent()) ? await this.health(800) : null;
      const now = Date.now();
      if (this.verifiedHealth(health)) {
        answered = true;
        if (health.status !== "recovering") return health;
        const r = health.recovery || {};
        const mark = `${r.phase}:${r.replayed}`;
        if (mark !== lastMark) { lastMark = mark; lastProgressAt = now; }
        const text = MarketRuntimeHost.recoveryText(health);
        if (text && text !== lastReport) { lastReport = text; try { report?.(text); } catch (error) { console.warn("[reporting market_runtime recovery progress] failed", error); } }
        if (now - started > limitMs) throw await fail(`market_runtime still recovering after ${Math.round(limitMs / 60000)} min (${text})`);
        if (r.phase === "replaying" && now - lastProgressAt > stallMs) throw await fail(`market_runtime recovery stalled (${text})`);
        if (r.phase !== "replaying" && now - started > scanLimitMs) throw await fail(`market_runtime WAL scan did not finish in ${Math.round(scanLimitMs / 60000)} min`);
      } else if (!answered && now - started > firstAnswerMs) {
        throw await fail("market_runtime did not answer an authenticated health in time");
      } else if (answered && now - lastProgressAt > stallMs) {
        throw await fail("market_runtime stopped answering while recovering");
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  async ensure({ report = null } = {}) {
    // A child that was ended but never proven gone holds the same data root: no replacement starts beside it.
    if (this.unexited) {
      if (this.unexited.exitCode !== null || this.unexited.signalCode) this.unexited = null;
      else throw new Error(`market_runtime pid ${this.unexited.pid} was ended but has not exited; no replacement is started beside it`);
    }
    const probe = await this.supervisorProbe();
    if (probe.verified) {
      this.instanceId = probe.instance_id;
      // An instance that is still recovering is adopted, and waited for like one this host started.
      if (probe.health?.status === "recovering") await this.waitServing(null, report);
      return { ok: true, attached: !probe.owned, pid: probe.pid, instance_id: probe.instance_id };
    }
    if (probe.occupied) throw new Error(`market_runtime port ${probe.port} is held by an unverified occupant; not started, not killed`);
    const binary = this.binaryPath();
    if (!this.fs.existsSync(binary)) throw new Error(`market_runtime binary missing: ${binary}`);
    this.fs.mkdirSync(this.logDir, { recursive: true });
    this.fs.mkdirSync(this.dataDir(), { recursive: true });
    const logFile = this.path.join(this.logDir, "market_runtime.log");
    const log = createLogSink(this.fs, logFile);
    this.logSink = log;
    const { host, port } = this.endpoint;
    const args = ["--host", host, "--port", String(port), "--data-dir", this.dataDir(), "--credentials", this.credentialsFile,
      "--config-root", this.configRoot,
      // 歷史回放 plays the materializer's partitions back through A (native/market_runtime/src/replay.rs).
      "--historical-dir", this.historicalDir(),
      // A's rollover cutoffs, the one thing it writes for the historical store's retention (B's manager reads them,
      // native/market_runtime/src/historical_store.rs).
      "--rollover-cutoffs", this.path.join(this.dataRoot, ...dataChild("rollover_cutoffs").split("/")),
      // Trading days for the session rollover at each pre-open (native/market_runtime/src/rollover.rs).
      "--market-holidays", this.path.join(this.projectRoot, "config", "market_holidays.json"),
      // The sessions that opened on their first print and the closures A observed; A writes it, B and Python read it.
      "--market-sessions", this.path.join(this.dataRoot, ...dataChild("market_sessions").split("/")),
      // The US exchange calendar the Futu provider writes from OpenD: US trading days for the Futu rollover.
      "--us-trading-calendar", this.path.join(this.dataRoot, ...dataChild("us_trading_calendar").split("/")),
      // The durable events the user decided are void (native/market_runtime/src/voided.rs): left out of A's state.
      "--voided-events", this.path.join(this.dataRoot, ...dataChild("voided_events").split("/"))];
    if (this.evidenceRoot) args.push("--evidence-root", this.evidenceRoot);
    if (this.effective.revision !== null && this.effective.revision !== undefined) args.push("--config-revision", String(this.effective.revision));
    const child = this.spawn(binary, args, { cwd: this.projectRoot, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: this.env() });
    child.stdout?.on("data", (chunk) => log.write(chunk));
    if (child.stdout) readline.createInterface({ input: child.stdout }).on("line", (line) => this.readStdoutLine(line));
    child.stderr?.on("data", (chunk) => log.write(chunk));
    this.child = child;
    spawnedStorageUser("market_runtime", child.pid);
    // A failed spawn (missing executable, bad cwd) emits "error", never "exit": unhandled it was an uncaught
    // exception in Health, and exitCode stayed null so the start waited out its whole timeout.
    child.once("error", (error) => {
      child.spawnError = error;
      this.lastExit = { code: null, signal: null, error: String(error?.message || error), at: new Date().toISOString() };
      if (this.child === child) this.child = null;
      this.logger.error(`[HEALTH] market_runtime could not be started: ${error?.message || error}`);
    });
    child.once("exit", (code, signal) => {
      this.lastExit = { code, signal, at: new Date().toISOString() };
      if (this.child === child) this.child = null;
      if (code) this.logger.error(`[HEALTH] market_runtime exited code=${code}`);
    });
    let health;
    try {
      health = await this.waitServing(child, report);
    } catch (error) {
      throw new Error(`${error.message} (see ${logFile})`);
    }
    this.instanceId = health.instance_id;
    return { ok: true, pid: child.pid, instance_id: health.instance_id, recovery: null };
  }

  // One line of A's stdout. Anything that is not a JSON message is log text (already in the log sink).
  readStdoutLine(line) {
    if (!line.startsWith("{")) return;
    let message;
    try { message = JSON.parse(line); }
    catch (error) { this.logger.error(`[HEALTH] market_runtime stdout line is not JSON (${error?.message || error}): ${line.slice(0, 200)}`); return; }
    if (message?.type !== "session_ending") return;
    this.logger.log(`[HEALTH] market_runtime: Windows ${message.payload?.event} announced; full shutdown`);
    this.onSessionEnding(message.payload || {});
  }

  async metrics() {
    const reply = await this.control("metrics", {}, 2000);
    if (reply?.type !== "metrics") throw new Error(reply?.error || "metrics refused");
    return reply.payload;
  }

  async demandStatus() {
    const reply = await this.control("demand.status", {}, 2000);
    return reply?.payload || null;
  }

  async drain() {
    const reply = await this.control("drain", {}, 8000, "drain.ack");
    return { ok: reply?.type === "drain.ack", receipt: reply?.payload };
  }

  async stop(reason = "health_stop") {
    const probe = await this.supervisorProbe();
    if (!probe.occupied) return { ok: true, stopped: true, reason };
    if (!probe.verified) return { ok: false, reason, error: "refusing to stop an unverified occupant" };
    let ack = null;
    try {
      // The ack now follows the WAL flush and the checkpoint (up to ~5 s flush plus the checkpoint write).
      ack = await this.control("shutdown", {}, 20000, "shutdown.ack");
    } catch (error) {
      this.logger.error(`[HEALTH] market_runtime shutdown request (${reason}) failed: ${error?.message || error}`);
      return { ok: false, reason, error: String(error?.message || error) };
    }
    // Not a clean stop unless A says so: a failed flush/checkpoint is reported, never hidden.
    const receipt = ack?.payload || {};
    const clean = receipt.clean === true;
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.child && this.child.exitCode !== null) this.child = null;
      if (!(await portOpen(this.endpoint.host, this.endpoint.port, 150)) && !this.child) {
        return { ok: clean, reason, committed: receipt.committed ?? null, released: true, receipt,
          ...(clean ? {} : { error: `market_runtime stop not clean: ${JSON.stringify({ wal_flushed: receipt.wal_flushed, wal_failed: receipt.wal_failed, checkpoint: receipt.checkpoint?.error || null })}` }) };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.child) {
      this.logger.error(`[HEALTH] market_runtime durable shutdown exceeded ${STOP_TIMEOUT_MS} ms; terminating owned pid ${this.child.pid}`);
      await killChildAndRecord(this.child, this.remediation, { component: "market_runtime_host", serviceId: "market_runtime",
        instanceId: probe.instance_id ?? null, trigger: TRIGGERS.STOP_GRACE_EXCEEDED, reason, graceMs: STOP_TIMEOUT_MS });
      return { ok: false, reason, forced: true, error: "durable shutdown did not finish in time; the WAL tail is recovered on next start" };
    }
    return { ok: false, reason, error: "listener still open and not owned" };
  }
}

module.exports = { MarketRuntimeHost, portOpen };
