"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// The renderer error log and the performance window recorder used to swallow every write
// error and still resolve flush/close as if the data were on disk. Now each counts the loss with its last error,
// reports FAILING, and the first write that succeeds again states the loss in the file itself.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createErrorLogWriter } = require("../ui/main/renderer_health");
const { createPerformanceWindowRecorder } = require("../ui/main/performance_window_recorder");

(async () => {
  const dir = makeTempDir("sink-health-");
  try {
    let failing = true;
    const flakyAppend = (real) => (...args) => {
      if (failing) {
        const callback = args.find((a) => typeof a === "function");
        const error = Object.assign(new Error("disk full"), { code: "ENOSPC" });
        if (callback) return callback(error);
        return Promise.reject(error);
      }
      return real(...args);
    };
    const flakyFs = { ...fs, appendFile: flakyAppend(fs.appendFile), promises: { ...fs.promises, appendFile: flakyAppend(fs.promises.appendFile) } };

    const file = path.join(dir, "error.log");
    const writer = createErrorLogWriter(flakyFs, file, { now: () => 1_000_000 });
    writer.write("one\n");
    writer.write("two\n");
    let health = await writer.flush();
    assert.equal(health.state, "FAILING");
    assert.equal(health.lost_records, 2);
    assert.equal(health.unstated_loss, 2);
    failing = false;
    writer.write("three\n");
    health = await writer.flush();
    assert.equal(health.state, "OK");
    assert.equal(health.unstated_loss, 0);
    assert.match(fs.readFileSync(file, "utf8"), /LOSS MARKER: 2 record\(s\) lost[^\n]*ENOSPC disk full\nthree\n$/);

    failing = true;
    let now = new Date(2026, 9, 10, 9, 0, 0).getTime();
    const recorder = createPerformanceWindowRecorder({ fs: flakyFs, path, outputDir: dir, electronPid: 1,
      now: () => now, windowMs: 1000 });
    recorder.observe(1, { sampled_at: now, event_loop_delay_ms: 1, performance: {}, components: [] });
    health = await recorder.close();
    assert.equal(health.state, "FAILING", "close() no longer reads as written");
    assert.equal(health.unstated_loss, 1);
    failing = false;
    now += 5000;
    recorder.observe(1, { sampled_at: now, event_loop_delay_ms: 2, performance: {}, components: [] });
    health = await recorder.close();
    assert.equal(health.state, "OK");
    const rows = fs.readdirSync(path.join(dir, "performance")).flatMap((name) =>
      fs.readFileSync(path.join(dir, "performance", name), "utf8").trim().split("\n").map(JSON.parse));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].loss_marker.lost_records, 1, "the written window says one window before it was lost");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("observability sink health contract passed");
})().catch((error) => { console.error(error); process.exit(1); });
