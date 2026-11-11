import assert from "node:assert/strict";

// The view stats core diagnostics read have one shape: a count and an array. Before the feature registers, the
// reader answers that empty shape; a reader that is not a function (or an unknown one) is refused at register time;
// a snapshot in another shape is logged and read as its empty form, so the health sampler's filter cannot throw.
const warnings = [];
console.warn = (...args) => warnings.push(String(args[0]));
const stats = await import("../ui/renderer/js/core/realtime_stats.js");

assert.deepEqual(stats.getRealtimeViewStats(), { client_subscription_count: 0, subscriptions: [] });
assert.throws(() => stats.registerRealtimeStats({ viewStats: {} }), /viewStats is not a function/);
assert.throws(() => stats.registerRealtimeStats({ viewStat: () => ({}) }), /unknown reader viewStat/);

stats.registerRealtimeStats({ viewStats: () => ({}) });
assert.deepEqual(stats.getRealtimeViewStats(), { client_subscription_count: 0, subscriptions: [] });
stats.getRealtimeViewStats();
assert.equal(warnings.length, 1, "a wrong shape is logged once, not every sample");
assert.match(warnings[0], /client_subscription_count is not a number; subscriptions is not an array/);

const good = { client_subscription_count: 2, subscriptions: [{ active: true }], dropped: 1 };
stats.registerRealtimeStats({ viewStats: () => good });
assert.equal(stats.getRealtimeViewStats(), good, "a snapshot in shape passes through as is");
console.log("renderer realtime stats shape contract passed");
