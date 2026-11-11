"use strict";

const { writeJsonAtomic, readJsonObject } = require("../service/platform/js/atomic_files");
const { TRIGGERS, recordForcedTermination, terminateProcessTree, endChildTree, childExited } = require("../service/platform/js/forced_termination");
const { dataChild } = require("../config/js/system_contract.js");

// Health's lifecycle-only half of M12 (Historical Materializer): spawn and
// monitor the one-shot Rust job, never decide whether a session is sealed or
// mutate its business-state (docs/system-architecture/00_services_and_ports.md §2: "封盤／交易時段判斷由業務規則負責，
// Health 只管理程序"). The
// per-source orchestrator (Shioaji: SessionOrchestrator/rollover.py; Futu:
// FutuSessionLifecycleCoordinator/session_lifecycle.py) is the only thing
// that requests a job (by writing a pending job-request file) and the only
// thing that mutates materialization_status from the job's result.
//
// File-based, not RPC: this process (the Controller/Health) and the daemon
// processes that own materialization_status are separate OS processes with
// no existing RPC channel between them. Every other cross-process signal in
// this app already goes through an atomically-written JSON file under
// output/ (health_supervisor.json, recovery_request.json, the dataflow
// snapshots health_supervisor_loop.js itself reads) -- this reuses that same
// convention instead of inventing a new IPC mechanism.
//
// output/materialization_jobs/pending/<job_id>.json  -- written by Python,
//   consumed (spawn + delete) by this loop.
// output/materialization_jobs/done/<job_id>.json      -- written by this
//   loop, consumed (read + delete) by the requesting Python orchestrator.
//
// WAL retention follows the same split (B14): the session owner decides the
// cutoff from what is materialized and writes
// output/materialization_jobs/wal_retention/request.json {before_ns}; this
// loop forwards it to market_runtime (`wal.prune`, controller role) and writes
// wal_retention/result.json. market_runtime enforces its own safety (checkpoint
// first, never the segment being written); nothing here decides what is safe.

const { spawn: defaultSpawn } = require("child_process");
const { resolveVarPaths } = require("../config/js/var_paths");
const { childEnv } = require("../service/platform/js/child_env");
const { jobBinary } = require("../service/platform/js/native_job_binary");

const JOB_RESULT_SCHEMA = "materialization-job-result-v1";
const RETENTION_RESULT_SCHEMA = "wal-retention-result-v1";
// A whole-session job reads every WAL segment still held: 149 s for an STK day with 14 GB of WAL,
// and 120 s killed it (and the FUT day and night before it) five times over until the ledger gave up. The bound is
// the ledger's own running lease (RUN_LEASE_SECONDS = 900, materialization_ledger.py): longer than that, the job is
// lost anyway.
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const PRUNE_TIMEOUT_MS = 60000;
// How long an earlier Health's still-running job process gets to exit after it is terminated, before its claim is
// left blocked, and how far its OS creation time may sit from the spawn time its owner record states.
const ORPHAN_EXIT_MS = 10000;
const ORPHAN_IDENTITY_TOLERANCE_MS = 5000;

function atomicWriteJson(fsImpl, pathImpl, targetPath, payload) {
  writeJsonAtomic(targetPath, payload, { fsImpl, pathImpl, indent: 0 });
}

const KILL_GRACE_MS = 10_000;
const STDOUT_TAIL_CHARS = 64 * 1024;
const STDERR_TAIL_CHARS = 16 * 1024;

function tail(text, limit) {
  return text.length > limit ? text.slice(-limit) : text;
}

const PROGRESS_SCHEMA = "materialization-progress-v2";
// Finished jobs kept in progress.json: a few days of closes (Shioaji closes 4 sessions a day, Futu one per code).
const PROGRESS_KEEP = 40;
// progress.json is rewritten at most this often while lines arrive; a phase change and a job's end write at once.
const PROGRESS_WRITE_MS = 1000;

