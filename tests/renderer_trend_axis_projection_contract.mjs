import assert from "node:assert/strict";
import { TimeAxisPolicy, createFuturesTimeAxis } from "../ui/renderer/js/core/trend/time_axis_policy.js";
import { projectTrendForDisplay } from "../ui/renderer/js/core/trend/trend_projection.js";
import { resolveTrendAdapter, FuturesTrendAdapter, ReplayTrendAdapter } from "../ui/renderer/js/core/trend/adapters.js";

// TimeAxisPolicy refuses a wrong configuration where it is built, with the policy id and the segment index.
assert.throws(() => new TimeAxisPolicy({ id: "p", segments: [] }), /TimeAxisPolicy p: segments must be a non-empty array/);
assert.throws(() => new TimeAxisPolicy({ id: "p" }), /non-empty array/);
assert.throws(() => new TimeAxisPolicy({ id: "p", segments: [{ start: "09:00", end: "13:30" }, { start: "x", end: "15:00" }] }),
  /TimeAxisPolicy p: segment 1 has an unreadable start \(x\)/);
assert.throws(() => new TimeAxisPolicy({ id: "p", segments: [{ start: "09:00", end: "25:00" }] }), /segment 0 has an unreadable end/);
assert.throws(() => new TimeAxisPolicy({ id: "p", segments: [{ start: "09:00", end: "09:00" }] }), /segment 0 is empty/);
assert.throws(() => new TimeAxisPolicy({ id: "p", segments: [{ start: "09:00", end: "13:30" }, { start: "13:00", end: "14:00" }] }),
  /segment 1 overlaps segment 0/);
assert.throws(() => new TimeAxisPolicy({ id: "p", segments: [{ start: "20:00", end: "04:00" }, { start: "03:00", end: "09:30" }] }),
  /segment 1 overlaps segment 0/, "a segment past midnight overlaps the next morning's");
// Touching ends are fine (US pre / regular / after), as is a night segment past midnight.
const us = new TimeAxisPolicy({ id: "us", segments: [{ start: "20:00", end: "04:00" }, { start: "04:00", end: "09:30" }, { start: "09:30", end: "16:00" }] });
assert.equal(us.span, 480 + 330 + 390);
assert.ok(Object.isFrozen(us) && Object.isFrozen(us.segments[0]), "a policy is immutable");

// One futures policy per session: the adapter's every draw gets the same object.
assert.equal(createFuturesTimeAxis("full"), createFuturesTimeAxis("full"));
assert.notEqual(createFuturesTimeAxis("day"), createFuturesTimeAxis("full"));
assert.equal(createFuturesTimeAxis("DAY"), createFuturesTimeAxis("day"));

// The display projection: first and last kept, each bucket's extremes in source order, never above capacity.
const series = Array.from({ length: 10000 }, (_, i) => ({ time: i, price: 100 + Math.sin(i / 50) * 10 + (i === 4321 ? 50 : 0) }));
const projected = projectTrendForDisplay(series, { maxPoints: 200 });
assert.ok(projected.length <= 200, `capacity: ${projected.length}`);
assert.equal(projected[0], series[0]);
assert.equal(projected.at(-1), series.at(-1));
assert.ok(projected.includes(series[4321]), "the spike survives");
const times = projected.map((point) => point.time);
assert.deepEqual(times, [...times].sort((a, b) => a - b), "source order is kept");
// The same point object repeated: it is kept at the place it was found, not at its first occurrence.
const flat = { price: 100 }, high = { price: 120 }, low = { price: 80 };
const repeated = [flat, ...Array.from({ length: 98 }, (_, i) => (i === 10 ? high : i === 80 ? low : flat)), flat];
const shown = projectTrendForDisplay(repeated, { maxPoints: 32 });
assert.ok(shown.includes(high) && shown.includes(low));
assert.ok(shown.indexOf(high) < shown.indexOf(low), "high (earlier) is drawn before low (later)");
// Linear: a 200k-point series projects quickly.
const big = Array.from({ length: 200000 }, (_, i) => ({ price: i % 997 }));
const started = performance.now();
projectTrendForDisplay(big, { maxPoints: 1500 });
assert.ok(performance.now() - started < 500, "the projection is one pass");
// One name per adapter; an old alias or a typo is refused, not drawn as equity.
assert.ok(resolveTrendAdapter("futures") instanceof FuturesTrendAdapter);
assert.ok(resolveTrendAdapter("replay") instanceof ReplayTrendAdapter);
for (const name of ["market", "txf", "history", "Futures", "toString"]) assert.throws(() => resolveTrendAdapter(name), /unknown trend adapter type/);
console.log("renderer trend axis projection contract passed");
