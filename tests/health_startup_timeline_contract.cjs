"use strict";
// Health's startup timeline (health/startup/timeline.js): each stage carries its wall-clock and monotonic times, a
// stage that fails ends with a terminal failed record, a stage never ended shows as unfinished, and one structured
// line closes the startup. A fake clock: no sleeps.
const assert = require("node:assert/strict");
const { createStartupTimeline } = require("../health/startup/timeline.js");

(async () => {
  let mono = 120;                       // Health's own elapsed time when main() runs (module loading before it)
  const wall = () => new Date(Date.UTC(2026, 9, 14, 5, 10, 10) + mono);
  const lines = [];
  const timeline = createStartupTimeline({ wallNow: wall, monoNow: () => mono, processUptimeMs: () => mono, log: (l) => lines.push(l) });

  timeline.mark("main");
  const ledger = timeline.stage("remediation_ledger", () => { mono += 22; return { source: "checkpoint" }; }, (r) => ({ source: r.source }));
  assert.deepEqual(ledger, { source: "checkpoint" }, "the stage's value is passed through");
  const listen = await timeline.stage("control_listen", async () => { mono += 3; });
  assert.equal(listen, undefined);
  await assert.rejects(timeline.stage("start_all", async () => { mono += 40; throw new Error("bind failed"); }), /bind failed/);
  assert.throws(() => timeline.stage("sync_stage", () => { mono += 1; throw new Error("boom"); }), /boom/);
  const hanging = timeline.begin("storage_location");
  mono += 5;
  const span = timeline.begin("collector_first_probe");
  mono += 2;
  span.end({ probes: 7 });
  assert.equal(span.end(), null, "a stage ends once");

  const stages = timeline.stages();
  assert.deepEqual(stages.map((s) => [s.stage, s.outcome]), [["main", "reached"], ["remediation_ledger", "ok"], ["control_listen", "ok"],
    ["start_all", "failed"], ["sync_stage", "failed"], ["collector_first_probe", "ok"]]);
  assert.equal(stages[0].at_ms, 120);
  assert.equal(stages[0].at, "2026-10-14T05:10:10.120Z", "wall-clock ISO time");
  assert.deepEqual([stages[1].start_ms, stages[1].end_ms, stages[1].ms], [120, 142, 22], "monotonic elapsed and duration");
  assert.deepEqual(stages[1].detail, { source: "checkpoint" });
  assert.equal(stages[3].error, "bind failed", "a failed stage carries its error");
  assert.deepEqual(stages[5].detail, { probes: 7 });
  assert.ok(lines.some((l) => l === "[HEALTH] [startup +142 ms] remediation_ledger ok 22 ms {\"source\":\"checkpoint\"}"), lines.join("\n"));

  const result = timeline.finish("ready", { services: 7 });
  assert.equal(result.outcome, "ready");
  assert.equal(result.elapsed_ms, mono);
  assert.deepEqual(result.unfinished.map((s) => s.stage), ["storage_location"], "a stage never ended is reported, not dropped");
  void hanging;
  const last = lines.at(-1);
  assert.ok(last.startsWith("[HEALTH] startup timeline {"), last);
  assert.deepEqual(JSON.parse(last.slice("[HEALTH] startup timeline ".length)), result, "one structured line");
  assert.equal(timeline.finish("failed"), result, "finished once");
  console.log("health startup timeline contract: ok");
})().catch((error) => { console.error(error); process.exit(1); });
