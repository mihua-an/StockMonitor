import assert from "node:assert/strict";

// One reading of the providers' 均價 for the crosshair and the 均價 line: a positive value is the average; missing,
// blank, zero, negative or not-a-number carries the previous one; nothing before the first.
const { normalizeProviderAverageSeries, trendIndicatorEngine } = await import("../ui/renderer/js/core/trend/trend_indicator_engine.js");
const points = [
  { minute: 0, average_price: null }, { minute: 1, average_price: "" }, { minute: 2, average_price: 100 },
  { minute: 3, average_price: 0 }, { minute: 4, average_price: "abc" }, { minute: 5, avg_price: "101.5" },
  { minute: 6 }, { minute: 7, average_price: -1 }, { minute: 8, average_price: true },
];
assert.deepEqual(normalizeProviderAverageSeries(points), [null, null, 100, 100, 100, 101.5, 101.5, 101.5, 101.5]);
assert.deepEqual(trendIndicatorEngine.averagePrice(points).map((p) => [p.minute, p.price]),
  [[2, 100], [3, 100], [4, 100], [5, 101.5], [6, 101.5], [7, 101.5], [8, 101.5]],
  "the line draws the same averages the lookup shows (a 0 carries the previous one instead of dropping the point)");
console.log("renderer provider average series contract passed");
