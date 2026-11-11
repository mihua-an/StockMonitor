"use strict";

// Health's startup timeline: every stage from main() to "ready" with its wall-clock time (ISO, to compare with the
// other processes' logs) and its monotonic elapsed time since Health's process started (immune to clock changes).
// One line per stage as it ends, and one structured `startup timeline` line once startup is over. A stage that throws
// ends with a terminal `failed` record before the error goes on. Measuring the 10-14 launch (19 s, then 80 s,
// between Health's start and its first service) needed log timestamps from five processes; this says it in one line.

function createStartupTimeline({ wallNow = () => new Date(), monoNow = () => performance.now(), processUptimeMs = () => process.uptime() * 1000,
  log = (line) => console.log(line) } = {}) {
  // performance.now() counts from this process's start (timeOrigin), like process.uptime(): Health's own elapsed time.
  const stages = [];
  const open = new Map();
  let finished = null;
  const iso = () => wallNow().toISOString();
  const elapsed = () => Math.round(monoNow());

  function record(entry) {
    stages.push(entry);
    const detail = entry.detail ? ` ${JSON.stringify(entry.detail)}` : "";
    const took = entry.ms === undefined ? "" : ` ${entry.ms} ms`;
    log(`[HEALTH] [startup +${entry.end_ms ?? entry.at_ms} ms] ${entry.stage} ${entry.outcome}${took}${detail}`);
    return entry;
  }

  // A point in time (no duration).
  function mark(stage, detail = null) {
    return record({ stage, outcome: "reached", at: iso(), at_ms: elapsed(), ...(detail ? { detail } : {}) });
  }

  // A stage with a start and an end: end(detail) or fail(error, detail) exactly once.
  function begin(stage) {
    const span = { stage, started_at: iso(), start_ms: elapsed() };
    open.set(span, true);
    const close = (outcome, detail, error) => {
      if (!open.delete(span)) return null;
      const end = elapsed();
      return record({ stage, outcome, started_at: span.started_at, start_ms: span.start_ms, ended_at: iso(), end_ms: end,
        ms: end - span.start_ms, ...(detail ? { detail } : {}), ...(error ? { error: String(error?.message || error).slice(0, 300) } : {}) });
    };
    return { end: (detail = null) => close("ok", detail), fail: (error, detail = null) => close("failed", detail, error) };
  }

  // Runs fn as a stage; a throw (or rejection) is recorded as failed and re-thrown.
  function stage(name, fn, describe = null) {
    const span = begin(name);
    const settle = (value) => { span.end(describe ? describe(value) : null); return value; };
    const failed = (error) => { span.fail(error); throw error; };
    let value;
    try { value = fn(); } catch (error) { return failed(error); }
    return value && typeof value.then === "function" ? value.then(settle, failed) : settle(value);
  }

  // The one structured line: every stage, the stages still open (an abandoned startup), and the totals.
  function finish(outcome = "ready", detail = null) {
    if (finished) return finished;
    const unfinished = [...open.keys()].map((span) => ({ stage: span.stage, started_at: span.started_at, start_ms: span.start_ms }));
    finished = { schema: "stock-monitor-health-startup-timeline-v1", outcome, finished_at: iso(), elapsed_ms: elapsed(),
      process_uptime_ms: Math.round(processUptimeMs()), stages: [...stages], unfinished, ...(detail ? { detail } : {}) };
    log(`[HEALTH] startup timeline ${JSON.stringify(finished)}`);
    return finished;
  }

  return { mark, begin, stage, finish, stages: () => [...stages], result: () => finished };
}

module.exports = { createStartupTimeline };
