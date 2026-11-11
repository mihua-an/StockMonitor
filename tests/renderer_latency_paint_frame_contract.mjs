import assert from "node:assert/strict";
import { installRealtimeHarness } from "./support/realtime_socket_harness.mjs";

// latency.report stamps each traced delta with the next painted frame. It asked for one animation frame per delta;
// while the window is hidden no frame runs, so the requests piled up (thousands per minute under a live feed) and all
// ran in the first frame after show() -- the 1.5-3 s frame (render phase, no script >= 5 ms) on a full close, where
// main shows the hidden window and then waits for app:closing-done. One pending frame now stamps every waiting sample.

const live = installRealtimeHarness();
const frames = new Map();
let nextFrame = 1;
globalThis.requestAnimationFrame = (fn) => { const id = nextFrame++; frames.set(id, fn); return id; };
globalThis.cancelAnimationFrame = (id) => frames.delete(id);
const runFrames = () => { const due = [...frames.values()]; frames.clear(); for (const fn of due) fn(performance.now()); };

const realtime = await import("../ui/renderer/js/market_data/realtime.js");
realtime.startRealtimeStream();
const socket = live.sockets[0];
socket.ready();

const sessionKey = { source: "futu", market: "US", logical_code: "US.AAPL", trading_date: "2026-10-28", session: "DAY" };
const item = (version) => ({ subscription_id: "sub-x", stream_id: "s", session_key: sessionKey, symbol: "US.AAPL", session_generation: 1,
  sequence: version, delta_type: "quote.upsert", channels: ["quote"], payload: {}, trace: { version } });

// A hidden window: 2000 traced deltas arrive and no frame runs.
for (let n = 0; n < 200; n += 1) socket.frame({ type: "view.delta.batch", payload: { items: Array.from({ length: 10 }, (_, i) => item(n * 10 + i + 1)) } });
socket.frame({ type: "view.delta", payload: item(5000) });
assert.equal(frames.size, 1, `traced deltas must share one pending animation frame, not one each (had ${frames.size})`);

// The first frame stamps every sample still waiting, and the report carries the paint time.
runFrames();
assert.equal(frames.size, 0);
live.fireTimers(({ delay }) => delay === 1000);
const report = socket.sentOfType("latency.report").at(-1);
assert.ok(report, "the latency report is sent");
assert.equal(report.payload.samples.length, 512, "the report stays bounded");
assert.ok(report.payload.samples.every((s) => Number.isFinite(s.painted_us) && s.painted_us >= s.applied_us), "every sample has its paint time");

// The next delta asks for a frame again.
socket.frame({ type: "view.delta", payload: item(6000) });
assert.equal(frames.size, 1);
console.log("renderer latency paint frame contract passed");
