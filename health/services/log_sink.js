"use strict";

// One child's output log for a Health host. Appending every stdout/stderr chunk with
// statSync + appendFileSync on Health's event loop would block it per chunk, without bound when the disk stalls.
// Chunks are buffered and written asynchronously, one flush at a time, with a size rotation
// checked per flush. While a flush is outstanding at most `maxPendingBytes` wait; beyond that chunks are dropped
// and the drop is written into the log (a loss marker) when writing resumes, never silently.

const { createSinkHealth, lossLine } = require("../../service/platform/js/sink_health");
const { rotateIfLarger } = require("../../service/platform/js/atomic_files");

const DEFAULT_LIMIT = 4 * 1024 * 1024;
const DEFAULT_MAX_PENDING = 1024 * 1024;

// A write that fails is counted, not swallowed: the sink's health says FAILING with the lost chunk count and
// the last error, and the first write that succeeds again begins with a loss marker for every chunk lost meanwhile.
function createLogSink(fs, file, { limit = DEFAULT_LIMIT, maxPendingBytes = DEFAULT_MAX_PENDING, now = Date.now } = {}) {
  const health = createSinkHealth(`log:${file}`, { now });
  let pending = [];
  let pendingBytes = 0;
  let flushing = null;

  // A rotation that fails leaves the log growing until the next flush tries again: warned, and the write still happens.
  async function rotate() {
    try {
      const { pruneFailures } = await rotateIfLarger(file, limit, { fsImpl: fs });
      for (const failure of pruneFailures) console.warn(`[removing an old service log ${failure.name}] failed: ${failure.message}`);
    } catch (error) { console.warn("[rotating a service log] failed", error); }
  }

  async function drain() {
    while (pending.length || health.lossMarker()) {
      const parts = pending;
      pending = [];
      pendingBytes = 0;
      const marker = health.lossMarker();
      const data = Buffer.concat(marker ? [Buffer.from(lossLine(marker, "[health]")), ...parts] : parts);
      try {
        await rotate();
        await fs.promises.appendFile(file, data);
        health.succeeded();
        health.markerWritten(marker);
      } catch (error) {
        // A log write never fails the host, and never vanishes either: counted, and stated when writing resumes.
        health.failed(error, parts.length);
        break;
      }
    }
  }

  function flush() {
    if (!flushing) flushing = drain().finally(() => { flushing = null; });
    return flushing.then(() => health.snapshot());
  }

  return {
    write(chunk) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (pendingBytes + data.length > maxPendingBytes) {
        health.dropped(1, "write_behind");
        return false;
      }
      pending.push(data);
      pendingBytes += data.length;
      if (!flushing) setImmediate(flush);
      return true;
    },
    // Resolves with the sink's health once everything written so far was attempted: `state` and `unstated_loss` say
    // whether it actually reached the disk (tests, and a host about to report a log path).
    flush,
    health: () => health.snapshot(),
  };
}

module.exports = { createLogSink };
