"use strict";

// One child's output log for a Health host. Appending every stdout/stderr chunk with
// statSync + appendFileSync on Health's event loop would block it per chunk, without bound when the disk stalls.
// The shared append writer buffers chunks and writes them asynchronously with a size rotation; while a flush is
// outstanding at most `maxPendingBytes` wait, beyond that chunks are dropped and the drop is written into the log
// (a loss marker) when writing resumes, never silently.

const { createAppendWriter } = require("../../service/platform/js/sink_health");

const DEFAULT_LIMIT = 4 * 1024 * 1024;
const DEFAULT_MAX_PENDING = 1024 * 1024;

function createLogSink(fs, file, { limit = DEFAULT_LIMIT, maxPendingBytes = DEFAULT_MAX_PENDING, now = Date.now } = {}) {
  return createAppendWriter(fs, file, {
    name: `log:${file}`,
    label: `service log ${file}`,
    limit,
    now,
    admit: (data, { pendingBytes }) => (pendingBytes + data.length > maxPendingBytes ? "write_behind" : null),
    markerPrefix: () => "[health]",
  });
}

module.exports = { createLogSink };
