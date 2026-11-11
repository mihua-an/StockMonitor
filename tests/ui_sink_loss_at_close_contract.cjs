"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// The UI's sinks report their health at close; a sink that lost records, is failing, or failed to rotate its file is
// recorded (sink.observability_loss, scalar detail), a healthy one is not. What Health has not acknowledged when the
// UI quits -- it already exited -- is kept in a pending file, and the next UI forwards it.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ShutdownController, pendingRemediationDir, collectPendingRemediation } = require("../ui/main/shutdown_controller.js");
const { createRemediationClient } = require("../service/platform/js/remediation_client.js");

const events = [];
const errors = [];
const fake = { remediationClient: { emit: (e) => events.push(e) }, logger: { error: (line) => errors.push(line) } };
ShutdownController.prototype.recordSinkLoss.call(fake, {
  renderer_health: { sink: "renderer_health", state: "OK", lost_records: 0, rotation: { failures: 0, last_error: null } },
  error_log: { sink: "error_log", state: "OK", lost_records: 7, unstated_loss: 0 },
  performance: { sink: "performance", state: "FAILING", lost_records: 2, last_error: { code: "ENOSPC", message: "disk full" } },
  rotating: { sink: "rotating", state: "OK", lost_records: 0, rotation: { failures: 3, last_error: { message: "EBUSY rename" } } },
  absent: null,
});
assert.deepEqual(events.map((e) => [e.mechanismId, e.detail.sink]),
  [["sink.observability_loss", "error_log"], ["sink.observability_loss", "performance"], ["sink.observability_loss", "rotating"]]);
assert.equal(errors.length, 3);
assert.equal(events[1].detail.last_error, "disk full", "the error message, never an object the detail would stringify");
assert.equal(events[2].detail.rotation_failures, 3);
assert.equal(events[2].detail.rotation_last_error, "EBUSY rename");
for (const event of events) assert.ok(Object.values(event.detail).every((v) => v === null || typeof v !== "object"), JSON.stringify(event.detail));

(async () => {
  const root = makeTempDir("ui-pending-remediation-");
  const env = { ...process.env, STOCK_MONITOR_VAR_ROOT: path.join(root, "var") };
  try {
    // A client whose writer is gone: nothing it emits is acknowledged.
    const client = createRemediationClient({ process: { service_id: "electron_main", instance_id: "e-1", pid: 1, runtime: "node" },
      pipePath: path.join(root, "no-such-pipe"), logger: { warn() {} } });
    client.emit({ component: "ui_sinks", mechanismId: "sink.observability_loss", triggerReason: "records_lost", outcome: "failed",
      identity: {}, detail: { sink: "error_log" } });
    const warned = [];
    const controller = Object.assign(Object.create(ShutdownController.prototype), {
      remediationClient: client, logger: { warn: (line) => warned.push(line), error: (line) => warned.push(line) },
      node: { fs, path, processRef: { pid: 4242, env } },
    });
    assert.equal(await controller.spoolUndeliveredRemediation(0), 1);
    const dir = pendingRemediationDir(env);
    const [file] = fs.readdirSync(dir);
    const kept = fs.readFileSync(path.join(dir, file), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(kept.length, 1);
    assert.equal(kept[0].mechanism_id, "sink.observability_loss");
    assert.ok(warned.some((line) => line.includes("kept for the next start")), warned.join("\n"));

    // The next UI forwards it as it was (same event id) and removes the file.
    const forwarded = [];
    collectPendingRemediation({ forward: (event) => forwarded.push(event) }, { warn() {} }, env);
    assert.deepEqual(forwarded.map((e) => e.event_id), [kept[0].event_id]);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("ui sink loss at close contract passed");
})().catch((error) => { console.error(error); process.exit(1); });
