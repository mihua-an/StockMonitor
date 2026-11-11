import assert from "node:assert/strict";
import { installRealtimeHarness } from "./support/realtime_socket_harness.mjs";

// /ws/realtime's handleMessage() used to swallow any JSON.parse failure with
// a bare `catch (_error) { return; }` -- zero counter, zero log, zero
// diagnostics. The fix counts it and reports it through the existing
// reportClientMetric()/getRealtimeTransportHealth() observability owner
// (already consumed by core/renderer_runtime_health.js), without adding a
// per-event console/log call or changing how a malformed frame is handled
// (it is still dropped).

// No health answer: this test drives the frames itself.
const live = installRealtimeHarness({ health: () => null });
const { sockets, timers } = live;

const fireTimersMatching = live.fireTimers;

const realtime = await import("../ui/renderer/js/market_data/realtime.js");
realtime.startRealtimeStream(() => {});
assert.equal(sockets.length, 1);
const socket = sockets[0];
socket.ready();

// Baseline: normal frame processing before any malformed frame.
assert.equal(realtime.getRealtimeTransportHealth().frame_parse_errors, 0);
assert.equal(realtime.getRealtimeTransportHealth().last_frame_parse_error_at, null);

// 1. A malformed frame must not throw, must be dropped, and must become
//    observable via getRealtimeTransportHealth().
socket.emit("message", { data: "{not valid json" });
let health = realtime.getRealtimeTransportHealth();
assert.equal(health.frame_parse_errors, 1);
assert.ok(health.last_frame_parse_error_at > 0);

// 2. A subsequent well-formed frame must still be processed exactly as
//    before -- normal-frame behavior is completely unchanged.
socket.emit("message", { data: JSON.stringify({ type: "system.heartbeat" }) });
health = realtime.getRealtimeTransportHealth();
assert.equal(health.frame_parse_errors, 1, "a valid frame must not bump the parse-error counter");

// 3. Repeated malformed frames must not flood the socket with one
//    client.metric message per occurrence -- reportClientMetric() coalesces
//    by key and flushes on its own timer.
for (let i = 0; i < 25; i++) socket.emit("message", { data: "still not json" });
assert.equal(realtime.getRealtimeTransportHealth().frame_parse_errors, 26);
const beforeFlush = socket.sent.filter(m => m.type === "client.metric" && m.payload?.name === "REALTIME_FRAME_PARSE_ERROR");
assert.equal(beforeFlush.length, 0, "metric must be batched, not sent per malformed frame");
fireTimersMatching(entry => entry.delay === 2000);
// Client metrics stay in the renderer: the viewer role on market_runtime has no command for them
// (realtime.js flushClientMetrics), so the coalesced sample lands in the local log, never the socket.
const metricLog = () => Object.values(window.__stockMonitorClientMetrics());
assert.equal(socket.sent.filter(m => m.type === "client.metric").length, 0, "client metrics are never sent to market_runtime");
const afterFlush = metricLog().filter(m => m.name === "REALTIME_FRAME_PARSE_ERROR");
assert.equal(afterFlush.length, 1, "coalesced malformed frames must flush as exactly one metric entry");
assert.equal(afterFlush[0].count, 26);

// 4. Schema failures have their own counter, separate from JSON syntax.
const beforeShapeMismatch = realtime.getRealtimeTransportHealth().frame_parse_errors;
socket.emit("message", { data: JSON.stringify([1, 2, 3]) });
assert.equal(realtime.getRealtimeTransportHealth().frame_parse_errors, beforeShapeMismatch);
assert.equal(realtime.getRealtimeTransportHealth().frame_shape_errors, 1);
for (const malformed of [null, 42,
  { type: 'view.delta.batch', payload: { items: [null] } },
  { type: 'view.snapshot', payload: { channels: {} } }]) {
  assert.doesNotThrow(() => socket.emit('message', { data: JSON.stringify(malformed) }));
}
// The probes for market.futures.frame, market.quotes.delta,
// market.signals.delta_batch have no validMessageShape arms.
// Market Runtime cannot send those types, so a shape rule for them described a protocol this
// socket does not speak, and feeding them here asserted against the fixture rather than the
// transport. An unknown type is accepted by `default` and simply finds no handler.
assert.equal(realtime.getRealtimeTransportHealth().frame_shape_errors, 5);
fireTimersMatching(entry => entry.delay === 2000);
const shapeMetrics = metricLog().filter(m => m.name === 'REALTIME_FRAME_SHAPE_ERROR');
assert.equal(shapeMetrics.length, 1);
assert.equal(shapeMetrics[0].count, 5);

// A transport that buffered wire frames in a `pending` object flushed
// on requestAnimationFrame (throttled while the window is hidden) would need a fallback
// timer so a hidden window could not accumulate an unbounded buffer.
//
// That whole layer does not exist. Nothing buffers: RealtimeViewStore applies each
// payload as it is parsed, so there is no pending state whose growth a hidden window could drive,
// and no flush to guarantee. The guard is not being dropped quietly -- its subject is gone. What
// replaces it as the meaningful assertion is that a frame is applied on arrival, with no timer and
// no animation frame in the path at all.
fireTimersMatching(entry => entry.delay === 0);
window.requestAnimationFrame = () => { throw new Error('the transport must not schedule paint work'); };
realtime.startRealtimeStream();

const before = realtime.getRealtimeViewStats?.() ?? null;
assert.doesNotThrow(() => socket.emit('message', { data: JSON.stringify({
  type: 'view.subscription.error', payload: { subscription_id: 'sub-x', error: 'probe' },
}) }), 'a frame must be handled inline, without requestAnimationFrame');
void before;

// Nor may a frame leave a timer armed behind it: the per-frame flush used to arm one every time.
const armedAfterFrame = [...timers.values()].filter(entry => entry.delay === 1000 || entry.delay === 0);
assert.equal(
  armedAfterFrame.length, 0,
  'a view frame must not schedule a flush: the removed scheduleFlush() armed one rAF and one '
  + '1000ms timer per frame, at tick rate, to deliver a batch that was always empty',
);

console.log('A13 PASS; R01 RETIRED: the rAF/timer batch buffer it guarded no longer exists -- frames apply inline (verified here); real Electron minimize/hide NOT VERIFIED (out of reach for this Node harness)');

console.log("renderer realtime frame parse error contract passed");
