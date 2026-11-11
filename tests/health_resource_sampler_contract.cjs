"use strict";
// Replies are matched to queries by request id, never by order. A timed-out
// query ends alone and its late reply is dropped; a sampler whose input fails or that dies is replaced at the next
// query, and that replacement is recorded (health.resource_sampler_restart).
const assert = require("assert");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const { ProcessResources } = require("../health/monitoring/process_resources.js");

function fakeChild({ failWrite = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = Object.assign(new EventEmitter(), {
    written: [], write(line) { if (failWrite) throw new Error("EPIPE"); this.written.push(line); }, end() {},
  });
  child.killed = false;
  child.kill = () => { child.killed = true; };
  // Answer the query written at `index` (its id is the part before ';').
  child.answer = (index, rows) => {
    const id = Number(child.stdin.written[index].split(";")[0]);
    child.stdout.write(`${JSON.stringify({ id, rows })}\n`);
  };
  return child;
}

async function main() {
  if (process.platform !== "win32") { console.log("health_resource_sampler_contract: skipped (win32 only)"); return; }
  const children = [];
  const events = [];
  let nextFails = false;
  // A replacement is started when it is spawned and succeeded only at the new sampler's first answer.
  const remediation = { begin: (f) => { events.push({ ...f, outcome: "started" }); return { finish: (outcome) => events.push({ ...f, outcome }) }; } };
  const sampler = new ProcessResources({ remediation,
    spawnImpl: () => { const c = fakeChild({ failWrite: nextFails }); children.push(c); return c; } });

  await assert.rejects(sampler.query([11], 30), /timed out/);
  assert.strictEqual(children[0].killed, false, "a late reply ends only its own query, not the sampler");
  assert.match(children[0].stdin.written[0], /^\d+;11\n$/);

  const second = sampler.query([22], 500);
  assert.strictEqual(children.length, 1, "the same sampler answers the next query");
  children[0].answer(0, [{ pid: 11 }]);          // the timed-out query's late reply: dropped
  children[0].answer(1, [{ pid: 22 }]);
  assert.deepStrictEqual(await second, [{ pid: 22 }], "each query gets its own reply");
  assert.strictEqual(sampler.lateReplies, 1);

  const third = sampler.query([33], 500);
  children[0].emit("error", new Error("spawn EPERM"));
  await assert.rejects(third, /resource sampler failed: spawn EPERM/);

  // The next query replaces the sampler, and that is recorded.
  const fourth = sampler.query([44], 500);
  assert.strictEqual(children.length, 2);
  assert.deepStrictEqual(events.map((e) => [e.mechanismId, e.triggerReason, e.outcome]), [["health.resource_sampler_restart", "sampler_failed", "started"]]);
  children[1].answer(0, [{ pid: 44 }]);
  assert.deepStrictEqual(await fourth, [{ pid: 44 }]);
  assert.strictEqual(events.at(-1).outcome, "succeeded", "succeeded only once the replacement answered");

  // A write that fails synchronously retires the sampler instead of leaving the queue misaligned.
  children[1].stdin.write = () => { throw new Error("EPIPE"); };
  await assert.rejects(sampler.query([55], 500), /EPIPE/);
  assert.strictEqual(children[1].killed, true);
  nextFails = false;
  const sixth = sampler.query([66], 500);
  assert.strictEqual(children.length, 3);
  assert.deepStrictEqual([events.at(-1).triggerReason, events.at(-1).outcome], ["sampler_input_failed", "started"]);
  children[2].emit("exit", 1);                 // the replacement ends before it answers: the restart failed
  await assert.rejects(sixth, /exited/);
  assert.deepStrictEqual([events.at(-1).triggerReason, events.at(-1).outcome], ["sampler_input_failed", "failed"]);

  // A replacement that stays alive but never answers: past its startup allowance its timed-out query retires it,
  // the restart is failed, and the next query starts another -- never stuck on a silent sampler with the operation open.
  const silentEvents = [];
  const silentRemediation = { begin: (f) => { silentEvents.push({ ...f, outcome: "started" }); return { finish: (outcome) => silentEvents.push({ ...f, outcome }) }; },
    emit: (e) => silentEvents.push(e) };
  const silent = [];
  const quiet = new ProcessResources({ remediation: silentRemediation, firstAnswerMs: 0,
    spawnImpl: () => { const c = fakeChild(); Object.assign(c, { exitCode: null, signalCode: null }); c.kill = () => { c.killed = true; c.exitCode = 1; setImmediate(() => c.emit("exit", 1)); }; silent.push(c); return c; } });
  quiet.retired = "sampler_exited";                // as after an earlier sampler ended: the next start is a replacement
  await assert.rejects(quiet.query([77], 20), /timed out/);
  assert.strictEqual(silent[0].killed, true, "the silent replacement is ended");
  assert.deepStrictEqual(silentEvents.filter((e) => e.mechanismId === "health.resource_sampler_restart").map((e) => e.outcome), ["started", "failed"]);
  await new Promise((resolve) => setImmediate(resolve));
  const next = quiet.query([78], 500);
  assert.strictEqual(silent.length, 2, "the next query starts another sampler");
  assert.strictEqual(silentEvents.filter((e) => e.mechanismId === "health.resource_sampler_restart").at(-1).triggerReason, "sampler_unanswered");
  silent[1].answer(0, [{ pid: 78 }]);
  assert.deepStrictEqual(await next, [{ pid: 78 }]);

  // stop() during a sample rejects the pending query at once (not at its own timeout), and the sampler's exit
  // afterwards changes nothing; a stop is no failure and is final (Health is stopping): no sampler is started again.
  const stopped = [];
  const stopping = new ProcessResources({ remediation: { begin: () => { throw new Error("a stop is not a restart"); } },
    spawnImpl: () => { const c = fakeChild(); stopped.push(c); return c; } });
  const inFlight = stopping.query([88], 60000);
  const began = Date.now();
  stopping.stop();
  await assert.rejects(inFlight, /resource sampler stopped/);
  assert.ok(Date.now() - began < 1000, "rejected at the stop");
  assert.strictEqual(stopped[0].killed, true);
  assert.strictEqual(stopping.pending.size, 0);
  stopped[0].emit("exit", 0);
  assert.strictEqual(stopping.retired, null);
  assert.strictEqual(await stopping.query([89], 500), null, "a query after the stop gets no sample");
  assert.strictEqual(stopped.length, 1, "and starts no sampler");

  // Health stopping at a Windows session end: the sampler Windows ends after the stop is not replaced (10-28 17:04
  // recorded a health.resource_sampler_restart for exactly this).
  const ending = [];
  const sessionEnd = new ProcessResources({ remediation: { begin: () => { throw new Error("no restart while stopping"); } },
    spawnImpl: () => { const c = fakeChild(); ending.push(c); return c; } });
  const sampled = sessionEnd.query([90], 500);
  ending[0].answer(0, [{ pid: 90 }]);
  await sampled;
  sessionEnd.stop();
  ending[0].emit("exit", 0x40010004);
  assert.strictEqual(await sessionEnd.query([91], 500), null);
  assert.strictEqual(ending.length, 1);
  console.log("health_resource_sampler_contract: ok");
}

main().catch((error) => { console.error(error); process.exit(1); });
