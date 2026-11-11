"use strict";

const { performance } = require("perf_hooks");

// Records how long startup phases take and, separately, timestamped trace
// events for the startup timeline. Both are buffered until a persist handler
// (renderer health) is attached, then replayed and written through live.
function createStartupMetricsRecorder({ electronPid = process.pid } = {}) {
  const electronProcessStartedAt = performance.now();
  const items = [];
  let persist = null;

  function record(item) {
    items.push(item);
    persist?.(item);
  }

  function mark(name, startedAt = electronProcessStartedAt, detail = null) {
    record({ name, duration_ms: Math.max(0, performance.now() - startedAt), detail });
  }

  function markTrace(stage, detail = null) {
    const elapsedMs = Math.max(0, performance.now() - electronProcessStartedAt);
    record({
      name: "startup_trace",
      duration_ms: elapsedMs,
      detail: {
        stage: String(stage || "").toUpperCase(),
        elapsed_ms_from_app_start: elapsedMs,
        timestamp: new Date().toISOString(),
        electron_pid: electronPid,
        ...(detail && typeof detail === "object" ? detail : {}),
      },
    });
  }

  function setPersistHandler(handler) {
    persist = handler;
    for (const item of items) persist(item);
  }

  // The persist handler (renderer health's startup log) is the only sink: the POST to FastAPI that also
  // drained this buffer went to a route that discarded every item, so metrics recorded before the handler attached
  // could be lost there.
  return { electronProcessStartedAt, mark, markTrace, setPersistHandler };
}

module.exports = { createStartupMetricsRecorder };
