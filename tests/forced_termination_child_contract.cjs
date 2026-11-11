"use strict";
// A child ended by kill() on Windows has signalCode and no exitCode, and a parent killed first leaves taskkill /T
// nothing to walk: the shared helpers judge by the exit event or either field, end the tree while the child lives,
// and write exactly one record with what really happened.
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { childExited, waitChildExit, forceEndChild, endChildTree, terminateProcessTree, TRIGGERS } =
  require("../service/platform/js/forced_termination.js");

function child(pid) {
  return Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null, kill: () => assert.fail("no kill() on Windows") });
}

(async () => {
  assert.equal(childExited(Object.assign(child(1), { signalCode: "SIGTERM" })), true, "ended by a signal");
  assert.equal(childExited(Object.assign(child(1), { exitCode: 0 })), true);
  assert.equal(childExited(child(1)), false);

  const waiting = child(2);
  assert.equal(await waitChildExit(waiting, 5), false, "no exit within the wait");
  assert.equal(waiting.listenerCount("exit"), 0, "its listener is removed");
  setImmediate(() => waiting.emit("exit", 0));
  assert.equal(await waitChildExit(waiting, 5000), true);

  // Windows: the tree first, /F only, and the record says it exited.
  const events = [];
  const remediation = { emit: (event) => events.push(event) };
  const calls = [];
  const job = child(11);
  const ended = await endChildTree(job, remediation, { component: "x", serviceId: "y", trigger: TRIGGERS.JOB_TIMEOUT, reason: "r" },
    { platform: "win32", graceMs: 10_000, execFileImpl: (file, args, _options, done) => {
      calls.push([file, ...args]);
      job.signalCode = "SIGKILL";  // the exit event may come later; the field alone says it is gone
      done(null);
    } });
  assert.equal(ended, true);
  assert.deepEqual(calls, [["taskkill.exe", "/PID", "11", "/T", "/F"]]);
  assert.equal(events.length, 1, "one record");
  assert.equal(events[0].outcome, "succeeded");
  assert.equal(events[0].detail.exited, true);
  assert.equal(events[0].detail.grace_ms, 0, "Windows gives no grace: kill() is not a polite request there");
  assert.equal(job.listenerCount("exit"), 0);

  // A child already over needs nothing: no taskkill aimed at a pid that may have been reused, and no record.
  const over = Object.assign(child(12), { signalCode: "SIGTERM" });
  events.length = 0;
  assert.equal(await endChildTree(over, remediation, { component: "x", serviceId: "y", trigger: TRIGGERS.JOB_TIMEOUT },
    { platform: "win32", execFileImpl: () => assert.fail("no taskkill for an ended child") }), true);
  assert.equal(events.length, 0);

  // A tree kill that fails is reported as not exited.
  const stubborn = child(13);
  assert.equal(await forceEndChild(stubborn, { platform: "win32", waitMs: 5, logger: { warn() {} },
    execFileImpl: (_file, _args, _options, done) => done(Object.assign(new Error("denied"), { code: 5 }), "", "denied") }), false);

  // forceOnly skips the polite round; elsewhere the signal is SIGKILL through the injected kill.
  const argv = [];
  let alive = true;
  await terminateProcessTree(21, { forceOnly: true, platform: "win32", alive: () => alive,
    execFileImpl: (_file, args, _options, done) => { argv.push(args); alive = false; done(null); } });
  assert.deepEqual(argv, [["/PID", "21", "/T", "/F"]]);
  alive = true;
  const signals = [];
  assert.equal(await terminateProcessTree(22, { platform: "linux", alive: () => alive,
    killImpl: (pid, signal) => { signals.push([pid, signal]); alive = false; } }), true);
  assert.deepEqual(signals, [[22, "SIGKILL"]]);
  console.log("forced_termination_child_contract: ok");
})().catch((error) => { console.error(error); process.exit(1); });
