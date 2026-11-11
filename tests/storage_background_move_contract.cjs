const { makeTempDir } = require("./support/temp_dirs.cjs");
// 設定 → 資料儲存, a new folder on another drive: moving 57 GB before anything started kept the App unusable for ten
// minutes. Now the App starts on the old folder, the copy runs beside it and the next full start switches to it after
// a short final sync. Everything here is about not losing data on the way: writes during the copy, an interrupted copy
// or switch, a full disk, a busy target, a folder changed again -- until the pointer moves, the old folder stays whole.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ConfigRevisionStore } = require("../config/js/config_revisions.js");
const { applyPendingLocation, advanceBackgroundMove, historicalRoot, storagePaths, locationChangePending, MARKER, PART_SUFFIX } = require("../config/js/storage_settings.js");
const { startStorageBackgroundMove } = require("../health/startup/storage_background_move.js");

const quiet = { log() {}, error() {} };
const partition = path.join("source=shioaji", "market=STK", "trading_date=2026-10-07", "session=DAY", "2330", "manifest.json");
const events = path.join("analysis-events", "2026-10-27.jsonl");
const crossDrive = () => false;

async function setup() {
  const tmp = makeTempDir("storage-background-");
  const configRoot = path.join(tmp, "config"), dataRoot = path.join(tmp, "data");
  const source = path.join(dataRoot, "historical");
  for (const [rel, text] of [[partition, "{}"], [events, "x".repeat(1000)]]) {
    fs.mkdirSync(path.dirname(path.join(source, rel)), { recursive: true });
    fs.writeFileSync(path.join(source, rel), text);
  }
  const store = new ConfigRevisionStore(configRoot, "storage_location");
  await store.save({ historical_root: null }, { source: "seed", activate: true });
  const target = path.join(tmp, "E", "History");
  await store.save({ historical_root: target }, { expectedRevision: 1, source: "test" });
  const args = { configRoot, dataRoot, logger: quiet, sameVolumeImpl: crossDrive };
  return { tmp, configRoot, dataRoot, store, source, target, args,
    advance: (extra = {}) => advanceBackgroundMove({ ...args, catchUpIntervalMs: 0, ...extra }),
    start: (extra = {}) => applyPendingLocation({ ...args, ...extra }),
    journal: () => JSON.parse(fs.readFileSync(path.join(store.directory, "apply_operation.json"), "utf8")),
    root: () => historicalRoot({ configRoot, dataRoot }) };
}
const stagingOf = (op) => op.staging;
const withPromises = (overrides, extra = {}) => ({ ...fs, ...extra, promises: { ...fs.promises, ...overrides } });
const done = (tmp) => fs.rmSync(tmp, { recursive: true, force: true });

