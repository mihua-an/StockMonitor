"use strict";

// The ledger's recovery: the raw files of every retained log session, read from where the checkpoint left them,
// and the checkpoint itself -- what those files folded into (per-day stats, open operations, the dedupe tail) and
// the identity (size, mtime, tail digest) of each file it covers. A file is only ever appended to by the Health that
// created it, so a start reads only what the checkpoint does not cover; a covered file that changed, or no usable
// checkpoint while raw files exist, re-reads everything once (the facade records that as `sink.ledger_rebuild`).

const path = require("path");
const { writeJsonAtomic } = require("../../service/platform/js/atomic_files");
const crypto = require("crypto");
const { CHECKPOINT_SCHEMA, FILE_PATTERN, eventDay, boundedAdd, statsFromJson, statsToJson } = require("./ledger_records.js");
const contract = require("../../config/js/remediation_contract.js");
const { listDir } = require("./ledger_writer.js");

const TAIL_DIGEST_BYTES = 256;

function listEntries(fs, dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); }
  catch (error) {
    // absent is not an error: no such directory yet
    if (error?.code !== "ENOENT") console.warn("[listing a remediation ledger directory] failed", error);
    return [];
  }
}

class LedgerRecovery {
  constructor({ fs, now, logger, logsRoot, checkpointPath, eventSchema, stats }) {
    Object.assign(this, { fs, now, logger, logsRoot, checkpointPath, eventSchema, stats });
  }

  // Every raw ledger file across all retained log sessions, in name order: [{ path, key, day }] (key: relative to logsRoot).
  rawFiles() {
    const out = [];
    // The logs root also holds plain files (health.log, ...); only its log-session directories hold ledger files.
    for (const entry of listEntries(this.fs, this.logsRoot)) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.logsRoot, entry.name);
      for (const name of listDir(this.fs, dir)) {
        const match = FILE_PATTERN.exec(name);
        if (match) out.push({ path: path.join(dir, name), key: `${entry.name}/${name}`, day: match[1] });
      }
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  // The records of one raw file from byte `covered.offset` on (0 for a file not read yet), each event not in `seen`
  // yet handed to onEvent. Returns the file's new entry -- {
  // offset (end of its last complete line), lines, size, mtime_ms, tail_sha1 (of the bytes right before offset),
  // corrupt } -- and how many bytes and events it read.
  readRawFile(file, onEvent, covered, seen) {
    const from = covered?.offset || 0;
    let events = 0, corrupt = covered?.corrupt ? { ...covered.corrupt } : null;
    const fd = this.fs.openSync(file.path, "r");
    try {
      const stat = this.fs.fstatSync(fd);
      const buffer = Buffer.alloc(Math.max(0, stat.size - from));
      if (buffer.length) this.fs.readSync(fd, buffer, 0, buffer.length, from);
      // Every complete line ends with a newline: only the bytes after the last one can be a write a crash cut off
      // (not an error: its loss is stated by the writer's loss marker). They are read again next time.
      const complete = buffer.subarray(0, buffer.lastIndexOf(10) + 1);
      const lines = complete.toString("utf8").split("\n");
      lines.pop();
      const linesBefore = covered?.lines || 0;
      for (const [index, line] of lines.entries()) {
        if (!line.trim()) continue;
        let record;
        try { record = JSON.parse(line); } catch (error) {
          // A complete line that does not parse: never skipped as if a crash tore it -- an operation's terminal event
          // lost this way would leave it open forever. Counted per file; the ledger is degraded while the file is kept.
          // not an error: recorded -- restore() logs every file's corrupt entry and puts it in the ledger stats
          if (corrupt) corrupt.lines += 1;
          else corrupt = { lines: 1, first_line: linesBefore + index + 1, error: String(error?.message || error).slice(0, 200) };
          continue;
        }
        if (record.schema !== this.eventSchema) continue;
        if (seen.has(record.event_id)) continue;
        boundedAdd(seen, record.event_id);
        events += 1;
        onEvent(record);
      }
      const offset = from + complete.length;
      return { entry: { offset, lines: linesBefore + lines.length, size: stat.size, mtime_ms: stat.mtimeMs,
        tail_sha1: this.tailDigest(fd, offset), corrupt }, bytes: buffer.length, events };
    } finally {
      this.fs.closeSync(fd);
    }
  }

