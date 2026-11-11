"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createPerformanceWindowRecorder } = require("../ui/main/performance_window_recorder");

(async () => {
  const output = makeTempDir("performance-window-contract-");
  let now = new Date(2026, 8, 14, 9, 0, 0).getTime();
  const recorder = createPerformanceWindowRecorder({ fs, path, outputDir: output,
    electronPid: 42, now: () => now, windowMs: 10000 });
  recorder.observeStartup({ name: "backend_ready", duration_ms: 321, detail: { attempt: 1 } });
  recorder.observe(1, { sampled_at: now, event_loop_delay_ms: 2,
    performance: { long_task_count: 0, frame_interval_p95_ms: 16.7 },
    transport: { last_frame_at: now - 8 }, components: [],
    market_latency: { stock_tick: { frame: { p95_ms: 20, p99_ms: 25, max_ms: 30 } } },
    selection_recent: [{ selection_generation: 7, request_id: "s7", to_code: "2330",
      selection_started_ns: "1", marks: { first_visible_paint: 80 }, stages: {} }],
  });
  now += 2000;
  recorder.observe(1, { sampled_at: now, event_loop_delay_ms: 12,
    performance: { long_task_count: 1, long_task_max_ms: 60 }, transport: { last_frame_at: now - 15 },
    components: [{ active: true, component: "trades", frame_at: now - 25 }],
    selection_recent: [{ selection_generation: 7, to_code: "2330", marks: { first_visible_paint: 80 } }],
  });
  now += 9000;
  recorder.observe(1, { sampled_at: now, event_loop_delay_ms: 1, performance: {}, components: [] });
  await recorder.close();
  const files = fs.readdirSync(path.join(output, "performance"));
  assert.equal(files.length, 1);
  const rows = fs.readFileSync(path.join(output, "performance", files[0]), "utf8").trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(rows[0].schema, "stock-monitor-performance-window-v1");
  assert.equal(rows[0].selection_count, 1, "repeated renderer snapshots must be deduplicated");
  assert.equal(rows[0].metrics["renderer.event_loop_delay_ms"].max, 12);
  assert.equal(rows[0].counters["renderer.long_task_count"], 1);
  assert.equal(rows[0].metrics["component.trades.freshness_ms"].max, 25);
  assert.equal(rows[0].metrics["startup.backend_ready_ms"].max, 321);
  assert.equal(rows[0].startup_events[0].detail.attempt, 1);
  assert.equal(rows[0].slow_selections.length, 0);

  const old = path.join(output, "performance", "2026-08-01.jsonl");
  fs.writeFileSync(old, "old telemetry\n");
  fs.utimesSync(old, new Date(2026, 7, 1), new Date(2026, 7, 1));
  const retention = createPerformanceWindowRecorder({ fs, path, outputDir: output,
    electronPid: 43, now: () => now, retentionDays: 7 });
  await retention.close();
  assert.equal(fs.existsSync(old), false, "expired performance telemetry must be removed");
  console.log("Performance window recorder contract passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
