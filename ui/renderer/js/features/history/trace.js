/**
 * History replay page diagnostics/trace log.
 *
 * Records a bounded, in-memory timeline of page lifecycle events (relative
 * to when the trace was last reset) and mirrors it onto `window.__historyTrace`
 * for manual inspection/debugging. Intentionally isolated from replay
 * selection/state, same as the other `features/history/*` controllers.
 */
export function createHistoryTrace({ windowRef = window, performanceRef = performance } = {}) {
  const state = { startedAt: performanceRef.now(), entries: [] };

  function trace(name, detail = {}) {
    const entry = {
      name: String(name || ""),
      elapsed_ms: Math.round((performanceRef.now() - state.startedAt) * 1000) / 1000,
      ...detail,
    };
    state.entries.push(entry);
    if (state.entries.length > 80) state.entries.splice(0, state.entries.length - 80);
    windowRef.__historyTrace = { entries: state.entries.slice() };
    return entry;
  }

  function reset() {
    state.startedAt = performanceRef.now();
    state.entries = [];
  }

  return { trace, reset };
}