  // A digest of the bytes right before `offset`: a covered file that grew is read on from there only if what it
  // ended with is still there (an append), never if it was rewritten.
  tailDigest(fd, offset) {
    const length = Math.min(TAIL_DIGEST_BYTES, offset);
    const buffer = Buffer.alloc(length);
    if (length) this.fs.readSync(fd, buffer, 0, length, offset - length);
    return crypto.createHash("sha1").update(buffer).digest("hex");
  }

  // How a covered file is read at this start: "skip" (unchanged), "tail" (appended to since),
  // or "changed" (shorter, rewritten in place, or its covered end differs) -- the checkpoint is not used then.
  coveredState(file, covered) {
    let fd;
    try {
      fd = this.fs.openSync(file.path, "r");
      const stat = this.fs.fstatSync(fd);
      if (stat.size === covered.size && stat.mtimeMs === covered.mtime_ms) return "skip";
      if (stat.size <= covered.size || stat.size < covered.offset) return "changed";
      return this.tailDigest(fd, covered.offset) === covered.tail_sha1 ? "tail" : "changed";
    } catch (error) {
      console.warn("[checking a remediation ledger file against the checkpoint] failed", error);
      return "changed";
    } finally {
      if (fd !== undefined) this.fs.closeSync(fd);
    }
  }

  // { state } -- a checkpoint of this schema; or { state: null, reason, error }.
  loadCheckpoint() {
    let text;
    try { text = this.fs.readFileSync(this.checkpointPath, "utf8"); }
    catch (error) {
      // not an error: recorded -- the reason and error go back to Ledger.restore(), which logs and emits the rebuild
      if (error?.code === "ENOENT") return { state: null, reason: "checkpoint_absent" };
      return { state: null, reason: "checkpoint_unreadable", error: String(error?.message || error).slice(0, 300) };
    }
    let state;
    try { state = JSON.parse(text); }
    catch (error) {   // not an error: recorded -- Ledger.restore() logs and emits the rebuild with this error
      return { state: null, reason: "checkpoint_unreadable", error: String(error?.message || error).slice(0, 300) };
    }
    if (state?.schema !== CHECKPOINT_SCHEMA || state.event_schema !== this.eventSchema
      || !state.files || !state.days) {
      return { state: null, reason: "checkpoint_incompatible", error: `schema ${state?.schema} event schema ${state?.event_schema}` };
    }
    return { state, reason: null };
  }

