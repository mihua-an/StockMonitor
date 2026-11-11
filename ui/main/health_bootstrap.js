"use strict";

// Electron main is the local bootstrap owner of Health (docs/system-architecture/00 section 3, 06 section 6).
//
// It spawns Health with the same ELECTRON_RUN_AS_NODE technique in dev and packaged runs, and waits until Health
// answers an AUTHENTICATED /health (the controller credential Health mints; Electron only reads it). Which address
// to ask is taken from Health's own bootstrap record (CONFIG_ROOT/bootstrap/health_endpoint.json) once the record
// names the Health process this bootstrap spawned (same pid) -- a stale record of an earlier instance is ignored
// and ports are never scanned.
//
// Exit code 75 is Health's planned restart: a network operation changed Health's or settings_api's own endpoint,
// Health already ran the full ordered shutdown, and the next Health must start from the candidate revision (or,
// if that fails, the previous one). That restart is immediate and not counted as a crash; listeners
// (onRestarted) then re-read endpoints and reload windows. Any other unexpected exit is retried with backoff and
// a bounded budget. Each restart is one `health.bootstrap_restart` remediation: started at the exit (old
// Health pid and instance, code/signal), finished only once the new Health reports `phase: "ready"` -- services
// started and any pending network operation finished -- not merely when its control API answers; its old
// and new instance ids are recorded. A restart that never reaches ready is a failed one.
//
// Health is spawned DETACHED: a plain child lands in libuv's kill-on-close job object, so Electron
// quitting -- "close UI and FastAPI", a crash, a taskkill -- silently killed Health and with it Rust A and B, whose
// data flow must outlive the UI. Its output goes to var/logs/health.log, not to Electron's stdio.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { resolveVarPaths } = require("../../config/js/var_paths.js");
const { readControllerToken } = require("../../service/platform/js/daemon_auth.js");
const { fetchJson } = require("../../service/platform/js/fetch_timeout.js");
const { rotateIfLarger } = require("../../service/platform/js/atomic_files.js");
const { waitChildExit } = require("../../service/platform/js/forced_termination.js");
const { createShutdownHandoffStore } = require("../../service/platform/js/shutdown_handoff.js");
const { PROTOCOL } = require("./controller_client.js");
const { childEnv } = require("../../service/platform/js/child_env.js");

const RESTART_MAX_ATTEMPTS = 5;
const RESTART_BACKOFF_MS = 2000;
const EXIT_GRACE_MS = 3000;
const HEALTH_LOG_ROTATE_BYTES = 8 * 1024 * 1024;
const PLANNED_RESTART_EXIT = 75;
// Bounds the whole start-all of an attached Health: every stage, A's longest recovery and the daemons' own retry
// windows included (config/js/startup_budget.js, the limits Health itself enforces).
const { START_ALL_TIMEOUT_MS } = require("../../config/js/startup_budget.js");
// How long a new UI waits for a Health that is still shutting down: past its own worst full shutdown (Shioaji daemon
// 180 s + Futu 90 s + port release 25 s, staged).
const STOPPING_HEALTH_WAIT_MS = 6 * 60 * 1000;
// An attached Health that does not accept a start-all (503 while it starts stopping, a timeout) is asked again a few
// times with a doubling delay, then the attach fails. Every try carries the same request id, so a try whose answer was
// lost (a timeout after Health had begun the attempt) is answered with that attempt, never a second one.
const START_ALL_TRIES = 3;
// How long an unready Health asked to shut down has to exit before it is terminated (its full shutdown is staged and
// bounded well below this).
const UNREADY_EXIT_MS = 7 * 60 * 1000;
const START_ALL_RETRY_MS = 1000;
// How long a Health being ended has to answer its shutdown request before it is terminated instead.
const SHUTDOWN_REQUEST_MS = 10000;

function resolveHealthMainPath({ isPackaged, resourcesPath, uiMainDir, path: pathApi = path }) {
  if (isPackaged) return pathApi.join(resourcesPath, "app.asar.unpacked", "health", "main.js");
  return pathApi.resolve(uiMainDir, "..", "..", "health", "main.js");
}

