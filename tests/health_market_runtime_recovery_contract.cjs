"use strict";
// A recovering market_runtime is waited for as long as it advances. A fixed start timeout killed a
// full WAL replay at 90 s and started it again from zero, forever.
const assert = require("node:assert/strict");
const { MarketRuntimeHost } = require("../health/services/market_runtime_host.js");

function host(sequence, timing) {
  const h = new MarketRuntimeHost({ fs: {}, path: {}, effective: { services: { market_runtime: { host: "127.0.0.1", port: 1 } } },
    timing: { firstAnswerMs: 200, scanLimitMs: 300, stallMs: 120, limitMs: 2000, pollMs: 10, ...timing } });
  let i = 0;
  h.portPresent = async () => true;   // A listens at once; what it answers is the sequence
  h.health = async () => sequence[Math.min(i++, sequence.length - 1)];
  return h;
}
const id = { service_id: "market_runtime", clock: "wall", instance_id: "mr-1" };
const recovering = (phase, replayed, total = 100) => ({ ...id, status: "recovering", recovery: { phase, replayed, total } });

(async () => {
  // Advancing recovery: waited for, reported, then served.
  const reports = [];
  const advancing = host([recovering("scanning", 0), recovering("replaying", 10), recovering("replaying", 60), { ...id, status: "healthy" }]);
  const served = await advancing.waitServing(null, (text) => reports.push(text));
  assert.equal(served.status, "healthy");
  assert.ok(reports.some((t) => t.includes("掃描")), "the scan is reported");
  assert.ok(reports.some((t) => t.includes("60%")), "the replay progress is reported");

  // A replay that stops advancing is a hang.
  const stuck = host([recovering("replaying", 40)]);
  await assert.rejects(stuck.waitServing(null), /stalled/);

  // A replay that keeps advancing past the old fixed timeout is NOT killed.
  let n = 0;
  const slow = host([], { stallMs: 200 });
  slow.health = async () => (++n < 40 ? recovering("replaying", n) : { ...id, status: "healthy" });
  assert.equal((await slow.waitServing(null)).status, "healthy");

  // Nothing answering at all still fails.
  const silent = host([null]);
  await assert.rejects(silent.waitServing(null), /did not answer/);
  // Before A binds, only the TCP knock runs: no authenticated health waits out its timeout on a closed port.
  let knocks = 0, asked = 0;
  const binding = host([]);
  binding.portPresent = async () => ++knocks > 3;
  binding.health = async () => { asked += 1; return { ...id, status: "healthy" }; };
  assert.equal((await binding.waitServing(null)).status, "healthy");
  assert.deepEqual([knocks, asked], [4, 1], "health is asked once the port is open, never before");

  // A failed start returns only once the child it spawned has exited; one that does not exit keeps every later start
  // from spawning a second market_runtime beside it.
  const { EventEmitter } = require("node:events");
  const child = (onKill) => Object.assign(new EventEmitter(), { pid: 77, exitCode: null, signalCode: null, kill() { onKill(this); } });
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const exiting = host([null]);
    const quick = child((c) => setTimeout(() => { c.exitCode = 1; c.emit("exit", 1, null); }, 5));
    await assert.rejects(exiting.waitServing(quick), (error) => /did not answer/.test(error.message) && !/did not exit/.test(error.message));
    assert.equal(quick.exitCode, 1, "the child had exited by the time the start failed");

    const stubborn = host([null]);
    const holdout = child(() => {});
    await assert.rejects(stubborn.waitServing(holdout), /pid 77 did not exit when ended/);
    stubborn.supervisorProbe = async () => ({ verified: false, occupied: false });
    await assert.rejects(stubborn.ensure(), /pid 77 was ended but has not exited/);
  } finally {
    clearInterval(keepAlive);
  }
  console.log("market_runtime recovery wait contract ok");
})().catch((error) => { console.error(error); process.exit(1); });
