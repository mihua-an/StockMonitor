"use strict";

// The model training job's lifecycle: training is a process of its own that Health
// starts -- never a thread inside an API -- so closing the UI and FastAPI ("關閉介面與 FastAPI") does not interrupt it.
//
// * auto: for the trading date the Shioaji session owner published as its newest settled, materialized STK day
//   session (<output>/materialization_jobs/settled/shioaji.json, service/market/shared/materialization_jobs.py) --
//   not at a clock time -- outside config/model_training.json `auto.quiet` (Asia/Taipei, the TW day session), only
//   while the materializer is idle, and only when the training domain's own ledger
//   (<data>/model/online_training/schedule.json, written by the job) says an attempt for that date is due: none yet;
//   not DONE and its `next_due_at` passed (a failed attempt); or, with no due time (NOT_READY), settled again after
//   that attempt ended. The job decides readiness and records every attempt; this runner keeps no retry timing.
// * manual: model_api writes <data>/model/online_training/requests/<job_id>.json (POST /api/training/run); this
//   runner watches that directory and starts the job with that id as soon as the file appears. The job removes the
//   request once its own RUNNING status is written (so a reader sees the request or the job, never neither); a job
//   that ends before doing so has it removed here. One job at a time.
//
// What the job does and its progress are the job's (service/analysis/online_training/job.py, status.json); this
// runner only starts, watches and stops the process.
//
// One job at a time across Health instances, not only within this one: the job's owner record
// (<data>/model/online_training/job.owner.json: this Health's instance, the job's pid and OS creation time) is written
// durably before the job is told to start (`--start-gate stdin`), and removed when it ends. A Health that finds another
// instance's record (it crashed, or its stop could not end the job) starts nothing while that exact process -- pid and
// creation time -- still runs: it keeps the job's time bound and ends it at a full shutdown, as if it had started it.
// A record whose process is gone, or whose pid now names another process, is released; one that cannot be verified
// (or read) blocks every start and is reported.

const { writeJsonAtomic, readJsonObject } = require("../service/platform/js/atomic_files");
const { TRIGGERS, recordForcedTermination, terminateProcessTree, endChildTree } = require("../service/platform/js/forced_termination");
const { processAliveFast, processCreatedMsAsync } = require("../service/platform/js/process_utils");
const { spawn: defaultSpawn } = require("child_process");
const { childEnv } = require("../service/platform/js/child_env");
const { resolveVarPaths } = require("../config/js/var_paths");

const RESULT_TAIL_CHARS = 64 * 1024;
const KILL_GRACE_MS = 5000;
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function taipeiClock(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hhmm: `${parts.hour}:${parts.minute}` };
}

function lastJsonLine(text) {
  const lines = String(text || "").trim().split("\n").filter(Boolean);
  try { return JSON.parse(lines[lines.length - 1]); } catch (_error) { /* not an error: a last output line that is not JSON is no result; the caller reports the job as failed */ return null; }
}

