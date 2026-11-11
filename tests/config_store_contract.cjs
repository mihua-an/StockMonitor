"use strict";

const { makeTempDir } = require("./support/temp_dirs.cjs");
// config/js/config_revisions.js: the same store states and writer lock as config/config_revisions.py.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ConfigRevisionStore, StoreUnreadable, setRemediationEmitter } = require("../config/js/config_revisions.js");

(async () => {
const root = makeTempDir("config-store-");
try {
  // States: a damaged store fails closed, never read as an empty one.
  const store = new ConfigRevisionStore(root, "network");
  assert.equal(store.state().state, "ABSENT");
  assert.equal(store.latest(), null);
  await store.save({ services: {} }, { source: "t", activate: true });
  assert.equal(store.state().state, "OK");
  const good = fs.readFileSync(store.pointerPath, "utf8");
  fs.writeFileSync(store.pointerPath, "{not json");
  assert.equal(store.state().state, "CORRUPT");
  assert.throws(() => store.active(), StoreUnreadable);
  await assert.rejects(() => store.save({ services: {} }, { source: "t" }), StoreUnreadable);
  assert.equal(store.get(1).revision, 1, "revision 1 was not overwritten");
  fs.unlinkSync(store.pointerPath);
  assert.equal(store.state().state, "CORRUPT", "a missing pointer over existing history is damage");
  fs.writeFileSync(store.pointerPath, good.replace('"latest": 1', '"latest": 3'));
  assert.equal(store.state().state, "INCONSISTENT");
  fs.writeFileSync(store.pointerPath, good);
  assert.equal(store.active().revision, 1);

  // expectedActive null is "the defaults are active", checked like any revision; undefined does not check.
  const cas = new ConfigRevisionStore(path.join(root, "cas"), "network");
  await cas.save({ services: {} }, { source: "t" });
  assert.equal((await cas.setActive(1, { verified: true, expectedActive: null })).active, 1);
  await cas.save({ services: {} }, { source: "t", expectedRevision: 1 });
  await assert.rejects(() => cas.setActive(2, { verified: true, expectedActive: null }), /RevisionConflict|expected/i);
  assert.equal(cas.pointer().active, 1);
  assert.equal((await cas.setActive(2, { verified: true })).active, 2);

  // Lock: a live owner's lock is waited on whatever its age; a dead owner's is taken over and recorded.
  const lock = path.join(store.directory, ".lock");
  fs.writeFileSync(lock, JSON.stringify({ token: "other", pid: process.pid, created_ms: null, at_ms: 0 }));
  fs.utimesSync(lock, 0, 0);
  // Waiting for it does not block the event loop: a timer keeps firing while the lock is contended.
  let ticks = 0;
  const ticker = setInterval(() => { ticks += 1; }, 10);
  await assert.rejects(() => store.withLock(() => 1, 1200), /is locked/);
  clearInterval(ticker);
  assert.ok(ticks >= 20, `the event loop ran during the wait (${ticks} ticks)`);
  assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).token, "other");

  const events = [];
  setRemediationEmitter({ emit: (event) => events.push(event) });
  // A PID that is no process: spawn one, let it exit, reuse its PID as the dead owner.
  const dead = require("node:child_process").spawnSync(process.execPath, ["-e", "0"]).pid;
  fs.writeFileSync(lock, JSON.stringify({ token: "other", pid: dead, created_ms: null, at_ms: Date.now() }));
  assert.equal(await store.withLock(() => "ran", 3000), "ran");
  assert.deepEqual(events.map((e) => [e.mechanismId, e.triggerReason, e.outcome]), [["config.lock_takeover", "owner_process_gone", "succeeded"]]);
  assert.equal(fs.existsSync(lock), false, "released by its own token");
  assert.deepEqual(fs.readdirSync(store.directory).filter((name) => name.startsWith(".lock")), [], "nothing left aside");

  // A claim left by a claimant that died mid-takeover is itself taken over: the domain can be written again.
  events.length = 0;
  fs.writeFileSync(lock, JSON.stringify({ token: "dead-owner", pid: dead, created_ms: null, at_ms: 0 }));
  const claim = path.join(store.directory, ".lock.takeover.dead-owner");
  fs.writeFileSync(claim, JSON.stringify({ token: "dead-claimant", pid: dead, created_ms: null, at_ms: 0 }));
  assert.equal(await store.withLock(() => "ran again", 3000), "ran again");
  assert.deepEqual(events.map((e) => e.detail.result), ["takeover claim removed", "lock removed"]);
  assert.equal(fs.existsSync(claim), false);

  // Only an existing claim is contention: an I/O error making one is thrown, never retried into "is locked".
  fs.writeFileSync(lock, JSON.stringify({ token: "dead-owner", pid: dead, created_ms: null, at_ms: 0 }));
  const realLink = fs.linkSync;
  fs.linkSync = (src, dst) => {
    if (String(dst).includes(".takeover.")) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    return realLink(src, dst);
  };
  try {
    await assert.rejects(() => store.withLock(() => 1, 3000), /EACCES/);
  } finally { fs.linkSync = realLink; }
  assert.deepEqual(fs.readdirSync(store.directory).filter((name) => name.endsWith(".aside")), []);
  fs.unlinkSync(lock);
  setRemediationEmitter(null);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("config store contract passed");
})().catch((error) => { console.error(error); process.exit(1); });