// A `{"progress": {...}}` line of the job's stderr (native/analysis_runtime/src/materialize.rs), or null for any other
// line.
function parseProgressLine(line) {
  if (!line.startsWith('{"progress"')) return null;
  try {
    const progress = JSON.parse(line).progress;
    return progress && typeof progress.phase === "string" ? progress : null;
  } catch (error) {
    console.warn("[reading a materializer progress line] failed", error);
    return null;
  }
}

function parseResultLine(stdout) {
  const lines = String(stdout || "").trim().split("\n").filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return null;
  try {
    return JSON.parse(last);
  } catch (_error) { /* not an error: a last output line that is not JSON is no result; the caller reports the job as failed */ return null; }
}

function createMaterializerJobRunner({
  // `binaryPath`: Rust B's own binary (AnalysisRuntimeHost.binaryPath), run in its one-shot `--materialize` mode, so
  // history is folded by B's canonical engine and never one of its own.
  projectRoot, dataRoot, binaryPath, fs, path,
  spawnImpl = defaultSpawn, pollSeconds = 5, jobTimeoutMs = DEFAULT_TIMEOUT_MS, logger = console, marketRuntime = null,
  maxConcurrent = 2, killGraceMs = KILL_GRACE_MS, execFileImpl = require("node:child_process").execFile,
  platform = process.platform, env = () => childEnv(process.env), historicalDir = null, configRoot = null, dailySummaryDir = null, kbarDir = null, remediation = null,
  processAlive = require("../service/platform/js/process_utils").processAliveFast,
  createdMs = require("../service/platform/js/process_utils").processCreatedMsAsync,
  jobBinaryDir = null,
}) {
  const readJob = (file) => readJsonObject(file, { fsImpl: fs, label: "a materializer job file" });
  const varPaths = resolveVarPaths({ projectRoot, env: process.env });
  const outputDir = varPaths.output;
  // Each job runs a copy of B named by its content, never the release file the deploy replaces
  // (service/platform/js/native_job_binary.js).
  const jobBinaryRoot = jobBinaryDir || path.join(varPaths.state, "native_jobs");
  // One job, three places (service/market/shared/materialization_jobs.py): pending/ (requested),
  // claimed/ (taken by an atomic rename, run by this Health), done/ (its result, written before the claim goes).
  // A request that cannot be read is moved to quarantine/ and answered with an invalid_request result.
  const pendingDir = path.join(outputDir, "materialization_jobs", "pending");
  const claimedDir = path.join(outputDir, "materialization_jobs", "claimed");
  const quarantineDir = path.join(outputDir, "materialization_jobs", "quarantine");
  const doneDir = path.join(outputDir, "materialization_jobs", "done");
  const instanceId = `materializer-${process.pid}-${Date.now()}`;
  const walDataDir = path.join(dataRoot, dataChild("market_runtime"));
  // The raw-history folder (設定 → 資料儲存, config/js/storage_settings.js); Health activates a new one before this runs.
  const historicalOutDir = typeof historicalDir === "function" ? historicalDir() : historicalDir || path.join(dataRoot, "historical");
  const retentionDir = path.join(outputDir, "materialization_jobs", "wal_retention");
  let pruning = false;
  let lastPrune = null;
  // What the session owners say is not materialized yet and when the next run is due (wal_retention.py
  // materialization_status): carried in the probe so the monitoring snapshot (連線診斷 WAL) can show it.
  let materialization = null;

  const inFlight = new Set();
  // Running job processes: bounded (never every pending job at once), and ended when Health stops
  // so none outlives it and a restarted Health never runs the same job twice.
  const children = new Map();
  let stopping = false;
  let timer = null;
  let runsStarted = 0;
  let runsCompleted = 0;
  let runsFailed = 0;
  let lastError = null;

  // Each job's run as its process reports it (progress.json, read by the data center's 收盤整理 card through the
  // Shioaji session owner): identity, start and end, its phases (done / total / elapsed_ms, first seen at) and how it
  // ended. Only the process's own facts -- whether the session is sealed or materialized stays the ledger's.
  const progressPath = path.join(outputDir, "materialization_jobs", "progress.json");
  const progressJobs = new Map();
  let progressWrittenAt = 0;
  let progressTimer = null;
  {
    const previous = readJob(progressPath);
    const jobs = previous?.schema === PROGRESS_SCHEMA && previous.jobs && typeof previous.jobs === "object" ? previous.jobs : {};
    for (const [jobId, entry] of Object.entries(jobs)) {
      // A run an earlier Health left open ended with that Health (its claim is recovered and run again).
      progressJobs.set(jobId, entry?.status === "running" ? { ...entry, status: "interrupted", ended_at: entry.updated_at || null } : entry);
    }
  }

  function writeProgress() {
    if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
    progressWrittenAt = Date.now();
    const kept = [...progressJobs.entries()].sort(([, a], [, b]) => String(b.started_at).localeCompare(String(a.started_at)))
      .slice(0, PROGRESS_KEEP);
    progressJobs.clear();
    for (const [jobId, entry] of kept) progressJobs.set(jobId, entry);
    try {
      atomicWriteJson(fs, path, progressPath, { schema: PROGRESS_SCHEMA, updated_at: new Date().toISOString(), jobs: Object.fromEntries(kept) });
    } catch (error) {
      lastError = `writing progress.json: ${error?.message || error}`;
      logger.error?.(`[MATERIALIZER JOB] ${lastError}`);
    }
  }

  function noteProgress(jobId, line, { now = false } = {}) {
    const entry = progressJobs.get(jobId);
    if (!entry) return;
    const at = new Date().toISOString();
    entry.updated_at = at;
    if (line) {
      const phaseChanged = entry.phase !== line.phase;
      const before = entry.phases[line.phase];
      entry.phase = line.phase;
      entry.phases[line.phase] = { done: line.done ?? null, total: line.total ?? null, elapsed_ms: line.elapsed_ms ?? null,
        started_at: before?.started_at || at };
      now ||= phaseChanged;
    }
    if (now || Date.now() - progressWrittenAt >= PROGRESS_WRITE_MS) writeProgress();
    else if (!progressTimer) {
      progressTimer = setTimeout(writeProgress, PROGRESS_WRITE_MS);
      progressTimer.unref?.();
    }
  }

  function startProgress(jobId, request) {
    const at = new Date().toISOString();
    progressJobs.set(jobId, { job_id: jobId, source: request.source ?? null, market: request.market ?? null, code: request.code ?? null,
      trading_date: request.trading_date ?? null, session: request.session ?? null, close_operation_id: request.close_operation_id ?? null,
      started_at: at, updated_at: at, ended_at: null, status: "running", error: null, phase: null, phases: {} });
    noteProgress(jobId, null, { now: true });
  }

  function endProgress(jobId, status, error) {
    const entry = progressJobs.get(jobId);
    if (!entry) return;
    Object.assign(entry, { status, error: error || null, ended_at: new Date().toISOString() });
    noteProgress(jobId, null, { now: true });
  }

  function listPendingJobIds() {
    try {
      return fs.readdirSync(pendingDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length));
    } catch (error) { /* absent is not an error: no jobs directory yet */ if (error?.code !== "ENOENT") console.warn("[listing materializer jobs] failed", error); return []; }
  }

  function writeResult(jobId, payload) {
    atomicWriteJson(fs, path, path.join(doneDir, `${jobId}.json`), { schema: JOB_RESULT_SCHEMA, job_id: jobId,
      completed_at: new Date().toISOString(), ...payload });
  }

  function recordClaimRecovery(outcome, detail) {
    try {
      remediation?.emit({ component: "materializer_job_runner", mechanismId: "materialization.claim_recovered",
        triggerReason: "previous_health_gone", outcome, identity: {}, detail });
    } catch (error) { console.warn("[recording the materializer claim recovery] failed", error); }
  }

  // Back to pending, recorded: only once nothing of the earlier Health still runs it.
  function requeue(jobId, owner, pid) {
    const name = `${jobId}.json`;
    try {
      fs.renameSync(path.join(claimedDir, name), path.join(pendingDir, name));
      fs.rmSync(path.join(claimedDir, `${jobId}.owner.json`), { force: true });
      recordClaimRecovery("succeeded", { job_id: jobId, previous_owner: owner.instance || null, child_pid: pid || null });
    } catch (error) {
      lastError = `claim recovery ${jobId}: ${error?.message || error}`;
      logger.error?.(`[MATERIALIZER JOB] ${lastError}`);
    }
  }

  // Left claimed -- never run twice -- with why, for the next start (and the operator) to see.
  function recordBlockedClaim(jobId, owner, pid, reason) {
    lastError = `claim ${jobId} blocked: ${reason}`;
    logger.error?.(`[MATERIALIZER JOB] ${lastError}`);
    try { atomicWriteJson(fs, path, path.join(claimedDir, `${jobId}.owner.json`), { ...owner, blocked: { reason, at: new Date().toISOString() } }); }
    catch (error) { console.warn("[marking a materializer claim blocked] failed", error); }
    recordClaimRecovery("failed", { job_id: jobId, previous_owner: owner.instance || null, child_pid: pid || null, blocked: reason });
  }

  // The earlier Health's job process: ended, and proven gone, before its job is queued again.
  async function endOrphan(jobId, owner, pid) {
    const gone = await terminateProcessTree(pid, { forceOnly: true, platform, execFileImpl, alive: processAlive, waitMs: ORPHAN_EXIT_MS, logger });
    recordForcedTermination(remediation, { component: "materializer_job_runner", serviceId: "materializer_job", pid,
      trigger: TRIGGERS.ORPHAN, reason: "job of an earlier Health still running", graceMs: ORPHAN_EXIT_MS, exited: gone });
    if (!gone) { recordBlockedClaim(jobId, owner, pid, `its process ${pid} did not exit within ${ORPHAN_EXIT_MS} ms of being terminated`); return; }
    requeue(jobId, owner, pid);
    tick();
  }

  // Claimed by a Health that is gone (it ended its jobs when it stopped, or it crashed). A claim whose result was
  // already written is finished: only the claim goes. One whose process still runs -- that exact process, by
  // its creation time -- is ended first, and queued again only once it has exited; one that cannot be proven either
  // way stays claimed, blocked.
  async function recoverClaims() {
    let names = [];
    try { names = fs.readdirSync(claimedDir).filter((name) => name.endsWith(".json") && !name.endsWith(".owner.json")); } catch (error) { /* absent is not an error: no claims directory yet */ if (error?.code !== "ENOENT") console.warn("[listing claimed materializer jobs] failed", error); return; }
    for (const name of names) {
      const jobId = name.slice(0, -".json".length);
      const ownerPath = path.join(claimedDir, `${jobId}.owner.json`);
      const owner = readJob(ownerPath) || {};
      if (owner.instance === instanceId) continue;
      const pid = Number(owner.child_pid || 0);
      if (fs.existsSync(path.join(doneDir, name))) {
        try {
          fs.rmSync(path.join(claimedDir, name), { force: true });
          fs.rmSync(ownerPath, { force: true });
          recordClaimRecovery("succeeded", { job_id: jobId, previous_owner: owner.instance || null, child_pid: pid || null, already_done: true });
        } catch (error) { lastError = `clearing finished claim ${jobId}: ${error?.message || error}`; logger.error?.(`[MATERIALIZER JOB] ${lastError}`); }
        continue;
      }
      if (pid > 0 && processAlive(pid)) {
        const started = Number(owner.child_started_ms || 0);
        const created = started > 0 ? await createdMs(pid) : null;
        if (stopping) return;   // the next Health recovers what is left
        if (started > 0 && created !== null && Math.abs(created - started) > ORPHAN_IDENTITY_TOLERANCE_MS) {
          requeue(jobId, owner, pid);         // the pid now names another process: the job's own is gone
          continue;
        }
        if (!(started > 0) || created === null) {
          recordBlockedClaim(jobId, owner, pid, `pid ${pid} is alive and cannot be verified as this job's process`);
          continue;
        }
        void endOrphan(jobId, owner, pid).catch((error) => recordBlockedClaim(jobId, owner, pid, `ending it failed: ${error?.message || error}`));
        continue;
      }
      requeue(jobId, owner, pid);
    }
  }

  function runOneJob(jobId) {
    const pendingPath = path.join(pendingDir, `${jobId}.json`);
    const claimedPath = path.join(claimedDir, `${jobId}.json`);
    const ownerPath = path.join(claimedDir, `${jobId}.owner.json`);
    const request = readJob(pendingPath);
    if (!request) {
      // Not deleted: kept in quarantine with an invalid_request result the ledger records as terminal.
      try {
        fs.mkdirSync(quarantineDir, { recursive: true });
        fs.renameSync(pendingPath, path.join(quarantineDir, `${jobId}.json`));
        writeResult(jobId, { ok: false, status: "invalid_request", error: "the request file could not be read; kept in quarantine/" });
      } catch (error) {
        lastError = `quarantine ${jobId}: ${error?.message || error}`;
        logger.error?.(`[MATERIALIZER JOB] ${lastError}: the unreadable request could not be moved to quarantine/`);
      }
      return;
    }
    // The claim: an atomic rename, so the job is pending or claimed, never both or neither.
    try {
      fs.mkdirSync(claimedDir, { recursive: true });
      fs.renameSync(pendingPath, claimedPath);
    } catch (error) {
      lastError = `claim ${jobId}: ${error?.message || error}`;
      logger.error?.(`[MATERIALIZER JOB] ${lastError}; the job stays pending`);
      return;
    }
    inFlight.add(jobId);
    runsStarted += 1;
    startProgress(jobId, request);
    // A closed session folded again from the historical store with its gaps' fills (service/market/shioaji/
    // history_fill.py): the store, not the WAL, is its input, and its completeness is the job's own (materialize.rs).
    const fill = request.fill && typeof request.fill === "object" ? request.fill : null;
    const input = fill
      ? ["--input", "store", "--fills-dir", String(fill.fills_dir || "")]
      : ["--data-dir", walDataDir];
    const args = [
      "--materialize",
      ...input,
      "--out-dir", historicalOutDir,
      "--source", String(request.source || ""),
      "--market", String(request.market || ""),
      "--code", String(request.code || ""),
      "--logical-code", String(request.logical_code || request.code || ""),
      "--trading-date", String(request.trading_date || ""),
      "--session", String(request.session || ""),
      "--completeness", String(request.completeness || "gap_detected"),
      // The job does nothing until it reads "start" on stdin -- sent only once its owner record is on disk.
      "--start-gate", "stdin",
      // Publishing goes through the historical store's manager (native/market_runtime/src/historical_store.rs), which
      // drops a partition retention already removes: A's cutoffs, the storage_retention revision, the traded codes.
      "--rollover-cutoffs", path.join(dataRoot, ...dataChild("rollover_cutoffs").split("/")),
      "--traded-codes-dir", path.join(dataRoot, ...dataChild("traded_codes").split("/")),
    ];
    // Only the storage_retention revision is read from it: --config-root would also fold the history under the flow/event
    // rules, which the job has never been given.
    if (configRoot) args.push("--retention-config-root", configRoot);
    // A whole Shioaji session's daily summary (training data under the storage location, native/analysis_runtime/src/
    // daily_summary.rs).
    // The codes whose session evidence holds a broker-connection outage during trading: never complete.
    const gapCodes = Array.isArray(request.gap_codes) ? request.gap_codes.map(String).filter(Boolean) : [];
    if (gapCodes.length) args.push("--gap-codes", gapCodes.join(","));
    // The codes whose every such outage was filled from the broker's history and verified: repaired at best.
    const repairedCodes = Array.isArray(request.repaired_codes) ? request.repaired_codes.map(String).filter(Boolean) : [];
    if (repairedCodes.length) args.push("--repaired-codes", repairedCodes.join(","));
    const unresolved = fill && Array.isArray(fill.unresolved_codes) ? fill.unresolved_codes.map(String).filter(Boolean) : [];
    if (unresolved.length) args.push("--unresolved-codes", unresolved.join(","));
    // The durable events the user decided are void (Market Runtime's list, native/market_runtime/src/voided.rs): left
    // out of every session, whichever its input.
    args.push("--voided-events", path.join(dataRoot, ...dataChild("voided_events").split("/")));
    // A US half day's sessions are shorter: the calendar Market Runtime splits by (OpenD's, over the NYSE days).
    args.push("--us-trading-calendar", path.join(dataRoot, ...dataChild("us_trading_calendar").split("/")));
    const summaryDir = typeof dailySummaryDir === "function" ? dailySummaryDir() : dailySummaryDir;
    if (summaryDir) args.push("--daily-summary-dir", summaryDir);
    // The session's K bars for 技術分析 (native/analysis_runtime/src/kbar_store.rs); the job also ages every file to the
    // kbar_retention revision.
    const kbars = typeof kbarDir === "function" ? kbarDir() : kbarDir;
    if (kbars) args.push("--kbar-dir", kbars);
    // A whole Shioaji STK / Futu US session's 量變 baseline (native/analysis_runtime/src/baseline_publish.rs), read by
    // Rust B from the same root (analysis_runtime_host.js --volume-baseline-root).
    args.push("--volume-baseline-root", path.join(dataRoot, "market"));
    let binary = null;
    let child;
    // Only the tails are kept: the result is stdout's last line, stderr is reported as its tail. A binary stuck in
    // an output loop would otherwise grow both without bound for the job's whole lifetime.
    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = null;
    let ownerWriteFailed = null;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      inFlight.delete(jobId);
      children.delete(jobId);
      // Ended by Health stopping: no result; the claim goes back to pending for the next start.
      if (stopping) {
        endProgress(jobId, "interrupted", "Health stopped");
        try { fs.renameSync(claimedPath, pendingPath); fs.rmSync(ownerPath, { force: true }); } catch (error) { console.warn("[returning a materializer claim to pending (recovered at the next start)] failed", error); }
        return;
      }
      if (result.ok) runsCompleted += 1; else runsFailed += 1;
      endProgress(jobId, String(result.status || (result.ok ? "materialized" : "retryable")), result.ok ? null : result.error);
      // Completion first, then the claim goes: the job is always in exactly one place.
      try {
        writeResult(jobId, { request, ...result });
      } catch (error) {
        lastError = String(error?.message || error);
        logger.error?.(`[MATERIALIZER JOB] failed to write result for ${jobId}: ${lastError}; the claim stays until the next start`);
        return;
      }
      try { fs.unlinkSync(claimedPath); } catch (error) { /* absent is not an error: already removed */ if (error?.code !== "ENOENT") console.warn("[removing a finished materializer claim] failed", error); }
      try { fs.rmSync(ownerPath, { force: true }); } catch (error) { console.warn("[removing a materializer owner record] failed", error); }
    };

    try {
      binary = jobBinary({ fs, path, source: binaryPath, dir: jobBinaryRoot });
    } catch (error) {
      // not an error: recorded -- finish() writes the failure as this job's result, which the materialization ledger keeps
      finish({ ok: false, status: "retryable", error: `materializer binary unavailable (${binaryPath}): ${error?.message || error}` });
      return;
    }
    try {
      child = spawnImpl(binary, args, { cwd: projectRoot, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: env() });
      children.set(jobId, child);
      // A job that already ended cannot take "start" (EPIPE): that is its exit's business, reported with its result --
      // never an unhandled stream error in Health.
      child.stdin?.on?.("error", (error) => logger.warn?.(`[MATERIALIZER JOB] ${jobId}: its stdin failed (${error?.code || error?.message || error}); its exit reports the job`));
    } catch (error) {
      // not an error: recorded -- finish() writes the failure as this job's result, which the materialization ledger keeps
      finish({ ok: false, status: "retryable", error: `spawn failed: ${error?.message || error}` });
      return;
    }
    // A timed-out job is not over until its process is: it stays in flight (and in `children`) until the exit
    // event, so no restart or next tick starts the same job beside a still-running one.
    const timeout = setTimeout(() => {
      timedOut = `materializer job timed out after ${jobTimeoutMs}ms`;
      endChild(child, TRIGGERS.JOB_TIMEOUT);
    }, jobTimeoutMs);
    timeout.unref?.();
    child.stdout?.on("data", (chunk) => { stdout = tail(stdout + chunk.toString(), STDOUT_TAIL_CHARS); });
    // Stderr is the job's progress lines and its diagnostics: a progress line goes to progress.json, every other line to
    // the tail reported with a failure.
    let stderrPartial = "";
    child.stderr?.on("data", (chunk) => {
      const lines = (stderrPartial + chunk.toString()).split("\n");
      stderrPartial = lines.pop();
      for (const raw of lines) {
        const line = raw.replace(/\r$/, "");
        const progress = parseProgressLine(line);
        if (progress) noteProgress(jobId, progress);
        else stderr = tail(`${stderr}${line}\n`, STDERR_TAIL_CHARS);
      }
      if (stderrPartial.length > STDERR_TAIL_CHARS) { stderr = tail(stderr + stderrPartial, STDERR_TAIL_CHARS); stderrPartial = ""; }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      finish({ ok: false, status: "retryable", error: `process error: ${error?.message || error}` });
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (ownerWriteFailed) {
        finish({ ok: false, status: "retryable", error: ownerWriteFailed });
        return;
      }
      if (timedOut) {
        finish({ ok: false, status: "retryable", error: timedOut, stderr_tail: stderr.slice(-2000) });
        return;
      }
      const parsed = parseResultLine(stdout);
      if (parsed && typeof parsed === "object") {
        finish(parsed);
      } else {
        finish({
          ok: false, status: "retryable",
          error: `materializer exited code=${code} with unparseable stdout`,
          stderr_tail: stderr.slice(-2000),
        });
      }
    });
    // The owner record before any work: the process's pid and OS creation time, durable, so a later Health that finds
    // this claim knows exactly which process may still be writing. Only then is the job told to start; a Health that
    // dies before that closes the job's stdin and the job ends without touching anything. An owner record that cannot
    // be written is a failed start: the job is never told to start. Runs after the exit listener above: the creation
    // time is awaited, and the job can end meanwhile.
    void (async () => {
      try {
        const pid = child.pid ?? null;
        const started = (pid ? await createdMs(pid) : null) ?? Date.now();
        if (finished || childExited(child)) return;   // settled by its exit: a record written now would outlive the job
        writeJsonAtomic(ownerPath, { instance: instanceId, health_pid: process.pid, child_pid: pid,
          child_started_ms: started, claimed_at: new Date().toISOString() },
        { fsImpl: fs, pathImpl: path, indent: 0, durable: true });
      } catch (error) {
        logger.error?.(`[MATERIALIZER JOB] the owner record of ${jobId} could not be written; the job is not started: ${error?.message || error}`);
        ownerWriteFailed = `owner record not written: ${error?.message || error}`;
        try { child.stdin?.end(); } catch (endError) { console.warn("[closing an unstarted materializer job's stdin] failed", endError); }
        return;
      }
      try { child.stdin?.end("start\n"); } catch (error) { console.warn("[starting a materializer job] failed", error); }
    })();
  }

  // Ends the process and its whole tree (a child it spawned would otherwise outlive it). Its exit event is what finally
  // releases the job.
  function endChild(target, trigger = TRIGGERS.STOP_GRACE_EXCEEDED) {
    endChildTree(target, remediation, { component: "materializer_job_runner", serviceId: "materializer_job", trigger,
      reason: trigger === TRIGGERS.JOB_TIMEOUT ? `timed out after ${jobTimeoutMs} ms` : "Health is stopping" },
    { graceMs: killGraceMs, platform, execFileImpl, logger })
      .catch((error) => logger.error?.(`[MATERIALIZER JOB] ending pid ${target?.pid} failed: ${error?.message || error}`));
  }

  async function forwardRetention() {
    const requestPath = path.join(retentionDir, "request.json");
    if (pruning || !marketRuntime || !fs.existsSync(requestPath)) return;
    const request = readJob(requestPath);
    const beforeNs = Number(request?.before_ns);
    pruning = true;
    let result;
    try {
      if (!Number.isFinite(beforeNs) || beforeNs <= 0) {
        result = { ok: false, error: "request without a valid before_ns" };
      } else {
        const reply = await marketRuntime.control("wal.prune", { before_ns: beforeNs }, PRUNE_TIMEOUT_MS, "wal.prune.ack");
        result = reply?.type === "wal.prune.ack" ? { ...(reply.payload || {}) } : { ok: false, error: reply?.error || "wal.prune refused" };
      }
    } catch (error) {
      // not an error: recorded -- result.ok is false, so the [WAL RETENTION] line below logs it and result.json keeps it
      result = { ok: false, error: String(error?.message || error) };
    }
    lastPrune = { schema: RETENTION_RESULT_SCHEMA, request, completed_at: new Date().toISOString(), ...result };
    try {
      atomicWriteJson(fs, path, path.join(retentionDir, "result.json"), lastPrune);
      fs.unlinkSync(requestPath);
    } catch (error) {
      lastError = String(error?.message || error);
      logger.error?.(`[WAL RETENTION] writing result.json or removing the request failed: ${lastError}`);
    }
    if (!result.ok) logger.error?.(`[WAL RETENTION] ${result.error || result.reason || "failed"}`);
    pruning = false;
  }

  function tick() {
    if (stopping) return;
    materialization = readJob(path.join(retentionDir, "status.json"));
    for (const jobId of listPendingJobIds()) {
      if (inFlight.size >= Math.max(1, maxConcurrent)) break;
      if (inFlight.has(jobId)) continue;
      runOneJob(jobId);
    }
    forwardRetention().catch((error) => {
      pruning = false;
      lastError = String(error?.message || error);
      logger.error?.(`[WAL RETENTION] forwarding the prune request failed: ${lastError}`);
    });
  }

  return {
    start() {
      if (!timer) {
        stopping = false;
        void recoverClaims().catch((error) => logger.error?.(`[MATERIALIZER JOB] recovering claimed jobs failed: ${error?.message || error}`));
        tick();
        timer = setInterval(tick, Math.max(1000, pollSeconds * 1000));
        timer.unref?.();
      }
      return process.pid;
    },
    stop() {
      stopping = true;
      if (timer) { clearInterval(timer); timer = null; }
      const ended = children.size;
      // Entries stay until each process has exited (see endChild), so a start() right after cannot double-run them.
      for (const child of children.values()) endChild(child);
      return { ok: true, stopped: true, in_flight: inFlight.size, ended_jobs: ended };
    },
    // Health's full shutdown waits on this before it exits: stop() only asked the processes to end,
    // and the 10 s force timer was unref'd, so a materializer could outlive Health.
    async stopAndWait(timeoutMs = killGraceMs + 5000) {
      const receipt = this.stop();
      const deadline = Date.now() + timeoutMs;
      while (children.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      const remaining = [...children.values()].map((child) => child.pid).filter(Boolean);
      return { ...receipt, ok: remaining.length === 0, stopped: remaining.length === 0, still_running: remaining };
    },
    // The running jobs' processes, for 連線診斷 記憶體 (user 10-22).
    childPids() {
      return [...children.values()].map((child) => child.pid).filter(Boolean);
    },
    probe() {
      return {
        alive: Boolean(timer), pid: process.pid, in_flight: inFlight.size, pending: listPendingJobIds().length,
        runs_started: runsStarted, runs_completed: runsCompleted, runs_failed: runsFailed,
        last_error: lastError, wal_retention: lastPrune, materialization,
      };
    },
  };
}

module.exports = {
  createMaterializerJobRunner,
  parseResultLine,
  parseProgressLine,
  PROGRESS_SCHEMA,
  JOB_RESULT_SCHEMA,
  RETENTION_RESULT_SCHEMA,
};
