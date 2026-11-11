"use strict";
// A forced termination is recorded with the outcome the child actually had -- its exit, or none in time --
// never exitCode read right after kill().
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { killChildAndRecord, TRIGGERS } = require("../service/platform/js/forced_termination.js");

(async () => {
  const events = [];
  const remediation = { emit: (e) => events.push([e.outcome, e.detail.exited]) };
  const fields = { component: "t", serviceId: "svc", trigger: TRIGGERS.START_FAILED, reason: "test" };
  const slow = Object.assign(new EventEmitter(), { pid: 1, exitCode: null, kill() { setTimeout(() => { this.exitCode = 1; this.emit("exit", 1); }, 30); } });
  assert.equal(await killChildAndRecord(slow, remediation, fields, { waitMs: 1000 }), true);
  const stuck = Object.assign(new EventEmitter(), { pid: 2, exitCode: null, kill() {} });
  assert.equal(await killChildAndRecord(stuck, remediation, fields, { waitMs: 50 }), false);
  assert.deepEqual(events, [["succeeded", true], ["failed", false]]);
  console.log("forced termination outcome contract passed");
})().catch((error) => { console.error(error); process.exit(1); });
