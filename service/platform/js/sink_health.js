"use strict";

// The health of one observability sink: a log or telemetry writer that must never break
// its owner also must never pretend. Every write that failed and every record dropped is counted here with the last
// error; the owner exposes `snapshot()` (state OK / FAILING, lost_records, write_failures, last_error), and the next
// write that succeeds carries a loss marker for whatever was lost since the last one -- the gap is stated in the file
// itself once the disk is back. A flush answers with this snapshot, so "flushed" is never read as "on disk".

const { rotateIfLarger } = require("./atomic_files");

function errorSummary(error) {
  return { code: error?.code || null, message: String(error?.message || error || "write failed").slice(0, 300) };
}

function createSinkHealth(name, { now = Date.now } = {}) {
  let state = "OK";
  let lostRecords = 0;
  let writeFailures = 0;
  let lastError = null;
  let lastWriteAt = null;
  // Loss not yet stated in the sink itself: the next successful write carries it.
  let unstated = 0;
  let unstatedSince = null;
  const reasons = new Map();

  function lose(count, reason) {
    const n = Math.max(0, Number(count) || 0);
    if (!n) return;
    lostRecords += n;
    unstated += n;
    unstatedSince ??= new Date(now()).toISOString();
    reasons.set(reason, (reasons.get(reason) || 0) + n);
  }

  return {
    /** A write that went through. */
    succeeded() {
      state = "OK";
      lastWriteAt = new Date(now()).toISOString();
    },
    /** A write that failed; `count` records it carried are lost. */
    failed(error, count) {
      state = "FAILING";
      writeFailures += 1;
      lastError = { at: new Date(now()).toISOString(), ...errorSummary(error) };
      lose(count, "write_failed");
    },
    /** Records refused before any write (a full buffer, a rate limit): lost, though the disk is fine. */
    dropped(count, reason = "dropped") {
      lose(count, reason);
    },
    /**
     * The marker the next write must carry, or null: an immutable copy of the loss not yet stated. Call
     * `markerWritten(marker)` with this same marker once the write carrying it succeeded; loss counted after it was
     * taken stays unstated for the next marker.
     */
    lossMarker() {
      if (!unstated) return null;
      return Object.freeze({ sink: name, lost_records: unstated, since: unstatedSince, taken_at: new Date(now()).toISOString(),
        reasons: Object.freeze(Object.fromEntries(reasons)), last_error: lastError });
    },
    markerWritten(marker) {
      if (!marker) return;
      unstated = Math.max(0, unstated - marker.lost_records);
      for (const [reason, n] of Object.entries(marker.reasons)) {
        const left = (reasons.get(reason) || 0) - n;
        if (left > 0) reasons.set(reason, left); else reasons.delete(reason);
      }
      // What is left was lost after the marker was taken.
      unstatedSince = unstated ? marker.taken_at : null;
      if (!unstated) reasons.clear();
    },
    snapshot() {
      return { sink: name, state, lost_records: lostRecords, write_failures: writeFailures, unstated_loss: unstated,
        last_error: lastError, last_write_at: lastWriteAt };
    },
  };
}

/** One text line stating a loss, for line-oriented logs. */
function lossLine(marker, prefix) {
  const reasons = Object.entries(marker.reasons || {}).map(([reason, n]) => `${reason}=${n}`).join(", ");
  const error = marker.last_error ? `; last error ${marker.last_error.code || ""} ${marker.last_error.message}`.trimEnd() : "";
  return `${prefix} LOSS MARKER: ${marker.lost_records} record(s) lost since ${marker.since} (${reasons})${error}\n`;
}

/**
 * The one background append writer of a line-oriented log (a Health child's output log, Electron main's error log).
 * Appending synchronously per record would block the owner's event loop on the disk, so records wait in memory and
 * are written asynchronously, one flush at a time, with a size rotation tried before every append.
 *
 * `admit(record, { pendingBytes })` is the owner's rule for what may wait: it returns null to accept the record, or a
 * reason string under which the record is dropped (a full buffer, a rate limit) -- counted in the sink's health and
 * stated by the loss marker the next successful write carries. A rotation that fails is counted apart from the
 * appends (`rotation.failures`, `rotation.last_error`): the log keeps growing although every append succeeds; it is
 * logged when its reason changes. `markerPrefix()` is the text in front of a loss marker line.
 */
function createAppendWriter(fs, file, { name, limit, now = Date.now, admit = () => null, markerPrefix, label = file } = {}) {
  const health = createSinkHealth(name, { now });
  const rotation = { failures: 0, last_error: null };
  let pending = [];
  let pendingBytes = 0;
  let flushing = null;

  async function rotate() {
    try {
      const { pruneFailures } = await rotateIfLarger(file, limit, { fsImpl: fs, now });
      if (pruneFailures.length) {
        const first = pruneFailures[0];
        throw Object.assign(new Error(`removing ${pruneFailures.length} old rotated log(s) failed: ${first.name}: ${first.message}`), { code: first.code });
      }
    } catch (error) {
      rotation.failures += 1;
      const message = String(error?.message || error).slice(0, 300);
      // not an error: the same reason again repeats the one already logged; every failure is counted
      if (message !== rotation.last_error?.message) console.warn(`[${label}] rotation failed: ${message}`);
      rotation.last_error = { at: new Date(now()).toISOString(), code: error?.code || null, message };
    }
  }

  const snapshot = () => ({ ...health.snapshot(), rotation: { ...rotation } });

  async function drain() {
    while (pending.length || health.lossMarker()) {
      const parts = pending;
      pending = [];
      pendingBytes = 0;
      const marker = health.lossMarker();
      const data = Buffer.concat(marker ? [Buffer.from(lossLine(marker, markerPrefix()), "utf8"), ...parts] : parts);
      await rotate();
      try {
        await fs.promises.appendFile(file, data);
        health.succeeded();
        health.markerWritten(marker);
      } catch (error) {
        // A log write never fails its owner, and never vanishes either: counted, and stated when writing resumes.
        health.failed(error, parts.length);
        break;
      }
    }
  }

  function flush() {
    if (!flushing) flushing = drain().finally(() => { flushing = null; });
    return flushing.then(() => snapshot());
  }

  return {
    /** Queues one record (a string or a Buffer); false when `admit` refused it. */
    write(record) {
      const data = Buffer.isBuffer(record) ? record : Buffer.from(String(record), "utf8");
      const refused = admit(data, { pendingBytes });
      if (refused) {
        health.dropped(1, refused);
        return false;
      }
      pending.push(data);
      pendingBytes += data.length;
      if (!flushing) setImmediate(flush);
      return true;
    },
    // Resolves with the sink's health once everything written so far was attempted: `state` and `unstated_loss` say
    // whether it actually reached the disk.
    flush,
    health: () => snapshot(),
  };
}

module.exports = { createSinkHealth, lossLine, createAppendWriter };
