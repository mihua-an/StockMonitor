"use strict";

// The storage location (設定 → 資料儲存) -- the Node half of config/storage_settings.py.
//
// `storage_location` holds the folder for everything that grows without bound (`historical_root`; null = the data
// root's default, config/var_layout.json "storage"): the materialized raw history at its root, and the children
// var_layout names under it (B's rule events, the model datasets and registry). settings_api saves it as the desired
// revision only. historicalRoot() is the active one, storagePaths() its children; every process reads one root.
//
// Changing it is one journaled operation (`<config>/storage_location/apply_operation.json`):
// * Only what this program owns is moved or deleted (var_paths.js isOwnedStorageEntry: the `source=*` partition trees,
//   the data-center index and the children's top folders). A folder the user picked may hold other files; they are
//   never touched.
// * The new folder must be empty, or a StockMonitor history folder (it carries MARKER) that holds no history yet.
//   History is never merged into, or written over, an existing store.
// * Same drive: at the next full start, before any service, each entry is renamed, the journal naming it first, so a
//   failure (or a crash) renames the moved ones back. That is instant, so nothing else is needed.
// * Another drive: a copy takes minutes (57 GB took ~10 min), and the App must work meanwhile, so the services keep
//   using the old folder. While the App runs, advanceBackgroundMove() copies into a staging folder inside the new one
//   (state "copying"): each pass compares the whole store and copies only what differs, a file at a time through a
//   ".part" name, so an interrupted pass resumes where it stopped and what the App writes meanwhile is picked up by the
//   next pass. A pass that leaves little to do makes the journal "synced", and passes go on keeping it close.
// * The switch needs every writer gone, which only a full start guarantees: applyPendingLocation(), before any service,
//   finds a "synced" journal, copies the last differences, compares the whole store again (it must match exactly),
//   renames staging into place and activates the revision. When the differences are too many to copy quickly the
//   App starts on the old folder and the background catches up, so this step stays short.
// * The source is deleted only after activation, and in the background (state "activated"): deleting takes minutes too.
// * Nothing here fails towards losing data: until the active pointer moves, the old folder is the whole store. A journal
//   found unfinished at a start is finished (activated), resumed (copying, synced) or undone (anything placed goes back).

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ConfigRevisionStore } = require("./config_revisions.js");
const { writeJsonAtomic } = require("../../service/platform/js/atomic_files.js");
const { samePath, isInside, sameVolume } = require("./path_policy.js");
const { storageDefaultRoot, storagePaths: childrenOf, isOwnedStorageEntry: isOwnedEntry } = require("./var_paths.js");

const DOMAIN = "storage_location";
const MARKER = ".stock-monitor-historical.json";
const OPERATION_SCHEMA = "storage-location-apply-v2";
const PART_SUFFIX = ".stockmonitor-part";
// What the switch may still have to copy with the whole App waiting: about ten seconds across drives at the ~100 MB/s
// the 57 GB move ran at. Also what a background pass must get down to for the copy to count as synced.
const CUTOVER_MAX_DELTA_BYTES = 1024 ** 3;
// How far the copy may fall behind once synced: the writes of this long are what the switch has left to copy.
const CATCH_UP_INTERVAL_MS = 10 * 60_000;
// Windows refuses to rename a folder while anything has a file in it open, and a scanner or antivirus does so briefly
// right after a copy. 60 GB must not be given up for that: a rename is tried again for about 16 s, every retry recorded.
const RENAME_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000];
const RENAME_LOCKED_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const PROGRESS_JOURNAL_INTERVAL_MS = 2000;
const POINTER_CHECK_INTERVAL_MS = 1000;
const BACKGROUND_STATES = new Set(["copying", "synced"]);
const TERMINAL_STATES = new Set(["done", "rolled_back", "refused"]);
// A file the App holds or has just removed: this pass leaves it and the next one tries again. Any other failure (the
// disk is full, the drive is gone) ends the operation.
const NEXT_PASS_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOENT"]);

function rootOf(document, dataRoot) {
  const value = document?.values?.historical_root;
  return typeof value === "string" && value.trim() ? path.resolve(value.trim()) : storageDefaultRoot(dataRoot);
}

/** The active storage location: it holds the raw-history partitions at its root. */
function historicalRoot({ configRoot, dataRoot }) {
  return rootOf(new ConfigRevisionStore(configRoot, DOMAIN).active(), dataRoot);
}

/** The active storage location's children (config/var_layout.json "storage"). */
function storagePaths({ configRoot, dataRoot }) {
  return childrenOf(historicalRoot({ configRoot, dataRoot }));
}

function listNames(fsImpl, folder) {
  try { return fsImpl.readdirSync(folder); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }   // absent is not an error: no folder yet
}