function createHealthBootstrap({
  isPackaged, resourcesPath, uiMainDir, path: pathApi = path, healthBaseUrl,
  execPath = process.execPath, env = process.env, logger = console,
  // How long a restarted Health has to answer healthy: a planned restart waits out a slower start (the new revision).
  restartHealthyMs = { planned: 60000, crash: 30000 },
}) {
  const healthMainPath = resolveHealthMainPath({ isPackaged, resourcesPath, uiMainDir, path: pathApi });
  const varPaths = resolveVarPaths({ env });
  const recordPath = pathApi.join(varPaths.config, "bootstrap", "health_endpoint.json");
  const logPath = pathApi.join(varPaths.logs, "health.log");
  let child = null;
  let shuttingDown = false;
  let restartAttempts = 0;
  let baseUrl = healthBaseUrl;
  const restartListeners = new Set();
  const endedListeners = new Set();
  // Health's own record of a full shutdown it completed (service/platform/js/shutdown_handoff.js; Health writes it
  // before it exits). A full shutdown asked of Health by anyone but this UI -- the tray of another window, a tool --
  // ends the App: Health exits 0 after writing it, and restarting Health then would undo the shutdown.
  const shutdownHandoff = createShutdownHandoffStore(undefined, { env, logger });
  function completedFullShutdown(pid) {
    const handoff = shutdownHandoff.load();
    return Number(handoff?.health_pid) === Number(pid) && handoff?.scope === "full" && handoff?.signal !== "network_self_apply";
  }

  // The Health process this bootstrap answers for: the one it spawned, or one it attached to (a Health that
  // outlived an earlier UI after "close UI and business APIs").
  let attachedPid = null;
  // The Health start-all attempt this UI's startup projects: {instance, generation}. A Health this bootstrap
  // spawns runs attempt 1 itself; an attached one is asked for a new attempt and answers with its number.
  let expectedAttempt = null;
  // Electron main's remediation emitter, handed in once it exists (it is built after this bootstrap).
  let remediation = null;
  // The instance id of the Health this bootstrap last heard from: the "old" identity of the next restart.
  let knownInstance = null;
  // A start-all that needed more than one try while attaching: {attempts, outcome, detail}. The attach runs before
  // Electron main's remediation emitter exists, so it is recorded once the emitter is handed in.
  let attachRetry = null;
  function recordAttachRetry() {
    if (!attachRetry || !remediation) return;
    const { attempts, outcome, detail } = attachRetry;
    attachRetry = null;
    try {
      remediation.begin({ component: "health_bootstrap", mechanismId: "health.attach_start_all_retry", triggerReason: "start_all_not_accepted",
        identity: {}, detail: { first_failure_at: detail.first_failure_at, first_error: detail.first_error } })
        ?.finish(outcome, { attempt: attempts, detail });
    } catch (error) { console.warn("[BOOTSTRAP record attach start-all retry] failed", error); }
  }
  const expectedPid = () => (child ? child.pid : attachedPid);

  function beginRestart(trigger, oldPid, code, signal) {
    try {
      return remediation?.begin({ component: "health_bootstrap", mechanismId: "health.bootstrap_restart", triggerReason: trigger,
        identity: {}, detail: { old_pid: oldPid ?? null, old_instance: knownInstance, exit_code: code ?? null, signal: signal ?? null } }) || null;
    } catch (error) { console.warn("[BOOTSTRAP begin restart remediation record] failed", error); return null; }
  }
  function finishRestart(operation, outcome, detail) {
    try { operation?.finish(outcome, { detail }); } catch (error) { console.warn("[BOOTSTRAP finish restart remediation record] failed", error); }
  }

  // Health's endpoint record, or null when there is none (no Health has written one, or the last one removed it on
  // exit). Health writes it atomically, so a record that cannot be read or does not match its schema is damage, not
  // absence: that throws, and is never read as "no Health running" (which would spawn a second one).
  function readRecord() {
    let text;
    try { text = fs.readFileSync(recordPath, "utf8"); } catch (error) {
      if (error?.code === "ENOENT") return null;   // not an error: no Health has written a record, or the last one removed it
      throw new Error(`the Health endpoint record ${recordPath} cannot be read: ${error?.message || error}`);
    }
    let record;
    try { record = JSON.parse(text); } catch (error) {
      throw new Error(`the Health endpoint record ${recordPath} is not valid JSON: ${error?.message || error}`);
    }
    const valid = record && typeof record === "object" && record.schema === "stock-monitor-health-endpoint-v1"
      && Number.isInteger(record.pid) && record.pid > 0 && typeof record.host === "string" && record.host
      && Number.isInteger(record.port) && record.port > 0 && record.port < 65536;
    if (!valid) throw new Error(`the Health endpoint record ${recordPath} does not match stock-monitor-health-endpoint-v1`);
    return record;
  }

  // While a known Health process is polled, a damaged record leaves the configured address in place and is reported
  // once per distinct failure; the startup path (start) refuses to continue on one instead.
  let lastRecordFailure = null;
  function readRecordForPolling() {
    try {
      const record = readRecord();
      lastRecordFailure = null;
      return record;
    } catch (error) {
      // not an error: the same failure again repeats the one already logged
      if (error.message !== lastRecordFailure) console.error(`[BOOTSTRAP read Health endpoint record] failed: ${error.message}`);
      lastRecordFailure = error.message;
      return null;
    }
  }

  // The control API address of Health process `pid`, from its own endpoint record (the configured one until it wrote it).
  function baseUrlOf(pid) {
    const record = readRecordForPolling();
    if (record && pid && record.pid === Number(pid)) return `http://${record.host}:${record.port}`;
    return baseUrl;
  }

  function currentBaseUrl() {
    const record = readRecordForPolling();
    if (record && expectedPid() && record.pid === expectedPid()) baseUrl = `http://${record.host}:${record.port}`;
    return baseUrl;
  }

  // A damaged record at startup: it is moved aside (kept for inspection, never overwritten by the next Health) and
  // this start fails with the reason, so the next launch starts from a known state instead of guessing whether the
  // damaged record named a live Health.
  function readRecordAtStart() {
    try { return readRecord(); } catch (error) {
      const quarantine = `${recordPath}.corrupt-${Date.now()}`;
      let moved = false;
      try { fs.renameSync(recordPath, quarantine); moved = true; } catch (moveError) {
        console.error(`[BOOTSTRAP quarantine Health endpoint record] failed: ${moveError?.message || moveError}`);
      }
      console.error(`[BOOTSTRAP read Health endpoint record] failed: ${error.message}${moved ? `; moved to ${quarantine}` : ""}`);
      throw new Error(`${error.message}${moved ? `; it was moved to ${quarantine} and the next start begins a new Health` : ""}`);
    }
  }

  // "ours" = Health process `pid` answered with the controller credential and protocol; "stopping" = it is shutting
  // down. Every probe names the process it is about: a restart in flight never reads another Health's answer as its own.
  async function probe(timeoutMs = 800, pid = expectedPid()) {
    const token = readControllerToken({ fs, path: pathApi, processRef: process });
    if (!token) return { ours: false, stopping: false };
    try {
      const { response, payload } = await fetchJson(fetch, `${baseUrlOf(pid)}/health`, { cache: "no-store",
        headers: { Authorization: `Bearer ${token}` } }, timeoutMs);
      const ours = response.ok && payload?.ok === true && payload?.protocol === PROTOCOL && Number(payload?.pid) === Number(pid);
      if (ours && payload.instance_id) knownInstance = payload.instance_id;
      return { ours, stopping: ours && payload?.stopping === true, phase: ours ? payload.phase || null : null,
        instance: ours ? payload.instance_id || null : null };
    } catch (_error) {
      // not an error: no answer (or no listener) is the probe's "not ours / not running" answer
      return { ours: false, stopping: false };
    }
  }

  // A Health that is shutting down is not one to attach to: it answered healthy, so the UI attached and then
  // waited on services that were being stopped.
  async function healthy(timeoutMs = 800, pid = expectedPid()) {
    const state = await probe(timeoutMs, pid);
    return state.ours && !state.stopping;
  }

  // Wait for a stopping Health to stop answering, so a new one can take its port.
  async function waitGone(timeoutMs, intervalMs = 250) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await probe(800)).ours) return true;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return false;
  }

  // `target`: the Health process waited for -- the one this bootstrap spawned, never whichever is current by the time
  // the wait ends.
  async function waitForHealthy(timeoutMs = 30000, intervalMs = 250, target = child) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await healthy(800, target?.pid ?? expectedPid())) {
        if (target && target === child && !expectedAttempt && knownInstance) expectedAttempt = { instance: knownInstance, generation: 1 };
        return true;
      }
      if (target && target.exitCode !== null) return false;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return false;
  }

  // The restarted Health `target` has started its services and finished any pending operation. While it moves the
  // stored history to a new folder (phase moving_storage) no service has started yet: the start-all budget begins
  // once the move ends.
  async function waitForReady(target, timeoutMs = START_ALL_TIMEOUT_MS, intervalMs = 1000) {
    let deadline = Date.now() + timeoutMs;
    let last = { phase: null, instance: null };
    while (Date.now() < deadline) {
      const state = await probe(1500, target?.pid);
      if (state.ours) last = state;
      if (state.ours && !state.stopping && state.phase === "moving_storage") deadline = Date.now() + timeoutMs;
      if (state.ours && !state.stopping && state.phase === "ready") return { ready: true, ...state };
      if (target && target.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return { ready: false, phase: last.phase, instance: last.instance };
  }

  // Attaching asks Health for a new start-all attempt; Health answers at once with the attempt it began (its
  // outcome is followed through /status/startup like a spawned Health's own boot). Bounded: any answer but an
  // accepted attempt is reported, never taken as success.
  // `requestId` names this attach: Health answers a repeat of it with the attempt the first one began.
  // Returns {attempt} or {error}.
  async function requestStartAll(requestId, timeoutMs = 10000) {
    const token = readControllerToken({ fs, path: pathApi, processRef: process });
    try {
      const { response, payload } = await fetchJson(fetch, `${currentBaseUrl()}/control/start-all`, { method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ request_id: requestId }) }, timeoutMs);
      if (payload?.accepted === true && payload.attempt?.generation) return { attempt: payload.attempt };
      const error = `not accepted (HTTP ${response.status})`;
      logger.error?.(`[BOOTSTRAP] start-all on the attached Health was ${error}`);
      return { error };
    } catch (failure) {
      const error = failure?.name === "AbortError" ? `no answer within ${timeoutMs} ms` : String(failure?.message || failure);
      logger.error?.(`[BOOTSTRAP] start-all request failed: ${error}`);
      return { error };
    }
  }

  // A restarted Health that is not usable -- it never answered healthy, or answered but never reached ready -- is not
  // one to keep: that exact process is asked to shut down (only when it is the one answering at its address) and
  // waited for; one that does not answer, refuses, or does not exit is terminated. Its exit goes through the exit
  // handler -- the next, budgeted, restart.
  async function endCandidate(next, why) {
    if (!next || next.exitCode !== null || next.signalCode) return;
    logger.error?.(`[BOOTSTRAP] Health pid=${next.pid} ${why}; ending it so the restart budget decides`);
    const terminate = (reason) => {
      logger.error?.(`[BOOTSTRAP] ${reason}; terminating Health pid=${next.pid}`);
      try { next.kill(); } catch (killError) { logger.error?.(`[BOOTSTRAP] terminating the unusable Health failed: ${killError?.message || killError}`); }
    };
    if (!(await probe(800, next.pid)).ours) { terminate("it does not answer as itself"); return; }
    const token = readControllerToken({ fs, path: pathApi, processRef: process });
    try {
      const { response } = await fetchJson(fetch, `${baseUrlOf(next.pid)}/control/shutdown`, { method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ scope: "full" }) }, SHUTDOWN_REQUEST_MS);
      if (!response.ok) { terminate(`it refused the shutdown (HTTP ${response.status})`); return; }
    } catch (error) {
      // not an error: recorded -- terminate() logs the reason before it ends the process
      terminate(`could not ask it to shut down: ${error?.name === "AbortError" ? `no answer within ${SHUTDOWN_REQUEST_MS} ms` : error?.message || error}`);
      return;
    }
    if (!(await waitChildExit(next, UNREADY_EXIT_MS))) terminate(`it did not exit within ${UNREADY_EXIT_MS} ms of its shutdown`);
  }

  // The one recovery path of every restart, planned or after a crash: spawn the candidate, wait until it answers
  // healthy, then until it is ready. The remediation operation ends with exactly one terminal outcome, and a candidate
  // that fails either stage is ended. Resolves true only for a ready candidate.
  async function recoverCandidate(operation, healthyTimeoutMs, extra = {}) {
    const next = await spawnHealth();
    if (!(await waitForHealthy(healthyTimeoutMs, 250, next))) {
      finishRestart(operation, "failed", { new_pid: next?.pid ?? null, stage: "healthy", ...extra });
      await endCandidate(next, `did not answer healthy within ${healthyTimeoutMs} ms`);
      return false;
    }
    const ready = await waitForReady(next);
    finishRestart(operation, ready.ready ? "succeeded" : "failed",
      { new_pid: next?.pid ?? null, new_instance: ready.instance, phase: ready.phase, stage: "ready", ...extra });
    if (!ready.ready) await endCandidate(next, "did not reach ready");
    return ready.ready;
  }

  // Background work of the bootstrap (restarts run off the exit event): a rejection is recorded, never unhandled.
  function supervise(name, task) {
    Promise.resolve().then(task).catch((error) => logger.error?.(`[BOOTSTRAP] ${name} failed: ${error?.stack || error?.message || error}`));
  }

  function notifyRestarted(reason) {
    for (const listener of restartListeners) {
      Promise.resolve().then(() => listener({ reason, baseUrl })).catch((error) => logger.error?.(`[BOOTSTRAP] restart listener failed: ${error?.message || error}`));
    }
  }

  // Append-only log, rotated once past HEALTH_LOG_ROTATE_BYTES (the rule of every log: atomic_files.js rotateIfLarger).
  async function openHealthLog() {
    try {
      fs.mkdirSync(pathApi.dirname(logPath), { recursive: true });
      try {
        const { pruneFailures } = await rotateIfLarger(logPath, HEALTH_LOG_ROTATE_BYTES);
        for (const failure of pruneFailures) console.warn(`[BOOTSTRAP removing an old health.log ${failure.name}] failed: ${failure.message}`);
      } catch (error) { console.warn("[BOOTSTRAP rotate health.log] failed", error); }
      return fs.openSync(logPath, "a");
    } catch (error) {
      logger.error?.(`[BOOTSTRAP] cannot open ${logPath}: ${error?.message || error}`);
      return "ignore";
    }
  }

  // Health starts from an allowlisted environment, not Electron's whole one. It is the role
  // credentials' minter, so it alone also receives the token-file overrides.
  function healthEnv() {
    const grant = Object.fromEntries(Object.entries(env).filter(([name]) => /^STOCK_MONITOR_[A-Z_]+_TOKEN_FILE$/i.test(name)));
    return childEnv(env, { ...grant, ELECTRON_RUN_AS_NODE: "1", ...(isPackaged ? { STOCK_MONITOR_RESOURCES_PATH: resourcesPath } : {}) });
  }

  async function spawnHealth() {
    logger.log?.(`[BOOTSTRAP] starting Health (${healthMainPath}); log ${logPath}`);
    // A new Health is a new instance: its own boot attempt is the one to wait for, once it names itself.
    expectedAttempt = null;
    knownInstance = null;
    const out = await openHealthLog();
    try {
      child = spawn(execPath, [healthMainPath], {
        cwd: isPackaged ? resourcesPath : pathApi.resolve(uiMainDir, "..", ".."),
        detached: true,
        windowsHide: true,
        stdio: ["ignore", out, out],
        env: healthEnv(),
      });
    } finally {
      if (typeof out === "number") fs.closeSync(out);
    }
    // Electron must not wait on Health to exit; the exit listener below still fires while Electron is alive.
    child.unref();
    const spawned = child;
    spawned.once("error", (error) => logger.error?.(`[BOOTSTRAP] Health process error: ${error?.message || error}`));
    spawned.once("exit", (code, signal) => {
      if (shuttingDown || spawned !== child) return;
      if (code === PLANNED_RESTART_EXIT) {
        logger.log?.("[BOOTSTRAP] Health requested a planned restart (network self-endpoint change); restarting now");
        const operation = beginRestart("planned_restart", spawned.pid, code, signal);
        supervise("planned restart", async () => {
          // Endpoints are re-read only once the new Health is ready, its operation finished; one that never
          // gets there is not announced -- it is ended, and its exit is the next restart.
          const ok = await recoverCandidate(operation, restartHealthyMs.planned);
          logger[ok ? "log" : "error"]?.(`[BOOTSTRAP] Health ${ok ? "is back after the planned restart" : "did not come back after the planned restart"}`);
          if (ok) notifyRestarted("planned_restart");
        });
        return;
      }
      if (code === 0 && completedFullShutdown(spawned.pid)) {
        shuttingDown = true;
        logger.log?.(`[BOOTSTRAP] Health pid=${spawned.pid} completed a full shutdown; the App ends with it`);
        for (const listener of endedListeners) {
          Promise.resolve().then(() => listener()).catch((error) => logger.error?.(`[BOOTSTRAP] ended listener failed: ${error?.message || error}`));
        }
        return;
      }
      const operation = beginRestart("unexpected_exit", spawned.pid, code, signal);
      setTimeout(() => {
        if (shuttingDown || spawned !== child) return;
        logger.error?.(`[BOOTSTRAP] Health exited unexpectedly (code=${code} signal=${signal})`);
        if (restartAttempts >= RESTART_MAX_ATTEMPTS) {
          logger.error?.(`[BOOTSTRAP] Health restart attempts exhausted (${RESTART_MAX_ATTEMPTS}); Health-dependent actions fail until the App restarts`);
          finishRestart(operation, "abandoned", { attempts: restartAttempts });
          return;
        }
        restartAttempts += 1;
        logger.log?.(`[BOOTSTRAP] restarting Health (attempt ${restartAttempts}/${RESTART_MAX_ATTEMPTS})...`);
        setTimeout(() => supervise("crash recovery", async () => {
          if (shuttingDown) { finishRestart(operation, "abandoned", { attempt: restartAttempts, reason: "app_shutting_down" }); return; }
          // The budget is restored only by a Health that got all the way to ready; the endpoints are re-read then,
          // and a Health that never gets there leaves them fenced (api_endpoints retries, then records it).
          if (await recoverCandidate(operation, restartHealthyMs.crash, { attempt: restartAttempts })) {
            logger.log?.("[BOOTSTRAP] Health recovered and is ready");
            restartAttempts = 0;
            notifyRestarted("crash_recovery");
          } else {
            logger.error?.(`[BOOTSTRAP] Health restart attempt ${restartAttempts} did not reach ready`);
          }
        }), RESTART_BACKOFF_MS);
      }, EXIT_GRACE_MS);
    });
    return child;
  }

  return {
    async start(timeoutMs = 30000) {
      // A Health that proves itself (its own record, the controller credential, the protocol) is attached to --
      // never a second one on the same port. Anything else on that port is not ours and is left alone.
      const record = readRecordAtStart();
      if (record?.pid) {
        attachedPid = Number(record.pid);
        const state = await probe(1000);
        if (state.ours && !state.stopping) {
          logger.log?.(`[BOOTSTRAP] attached to the running Health pid=${attachedPid}; asking it to start every service`);
          // Attached only with an accepted attempt of our own: without one, the startup would read whatever
          // attempt Health last ran -- an earlier boot's "ready" -- as this UI's.
          const requestId = crypto.randomUUID();
          let attempt = null;
          let tries = 0;
          let firstFailure = null;
          let lastError = null;
          while (!attempt && tries < START_ALL_TRIES) {
            if (tries) await new Promise((resolve) => setTimeout(resolve, START_ALL_RETRY_MS * 2 ** (tries - 1)));
            tries += 1;
            const answer = await requestStartAll(requestId);
            attempt = answer.attempt || null;
            if (!attempt) {
              lastError = answer.error;
              firstFailure ??= { first_failure_at: new Date().toISOString(), first_error: answer.error };
            }
          }
          if (firstFailure) {
            attachRetry = { attempts: tries, outcome: attempt ? "succeeded" : "failed",
              detail: { ...firstFailure, request_id: requestId, health_pid: attachedPid, last_error: attempt ? null : lastError,
                generation: attempt?.generation ?? null } };
            recordAttachRetry();
          }
          if (!attempt) throw new Error(`the running Health pid=${attachedPid} did not accept a start-all after ${START_ALL_TRIES} tries`);
          expectedAttempt = { instance: attempt.health_instance, generation: attempt.generation };
          return true;
        }
        if (state.stopping) {
          logger.log?.(`[BOOTSTRAP] the running Health pid=${attachedPid} is shutting down; waiting for it before starting a new one`);
          if (!(await waitGone(STOPPING_HEALTH_WAIT_MS))) {
            throw new Error(`the previous Health pid=${attachedPid} is still shutting down after ${STOPPING_HEALTH_WAIT_MS} ms`);
          }
        }
        attachedPid = null;
      }
      await spawnHealth();
      if (!(await waitForHealthy(timeoutMs))) throw new Error("Health did not answer an authenticated health check within timeout");
      expectedAttempt = { instance: knownInstance, generation: 1 };
      return true;
    },
    baseUrl: () => currentBaseUrl(),
    // The start-all attempt this UI's startup waits for: {instance, generation}, or null when none was accepted.
    expectedStartupAttempt: () => (expectedAttempt ? { ...expectedAttempt } : null),
    onRestarted(listener) { restartListeners.add(listener); return () => restartListeners.delete(listener); },
    // Health completed a full shutdown it was asked for elsewhere: the UI closes too (no restart).
    onHealthEndedApp(listener) { endedListeners.add(listener); return () => endedListeners.delete(listener); },
    // Called by ShutdownController right before it asks Health to shut down, so the expected exit is not a crash.
    markShuttingDown() { shuttingDown = true; },
    setRemediation(emitter) { remediation = emitter || null; recordAttachRetry(); },
  };
}

module.exports = { createHealthBootstrap, resolveHealthMainPath, PLANNED_RESTART_EXIT };
