import assert from "node:assert/strict";
import { trendSurfaceSource } from "./lib/trend_surface_sources.mjs";

// 漲跌 / 漲幅 / 振幅 are the view model's: 漲跌 / 漲幅 are Market Runtime's (passed through trendMetrics, never derived
// from two prices, D01-04), 振幅 is the range against 昨收; the header presenter only formats what it gets. A null the
// view model sends stays "--"; the presenter never recomputes it from prices.
const source = trendSurfaceSource();
globalThis.window ??= { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} };
const { tabAmplitude, trendMetrics } = await import("../ui/renderer/js/core/trend_metrics.js");

const sent = trendMetrics({ change: 50, changePct: 0.238, amplitude: 0.81 });
assert.deepEqual([sent.change, sent.changePct, sent.amplitude], [50, 0.238, 0.81], "Market Runtime's 漲跌 / 漲幅 / 振幅 as sent");
assert.deepEqual(Object.keys(sent).sort(), ["amplitude", "change", "changePct"], "a limit price is never derived");

// Missing inputs give missing values, never 0 or NaN; nothing is derived from a price pair.
const bare = trendMetrics({ current: 21050, reference: 21000, high: 21100, low: 21000 });
assert.deepEqual([bare.change, bare.changePct, bare.amplitude], [null, null, null], "nothing sent: nothing computed");

// A 期貨 tab's own range is not the instrument's day: only it is computed here.
assert.ok(Math.abs(tabAmplitude({ reference: 21000, high: 21120, low: 20950 }) - 170 / 21000 * 100) < 1e-9, "(最高 - 最低) / 基準");
assert.equal(tabAmplitude({ reference: 0, high: 2, low: 1 }), null, "a zero reference is not divided by");
assert.equal(tabAmplitude({ reference: 9, high: 11 }), null, "振幅 needs both 最高 and 最低");

// The presenter reads the view model's metrics as they are.
assert.match(source, /const metrics = vm\?\.metrics \|\| \{\};/, "syncMetrics formats the view model's metrics only");
assert.doesNotMatch(source, /derivedMetrics/, "no second computation of the metrics in the presenter");

console.log("trend derived metrics contract passed");
