"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// Health hosts appended each child output chunk with statSync + appendFileSync on the event loop.
// The sink writes asynchronously, rotates by size, bounds what waits, and records drops in the log itself.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLogSink } = require("../health/services/log_sink");

(async () => {
  const dir = makeTempDir("log-sink-");
  const file = path.join(dir, "svc.log");
  try {
    // No synchronous file call on the write path.
    const syncCalls = [];
    const guarded = { ...fs, promises: fs.promises };
    for (const name of ["appendFileSync", "statSync", "renameSync", "existsSync"]) {
      guarded[name] = (...args) => { syncCalls.push(name); return fs[name](...args); };
    }
    const sink = createLogSink(guarded, file, { limit: 64, maxPendingBytes: 1024 });
    sink.write("first line\n");
    sink.write(Buffer.from("second line\n"));
    await sink.flush();
    assert.equal(fs.readFileSync(file, "utf8"), "first line\nsecond line\n");
    assert.deepEqual(syncCalls, []);

    // Rotation past the limit.
    sink.write("x".repeat(100) + "\n");
    await sink.flush();
    sink.write("after rotation\n");
    await sink.flush();
    assert.ok(fs.readdirSync(dir).some((name) => /^svc\.log\.\d{8}T/.test(name)), "the oversized log was rotated to a timestamped generation");
    assert.equal(fs.readFileSync(file, "utf8"), "after rotation\n");

    // A burst beyond the pending bound is dropped and the drop is written, not silent.
    const small = createLogSink(fs, path.join(dir, "burst.log"), { maxPendingBytes: 10 });
    assert.equal(small.write("12345"), true);
    assert.equal(small.write("1234567890"), false);
    await small.flush();
    assert.match(fs.readFileSync(path.join(dir, "burst.log"), "utf8"), /LOSS MARKER: 1 record\(s\) lost .*write_behind=1/);

    // A failing disk is counted and reported, and the first write after it states the loss in the file.
    let failing = true;
    const flaky = { promises: { ...fs.promises, appendFile: async (...args) => {
      if (failing) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return fs.promises.appendFile(...args);
    } } };
    const flakyFile = path.join(dir, "flaky.log");
    const lossy = createLogSink(flaky, flakyFile);
    lossy.write("a\n");
    lossy.write("b\n");
    let health = await lossy.flush();
    assert.equal(health.state, "FAILING");
    assert.equal(health.lost_records, 2);
    assert.equal(health.last_error.code, "ENOSPC");
    assert.equal(health.unstated_loss, 2, "a flush that failed is not reported as written");
    failing = false;
    lossy.write("c\n");
    health = await lossy.flush();
    assert.equal(health.state, "OK");
    assert.equal(health.unstated_loss, 0);
    const text = fs.readFileSync(flakyFile, "utf8");
    assert.match(text, /^\[health\] LOSS MARKER: 2 record\(s\) lost .*\(write_failed=2\); last error ENOSPC disk full\nc\n$/);

    // A rotation that fails is counted in the sink's health (the same shared writer as Electron main's error log),
    // and the append still happens.
    const lockedFile = path.join(dir, "locked.log");
    fs.writeFileSync(lockedFile, "x".repeat(200));
    const locked = { ...fs, promises: { ...fs.promises, rename: async () => { throw Object.assign(new Error("locked"), { code: "EBUSY" }); } } };
    const rotating = createLogSink(locked, lockedFile, { limit: 64 });
    rotating.write("kept\n");
    health = await rotating.flush();
    assert.equal(health.state, "OK", "the append itself succeeded");
    assert.equal(health.rotation.failures, 1, "a failed rotation of a service log is counted, not only warned");
    assert.equal(health.rotation.last_error.code, "EBUSY");
    assert.match(fs.readFileSync(lockedFile, "utf8"), /kept\n$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("health log sink contract ok");
})().catch((error) => { console.error(error); process.exit(1); });
