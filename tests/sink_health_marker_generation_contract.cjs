"use strict";
// A loss marker is an immutable copy of the loss not yet stated. Confirming it after its write removes exactly what it
// stated -- the total and each reason -- so a loss counted while that write was in flight is stated by the next
// marker with reasons that add up to it (R15-17).
const assert = require("node:assert/strict");
const { createSinkHealth } = require("../service/platform/js/sink_health");

let clock = Date.UTC(2026, 9, 21, 1, 0, 0);
const health = createSinkHealth("t", { now: () => clock });
health.dropped(2, "rate_limited");
health.failed(new Error("disk full"), 1);
const first = health.lossMarker();
assert.deepEqual(first.reasons, { rate_limited: 2, write_failed: 1 });
assert.ok(Object.isFrozen(first) && Object.isFrozen(first.reasons));
clock += 1000;
health.dropped(1, "rate_limited");            // lost while the write carrying `first` is in flight
health.markerWritten(first);
const second = health.lossMarker();
assert.equal(second.lost_records, 1);
assert.deepEqual(second.reasons, { rate_limited: 1 }, "reasons add up to the marker's count");
assert.equal(second.since, first.taken_at, "the rest was lost after the first marker was taken");
health.markerWritten(second);
assert.equal(health.lossMarker(), null);
assert.equal(health.snapshot().unstated_loss, 0);
assert.equal(health.snapshot().lost_records, 4);
console.log("sink health marker generation contract passed");
