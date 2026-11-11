"use strict";

// The ledger's writer: an ordered, bounded queue of event lines appended to this log session's raw file and fsync'd
// in batches. A new file per local day and past `rotateBytes`. `durableLines` counts the lines on disk; `onDurable`
// runs after each fsync (the ingress acknowledges client frames from it). A write failure keeps the lines queued;
// what overflows the queue is counted, and once writing works again `onLossReported(loss)` is told how many were
// lost (the facade records that as one `sink.writer_loss` event).

const path = require("path");
const contract = require("../../config/js/remediation_contract.js");
const { HEADER_SCHEMA, MARKER_SCHEMA, FILE_PATTERN, pad, localDay } = require("./ledger_records.js");

const ROTATE_BYTES = 64 * 1024 * 1024;
const MAX_QUEUE_LINES = 10_000;
const BATCH_LINES = 500;
const RETRY_MS = 1000;

function listDir(fs, dir) {
  try { return fs.readdirSync(dir); }
  catch (error) {
    // absent is not an error: no such directory yet
    if (error?.code !== "ENOENT") console.warn("[listing a remediation ledger directory] failed", error);
    return [];
  }
}

class LedgerWriter {
  constructor({ fs, now, logger, sessionDir, writer, eventSchema, stats, rotateBytes = ROTATE_BYTES,
    maxQueueLines = MAX_QUEUE_LINES, onDurable = () => {}, onLossReported = () => {} }) {
    Object.assign(this, { fs, now, logger, sessionDir, writer, eventSchema, stats, rotateBytes, maxQueueLines,
      onDurable, onLossReported });
    this.queue = [];
    this.file = null;                // { path, day, handle, bytes }
    this.draining = null;
    this.retryTimer = null;
    this.stopped = false;
    this.appendedLines = 0;
    this.durableLines = 0;
    this.unreportedLoss = null;      // { count, since, reason, last_error }
    this.ownFiles = new Set();       // raw files this writer created
  }

  // The line number it was queued as, or 0 when the queue is full. Only an event nobody will send again (Health's
  // own) is lost then and counted as a writer loss; a client's is refused and resent by the client.
  append(line, { lossIfFull = true } = {}) {
    if (this.queue.length >= this.maxQueueLines) {
      this.stats.dropped += 1;
      if (lossIfFull) {
        if (!this.unreportedLoss) this.unreportedLoss = { count: 0, since: contract.localIso(this.now()), reason: "queue_full", last_error: this.stats.last_error };
        this.unreportedLoss.count += 1;
      }
      return 0;
    }
    this.queue.push(line);
    this.appendedLines += 1;
    this.kick();
    return this.appendedLines;
  }

  kick() {
    if (!this.draining) {
      this.draining = this.drain().finally(() => { this.draining = null; if (this.queue.length && !this.stopped) this.retryLater(); });
    }
    return this.draining;
  }

  retryLater() {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.kick(); }, RETRY_MS);
    this.retryTimer.unref?.();
  }

  nextFilePath(day) {
    let highest = 0;
    for (const name of listDir(this.fs, this.sessionDir)) {
      const match = FILE_PATTERN.exec(name);
      if (match && match[1] === day) highest = Math.max(highest, Number(match[2]));
    }
    return path.join(this.sessionDir, `remediation-${day}-${pad(highest + 1, 3)}.jsonl`);
  }

  async openFile(day) {
    if (this.file) {
      await this.file.handle.close().catch((error) => console.warn("[closing the previous remediation ledger file] failed", error));
      this.stats.rotations += 1;
    }
    const file = this.nextFilePath(day);
    const handle = await this.fs.promises.open(file, "a");
    this.ownFiles.add(file);
    const header = JSON.stringify({ schema: HEADER_SCHEMA, day, opened_at: contract.localIso(this.now()),
      writer: this.writer, log_session: path.basename(this.sessionDir), event_schema: this.eventSchema }) + "\n";
    await handle.write(header);
    this.file = { path: file, day, handle, bytes: Buffer.byteLength(header) };
  }

  async drain() {
    while (this.queue.length) {
      const day = localDay(this.now());
      try {
        if (!this.file || this.file.day !== day || this.file.bytes >= this.rotateBytes) await this.openFile(day);
        const batch = this.queue.slice(0, BATCH_LINES);
        const data = batch.map((line) => `${line}\n`).join("");
        await this.file.handle.write(data);
        await this.file.handle.sync();
        this.queue.splice(0, batch.length);
        this.file.bytes += Buffer.byteLength(data);
        this.stats.written += batch.length;
        this.stats.last_fsync_at = contract.localIso(this.now());
        this.durableLines += batch.length;
        this.onDurable();
        if (this.unreportedLoss) this.reportLoss();
      } catch (error) {
        this.stats.write_errors += 1;
        this.stats.last_error = `write ${this.file?.path || this.sessionDir}: ${error.message}`;
        // Nothing is lost yet (the lines stay queued); recorded in the ledger once writing works again, with what
        // overflowed by then. The first failure of a streak also goes to the log, which a ledger that never recovers
        // cannot replace. not an error: later failures of the streak repeat that one (the stats keep the last).
        if (!this.unreportedLoss) {
          this.unreportedLoss = { count: 0, since: contract.localIso(this.now()), reason: "write_failed", last_error: null };
          console.warn(`[REMEDIATION] ledger ${this.stats.last_error}; the events stay queued`);
        }
        this.unreportedLoss.last_error = this.stats.last_error;
        if (this.file) {
          await this.file.handle.close().catch((closeError) => console.warn("[closing the remediation ledger file after a write failure] failed", closeError));
          this.file = null;
        }
        return false;
      }
    }
    return true;
  }

  // Writing works again: say how many events were lost while it did not (or that none were, after a failure).
  reportLoss() {
    const loss = this.unreportedLoss;
    this.unreportedLoss = null;
    this.onLossReported(loss);
  }

  // True only when everything accepted so far is written and fsync'd.
  async flush() {
    while (this.queue.length || this.draining) {
      const ok = await this.kick();
      if (!ok && this.queue.length) return false;
    }
    return !this.unreportedLoss || this.unreportedLoss.count === 0;
  }

  // The last line of this writer: the terminal marker, fsync'd, and the file closed. Throws what failed.
  async writeTerminal(marker) {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    try {
      if (!this.file) await this.openFile(localDay(this.now()));
      await this.file.handle.write(JSON.stringify({ schema: MARKER_SCHEMA, kind: "terminal", ...marker }) + "\n");
      await this.file.handle.sync();
      await this.file.handle.close();
      this.file = null;
    } catch (error) {
      if (this.file) {
        await this.file.handle.close().catch((closeError) => console.warn("[closing the remediation ledger file after a terminal-marker failure] failed", closeError));
      }
      this.file = null;
      throw error;
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
  }
}

module.exports = { LedgerWriter, ROTATE_BYTES, MAX_QUEUE_LINES, listDir };