  /**
   * Restores `ledger` (its files, seen, active, closedOps and summary.days) from the checkpoint plus the raw files it
   * does not cover, or from every raw file when it cannot be used. `fold(event)` folds each event read. Returns
   * { replay, reason, error, dirty } -- dirty: the days events were read for.
   */
  restore(ledger, fold) {
    const began = Date.now();
    const files = this.rawFiles();
    const checkpoint = this.loadCheckpoint();
    let reason = checkpoint.reason;
    const plan = new Map();   // key -> "skip" | "tail"; a file absent from it is read whole
    if (checkpoint.state) {
      for (const file of files) {
        const covered = checkpoint.state.files[file.key];
        if (!covered) continue;
        const state = this.coveredState(file, covered);
        if (state === "changed") { reason = "raw_file_changed"; break; }
        plan.set(file.key, state);
      }
    }
    const usable = Boolean(checkpoint.state) && reason === null;
    if (usable) this.loadState(ledger, checkpoint.state);
    else { plan.clear(); if (!files.length) reason = null; }   // nothing was ever written: nothing to rebuild
    const dirty = new Set();
    let read = 0, bytes = 0, events = 0;
    for (const file of files) {
      const how = plan.get(file.key);
      if (how === "skip") continue;
      let result;
      try {
        result = this.readRawFile(file, (event) => { fold(event); dirty.add(eventDay(event)); },
          how === "tail" ? ledger.files.get(file.key) : null, ledger.seen);
      } catch (error) { console.warn("[reading a remediation ledger file] failed", error); continue; }
      ledger.files.set(file.key, result.entry);
      read += 1; bytes += result.bytes; events += result.events;
    }
    // Pruned files leave the index (and their corruption finding with them).
    const present = new Set(files.map((file) => file.key));
    for (const key of [...ledger.files.keys()]) if (!present.has(key)) ledger.files.delete(key);
    for (const [key, entry] of ledger.files) {
      if (!entry.corrupt) continue;
      this.stats.degraded = true;
      this.stats.corrupt_lines = { ...(this.stats.corrupt_lines || {}), [path.basename(key)]: entry.corrupt };
      this.logger.warn?.(`[REMEDIATION] ${key}: line ${entry.corrupt.first_line} is not a complete record (${entry.corrupt.error}); the ledger is degraded`);
    }
    const replay = { source: usable ? "checkpoint" : "raw_files", reason, files_total: files.length, files_read: read,
      files_skipped: files.length - read, bytes_read: bytes, events_read: events, duration_ms: Date.now() - began };
    return { replay, reason, error: checkpoint.error || null, dirty };
  }

  loadState(ledger, state) {
    ledger.files = new Map(Object.entries(state.files));
    ledger.summary.days = new Map(Object.entries(state.days).map(([day, mechanisms]) =>
      [day, new Map(Object.entries(mechanisms).map(([id, stats]) => [id, statsFromJson(stats)]))]));
    ledger.active = new Map(state.active || []);
    ledger.closedOps = new Set(state.closed_operations || []);
    ledger.seen = new Set(state.seen || []);
  }

  // Durable and atomic (fsync'd temp file, then rename): a torn checkpoint is never read as a valid one. A failure is
  // recorded in the sink status and costs only the next start a re-read of the files it would have covered.
  writeCheckpoint(ledger, ownFiles) {
    // This writer's own files, as far as written (every line it writes ends with a newline).
    for (const file of ownFiles) {
      let fd;
      try {
        fd = this.fs.openSync(file, "r");
        const stat = this.fs.fstatSync(fd);
        const key = path.relative(this.logsRoot, file).split(path.sep).join("/");
        ledger.files.set(key, { offset: stat.size, lines: null, size: stat.size, mtime_ms: stat.mtimeMs,
          tail_sha1: this.tailDigest(fd, stat.size), corrupt: null });
      } catch (error) { console.warn("[stating an own remediation ledger file for the checkpoint] failed", error); }
      finally { if (fd !== undefined) this.fs.closeSync(fd); }
    }
    const state = { schema: CHECKPOINT_SCHEMA, event_schema: this.eventSchema,
      written_at: contract.localIso(this.now()), files: Object.fromEntries(ledger.files),
      days: Object.fromEntries([...ledger.summary.days].map(([day, mechanisms]) =>
        [day, Object.fromEntries([...mechanisms].map(([id, stats]) => [id, statsToJson(stats)]))])),
      active: [...ledger.active], closed_operations: [...ledger.closedOps], seen: [...ledger.seen] };
    try {
      writeJsonAtomic(this.checkpointPath, state, { fsImpl: this.fs, indent: 0, durable: true });
      this.stats.checkpoint_written_at = state.written_at;
      this.stats.checkpoint_error = null;
      return true;
    } catch (error) {
      this.stats.checkpoint_error = `${this.checkpointPath}: ${error?.message || error}`.slice(0, 300);
      this.logger.warn?.(`[REMEDIATION] checkpoint write failed: ${error?.message || error}`);
      return false;
    }
  }
}

module.exports = { LedgerRecovery };