(async () => {
// The full start does not wait for the copy: nothing is moved, the old folder stays the store; then the copy runs.
{
  const ctx = await setup();
  const started = await ctx.start();
  assert.equal(started.applied, false);
  assert.equal(started.background, true, "the App starts on the old folder");
  assert.equal(ctx.root(), ctx.source);
  assert.ok(fs.existsSync(path.join(ctx.source, partition)), "the store was not touched");
  assert.ok(!fs.existsSync(ctx.target), "nothing was copied before the services started");
  assert.equal(locationChangePending({ configRoot: ctx.configRoot }), true);

  assert.equal((await ctx.advance()).status, "synced");
  const op = ctx.journal();
  assert.equal(op.state, "synced");
  assert.equal(fs.readFileSync(path.join(stagingOf(op), events), "utf8").length, 1000);
  assert.ok(!fs.existsSync(path.join(ctx.target, events)), "staged, not in place");
  assert.equal(ctx.root(), ctx.source, "still the old folder until a full start");
  assert.ok(fs.existsSync(path.join(ctx.source, partition)), "the source is only read");
  done(ctx.tmp);
}

// A synced copy is not caught up again until the interval has passed.
{
  const ctx = await setup();
  await ctx.advance();
  const first = ctx.journal().last_pass.at;
  assert.equal((await ctx.advance({ catchUpIntervalMs: 3_600_000 })).status, "synced");
  assert.equal(ctx.journal().last_pass.at, first, "no pass before it is due");
  done(ctx.tmp);
}

// Writes during the copy are not lost: changed, new and pruned files all arrive, a same-size rewrite included, and a
// file written while a pass runs is caught. The switch is whole, then the old data goes in the background.
{
  const ctx = await setup();
  const rewritten = path.join(ctx.source, "analysis-events", "rewritten.json");
  fs.writeFileSync(rewritten, "aaaa");
  const pruned = path.join(ctx.source, "source=shioaji", "market=STK", "pruned.json");
  fs.writeFileSync(pruned, "gone");
  let hooked = false;
  const racing = withPromises({ copyFile: async (a, b, mode) => {
    if (!hooked) { hooked = true; fs.writeFileSync(path.join(ctx.source, "analysis-events", "during-pass.jsonl"), "written during the pass"); }
    return fs.promises.copyFile(a, b, mode);
  } });
  assert.equal((await ctx.advance({ fsImpl: racing })).status, "synced");
  fs.appendFileSync(path.join(ctx.source, events), "more");
  fs.writeFileSync(rewritten, "bbbb");
  fs.utimesSync(rewritten, new Date(), new Date(Date.now() + 60_000));
  fs.rmSync(pruned);
  fs.mkdirSync(path.join(ctx.source, "kbars"));
  fs.writeFileSync(path.join(ctx.source, "kbars", "new-entry.bin"), "k");

  assert.equal((await ctx.advance()).status, "synced", "a catch-up pass");
  fs.appendFileSync(path.join(ctx.source, events), "last");   // after the last pass, before the App closes
  const seen = [];
  const switched = await ctx.start({ onProgress: (p) => seen.push(p.state) });
  assert.equal(switched.applied, true, switched.error);
  assert.deepEqual(seen.filter((s, i, all) => s !== all[i - 1]), ["scanning", "copying", "verifying", "placing", "activating"]);
  assert.equal(ctx.root(), ctx.target);
  assert.equal(fs.readFileSync(path.join(ctx.target, events), "utf8"), `${"x".repeat(1000)}morelast`);
  assert.equal(fs.readFileSync(path.join(ctx.target, "analysis-events", "rewritten.json"), "utf8"), "bbbb", "a same-size rewrite is seen");
  assert.ok(fs.existsSync(path.join(ctx.target, "analysis-events", "during-pass.jsonl")));
  assert.ok(fs.existsSync(path.join(ctx.target, "kbars", "new-entry.bin")), "an entry that appeared during the copy");
  assert.ok(!fs.existsSync(path.join(ctx.target, "source=shioaji", "market=STK", "pruned.json")), "a pruned file does not come back");
  assert.ok(fs.existsSync(path.join(ctx.target, MARKER)));
  assert.ok(!fs.readdirSync(ctx.target).some((name) => name.startsWith(".staging-")), "no staging left");
  assert.equal(storagePaths({ configRoot: ctx.configRoot, dataRoot: ctx.dataRoot }).root, ctx.target);

  assert.equal(ctx.journal().state, "activated");
  assert.ok(fs.existsSync(path.join(ctx.source, events)), "the switch itself deletes nothing: deleting takes minutes");
  fs.writeFileSync(path.join(ctx.source, ".store.lock"), "");
  fs.mkdirSync(path.join(ctx.source, ".staging"), { recursive: true });
  await ctx.advance();
  assert.equal(ctx.journal().state, "done");
  assert.ok(!fs.existsSync(ctx.source), "the emptied old folder goes in the background");
  done(ctx.tmp);
}

// A file the App holds is left for the next pass; the copy does not count as synced while one is missing, and the
// failure is on the record.
{
  const ctx = await setup();
  const errors = [];
  let busy = true;
  const held = withPromises({ copyFile: async (a, b, mode) => {
    if (busy && String(a).endsWith("manifest.json")) throw Object.assign(new Error("sharing violation"), { code: "EBUSY" });
    return fs.promises.copyFile(a, b, mode);
  } });
  assert.equal((await ctx.advance({ fsImpl: held, logger: { log() {}, error: (m) => errors.push(m) } })).status, "copying");
  assert.equal(ctx.journal().state, "copying");
  assert.match(ctx.journal().error, /1 files were not copied yet.*EBUSY/);
  assert.equal(errors.length, 1, "recorded once per pass");
  assert.equal((await ctx.start()).background, true, "a copy with a missing file is not switched to");
  busy = false;
  assert.equal((await ctx.advance({ fsImpl: held })).status, "synced");
  assert.equal(ctx.journal().error, null);
  done(ctx.tmp);
}

// The App is closed mid-copy: the journal stays, the next start does not throw the copy away, and only the rest is
// copied. A file cut off mid-way never takes the real name; its part file is cleaned up.
{
  const ctx = await setup();
  let copies = 0;
  const closing = await ctx.advance({ shouldStop: () => copies > 0,
    fsImpl: withPromises({ copyFile: async (a, b, mode) => { copies += 1; return fs.promises.copyFile(a, b, mode); } }) });
  assert.equal(closing.status, "stopped");
  assert.equal(copies, 1);
  const op = ctx.journal();
  assert.equal(op.state, "copying");
  fs.writeFileSync(path.join(stagingOf(op), "analysis-events", `half.bin${PART_SUFFIX}`), "half");
  assert.equal((await ctx.start()).background, true);
  assert.equal(ctx.journal().state, "copying", "a full start does not roll a copy back");
  let resumed = 0;
  assert.equal((await ctx.advance({ fsImpl: withPromises({ copyFile: async (a, b, mode) => { resumed += 1; return fs.promises.copyFile(a, b, mode); } }) })).status, "synced");
  assert.equal(resumed, 1, "only what was missing");
  assert.ok(!fs.readdirSync(path.join(stagingOf(op), "analysis-events")).some((n) => n.endsWith(PART_SUFFIX)), "the part file is gone");
  done(ctx.tmp);
}

// The disk fills: the partial copy goes (it filled the disk), the old folder is untouched, and the same revision is not
// begun again by this Health; the next start or a new save tries anew. Known up front, nothing is written at all.
{
  const ctx = await setup();
  const failing = withPromises({ copyFile: async () => { throw Object.assign(new Error("no space"), { code: "ENOSPC" }); } });
  const result = await ctx.advance({ fsImpl: failing });
  assert.deepEqual(result, { status: "failed", revision: 2 });
  const op = ctx.journal();
  assert.equal(op.state, "rolled_back");
  assert.match(op.error, /no space/);
  assert.ok(!fs.existsSync(stagingOf(op)), "the partial copy is removed");
  assert.equal(ctx.root(), ctx.source);
  assert.ok(fs.existsSync(path.join(ctx.source, partition)) && fs.existsSync(path.join(ctx.source, events)), "failure leaves the old data alone");
  assert.equal((await ctx.advance({ failedRevision: 2 })).status, "failed", "not begun again by this Health");
  assert.equal(ctx.journal().operation_id, op.operation_id);
  assert.equal((await ctx.start()).background, true, "the App still starts on the old folder");
  assert.equal((await ctx.advance()).status, "synced", "the next Health tries anew");
  done(ctx.tmp);
}
{
  const ctx = await setup();
  let copied = 0;
  const small = withPromises({ statfs: async () => ({ bavail: 1, bsize: 10 }), copyFile: async () => { copied += 1; } });
  assert.equal((await ctx.advance({ fsImpl: small })).status, "failed");
  assert.equal(copied, 0, "too little free space is known before the first file");
  assert.match(ctx.journal().error, /not enough free space/);
  done(ctx.tmp);
}

// The target is taken: refused, its files untouched, the old folder still the store.
{
  const ctx = await setup();
  fs.mkdirSync(ctx.target, { recursive: true });
  fs.writeFileSync(path.join(ctx.target, "photo.jpg"), "p");
  assert.equal((await ctx.advance()).status, "failed");
  assert.equal(ctx.journal().state, "refused");
  assert.deepEqual(fs.readdirSync(ctx.target), ["photo.jpg"]);
  assert.equal(ctx.root(), ctx.source);
  done(ctx.tmp);
}

// The folder is changed again during the copy: that copy goes, the old data stays, the new folder is copied.
{
  const ctx = await setup();
  await ctx.advance();
  const first = ctx.journal();
  const other = path.join(ctx.tmp, "F", "Other");
  await ctx.store.save({ historical_root: other }, { expectedRevision: 2, source: "test" });
  assert.equal((await ctx.start()).background, true, "a stale copy is never switched to");
  assert.equal((await ctx.advance()).status, "synced");
  assert.ok(!fs.existsSync(stagingOf(first)), "the abandoned copy is removed");
  const second = ctx.journal();
  assert.equal(second.to, other);
  assert.notEqual(second.operation_id, first.operation_id);
  assert.equal((await ctx.start()).applied, true);
  assert.equal(ctx.root(), other);
  assert.equal(fs.existsSync(path.join(ctx.target, events)), false);
  done(ctx.tmp);
}
// ... while a pass is running: noticed between files.
{
  const ctx = await setup();
  let saved = false;
  const other = path.join(ctx.tmp, "F", "Other");
  const changing = withPromises({ copyFile: async (a, b, mode) => {
    if (!saved) { saved = true; await ctx.store.save({ historical_root: other }, { expectedRevision: 2, source: "test" }); await new Promise((r) => setTimeout(r, 1100)); }
    return fs.promises.copyFile(a, b, mode);
  } });
  assert.equal((await ctx.advance({ fsImpl: changing })).status, "superseded");
  assert.equal(ctx.journal().state, "rolled_back");
  assert.ok(fs.existsSync(path.join(ctx.source, events)));
  done(ctx.tmp);
}
// Saving the same folder again keeps the copy.
{
  const ctx = await setup();
  await ctx.advance();
  const id = ctx.journal().operation_id;
  await ctx.store.save({ historical_root: ctx.target }, { expectedRevision: 2, source: "test" });
  await ctx.advance();
  assert.equal(ctx.journal().operation_id, id);
  assert.equal(ctx.journal().revision, 3);
  assert.equal((await ctx.start()).applied, true);
  done(ctx.tmp);
}
// Changed back to the folder in use: the copy goes, no data moves, and the source is never deleted.
{
  const ctx = await setup();
  await ctx.advance();
  const op = ctx.journal();
  await ctx.store.save({ historical_root: null }, { expectedRevision: 2, source: "test" });
  assert.equal((await ctx.advance()).status, "applied");
  assert.equal(ctx.journal().state, "rolled_back");
  assert.ok(!fs.existsSync(stagingOf(op)));
  assert.ok(fs.existsSync(path.join(ctx.source, partition)) && fs.existsSync(path.join(ctx.source, events)));
  assert.equal(locationChangePending({ configRoot: ctx.configRoot }), false);
  done(ctx.tmp);
}

// Too much left for a short switch: the App starts on the old folder and the background catches up.
{
  const ctx = await setup();
  await ctx.advance();
  fs.writeFileSync(path.join(ctx.source, "analysis-events", "big.bin"), "y".repeat(4096));
  const started = await ctx.start({ maxDeltaBytes: 1024 });
  assert.equal(started.applied, false);
  assert.equal(started.delta_bytes, 4096);
  assert.equal(ctx.journal().state, "copying");
  assert.equal(ctx.root(), ctx.source);
  assert.equal((await ctx.advance()).status, "synced");
  assert.equal((await ctx.start()).applied, true);
  done(ctx.tmp);
}

// The switch fails part way: what was placed goes back to staging, the App starts on the old folder, nothing is lost and
// the next full start does not copy everything again.
{
  const ctx = await setup();
  await ctx.advance();
  const staging = stagingOf(ctx.journal());
  let failures = 0;
  const failing = { ...fs, renameSync(a, b) {
    if (String(a).includes("source=shioaji") && String(a).includes(".staging-") && !failures) { failures += 1; throw Object.assign(new Error("in use"), { code: "EBUSY" }); }
    return fs.renameSync(a, b);
  } };
  const result = await ctx.start({ fsImpl: failing, renameRetryDelaysMs: [] });
  assert.equal(result.applied, false);
  assert.match(result.error, /in use/);
  assert.equal(ctx.root(), ctx.source);
  assert.equal(ctx.journal().state, "copying");
  assert.ok(fs.existsSync(path.join(staging, events)), "the placed entry went back to staging");
  assert.ok(!fs.existsSync(path.join(ctx.target, "analysis-events")));
  assert.ok(fs.existsSync(path.join(ctx.source, events)), "the old data is whole");
  let copied = 0;
  await ctx.advance({ fsImpl: withPromises({ copyFile: async (a, b, mode) => { copied += 1; return fs.promises.copyFile(a, b, mode); } }) });
  assert.equal(copied, 0, "the copy survived");
  assert.equal((await ctx.start()).applied, true);
  done(ctx.tmp);
}
// Windows locks the folder for a moment after the copy (11-09: EPERM on the last rename threw away 60.7 GB): the rename
// holds out, every such rename is on the record, and the switch completes.
{
  const ctx = await setup();
  await ctx.advance();
  let locks = 0;
  const flaky = { ...fs, renameSync(a, b) {
    if (String(a).includes(".staging-") && String(a).endsWith("source=shioaji") && locks < 2) { locks += 1; throw Object.assign(new Error("operation not permitted"), { code: "EPERM" }); }
    return fs.renameSync(a, b);
  } };
  const retried = [];
  const result = await ctx.start({ fsImpl: flaky, renameRetryDelaysMs: [1, 1, 1], onRenameRetry: (r) => retried.push(r) });
  assert.equal(result.applied, true, result.error);
  assert.equal(locks, 2);
  assert.equal(retried.length, 1, "one record for the rename");
  assert.deepEqual([retried[0].retries, retried[0].code, retried[0].outcome], [2, "EPERM", "succeeded"]);
  assert.ok(fs.existsSync(path.join(ctx.target, partition)));
  done(ctx.tmp);
}
// Locked for longer than that: bounded, recorded as failed, the old folder stays in use and the copy is kept -- the next
// full start retries the switch without copying 60 GB again or holding the App for it.
{
  const ctx = await setup();
  await ctx.advance();
  let attempts = 0;
  const locked = { ...fs, renameSync(a, b) {
    if (String(a).includes(".staging-") && String(a).endsWith("source=shioaji")) { attempts += 1; throw Object.assign(new Error("operation not permitted"), { code: "EPERM" }); }
    return fs.renameSync(a, b);
  } };
  const retried = [];
  const result = await ctx.start({ fsImpl: locked, renameRetryDelaysMs: [1, 1], onRenameRetry: (r) => retried.push(r) });
  assert.equal(result.applied, false);
  assert.equal(attempts, 3, "bounded");
  assert.equal(retried[0].outcome, "failed");
  assert.equal(ctx.root(), ctx.source);
  assert.equal(ctx.journal().state, "copying");
  let copied = 0;
  assert.equal((await ctx.advance({ fsImpl: withPromises({ copyFile: async (a, b, mode) => { copied += 1; return fs.promises.copyFile(a, b, mode); } }) })).status, "synced");
  assert.equal(copied, 0, "the copy is kept");
  assert.equal((await ctx.start()).applied, true);
  done(ctx.tmp);
}

// A copy that does not match at the last comparison is not switched to.
{
  const ctx = await setup();
  await ctx.advance();
  const staging = stagingOf(ctx.journal());
  let stat = 0;
  const lying = withPromises({ utimes: async (a, b, c) => {
    stat += 1;
    await fs.promises.utimes(a, b, c);
    if (stat === 2) await fs.promises.truncate(a, 1);   // the copy written by the switch comes out short
  } });
  fs.appendFileSync(path.join(ctx.source, events), "z");
  const result = await ctx.start({ fsImpl: lying });
  assert.equal(result.applied, false);
  assert.match(result.error, /differs/);
  assert.equal(ctx.root(), ctx.source);
  assert.ok(fs.existsSync(staging));
  done(ctx.tmp);
}

// A crash during the switch (journal "cutover", one entry placed): undone at the next start, the copy continues.
{
  const ctx = await setup();
  await ctx.advance();
  const op = ctx.journal();
  fs.mkdirSync(ctx.target, { recursive: true });
  fs.renameSync(path.join(op.staging, "analysis-events"), path.join(ctx.target, "analysis-events"));
  fs.writeFileSync(path.join(ctx.store.directory, "apply_operation.json"), JSON.stringify({ ...op, state: "cutover", moved: ["analysis-events"] }));
  const started = await ctx.start();
  assert.equal(started.applied, false);
  assert.equal(ctx.journal().state, "copying");
  assert.ok(fs.existsSync(path.join(op.staging, events)));
  assert.equal(ctx.root(), ctx.source);
  done(ctx.tmp);
}

// A crash after the pointer was written: the new folder stands, the old one is deleted in the background, and a failing
// delete stays on the journal and is tried again.
{
  const ctx = await setup();
  await ctx.advance();
  const op = ctx.journal();
  fs.mkdirSync(ctx.target, { recursive: true });
  for (const name of op.entries) fs.renameSync(path.join(op.staging, name), path.join(ctx.target, name));
  await ctx.store.setActive(2, { verified: true, expectedActive: 1 });
  fs.writeFileSync(path.join(ctx.store.directory, "apply_operation.json"), JSON.stringify({ ...op, state: "cutover", moved: op.entries }));
  const started = await ctx.start();
  assert.equal(started.applied, false, "nothing left to apply");
  assert.equal(started.root, ctx.target);
  assert.equal(ctx.journal().state, "activated");
  assert.ok(fs.existsSync(path.join(ctx.source, events)), "not deleted while the App waits");
  const stuck = withPromises({ rm: async () => { throw Object.assign(new Error("locked"), { code: "EBUSY" }); } });
  assert.equal((await ctx.advance({ fsImpl: stuck })).status, "delete_failed");
  assert.match(ctx.journal().error, /locked/);
  assert.equal(ctx.journal().state, "activated");
  await ctx.advance();
  assert.equal(ctx.journal().state, "done");
  assert.ok(!fs.existsSync(path.join(ctx.source, events)));
  done(ctx.tmp);
}

// Moving back while the old folder is still being deleted waits for that delete, then copies.
{
  const ctx = await setup();
  await ctx.advance();
  assert.equal((await ctx.start()).applied, true);
  await ctx.store.save({ historical_root: null }, { expectedRevision: 2, source: "test" });
  assert.equal((await ctx.start()).background, true, "the delete is still pending");
  assert.equal((await ctx.advance()).status, "synced", "delete first, then the copy back");
  assert.equal(ctx.journal().to, ctx.source);
  assert.equal((await ctx.start()).applied, true);
  assert.equal(ctx.root(), ctx.source);
  assert.ok(fs.existsSync(path.join(ctx.source, events)));
  await ctx.advance();
  assert.ok(!fs.existsSync(path.join(ctx.target, events)));
  done(ctx.tmp);
}

// A same-drive change still waits for the next full start and is instant there; the background leaves it alone.
{
  const ctx = await setup();
  const sameDrive = { sameVolumeImpl: () => true };
  assert.equal((await ctx.advance(sameDrive)).status, "waiting_full_start");
  assert.equal(fs.existsSync(path.join(ctx.store.directory, "apply_operation.json")), false, "no copy was begun");
  assert.equal((await ctx.start(sameDrive)).applied, true);
  assert.ok(fs.existsSync(path.join(ctx.target, events)));
  assert.ok(!fs.existsSync(path.join(ctx.source, events)));
  done(ctx.tmp);
}

// The loop: steps never overlap, a failed revision is passed back, stop ends it and asks the running step to stop.
{
  let active = 0, calls = 0, overlap = false, lastOptions = null;
  let resolveStopped;
  const stopped = new Promise((resolve) => { resolveStopped = resolve; });
  const loop = startStorageBackgroundMove({ pollMs: 1, logger: quiet, advance: async (options) => {
    active += 1; overlap ||= active > 1; calls += 1; lastOptions = options;
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    if (calls === 3) resolveStopped();
    return calls === 1 ? { status: "failed", revision: 7 } : { status: "idle" };
  } });
  await stopped;
  await loop.stop();
  const finalCalls = calls;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, finalCalls, "stopped");
  assert.equal(overlap, false);
  assert.equal(lastOptions.failedRevision, 7);
  assert.equal(lastOptions.shouldStop(), true);
  // A step that throws is recorded and the loop goes on.
  const errors = [];
  let tries = 0, again;
  const continued = new Promise((resolve) => { again = resolve; });
  const failing = startStorageBackgroundMove({ pollMs: 1, logger: { error: (m) => errors.push(m) }, advance: async () => { tries += 1; if (tries === 1) throw new Error("boom"); again(); return { status: "idle" }; } });
  await continued;
  await failing.stop();
  assert.match(errors[0], /boom/);
}

console.log("storage background move contract ok");
})().catch((error) => { console.error(error); process.exit(1); });
