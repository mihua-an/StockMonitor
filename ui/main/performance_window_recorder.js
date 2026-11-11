"use strict";

function percentile(values, q) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return Math.round((ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * q) - 1))] || 0) * 1000) / 1000;
}

function localDate(epochMs) {
  const date = new Date(epochMs);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const { createSinkHealth } = require("../../service/platform/js/sink_health");

function createPerformanceWindowRecorder({ fs, path, outputDir, electronPid,
  now = Date.now, windowMs = 10000, slowSelectionMs = 100, maxValuesPerMetric = 2048,
  retentionDays = 14, maxRetentionBytes = 64 * 1024 * 1024 }) {
  const directory = path.join(outputDir, "performance");
  fs.mkdirSync(directory, { recursive: true });
  let windowStartedAt = Math.floor(now() / windowMs) * windowMs;
  let reportCount = 0;
  let rendererIds = new Set();
  let values = new Map();
  let counters = new Map();
  let selections = new Map();
  let startupEvents = [];
  let appendChain = Promise.resolve();
  // A failed append is never ignored with close() still resolving: it is counted with its error, and
  // the next record that is written carries a `loss_marker` for the windows lost in between.
  const health = createSinkHealth(`performance:${directory}`, { now });

  async function enforceRetention(referenceTime = now()) {
    const cutoff = Number(referenceTime) - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000;
    let entries = [];
    try {
      entries = (await fs.promises.readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name));
    } catch (error) { /* absent is not an error: no performance directory yet: nothing to prune */ if (error?.code !== "ENOENT") console.warn("[PERFORMANCE list directory] failed", error); return; }
    const rows = [];
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      try {
        const stat = await fs.promises.stat(file);
        if (stat.mtimeMs < cutoff) { await fs.promises.unlink(file); continue; }
        rows.push({ file, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch (error) { console.warn("[PERFORMANCE prune stat/unlink] failed", error); }
    }
    rows.sort((left, right) => right.mtimeMs - left.mtimeMs);
    let retained = 0;
    for (const row of rows) {
      retained += row.size;
      if (retained <= Math.max(1024, maxRetentionBytes)) continue;
      try { await fs.promises.unlink(row.file); } catch (error) { console.warn("[PERFORMANCE prune unlink] failed", error); }
    }
  }

  appendChain = appendChain.then(() => enforceRetention());

  function add(name, value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    if (!values.has(name)) values.set(name, []);
    const rows = values.get(name);
    rows.push(numeric);
    if (rows.length > maxValuesPerMetric) rows.shift();
  }

  function count(name, value = 1) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) counters.set(name, (counters.get(name) || 0) + numeric);
  }

  function addSummary(prefix, summary = {}) {
    for (const key of ["latest_ms", "p50_ms", "p95_ms", "p99_ms", "max_ms"]) {
      if (summary[key] != null) add(`${prefix}.${key}`, summary[key]);
    }
  }

  function observeSelection(rendererId, selection = {}) {
    const generation = Number(selection.selection_generation || 0);
    if (!generation) return;
    const key = `${rendererId}:${generation}`;
    if (selections.has(key)) return;
    const marks = selection.marks && typeof selection.marks === "object" ? selection.marks : {};
    const stages = selection.stages && typeof selection.stages === "object" ? selection.stages : {};
    selections.set(key, {
      renderer_id: rendererId,
      selection_generation: generation,
      request_id: String(selection.request_id || ""),
      from_code: String(selection.from_code || ""),
      to_code: String(selection.to_code || ""),
      selection_started_ns: String(selection.selection_started_ns || ""),
      marks,
      stages,
    });
    for (const [name, value] of Object.entries(marks)) add(`selection.${name}_ms`, value);
  }

  function observe(rendererId, payload = {}) {
    const current = now();
    if (current >= windowStartedAt + windowMs) flush(windowStartedAt + windowMs);
    rendererIds.add(rendererId);
    reportCount += 1;
    const performance = payload.performance || {};
    add("renderer.event_loop_delay_ms", payload.event_loop_delay_ms);
    add("renderer.event_loop_delay_p95_ms", performance.event_loop_delay_p95_ms);
    add("renderer.event_loop_delay_p99_ms", performance.event_loop_delay_p99_ms);
    add("renderer.event_loop_delay_max_ms", performance.event_loop_delay_max_ms);
    add("renderer.long_task_p95_ms", performance.long_task_p95_ms);
    add("renderer.long_task_max_ms", performance.long_task_max_ms);
    add("renderer.input_delay_p95_ms", performance.input_delay_p95_ms);
    add("renderer.input_delay_p99_ms", performance.input_delay_p99_ms);
    add("renderer.event_duration_p95_ms", performance.event_duration_p95_ms);
    add("renderer.event_duration_p99_ms", performance.event_duration_p99_ms);
    add("renderer.frame_interval_p95_ms", performance.frame_interval_p95_ms);
    add("renderer.frame_interval_p99_ms", performance.frame_interval_p99_ms);
    add("renderer.frame_interval_max_ms", performance.frame_interval_max_ms);
    add("renderer.layout_shift_score", performance.layout_shift_score);
    add("renderer.input_layout_shift_score", performance.input_layout_shift_score);
    add("renderer.heap_used_mb", performance.heap_used_mb);
    count("renderer.long_task_count", performance.long_task_count);
    count("renderer.slow_frame_count", performance.slow_frame_count);
    count("renderer.layout_shift_count", performance.layout_shift_count);
    count("renderer.input_layout_shift_count", performance.input_layout_shift_count);
    count("renderer.input_event_count", performance.input_event_count);

    const sampledAt = Number(payload.sampled_at || current);
    const transport = payload.transport || {};
    if (transport.last_frame_at) add("transport.websocket_freshness_ms", Math.max(0, sampledAt - Number(transport.last_frame_at)));
    for (const component of Array.isArray(payload.components) ? payload.components : []) {
      if (component?.active && component?.frame_at) {
        add(`component.${String(component.component || "unknown")}.freshness_ms`, Math.max(0, sampledAt - Number(component.frame_at)));
      }
    }
    for (const [lane, summary] of Object.entries(payload.market_latency || {})) {
      addSummary(`market.${lane}.update`, summary?.update);
      addSummary(`market.${lane}.frame`, summary?.frame);
    }
    for (const selection of Array.isArray(payload.selection_recent) ? payload.selection_recent : []) {
      observeSelection(rendererId, selection);
    }
  }

  function observeStartup(item = {}) {
    const name = String(item.name || "unknown");
    add(`startup.${name}_ms`, item.duration_ms);
    startupEvents.push({ name, duration_ms: Number(item.duration_ms) || 0, detail: item.detail ?? null });
    if (startupEvents.length > 128) startupEvents.shift();
    reportCount += 1;
  }

  function reset(nextStart) {
    windowStartedAt = nextStart;
    reportCount = 0;
    rendererIds = new Set();
    values = new Map();
    counters = new Map();
    selections = new Map();
    startupEvents = [];
  }

  function flush(flushedAt = now()) {
    if (!reportCount) {
      windowStartedAt = Math.floor(flushedAt / windowMs) * windowMs;
      return appendChain;
    }
    const metricRows = {};
    for (const [name, rows] of values) {
      metricRows[name] = { count: rows.length, p50: percentile(rows, .50), p95: percentile(rows, .95),
        p99: percentile(rows, .99), max: percentile(rows, 1) };
    }
    const selectionRows = [...selections.values()];
    const slowSelections = selectionRows.filter((row) => {
      const visible = Number(row.marks?.first_visible_paint);
      const ready = Number(row.marks?.full_view_ready);
      return (Number.isFinite(visible) && visible >= slowSelectionMs)
        || (Number.isFinite(ready) && ready >= slowSelectionMs);
    });
    const record = {
      schema: "stock-monitor-performance-window-v1",
      electron_pid: electronPid,
      window_started_at: windowStartedAt,
      window_ended_at: flushedAt,
      window_ms: Math.max(0, flushedAt - windowStartedAt),
      report_count: reportCount,
      renderer_ids: [...rendererIds],
      metrics: metricRows,
      counters: Object.fromEntries(counters),
      selection_count: selectionRows.length,
      slow_selections: slowSelections,
      startup_events: startupEvents,
    };
    const file = path.join(directory, `${localDate(windowStartedAt)}.jsonl`);
    appendChain = appendChain.then(() => new Promise((resolve) => {
      const marker = health.lossMarker();
      const wire = `${JSON.stringify(marker ? { ...record, loss_marker: marker } : record)}\n`;
      fs.appendFile(file, wire, (error) => {
        if (error) health.failed(error, 1);
        else { health.succeeded(); health.markerWritten(marker); }
        resolve();
      });
    })).then(() => enforceRetention(flushedAt));
    reset(Math.floor(flushedAt / windowMs) * windowMs);
    return appendChain;
  }

  // Resolves with the sink's health: `unstated_loss` > 0 means windows were lost and not yet stated on disk.
  function close() { return flush(now()).then(() => health.snapshot()); }
  return { observe, observeStartup, flush, close, health: () => health.snapshot() };
}

module.exports = { createPerformanceWindowRecorder };
