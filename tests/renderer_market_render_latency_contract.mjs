import assert from "node:assert/strict";
import fs from "node:fs";

const frames = [];
const events = [];
globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
globalThis.CustomEvent = class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } };
globalThis.window = { dispatchEvent: event => { events.push(event); return true; } };

const clock = Date.now;
let epochMs = 1_800_000_000_000;
Date.now = () => epochMs;
const { componentUpdated, marketRenderLatencySnapshot, marketRenderTraceSnapshot, marketRenderHealthSnapshot } = await import("../ui/renderer/js/core/market_render_trace.js");

const host = { isConnected: true };
// The wire carries epoch MICROseconds per channel (channel_arrival_us). Nanoseconds as a JSON
// number are past JS's safe-integer range and are rounded by JSON.parse -- see
// renderer_latency_destination_contract.mjs, which pins that with real numbers.
const arrivalUs = (epochMs - 125) * 1000;
componentUpdated("trades", { marketRead: {
  identity: { source: "shioaji", code: "2330", market: "STK" },
  session: { tradingDate: "2026-09-10", name: "DAY" },
  revision: { sequence: 11, streamId: "STK:2330:DAY" },
  sourceDetails: { channelArrivalUs: { trades: arrivalUs } },
} }, host);
epochMs += 8;
frames.shift()();

const trace = marketRenderTraceSnapshot()[0].samples[0];
assert.equal(trace.source_lane, "stock_tick");
assert.equal(trace.arrival_us, arrivalUs);
assert.equal(trace.arrival_to_component_ms, 125);
assert.equal(trace.arrival_to_frame_boundary_ms, 133);
assert.equal(trace.component_updated_epoch_ms, 1_800_000_000_000);
assert.equal(trace.frame_boundary_epoch_ms, 1_800_000_000_008);
const latency = marketRenderLatencySnapshot().stock_tick;
assert.equal(latency.update.p50_ms, 125);
assert.equal(latency.frame.p99_ms, 133);
assert.equal(events[0].type, "stock-monitor:market-render-latency");
assert.equal(events[0].detail.stream_id, "realtime-lane:stock_tick");
host.getClientRects = () => [1];
const health = marketRenderHealthSnapshot();
assert.equal(health[0].active, true);
assert.equal(health[0].sequence, 11);
assert.equal(health[0].frame_at, trace.frame_boundary_epoch_ms);
componentUpdated("trades", { marketRead: {
  identity: { source: "shioaji", code: "2330", market: "STK" },
  revision: { sequence: 12, streamId: "STK:2330:DAY" },
} }, host);
const pendingHealth = marketRenderHealthSnapshot()[0];
assert.equal(pendingHealth.sequence, 12);
assert.equal(pendingHealth.rendered_sequence, 11);
assert.equal(pendingHealth.frame_at, trace.frame_boundary_epoch_ms);
assert.equal(pendingHealth.frame_arrival_us, arrivalUs);
componentUpdated("trades", { marketRead: {
  identity: { source: "shioaji", code: "2330", market: "STK" },
  revision: { sequence: 1, streamId: "STK:2330:DAY", sessionGeneration: 2 },
} }, host);
assert.equal(marketRenderHealthSnapshot()[0].frame_at, 0);
host.getClientRects = () => [];
assert.equal(marketRenderHealthSnapshot()[0].active, false);

const source = fs.readFileSync(new URL("../ui/renderer/js/core/market_render_trace.js", import.meta.url), "utf8");
assert.doesNotMatch(source, /performance\.now\(\)\s*-\s*arrival/i);
Date.now = clock;
console.log("renderer market render latency contract passed");