function createTrainingJobRunner({
  projectRoot, dataRoot, pythonExecutable, analysisRuntimeBinary, securityMaster, logDir, fs, path,
  spawnImpl = defaultSpawn, pollSeconds = 10, materializerIdle = () => true, now = () => new Date(),
  logger = console, env = () => childEnv(process.env), jobTimeoutMs = DEFAULT_TIMEOUT_MS, killGraceMs = KILL_GRACE_MS,
  execFileImpl = require("node:child_process").execFile, platform = process.platform, remediation = null,
  settledFile = null, processAlive = processAliveFast, createdMsAsync = processCreatedMsAsync,
  terminateTree = (pid) => terminateProcessTree(pid, { execFileImpl, alive: processAlive }),
}) {
  const readJob = (file) => readJsonObject(file, { fsImpl: fs, label: "a training job file" });
  const root = path.join(dataRoot, "model", "online_training");
  const requestsDir = path.join(root, "requests");
  const ownerPath = path.join(root, "job.owner.json");
  const instanceId = `training-${process.pid}-${Date.now()}`;
  const configPath = path.join(projectRoot, "config", "model_training.json");
  const settledPath = settledFile || path.join(resolveVarPaths({ projectRoot, env: process.env }).output,
    "materialization_jobs", "settled", "shioaji.json");
  let timer = null;
  let watcher = null;
  let stopping = false;
  let child = null;
  let current = null;
  let lastResult = null;
  let runs = 0;
  // Another Health's job whose exact process still runs (its owner record), and a check of one in progress.
  let adopted = null;
  let verifying = false;
  let lastOwnerProblem = null;
  // The training domain's schedule ledger: null when none exists yet, {damaged: reason} when it exists but cannot be
  // read as an object. A damaged ledger stops auto starts (the job would refuse it too) and is reported once per
  // distinct reason, not every poll.
  let lastScheduleDamage = null;
  function schedule() {
    const file = path.join(root, "schedule.json");
    let value;
    try {
      value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not a JSON object");
    } catch (error) {
      // not an error: ENOENT is no ledger yet; a damage reason seen before was logged when it first appeared
      if (error?.code === "ENOENT") { lastScheduleDamage = null; return null; }
      const reason = String(error?.message || error);
      if (reason !== lastScheduleDamage) console.error(`[training schedule ledger ${file}] damaged; auto training stopped: ${reason}`);
      lastScheduleDamage = reason;
      return { damaged: reason };
    }
    lastScheduleDamage = null;
    return value;
  }

  // Whether the training domain's ledger lets an auto attempt for the settled `date` start now.
  function autoDue(date, settledAt) {
    const entry = schedule();
    if (entry?.damaged) return false;
    if (!entry || entry.trading_date !== date) return true;      // nothing attempted for this date yet
    if (entry.state === "DONE") return false;
    if (entry.next_due_at) {
      const due = Date.parse(entry.next_due_at);
      return !Number.isFinite(due) || now().getTime() >= due;
    }
    // NOT_READY: only a settled notice newer than that attempt starts another.
    return Date.parse(settledAt || "") > Date.parse(entry.finished_at || "");
  }

  // The session owner's newest settled STK day session: {trading_date, status, settled_at}, or null.
  function settledStkDay() {
    const notice = readJob(settledPath);
    const entry = notice?.sessions?.["STK:DAY"];
    return entry && typeof entry === "object" ? entry : null;
  }

  function quietNow(quiet, hhmm) {
    return Boolean(quiet?.from && quiet?.to) && hhmm >= String(quiet.from) && hhmm < String(quiet.to);
  }

  function config() {
    const value = readJob(configPath);
    return value?.schema === "model-training-v1" ? value : null;
  }

  function pendingRequest() {
    try {
      const name = fs.readdirSync(requestsDir).filter((n) => n.endsWith(".json")).sort()[0];
      return name ? { jobId: name.slice(0, -5), file: path.join(requestsDir, name) } : null;
    } catch (error) { /* absent is not an error: no requests directory yet */ if (error?.code !== "ENOENT") console.warn("[listing training requests] failed", error); return null; }
  }

  function removeRequest(file) {
    if (!file) return;
    try { fs.rmSync(file, { force: true }); } catch (error) { console.warn("[removing a training request] failed", error); }
  }

  // The owner record on disk: null when there is none, {damaged: reason} when it cannot be read as one.
  function readOwner() {
    try {
      const value = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
      if (!value || typeof value !== "object" || !(Number(value.child_pid) > 0)) throw new Error("not an owner record");
      return value;
    } catch (error) {
      // not an error: ENOENT is no job running anywhere; any other failure is returned and reported by the caller
      if (error?.code === "ENOENT") return null;
      return { damaged: String(error?.message || error) };
    }
  }

  function removeOwner(reason) {
    try { fs.rmSync(ownerPath, { force: true }); } catch (error) { console.error(`[removing the training job owner record (${reason})] failed`, error); }
  }

  function recordOwnerRecovery(outcome, owner, detail) {
    try {
      remediation?.emit({ component: "training_job_runner", mechanismId: "training.owner_recovered",
        triggerReason: "previous_health_gone", outcome, identity: {},
        detail: { job_id: owner?.job_id ?? null, previous_owner: owner?.instance ?? null, child_pid: owner?.child_pid ?? null, ...detail } });
    } catch (error) { console.warn("[recording the training job owner recovery] failed", error); }
  }

  // Reported once per distinct problem, not every poll.
  function ownerProblem(message, owner = null) {
    if (message !== lastOwnerProblem) {
      console.error(`[TRAINING JOB] ${message}; no training job starts until it is resolved`);
      recordOwnerRecovery("failed", owner, { blocked: message });
    }
    lastOwnerProblem = message;
  }

  // Another instance's record: true when nothing of it stands in the way of a start (its process is gone).
  function checkForeignOwner(owner) {
    const pid = Number(owner.child_pid);
    if (!processAlive(pid)) {
      console.warn(`[TRAINING JOB] the job ${owner.job_id} of an earlier Health (${owner.instance}) is no longer running; its owner record is released`);
      removeOwner("its process is gone");
      recordOwnerRecovery("succeeded", owner, { released: "its process is gone" });
      adopted = null;
      return true;
    }
    verifying = true;
    createdMsAsync(pid).then((created) => {
      verifying = false;
      if (created === null) {
        ownerProblem(`pid ${pid} of the earlier job ${owner.job_id} is alive and its creation time cannot be read to verify it`, owner);
        return;
      }
      if (created !== Number(owner.child_created_ms)) {
        console.warn(`[TRAINING JOB] pid ${pid} of the earlier job ${owner.job_id} now names another process; its owner record is released`);
        removeOwner("its pid names another process");
        recordOwnerRecovery("succeeded", owner, { released: "its pid names another process" });
        adopted = null;
        tick();
        return;
      }
      if (adopted?.job_id !== owner.job_id) {
        console.warn(`[TRAINING JOB] the job ${owner.job_id} (pid ${pid}) of an earlier Health (${owner.instance}) still runs; it is kept and no other job starts until it ends`);
        recordOwnerRecovery("succeeded", owner, { kept: true });
      }
      adopted = owner;
      lastOwnerProblem = null;
      if (now().getTime() - Date.parse(owner.started_at) > jobTimeoutMs) void endAdopted(TRIGGERS.JOB_TIMEOUT);
    }, (error) => { verifying = false; ownerProblem(`verifying pid ${pid} of the earlier job ${owner.job_id} failed: ${error?.message || error}`, owner); });
    return false;
  }

  // Ends the earlier Health's job (past its time bound, or at a full shutdown); its record goes once it exited.
  async function endAdopted(trigger) {
    const owner = adopted;
    if (!owner) return true;
    const exited = await terminateTree(Number(owner.child_pid));
    recordForcedTermination(remediation, { component: "training_job_runner", serviceId: "training_job", pid: owner.child_pid,
      instanceId: owner.instance, trigger, graceMs: killGraceMs, exited,
      reason: trigger === TRIGGERS.JOB_TIMEOUT ? `an earlier Health's job ran past ${jobTimeoutMs} ms` : "Health is stopping" });
    if (exited) { removeOwner("the earlier job was ended"); adopted = null; }
    return exited;
  }

  // Durable before the job does anything: the owner record names the exact process, then "start" is sent. A record
  // that cannot be made (creation time unknown, write failed) is a failed start: the job's stdin is closed unsent.
  async function claimAndStart(target, fields) {
    let refused = null;
    try {
      const created = await createdMsAsync(target.pid);
      if (target.exitCode !== null && target.exitCode !== undefined) return;
      if (created === null) refused = `the creation time of pid ${target.pid} cannot be read`;
      else {
        writeJsonAtomic(ownerPath, { instance: instanceId, health_pid: process.pid, ...fields, child_pid: target.pid,
          child_created_ms: created, started_at: now().toISOString() }, { fsImpl: fs, pathImpl: path, indent: 0, durable: true });
      }
    } catch (error) {
      // not an error: the refused start is logged just below with this reason
      refused = `the owner record could not be written: ${error?.message || error}`;
    }
    if (refused) {
      console.error(`[TRAINING JOB] ${fields.job_id} is not started: ${refused}`);
      try { target.stdin?.end(); } catch (error) { console.warn("[closing an unstarted training job's stdin] failed", error); }
      return;
    }
    try { target.stdin?.end("start\n"); } catch (error) { console.error(`[TRAINING JOB] telling ${fields.job_id} to start failed; it exits unstarted`, error); }
  }

  function start(mode, jobId, tradingDate, requestFile = null) {
    // The security master is the one Health hands Rust B (health/main.js), so the job's features read the same file.
    const args = ["-m", "service.analysis.online_training.job", "--mode", mode, "--job-id", jobId, "--security-master", securityMaster,
      "--start-gate", "stdin"];
    if (tradingDate) args.push("--trading-date", tradingDate);
    if (requestFile) args.push("--request-file", requestFile);
    fs.mkdirSync(logDir, { recursive: true });
    const log = fs.createWriteStream(path.join(logDir, "training_job.log"), { flags: "a" });
    log.write(`\n[${new Date().toISOString()}] start ${mode} ${jobId}\n`);
    let stdout = "";
    let timedOut = false;
    current = { mode, job_id: jobId, trading_date: tradingDate || null, started_at: new Date().toISOString() };
    runs += 1;
    // The B this job's feature exports run: a copy named by its content, made now (health/main.js), so the job keeps
    // the build it started with and never holds the release file a deploy replaces.
    let binary;
    try {
      binary = analysisRuntimeBinary();
    } catch (error) {
      removeRequest(requestFile);
      finish({ ok: false, state: "FAILED", error: `analysis_runtime job copy failed: ${error?.message || error}` });
      log.end();
      return;
    }
    try {
      child = spawnImpl(pythonExecutable, args, {
        cwd: projectRoot, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        env: { ...env(), PYTHONUNBUFFERED: "1", STOCK_MONITOR_ANALYSIS_RUNTIME_EXE: binary },
      });
    } catch (error) {
      removeRequest(requestFile);
      finish({ ok: false, state: "FAILED", error: `spawn failed: ${error?.message || error}` });
      log.end();
      return;
    }
    current.pid = child.pid;
    // A job that already ended cannot take "start" (EPIPE): its exit reports the job, never an unhandled stream error.
    child.stdin?.on?.("error", (error) => logger.warn?.(`[TRAINING JOB] ${jobId}: its stdin failed (${error?.code || error?.message || error}); its exit reports the job`));
    void claimAndStart(child, { job_id: jobId, mode, trading_date: tradingDate || null });
    const timeout = setTimeout(() => { timedOut = true; endChild(child, TRIGGERS.JOB_TIMEOUT); }, jobTimeoutMs);
    timeout.unref?.();
    child.stdout?.on("data", (chunk) => { stdout = (stdout + chunk.toString()).slice(-RESULT_TAIL_CHARS); log.write(chunk); });
    child.stderr?.on("data", (chunk) => log.write(chunk));
    child.once("error", (error) => { clearTimeout(timeout); removeRequest(requestFile); finish({ ok: false, state: "FAILED", error: `process error: ${error?.message || error}` }); log.end(); });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      removeRequest(requestFile);
      const parsed = lastJsonLine(stdout);
      if (stopping) finish({ ok: false, state: "INTERRUPTED", error: "Health stopped the job" });
      else if (timedOut) finish({ ok: false, state: "FAILED", error: `training job timed out after ${jobTimeoutMs} ms` });
      else finish(parsed && typeof parsed === "object" ? parsed : { ok: false, state: "FAILED", error: `job exited code=${code} without a result` });
      log.end();
    });
  }

  function finish(result) {
    if (!current) return;
    const finished = { ...current, ...result, completed_at: new Date().toISOString() };
    lastResult = finished;
    child = null;
    if (readOwner()?.instance === instanceId) removeOwner("its job ended");
    if (result?.ok === false) logger.warn?.(`[TRAINING JOB] ${current?.mode} ${current?.job_id}: ${result.state} ${result.error || result.reason || ""}`);
    current = null;
  }

  function endChild(target, trigger = TRIGGERS.STOP_GRACE_EXCEEDED) {
    endChildTree(target, remediation, { component: "training_job_runner", serviceId: "training_job", trigger,
      reason: trigger === TRIGGERS.JOB_TIMEOUT ? `timed out after ${jobTimeoutMs} ms` : "Health is stopping" },
    { graceMs: killGraceMs, platform, execFileImpl, logger })
      .catch((error) => logger.error?.(`[TRAINING JOB] ending pid ${target?.pid} failed: ${error?.message || error}`));
  }

  function tick() {
    if (stopping || child || verifying) return;
    const owner = readOwner();
    if (owner?.damaged) { ownerProblem(`the owner record ${ownerPath} is unreadable (${owner.damaged})`, owner); return; }
    if (owner && owner.instance !== instanceId && !checkForeignOwner(owner)) return;
    const request = pendingRequest();
    if (request) {
      start("manual", request.jobId, null, request.file);
      return;
    }
    const cfg = config();
    const auto = cfg?.auto;
    if (!auto) return;
    const settled = settledStkDay();
    if (settled?.status !== "materialized" || !settled.trading_date) return;
    if (quietNow(auto.quiet, taipeiClock(now()).hhmm)) return;
    const date = String(settled.trading_date).slice(0, 10);
    if (!autoDue(date, settled.settled_at)) return;
    if (!materializerIdle()) return;
    start("auto", `auto-${date}-${Date.now()}`, date);
  }

  return {
    start() {
      if (!timer) {
        stopping = false;
        timer = setInterval(tick, Math.max(1000, pollSeconds * 1000));
        timer.unref?.();
        // A manual request starts its job when its file appears, not on the next poll (which is the auto schedule's).
        try {
          fs.mkdirSync(requestsDir, { recursive: true });
          watcher = fs.watch(requestsDir, () => tick());
          watcher.on("error", (error) => console.error(`[watching training requests ${requestsDir}] failed; requests start on the ${pollSeconds} s poll`, error));
        } catch (error) {
          console.error(`[watching training requests ${requestsDir}] failed; requests start on the ${pollSeconds} s poll`, error);
        }
        tick();
      }
    },
    tick,
    // Full shutdown: a running job is ended (it is not on the data path) and reported as interrupted.
    async stopAndWait(timeoutMs = killGraceMs + 5000) {
      stopping = true;
      if (timer) { clearInterval(timer); timer = null; }
      if (watcher) { watcher.close(); watcher = null; }
      const running = current ? { ...current } : adopted ? { ...adopted, adopted: true } : null;
      if (child) endChild(child);
      const leftover = adopted ? Number(adopted.child_pid) : null;
      const adoptedEnded = await endAdopted(TRIGGERS.STOP_GRACE_EXCEEDED);
      const deadline = Date.now() + timeoutMs;
      while (child && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      const still = [...(child ? [child.pid] : []), ...(adoptedEnded ? [] : [leftover])];
      return { ok: !still.length, stopped: !still.length, interrupted: running, still_running: still };
    },
    probe() {
      return { alive: Boolean(timer), running: current || (adopted ? { ...adopted, adopted: true } : null), last_result: lastResult,
        schedule: schedule(), runs, owner_problem: lastOwnerProblem };
    },
  };
}

module.exports = { createTrainingJobRunner, taipeiClock };
