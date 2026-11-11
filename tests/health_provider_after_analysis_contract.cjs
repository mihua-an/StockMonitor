"use strict";
// Market Runtime hands unstored events to Rust B only over the live lane, to a B that is connected; nothing re-reads
// them. Health started the providers after Market Runtime alone, so a B that came up later lost what they had already
// sent (`analysis.live_lane_gap` joined_late, 18 partitions marked, 2026-11-03 23:59). The providers now follow B in
// `after` -- order only: a B that fails to start does not hold back the feed (not in `requires`).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Supervisor } = require("../health/supervisor.js");

const source = fs.readFileSync(path.join(__dirname, "..", "health", "main.js"), "utf8");

test("health/main.js starts each provider after Rust B, without requiring it", () => {
  for (const sid of ["provider_shioaji", "provider_futu"]) {
    const line = source.split("\n").find((l) => l.trimStart().startsWith(`${sid}: {`));
    assert.ok(line, `${sid} has a supervisor entry`);
    const after = JSON.parse(line.match(/after: (\[[^\]]*\])/)[1]);
    const requires = JSON.parse(line.match(/requires: (\[[^\]]*\])/)[1]);
    assert.ok(after.includes("analysis_runtime"), `${sid} starts only once Rust B has an outcome`);
    assert.ok(!requires.includes("analysis_runtime"), `${sid} still starts when Rust B fails`);
  }
});

const host = (sid, log, { fail = false } = {}) => ({
  running: false,
  async ensure() { log.push(`start:${sid}`); await new Promise((r) => setImmediate(r)); if (fail) throw new Error(`${sid} cannot start`);
    this.running = true; log.push(`ready:${sid}`); return { pid: 1 }; },
  async stop() { this.running = false; return { ok: true }; },
  async supervisorProbe() { return { alive: this.running, verified: this.running, instance_id: this.running ? `${sid}-1` : null }; },
});

const entries = (log, { bFails = false } = {}) => ({
  market_runtime: { host: host("market_runtime", log), autostart: true, watch: true },
  app_api: { host: host("app_api", log), autostart: true, watch: true },
  analysis_runtime: { host: host("analysis_runtime", log, { fail: bFails }), autostart: true, after: ["market_runtime", "app_api"],
    requires: ["market_runtime", "app_api"], watch: true },
  provider_shioaji: { host: host("provider_shioaji", log), autostart: true, after: ["market_runtime", "analysis_runtime"],
    requires: ["market_runtime"], watch: true },
});

test("a provider starts only after Rust B said ready", async () => {
  const log = [];
  const results = await new Supervisor({ entries: entries(log), logger: { warn() {}, error() {}, log() {} } }).startAll();
  assert.equal(results.provider_shioaji.ok, true);
  assert.ok(log.indexOf("ready:analysis_runtime") < log.indexOf("start:provider_shioaji"), log.join(" "));
});

test("a Rust B that fails to start does not hold back the provider", async () => {
  const log = [];
  const results = await new Supervisor({ entries: entries(log, { bFails: true }), logger: { warn() {}, error() {}, log() {} } }).startAll();
  assert.equal(results.analysis_runtime.ok, false);
  assert.equal(results.provider_shioaji.ok, true);
  assert.ok(log.indexOf("start:analysis_runtime") < log.indexOf("start:provider_shioaji"), log.join(" "));
});
