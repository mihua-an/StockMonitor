import assert from "node:assert/strict";

// A payload past main's byte bound was sent anyway; main rejected it, the heartbeat stopped and Health
// reported the renderer stale. Now optional detail is dropped until it fits, the report says what was dropped, and
// the components kept are the visible, most recently updated ones -- not whichever 64 came first.
globalThis.window ??= globalThis;
globalThis.document ??= { visibilityState: "visible", querySelectorAll: () => [], addEventListener() {} };
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.addEventListener ??= () => {};
globalThis.location ??= { search: "", href: "http://localhost/" };
const { fitTelemetry, reportedComponents, TELEMETRY_MAX_BYTES } = await import("../ui/renderer/js/core/renderer_runtime_health.js");

const small = { schema: "renderer-runtime-health-v1", sampled_at: 1, subscriptions: [], components: [] };
assert.deepEqual(fitTelemetry(small).truncated, [], "a payload that fits is sent unchanged");
assert.equal(fitTelemetry(small).payload, small);

const big = { ...small, selection_recent: [{ blob: "x".repeat(TELEMETRY_MAX_BYTES) }], components: [{ component: "trades" }] };
const fitted = fitTelemetry(big);
assert.deepEqual(fitted.truncated, ["selection_recent"]);
assert.deepEqual(fitted.payload.selection_recent, []);
assert.equal(fitted.payload.components.length, 1, "detail main can use is kept when dropping less is enough");
assert.ok(fitted.bytes <= TELEMETRY_MAX_BYTES);
assert.ok(fitted.payload.telemetry_original_bytes > TELEMETRY_MAX_BYTES);

const hopeless = { ...small, subscription_count: 3, event_loop_delay_ms: 2, performance: { blob: "y".repeat(TELEMETRY_MAX_BYTES) } };
const bare = fitTelemetry(hopeless);
assert.deepEqual(bare.truncated, ["all"]);
assert.ok(Array.isArray(bare.payload.subscriptions) && Array.isArray(bare.payload.components), "main still accepts it");
assert.equal(bare.payload.subscription_count, 3);
assert.ok(bare.bytes <= TELEMETRY_MAX_BYTES, "the heartbeat always goes out");

const ranked = reportedComponents([
  { component: "a", active: false, updated_at: 9 },
  { component: "b", active: true, updated_at: 1 },
  { component: "c", active: true, updated_at: 5 },
], 2).map((c) => c.component);
assert.deepEqual(ranked, ["c", "b"]);
console.log("renderer telemetry fit contract passed");
