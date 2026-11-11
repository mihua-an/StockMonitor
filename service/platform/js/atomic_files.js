"use strict";

// The one atomic JSON write for Node: five modules each wrote a temp file and renamed it,
// one with fsync, the others without, all with a pid-only temp name two writers in one process could share. The
// window-state store borrowed the color-preference store's copy. Readers see the old file or the new one, never part.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * Replace `file` with `value` as JSON. `durable` fsyncs before the rename (state that must survive a power loss);
 * `indent` is the JSON indentation (0 for compact).
 */
function writeJsonAtomic(file, value, { fsImpl = fs, pathImpl = path, indent = 2, durable = false } = {}) {
  fsImpl.mkdirSync(pathImpl.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const text = indent ? JSON.stringify(value, null, indent) : JSON.stringify(value);
  try {
    if (durable) {
      const fd = fsImpl.openSync(temp, "w");
      try {
        fsImpl.writeSync(fd, text);
        fsImpl.fsyncSync(fd);
      } finally { fsImpl.closeSync(fd); }
    } else {
      fsImpl.writeFileSync(temp, text, "utf8");
    }
    fsImpl.renameSync(temp, file);
  } catch (error) {
    try { fsImpl.unlinkSync(temp); } catch (cleanup) { /* absent is not an error: already renamed or never written */ if (cleanup?.code !== "ENOENT") console.warn("[removing a temp file after a failed write] failed", cleanup); }
    throw error;
  }
}

// The JSON object in `file`, or null when there is none: absent, unreadable or not an object (the last two warned).
function readJsonObject(file, { fsImpl = fs, label = file } = {}) {
  try {
    const value = JSON.parse(fsImpl.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch (error) {
    // absent is not an error: no such file
    if (error?.code !== "ENOENT") console.warn(`[reading ${label}] failed`, error);
    return null;
  }
}

// Rotated generations kept next to a log; older ones are removed. The same rule as service/platform/atomic_files.py.
const ROTATED_GENERATIONS = 3;

let rotationSequence = 0;

/**
 * `<file>.<UTC time>-<sequence>-<pid>-<random>`: unique, so a rotation never replaces another process's, and sortable
 * by time. The millisecond stamp alone ties for rotations in the same millisecond, so the process's rotation sequence
 * orders those (each log has one writing process).
 */
function rotatedName(file, { now = Date.now } = {}) {
  const at = new Date(now()).toISOString();   // 2026-10-21T10:00:00.123Z
  const stamp = `${at.slice(0, 4)}${at.slice(5, 7)}${at.slice(8, 10)}T${at.slice(11, 13)}${at.slice(14, 16)}${at.slice(17, 19)}${at.slice(20, 23)}`;
  const sequence = String(rotationSequence++).padStart(10, "0");
  return `${file}.${stamp}-${sequence}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
}

function isGeneration(base, name) {
  if (!name.startsWith(`${base}.`)) return false;
  const suffix = name.slice(base.length + 1);
  return suffix.length > 18 && /^\d{8}T/.test(suffix);
}

/**
 * Move `file` to a new rotated generation once it is larger than `maxBytes`, then keep the newest `keep`.
 * Each run's log has one writing process (Electron main's is error-electron.log): a rotation renames to a unique
 * name and never deletes or replaces the file it renames, so no generation is ever overwritten. Throws the rename's
 * error (the caller records it); a log already gone is not an error. Old generations that cannot be removed are
 * returned, not thrown: the rotation itself happened.
 */
async function rotateIfLarger(file, maxBytes, { fsImpl = fs, pathImpl = path, keep = ROTATED_GENERATIONS, now = Date.now } = {}) {
  let stat;
  try { stat = await fsImpl.promises.stat(file); }
  catch (error) {
    if (error?.code === "ENOENT") return { rotated: false, pruneFailures: [] };   // not an error: no log yet, or already rotated
    throw error;
  }
  if (stat.size <= maxBytes) return { rotated: false, pruneFailures: [] };
  try { await fsImpl.promises.rename(file, rotatedName(file, { now })); }
  catch (error) {
    if (error?.code === "ENOENT") return { rotated: false, pruneFailures: [] };   // not an error: the log went before the rename (its run directory was removed)
    throw error;
  }
  const dir = pathImpl.dirname(file), base = pathImpl.basename(file);
  const generations = (await fsImpl.promises.readdir(dir)).filter((name) => isGeneration(base, name)).sort();
  const pruneFailures = [];
  for (const name of keep > 0 ? generations.slice(0, -keep) : generations) {
    try { await fsImpl.promises.unlink(pathImpl.join(dir, name)); }
    catch (error) {
      // not an error: ENOENT is a generation another process removed; any other failure is returned for the caller to record
      if (error?.code !== "ENOENT") pruneFailures.push({ name, code: error?.code || null, message: String(error?.message || error) });
    }
  }
  return { rotated: true, pruneFailures };
}

module.exports = { writeJsonAtomic, readJsonObject, rotateIfLarger, rotatedName, ROTATED_GENERATIONS };
