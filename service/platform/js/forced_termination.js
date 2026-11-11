"use strict";

// One record for every forced termination. A process ended by force -- a stop that ran past its
// grace, a start that never came up, a job past its timeout, the shutdown watchdog -- did not keep its stop contract,
// and that is never silent: each is a `health.forced_termination` remediation naming the service, the exact process
// (pid + instance), why, the grace it had and whether it really exited.

const { execFile } = require("child_process");
const { processAliveFast } = require("./process_utils");

const TRIGGERS = Object.freeze({
  STOP_GRACE_EXCEEDED: "stop_grace_exceeded",
  START_FAILED: "start_failed",
  JOB_TIMEOUT: "job_timeout",
  SHUTDOWN_WATCHDOG: "shutdown_watchdog",
  ORPHAN: "orphan_of_previous_owner",
});

function recordForcedTermination(remediation, { component, serviceId, pid = null, instanceId = null, trigger, reason = null,
  graceMs = null, exited, detail = {} }) {
  try {
    remediation?.emit({ component, mechanismId: "health.forced_termination", triggerReason: trigger,
      outcome: exited ? "succeeded" : "failed", identity: {},
      detail: { service_id: serviceId, pid: pid ?? null, instance_id: instanceId ?? null, reason, grace_ms: graceMs ?? null,
        exited: Boolean(exited), ...detail } });
  } catch (error) { console.warn("[recording a forced termination] failed", error); }
}

// Whether a child this process holds has ended. A child ended by a signal has signalCode and no exitCode -- what
// kill() leaves on Windows too.
function childExited(child) {
  return !child || (child.exitCode !== null && child.exitCode !== undefined) || Boolean(child.signalCode);
}

// Resolves true at the child's exit, false after `timeoutMs` (its listener removed).
function waitChildExit(child, timeoutMs) {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.off?.("exit", onExit); resolve(false); }, timeoutMs);
    timer.unref?.();
    child.once("exit", onExit);
  });
}

// Ends the process tree of `pid` and resolves whether it exited: taskkill /T, then /F, on Windows (`forceOnly` skips
// the polite round), SIGKILL elsewhere. The caller has already proven `pid` is the process it means (its own child
// handle, or an owner record with the process's creation time).
// A taskkill that failed while the process is still there is recorded with its exit code and stderr; one that failed
// because the process had already gone is the outcome asked for.
async function terminateProcessTree(pid, { execFileImpl = execFile, alive = processAliveFast, waitMs = 5000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), logger = console, forceOnly = false,
  platform = process.platform, killImpl = (target, signal) => process.kill(target, signal) } = {}) {
  const target = Number(pid || 0);
  if (!(target > 0)) return true;
  const exitedWithin = async () => {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (!alive(target)) return true;
      await sleep(200);
    }
    return !alive(target);
  };
  if (platform !== "win32") {
    if (!alive(target)) return true;
    try { killImpl(target, "SIGKILL"); }
    catch (error) {
      // not an error: a process that had already gone is the outcome asked for; one still there is warned
      if (alive(target)) logger.warn?.(`[killing pid ${target}] failed: ${error?.message || error}`);
    }
    return exitedWithin();
  }
  for (const force of forceOnly ? [true] : [false, true]) {
    if (!alive(target)) return true;
    await new Promise((resolve) => {
      const args = ["/PID", String(target), "/T", ...(force ? ["/F"] : [])];
      execFileImpl("taskkill.exe", args, { windowsHide: true }, (error, _stdout, stderr) => {
        if (error && alive(target)) {
          logger.warn?.(`[taskkill ${args.join(" ")}] failed (exit ${error.code ?? "?"}): ${String(stderr || error.message || error).trim().slice(0, 300)}`);
        }
        resolve();
      });
    });
    if (await exitedWithin()) return true;
  }
  return !alive(target);
}

// Force-ends the tree of a child this process holds and resolves whether it exited, judged by its exit event or its
// exitCode / signalCode: the pid is not re-read once the handle says it is gone.
async function forceEndChild(child, { platform = process.platform, execFileImpl = execFile, logger = console, waitMs = 5000 } = {}) {
  if (childExited(child)) return true;
  let exited = false;
  const onExit = () => { exited = true; };
  child.once("exit", onExit);
  try {
    return await terminateProcessTree(child.pid, { platform, execFileImpl, logger, waitMs, forceOnly: true,
      alive: () => !exited && !childExited(child), killImpl: (_pid, signal) => child.kill(signal) });
  } finally { child.off?.("exit", onExit); }
}

// Ends a job's child and its whole tree, and writes the one record of the outcome it actually had. On Windows kill()
// is TerminateProcess: there is no polite request to wait on, and with the parent gone taskkill /T cannot find its
// children, so the tree goes first, while the child is alive. Elsewhere SIGTERM gets `graceMs` first.
async function endChildTree(child, remediation, fields, { graceMs = 0, platform = process.platform, execFileImpl = execFile,
  logger = console, waitMs = 5000 } = {}) {
  if (childExited(child)) return true;
  if (platform !== "win32") {
    try { child.kill(); } catch (error) { logger.warn?.(`[asking pid ${child.pid} to stop] failed: ${error?.message || error}`); }
    await waitChildExit(child, graceMs);
  }
  const exited = await forceEndChild(child, { platform, execFileImpl, logger, waitMs });
  recordForcedTermination(remediation, { ...fields, pid: child.pid, graceMs: platform === "win32" ? 0 : graceMs, exited });
  return exited;
}

// Ends a child this process holds and records the outcome it actually had: the exit event, or none within
// `waitMs`. Reading exitCode right after kill() recorded "failed" for a child that exited a few ms later.
async function killChildAndRecord(child, remediation, fields, { waitMs = 5000 } = {}) {
  const exit = waitChildExit(child, waitMs);
  if (!childExited(child)) {
    try { child.kill(); } catch (error) { console.warn(`[ending ${fields.serviceId}] failed`, error); }
  }
  const exited = await exit;
  recordForcedTermination(remediation, { ...fields, pid: child?.pid ?? fields.pid ?? null, exited });
  return exited;
}

module.exports = { TRIGGERS, recordForcedTermination, terminateProcessTree, killChildAndRecord, childExited, waitChildExit,
  forceEndChild, endChildTree };
