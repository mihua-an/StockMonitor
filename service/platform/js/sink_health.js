"use strict";

// The health of one observability sink: a log or telemetry writer that must never break
// its owner also must never pretend. Every write that failed and every record dropped is counted here with the last
// error; the owner exposes `snapshot()` (state OK / FAILING, lost_records, write_failures, last_error), and the next
// write that succeeds carries a loss marker for whatever was lost since the last one -- the gap is stated in the file
// itself once the disk is back. A flush answers with this snapshot, so "flushed" is never read as "on disk".

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

module.exports = { createSinkHealth, lossLine };