/** Why `folder` cannot receive the history, or null when it can (absent, empty, or an empty StockMonitor store). */
function targetProblem(fsImpl, folder) {
  const names = listNames(fsImpl, folder);
  if (!names || !names.length) return null;
  if (!names.includes(MARKER)) return "the new folder is not empty and is not a StockMonitor history folder";
  if (names.some(isOwnedEntry)) return "the new folder already holds StockMonitor history";
  return null;
}

function operationPath(store) { return path.join(store.directory, "apply_operation.json"); }

function readOperation(fsImpl, store) {
  try { return JSON.parse(fsImpl.readFileSync(operationPath(store), "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return null;   // absent is not an error: no apply has run yet
    throw new Error(`storage location apply journal unreadable: ${error?.message || error}`);
  }
}

function writeOperation(fsImpl, store, op) {
  op.updated_at = new Date().toISOString();
  writeJsonAtomic(operationPath(store), op, { fsImpl, durable: true, indent: 2 });
}

/** How far a file's modification time can come back from the disk at `folder` different from what was set on it: a
 * copy is compared with its source by size and time, and FAT-family disks store coarser times than NTFS. */
async function mtimeTolerance(fsImpl, folder) {
  const probe = path.join(folder, `.mtime-probe-${crypto.randomUUID()}`);
  const wanted = new Date(1_700_000_001_999);   // the odd milliseconds a coarse clock has to round away
  await fsImpl.promises.writeFile(probe, "");
  try {
    await fsImpl.promises.utimes(probe, wanted, wanted);
    return Math.abs((await fsImpl.promises.stat(probe)).mtimeMs - wanted.getTime()) + 2;   // Date holds whole milliseconds
  } finally { await fsImpl.promises.rm(probe, { force: true }); }
}

// One thing went wrong with one file, and the next pass will try it again; recorded with the pass (R4: runCopies'
// caller writes the count and the first names to the journal and the log).
function skip(context, file, error) { context.plan.skipped.push(`${file}: ${error?.code || error?.message || error}`); }

// Adds to `context.plan` what makes `target` equal `source`. Reads only.
async function scanEntry(context, source, target) {
  const { fsImpl, plan, tolerance } = context;
  context.check();
  let stat;
  try { stat = await fsImpl.promises.stat(source); }
  catch (error) {
    if (error?.code === "ENOENT") return;   // not an error: removed since its folder was listed (a prune)
    skip(context, source, error);
    return;
  }
  let have = null;
  try { have = await fsImpl.promises.stat(target); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }   // absent is not an error: not copied yet
  if (have && have.isDirectory() !== stat.isDirectory()) { plan.removals.push(target); have = null; }
  if (!stat.isDirectory()) {
    plan.filesTotal += 1; plan.bytesTotal += stat.size;
    if (have && have.size === stat.size && Math.abs(have.mtimeMs - stat.mtimeMs) <= tolerance) {
      plan.filesInSync += 1; plan.bytesInSync += stat.size;
    } else {
      plan.copies.push({ source, target, size: stat.size });
      plan.deltaBytes += stat.size;
    }
    return;
  }
  if (!have) plan.dirs.push(target);
  let names;
  try { names = await fsImpl.promises.readdir(source); }
  catch (error) {
    if (error?.code === "ENOENT") return;   // not an error: removed since it was stat'ed (a prune)
    skip(context, source, error);
    return;
  }
  if (have) {
    const wanted = new Set(names);
    for (const name of await fsImpl.promises.readdir(target)) if (!wanted.has(name)) plan.removals.push(path.join(target, name));
  }
  for (const name of names) await scanEntry(context, path.join(source, name), path.join(target, name));
}

/** What separates the staging folder from the store as it is now. Refreshes the journal's entries: the App may have
 * created one since the operation began. */
async function scanStore(context, op) {
  const { fsImpl } = context;
  context.plan = { copies: [], removals: [], dirs: [], skipped: [], deltaBytes: 0, filesTotal: 0, bytesTotal: 0, filesInSync: 0, bytesInSync: 0 };
  op.entries = (listNames(fsImpl, op.from) || []).filter(isOwnedEntry).sort();
  op.sources = Object.fromEntries(op.entries.map((name) => [name, path.join(op.from, name)]));
  await fsImpl.promises.mkdir(op.staging, { recursive: true });
  context.tolerance ??= await mtimeTolerance(fsImpl, op.staging);
  for (const name of await fsImpl.promises.readdir(op.staging)) if (!op.entries.includes(name)) context.plan.removals.push(path.join(op.staging, name));
  for (const name of op.entries) await scanEntry(context, op.sources[name], path.join(op.staging, name));
  return context.plan;
}

function planIsEmpty(plan) { return !plan.copies.length && !plan.removals.length && !plan.dirs.length && !plan.skipped.length; }

function showPlan(progress, plan) {
  Object.assign(progress, { files_total: plan.filesTotal, bytes_total: plan.bytesTotal, files_done: plan.filesInSync, bytes_done: plan.bytesInSync });
}

async function requireSpace(context, folder, bytes) {
  const { fsImpl, logger } = context;
  let free;
  try { const stat = await fsImpl.promises.statfs(folder); free = Number(stat.bavail) * Number(stat.bsize); }
  catch (error) {
    // not an error: recorded; the copy itself still fails with ENOSPC if the disk fills
    logger.error?.(`[HEALTH] storage location: reading the free space of ${folder} failed: ${error?.message || error}`);
    return;
  }
  if (free < bytes) throw Object.assign(new Error(`not enough free space on the new drive: ${bytes} bytes to copy, ${free} free`), { code: "ENOSPC" });
}

// Each file goes through a ".part" name: a name in the staging tree is always a whole file, whenever the copy stops. The
// source's time is read before the copy, so a write during it leaves the source newer and the next scan copies it again.
async function runCopies(context, progress, publish) {
  const { fsImpl, plan } = context;
  for (const target of plan.removals) { context.check(); await fsImpl.promises.rm(target, { recursive: true, force: true }); }
  for (const target of plan.dirs) await fsImpl.promises.mkdir(target, { recursive: true });
  for (const { source, target } of plan.copies) {
    context.check();
    const part = `${target}${PART_SUFFIX}`;
    try {
      const stat = await fsImpl.promises.stat(source);
      await fsImpl.promises.copyFile(source, part);
      await fsImpl.promises.utimes(part, stat.atime, stat.mtime);
      await fsImpl.promises.rename(part, target);
      progress.files_done += 1; progress.bytes_done += stat.size;
      publish();
    } catch (error) {
      await fsImpl.promises.rm(part, { force: true }).catch((inner) => {
        // not an error: recorded; the next scan removes a part file the source does not have
        context.logger.error?.(`[HEALTH] storage location: removing ${part} failed: ${inner?.message || inner}`);
      });
      if (!NEXT_PASS_CODES.has(error?.code)) throw error;
      skip(context, source, error);
    }
  }
}

// `rename(from, to)` for the folders of a switch: one that stays locked past the delays throws, as the plain rename does.
// `onRetry({ from, to, code, retries, outcome })`, once per rename that needed retries, is Health's remediation record.
function lockTolerantRename({ fsImpl, logger, delaysMs, onRetry }) {
  return async (from, to) => {
    let retries = 0, lastCode = null;
    for (;;) {
      try {
        fsImpl.renameSync(from, to);
        if (retries) onRetry({ from, to, code: lastCode, retries, outcome: "succeeded" });
        return;
      } catch (error) {
        lastCode = error?.code || null;
        if (!RENAME_LOCKED_CODES.has(error?.code) || retries >= delaysMs.length) {
          if (retries) onRetry({ from, to, code: lastCode, retries, outcome: "failed" });
          throw error;
        }
        logger.error?.(`[HEALTH] storage location: renaming ${from} is locked (${error.code}); retry ${retries + 1} of ${delaysMs.length}`);
        await new Promise((resolve) => setTimeout(resolve, delaysMs[retries]));
        retries += 1;
      }
    }
  };
}

async function placeEntry(fsImpl, op, rename, from, name, progress, report, journal) {
  op.moved.push(name);
  journal();
  fsImpl.mkdirSync(path.dirname(path.join(op.to, name)), { recursive: true });
  await rename(from, path.join(op.to, name));
  progress.entries_done += 1;
  report(progress);
}

// Puts back what an unfinished operation placed in the new folder. A rename goes back to the source; a copy goes back
// to staging, because the renames are all the switch did to it. Unless `keepStaging`, staging is then deleted.
async function rollBack(fsImpl, op, { keepStaging = false, rename = async (from, to) => fsImpl.renameSync(from, to) } = {}) {
  const problems = [];
  for (const name of [...(op.moved || [])].reverse()) {
    const placed = path.join(op.to, name), back = op.mode === "rename" ? op.sources[name] : path.join(op.staging, name);
    try {
      if (fsImpl.existsSync(placed) && !fsImpl.existsSync(back)) {
        fsImpl.mkdirSync(path.dirname(back), { recursive: true });
        await rename(placed, back);
      }
    } catch (error) { /* not an error: collected in problems, which every caller writes to the operation and logs */ problems.push(`${name}: ${error?.message || error}`); }
  }
  if (!problems.length) op.moved = [];
  if (op.staging && !keepStaging) {
    try { await fsImpl.promises.rm(op.staging, { recursive: true, force: true }); }
    catch (error) { /* not an error: collected in problems, which every caller writes to the operation and logs */ problems.push(`staging: ${error?.message || error}`); }
  }
  return problems;
}

/** Delete what an activated operation left behind: only the owned entries it moved, then -- for a whole location's move
 * -- the old folder itself when nothing else is in it. */
async function removeSource(fsImpl, op) {
  for (const name of op.entries || []) await fsImpl.promises.rm(op.sources[name], { recursive: true, force: true });
  if (!op.from) return;
  await fsImpl.promises.rm(path.join(op.from, MARKER), { force: true });
  // The store's own lock and staging (native/market_runtime/src/historical_store.rs): not entries of the move, and left
  // behind they make the old folder "not empty", so it could not be chosen again.
  for (const name of [".store.lock", ".staging"]) await fsImpl.promises.rm(path.join(op.from, name), { recursive: true, force: true });
  const left = listNames(fsImpl, op.from);
  if (left && !left.length) await fsImpl.promises.rmdir(op.from);
}

// Runs before any service at a full start. The active pointer is the one commit point: an operation whose revision the
// pointer already names was activated (every entry was in place before setActive), whatever its journal says.
async function finishUnfinished(fsImpl, store, logger, report, rename) {
  const op = readOperation(fsImpl, store);
  if (!op || TERMINAL_STATES.has(op.state) || BACKGROUND_STATES.has(op.state)) return null;
  if (op.state !== "activated" && op.revision !== undefined && store.pointer().active === op.revision) {
    logger.error?.(`[HEALTH] storage location ${op.operation_id}: interrupted after activation (journal "${op.state}"); finishing it`);
    op.state = "activated";
    writeOperation(fsImpl, store, op);
  }
  if (op.state === "activated") {
    if (op.mode === "copy") return op;   // the source's delete takes minutes: advanceBackgroundMove finishes it
    report({ operation_id: op.operation_id, revision: op.revision, from: op.from, to: op.to, mode: op.mode, state: "deleting_source" });
    await removeSource(fsImpl, op);
    op.state = "done";
    writeOperation(fsImpl, store, op);
    logger.log?.(`[HEALTH] storage location ${op.operation_id}: finished deleting the old folder ${op.from}`);
    return op;
  }
  report({ operation_id: op.operation_id, revision: op.revision, from: op.from, to: op.to, mode: op.mode, state: "rolling_back" });
  if (op.state === "cutover") {
    // The switch was interrupted: what it placed goes back to staging and the copy simply continues.
    const problems = await rollBack(fsImpl, op, { keepStaging: true, rename });
    op.state = problems.length ? "rollback_failed" : "copying";
    op.error = "the switch was interrupted";
    if (problems.length) op.rollback_problems = problems;
    writeOperation(fsImpl, store, op);
    logger.error?.(`[HEALTH] storage location ${op.operation_id}: interrupted switch undone (${op.state})${problems.length ? `: ${problems.join("; ")}` : ""}`);
    if (problems.length) throw new Error(`storage location rollback failed: ${problems.join("; ")}`);
    return op;
  }
  const problems = await rollBack(fsImpl, op, { rename });
  op.state = problems.length ? "rollback_failed" : "rolled_back";
  op.error = op.error || "interrupted before activation";
  if (problems.length) op.rollback_problems = problems;
  writeOperation(fsImpl, store, op);
  logger.error?.(`[HEALTH] storage location ${op.operation_id}: interrupted move ${op.state} (${op.from} -> ${op.to})${problems.length ? `: ${problems.join("; ")}` : ""}`);
  if (problems.length) throw new Error(`storage location rollback failed: ${problems.join("; ")}`);
  return op;
}

function newOperation(revision, previous, from, to, mode, now) {
  const operationId = crypto.randomUUID();
  return { schema: OPERATION_SCHEMA, operation_id: operationId, revision, previous_revision: previous ?? null, from, to, mode,
    state: mode === "copy" ? "copying" : "moving", entries: [], sources: {}, moved: [],
    staging: mode === "copy" ? path.join(to, `.staging-${operationId}`) : null, started_at: now().toISOString(), error: null };
}

function newProgress(op) {
  return { operation_id: op.operation_id, revision: op.revision, from: op.from, to: op.to, mode: op.mode, state: "sizing",
    entries_done: 0, entries_total: 0, files_done: 0, files_total: null, bytes_done: 0, bytes_total: null };
}

function refuseOperation(fsImpl, store, logger, op, error) {
  op.state = "refused"; op.error = error;
  writeOperation(fsImpl, store, op);
  logger.error?.(`[HEALTH] storage location r${op.revision} not applied (${op.from} -> ${op.to}): ${error}`);
  return { applied: false, revision: op.revision, operation_id: op.operation_id, from: op.from, to: op.to, error, root: op.from };
}

function activeRevision(store, logger) {
  try { return store.pointer().active; }
  catch (error) { logger.error?.(`[HEALTH] storage location: reading the active pointer failed: ${error?.message || error}`); return undefined; }
}

async function finishActivated(fsImpl, store, op, logger, started, report) {
  const { revision, from, to } = op;
  op.state = "activated";
  op.error = null;
  writeOperation(fsImpl, store, op);
  const result = { applied: true, revision, operation_id: op.operation_id, from, to, moved: op.entries.length, ms: Date.now() - started, root: to };
  logger.log?.(`[HEALTH] storage location r${revision} active: ${from} -> ${to} (${op.entries.length} entries, ${op.mode}, ${result.ms} ms)`);
  if (op.mode === "copy") return result;   // the old folder is deleted in the background (advanceBackgroundMove)
  try {
    report({ operation_id: op.operation_id, revision, from, to, mode: op.mode, state: "deleting_source" });
    await removeSource(fsImpl, op);
    op.state = "done";
    writeOperation(fsImpl, store, op);
  } catch (error) {
    // The new folder is active and whole; the old copy is deleted at the next start (finishUnfinished).
    logger.error?.(`[HEALTH] storage location r${revision}: deleting the old folder ${from} failed: ${error?.message || error}`);
  }
  return result;
}

// The last step of a copy, with every writer gone: the final differences, a whole-store comparison, the renames, the
// pointer. On any failure what was placed goes back to staging and the App starts on the old folder.
async function switchToCopy(fsImpl, store, op, { logger, now, started, report, maxDeltaBytes, latest, previous, rename }) {
  const background = { applied: false, background: true, revision: latest, operation_id: op.operation_id, from: op.from, to: op.to, root: op.from };
  const progress = newProgress(op);
  const step = (state) => { progress.state = state; report(progress); };
  const context = { fsImpl, logger, check: () => {} };
  const journal = () => writeOperation(fsImpl, store, op);
  op.state = "cutover"; op.revision = latest; op.moved = [];
  journal();
  try {
    step("scanning");
    const plan = await scanStore(context, op);
    showPlan(progress, plan);
    if (plan.skipped.length) throw new Error(`${plan.skipped.length} files unreadable: ${plan.skipped[0]}`);
    if (plan.deltaBytes > maxDeltaBytes) {
      op.state = "copying";
      op.error = null;
      journal();
      logger.log?.(`[HEALTH] storage location r${latest}: ${plan.deltaBytes} bytes still differ; starting on ${op.from} and catching up in the background`);
      return { ...background, delta_bytes: plan.deltaBytes };
    }
    await requireSpace(context, op.to, plan.deltaBytes);
    step("copying");
    await runCopies(context, progress, () => report(progress));
    if (plan.skipped.length) throw new Error(`${plan.skipped.length} files not copied: ${plan.skipped[0]}`);
    step("verifying");
    const remaining = await scanStore(context, op);
    if (!planIsEmpty(remaining)) throw new Error(`the copy differs from the store: ${remaining.copies.length} files, ${remaining.removals.length} extra, ${remaining.skipped.length} unreadable`);
    progress.entries_total = op.entries.length;
    step("placing");
    for (const name of op.entries) await placeEntry(fsImpl, op, rename, path.join(op.staging, name), name, progress, report, journal);
    await fsImpl.promises.rm(op.staging, { recursive: true, force: true });
    step("activating");
    writeJsonAtomic(path.join(op.to, MARKER), { schema: "stock-monitor-historical-root-v1", revision: latest, at: now().toISOString() }, { fsImpl, durable: true, indent: 2 });
    await store.setActive(latest, { verified: true, expectedActive: previous });
  } catch (error) {
    if (activeRevision(store, logger) === latest) {
      logger.error?.(`[HEALTH] storage location r${latest}: activation reported ${error?.message || error} after the pointer was written; keeping the new folder`);
      return finishActivated(fsImpl, store, op, logger, started, report);
    }
    op.error = String(error?.message || error);
    step("rolling_back");
    const problems = await rollBack(fsImpl, op, { keepStaging: true, rename });
    op.state = problems.length ? "rollback_failed" : "copying";
    if (problems.length) op.rollback_problems = problems;
    journal();
    logger.error?.(`[HEALTH] storage location r${latest} not switched (${op.from} -> ${op.to}): ${op.error}; ${op.state}${problems.length ? `: ${problems.join("; ")}` : ""}`);
    return { applied: false, revision: latest, operation_id: op.operation_id, from: op.from, to: op.to, error: op.error, root: op.from };
  }
  return finishActivated(fsImpl, store, op, logger, started, report);
}

// Runs at a full start, before any service: every reader and writer of the store has ended. Activates a same-drive
// change (renames), or switches to a finished copy; a copy not finished yet leaves the App on the old folder. Returns
// what happened; on failure the active (old) location stays whole, so nothing reads a half-moved store.
// `onProgress(progress)`: what this step is doing -- `state` (rolling_back, deleting_source, scanning, copying, verifying,
// placing, activating), the folders and mode, `entries_done/entries_total`, and for a copy `files_done/files_total`
// and `bytes_done/bytes_total` (null until scanned). `onRenameRetry`: see lockTolerantRename.
async function applyPendingLocation({ configRoot, dataRoot, fsImpl = fs, logger = console, now = () => new Date(), sameVolumeImpl = (a, b) => sameVolume(a, b, { fsImpl }),
  onProgress = () => {}, maxDeltaBytes = CUTOVER_MAX_DELTA_BYTES, renameRetryDelaysMs = RENAME_RETRY_DELAYS_MS, onRenameRetry = () => {} } = {}) {
  const store = new ConfigRevisionStore(configRoot, DOMAIN);
  const rename = lockTolerantRename({ fsImpl, logger, delaysMs: renameRetryDelaysMs, onRetry: onRenameRetry });
  const report = (progress) => {
    try { onProgress({ ...progress }); }
    catch (error) { logger.error?.(`[HEALTH] storage location progress listener failed: ${error?.message || error}`); }
  };
  try { await finishUnfinished(fsImpl, store, logger, report, rename); }
  catch (error) {
    logger.error?.(`[HEALTH] storage location: ${error?.message || error}; the pending folder is not applied`);
    return { applied: false, error: String(error?.message || error), root: historicalRoot({ configRoot, dataRoot }) };
  }
  const pointer = store.pointer();
  if (pointer.latest === null || pointer.latest === undefined || pointer.latest === pointer.active) {
    return { applied: false, root: historicalRoot({ configRoot, dataRoot }) };
  }
  const from = rootOf(store.active(), dataRoot);
  const to = rootOf(store.latest(), dataRoot);
  const started = Date.now();
  if (samePath(from, to)) {
    await store.setActive(pointer.latest, { verified: true, expectedActive: pointer.active });
    return { applied: true, revision: pointer.latest, from, to, moved: 0, root: to };
  }
  const background = { applied: false, background: true, revision: pointer.latest, from, to, root: from };
  const running = readOperation(fsImpl, store);
  // The journal holds a copy still running, or one whose source is still to delete: only the background may replace it.
  if (running && (BACKGROUND_STATES.has(running.state) || running.state === "activated")) {
    if (running.state !== "synced" || !samePath(running.to, to)) return { ...background, operation_id: running.operation_id };
    return switchToCopy(fsImpl, store, running, { logger, now, started, report, maxDeltaBytes, latest: pointer.latest, previous: pointer.active, rename });
  }
  const mode = sameVolumeImpl(from, to) ? "rename" : "copy";
  const op = newOperation(pointer.latest, pointer.active, from, to, mode, now);
  if (isInside(to, from) || isInside(from, to)) return refuseOperation(fsImpl, store, logger, op, "the new folder is inside the current one (or the other way round)");
  if (mode === "copy") return background;   // advanceBackgroundMove begins it once the services are up
  const progress = newProgress(op);
  const step = (state) => { progress.state = state; report(progress); };
  try {
    const problem = targetProblem(fsImpl, to);
    if (problem) return refuseOperation(fsImpl, store, logger, op, problem);
    op.entries = (listNames(fsImpl, from) || []).filter(isOwnedEntry).sort();
    op.sources = Object.fromEntries(op.entries.map((name) => [name, path.join(from, name)]));
    fsImpl.mkdirSync(to, { recursive: true });
    writeOperation(fsImpl, store, op);
    progress.entries_total = op.entries.length;
    step("placing");
    for (const name of op.entries) await placeEntry(fsImpl, op, rename, op.sources[name], name, progress, report, () => writeOperation(fsImpl, store, op));
    step("activating");
    writeJsonAtomic(path.join(to, MARKER), { schema: "stock-monitor-historical-root-v1", revision: pointer.latest, at: now().toISOString() },
      { fsImpl, durable: true, indent: 2 });
    await store.setActive(pointer.latest, { verified: true, expectedActive: pointer.active });
  } catch (error) {
    if (activeRevision(store, logger) === pointer.latest) {
      // setActive failed after the pointer was written: the pointer is the commit point, so the move stands
      logger.error?.(`[HEALTH] storage location r${pointer.latest}: activation reported ${error?.message || error} after the pointer was written; keeping the new folder`);
      return finishActivated(fsImpl, store, op, logger, started, report);
    }
    op.error = String(error?.message || error);
    step("rolling_back");
    const problems = await rollBack(fsImpl, op, { rename });
    op.state = problems.length ? "rollback_failed" : "rolled_back";
    if (problems.length) op.rollback_problems = problems;
    writeOperation(fsImpl, store, op);
    logger.error?.(`[HEALTH] storage location r${pointer.latest} not applied (${from} -> ${to}): ${op.error}; ${op.state}`
      + (problems.length ? `: ${problems.join("; ")}` : ""));
    return { applied: false, revision: pointer.latest, operation_id: op.operation_id, from, to, error: op.error, root: from };
  }
  return finishActivated(fsImpl, store, op, logger, started, report);
}

class MoveInterrupted extends Error {
  constructor(superseded) { super(superseded ? "the saved folder changed" : "Health is stopping"); this.superseded = superseded; }
}

async function abandon(fsImpl, store, logger, op, reason) {
  const problems = await rollBack(fsImpl, op);
  op.state = problems.length ? "rollback_failed" : "rolled_back";
  op.error = reason;
  if (problems.length) op.rollback_problems = problems;
  op.progress = null;
  writeOperation(fsImpl, store, op);
  logger.error?.(`[HEALTH] storage location ${op.operation_id}: copy to ${op.to} dropped (${reason}; ${op.state})${problems.length ? `: ${problems.join("; ")}` : ""}`);
  return problems;
}

// One step of the work that runs beside the App, called repeatedly by Health while the services are up: deletes the old
// folder of an activated copy, drops a copy whose folder is no longer the saved one, then begins or continues the copy.
// It only reads the store, so it needs no writer to stop. Returns { status }: idle, waiting_full_start (a same-drive
// change), applied (the saved folder is the one in use), copying, synced, stopped, superseded, delete_failed, failed
// (with `revision`; `failedRevision` tells a later call not to begin that revision again).
async function advanceBackgroundMove({ configRoot, dataRoot, fsImpl = fs, logger = console, now = () => new Date(), sameVolumeImpl = (a, b) => sameVolume(a, b, { fsImpl }),
  shouldStop = () => false, failedRevision = null, maxDeltaBytes = CUTOVER_MAX_DELTA_BYTES, catchUpIntervalMs = CATCH_UP_INTERVAL_MS } = {}) {
  const store = new ConfigRevisionStore(configRoot, DOMAIN);
  let op = readOperation(fsImpl, store);
  const elapsedSince = (at) => now().getTime() - new Date(at).getTime();
  if (op?.state === "activated") {
    if (op.delete_failed_at && elapsedSince(op.delete_failed_at) < catchUpIntervalMs) return { status: "delete_failed" };
    try {
      await removeSource(fsImpl, op);
      op.state = "done"; op.delete_failed_at = null; op.error = null;
      writeOperation(fsImpl, store, op);
      logger.log?.(`[HEALTH] storage location ${op.operation_id}: deleted the old folder ${op.from}`);
    } catch (error) {
      op.delete_failed_at = now().toISOString();
      op.error = `deleting the old folder failed: ${error?.message || error}`;
      writeOperation(fsImpl, store, op);
      logger.error?.(`[HEALTH] storage location ${op.operation_id}: ${op.error}`);
      return { status: "delete_failed" };
    }
  }
  if (op && !TERMINAL_STATES.has(op.state) && !BACKGROUND_STATES.has(op.state)) return { status: "waiting_full_start" };   // only a full start finishes it
  const pointer = store.pointer();
  const pending = pointer.latest !== null && pointer.latest !== undefined && pointer.latest !== pointer.active;
  const to = pending ? rootOf(store.latest(), dataRoot) : null;
  let current = op && BACKGROUND_STATES.has(op.state) ? op : null;
  if (current && (!pending || !samePath(current.to, to))) {
    await abandon(fsImpl, store, logger, current, "the saved folder changed");
    current = null;
  }
  if (!pending) return { status: "idle" };
  const from = rootOf(store.active(), dataRoot);
  if (samePath(from, to)) {   // back to the folder in use: no reader changes
    await store.setActive(pointer.latest, { verified: true, expectedActive: pointer.active });
    return { status: "applied" };
  }
  if (current?.last_pass && elapsedSince(current.last_pass.at) < catchUpIntervalMs) return { status: current.state };
  if (!current && pointer.latest === failedRevision) return { status: "failed", revision: pointer.latest };
  const fail = (error) => {
    logger.error?.(`[HEALTH] storage location r${pointer.latest}: the background copy could not start (${from} -> ${to}): ${error?.message || error}`);
    return { status: "failed", revision: pointer.latest };
  };
  if (!current) {
    try {
      if (sameVolumeImpl(from, to)) return { status: "waiting_full_start" };
      const fresh = newOperation(pointer.latest, pointer.active, from, to, "copy", now);
      const problem = isInside(to, from) || isInside(from, to) ? "the new folder is inside the current one (or the other way round)" : targetProblem(fsImpl, to);
      if (problem) { refuseOperation(fsImpl, store, logger, fresh, problem); return { status: "failed", revision: pointer.latest }; }
      fsImpl.mkdirSync(fresh.staging, { recursive: true });
      writeOperation(fsImpl, store, fresh);
      current = fresh;
    } catch (error) { /* not an error: fail() logs it and the status says so */ return fail(error); }
  }
  current.revision = pointer.latest;
  const running = current;
  let lastPointerCheck = 0, lastJournal = 0;
  const context = { fsImpl, logger, check() {
    if (shouldStop()) throw new MoveInterrupted(false);
    const at = Date.now();
    if (at - lastPointerCheck < POINTER_CHECK_INTERVAL_MS) return;
    lastPointerCheck = at;
    const latest = store.pointer().latest;
    if (latest === running.revision) return;
    if (!samePath(rootOf(store.latest(), dataRoot), running.to)) throw new MoveInterrupted(true);
    running.revision = latest;   // saved again with the same folder
  } };
  const progress = newProgress(running);
  const publish = (force = false) => {
    const at = Date.now();
    if (!force && at - lastJournal < PROGRESS_JOURNAL_INTERVAL_MS) return;
    lastJournal = at;
    running.progress = { ...progress, operation_id: undefined, revision: undefined, from: undefined, to: undefined, mode: undefined };
    writeOperation(fsImpl, store, running);
  };
  try {
    for (;;) {
      progress.state = "scanning";
      publish(true);
      const plan = await scanStore(context, running);
      showPlan(progress, plan);
      await requireSpace(context, running.to, plan.deltaBytes);
      progress.state = "copying";
      publish(true);
      await runCopies(context, progress, publish);
      running.last_pass = { at: now().toISOString(), copied_files: plan.copies.length, copied_bytes: plan.deltaBytes, removed: plan.removals.length, skipped: plan.skipped.length };
      running.error = null;
      if (plan.skipped.length) {
        running.error = `${plan.skipped.length} files were not copied yet (${plan.skipped[0]})`;
        logger.error?.(`[HEALTH] storage location ${running.operation_id}: ${running.error}`);
        running.progress = null;
        writeOperation(fsImpl, store, running);
        return { status: running.state };
      }
      if (plan.deltaBytes <= maxDeltaBytes) {
        running.state = "synced";
        running.synced_at = running.synced_at || now().toISOString();
        running.progress = null;
        writeOperation(fsImpl, store, running);
        logger.log?.(`[HEALTH] storage location ${running.operation_id}: copy in step with ${from} (${plan.copies.length} files this pass)`);
        return { status: "synced" };
      }
    }
  } catch (error) {
    // not an error: Health stopping or the folder changing ends the pass by design; abandon() logs every other case
    if (error instanceof MoveInterrupted && !error.superseded) {
      writeOperation(fsImpl, store, running);
      return { status: "stopped" };
    }
    if (error instanceof MoveInterrupted) {
      await abandon(fsImpl, store, logger, running, error.message);
      return { status: "superseded" };
    }
    // The disk is full, the drive is gone: the partial copy goes (it may be what filled the disk); the old folder was
    // only ever read. A later full start, or saving a folder again, tries anew.
    await abandon(fsImpl, store, logger, running, String(error?.message || error));
    return { status: "failed", revision: running.revision };
  }
}

/** A saved folder not active yet, or an unfinished operation: the next full start has something to look at. */
function locationChangePending({ configRoot, fsImpl = fs } = {}) {
  const store = new ConfigRevisionStore(configRoot, DOMAIN);
  const op = readOperation(fsImpl, store);
  if (op && !TERMINAL_STATES.has(op.state)) return true;
  const pointer = store.pointer();
  return pointer.latest !== null && pointer.latest !== undefined && pointer.latest !== pointer.active;
}

/** The move under way, for 連線診斷 儲存空間: where to, since when and how far; null when none is. */
function storageMoveStatus({ configRoot, fsImpl = fs } = {}) {
  const op = readOperation(fsImpl, new ConfigRevisionStore(configRoot, DOMAIN));
  if (!op || TERMINAL_STATES.has(op.state)) return null;
  const progress = op.progress || {};
  return { state: progress.state || op.state, to: op.to, started_at: op.started_at, files_done: progress.files_done ?? null, files_total: progress.files_total ?? null,
    bytes_done: progress.bytes_done ?? null, bytes_total: progress.bytes_total ?? null };
}

module.exports = { historicalRoot, storagePaths, applyPendingLocation, advanceBackgroundMove, locationChangePending, storageMoveStatus, targetProblem, MARKER, PART_SUFFIX };
