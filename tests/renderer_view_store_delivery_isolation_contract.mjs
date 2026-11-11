// The view store delivers through one isolated path: a consumer throwing on the cached snapshot replay is recorded as a
// consumer fault and its caller still gets the unsubscribe handle (no leaked subscription); a delta batch that throws
// part-way leaves batch mode, delivers what it applied, records the failure and rethrows.
import assert from "node:assert/strict";
import { RealtimeViewStore } from "../ui/renderer/js/market_data/realtime_view_store.js";

const errors = [];
console.error = (...args) => errors.push(args.map(String).join(" "));
const spec = { market: "STK", code: "2330", session: "DAY", trading_date: "2026-09-04" };
const key = { market: "STK", logical_code: "2330", session: "DAY", trading_date: "2026-09-04" };
const sent = [], metrics = [];
const store = new RealtimeViewStore({ send: (m) => { sent.push(m); return true; }, onMetric: (m) => metrics.push(m) });
const events = [];
const stopFirst = store.subscribe(spec, (e) => events.push(e));
store.onConnected();
const requestId = sent[0].payload.request_id;
store.handleAccepted({ request_id: requestId, subscription_id: "s", stream_id: "stream", watermark: 0 });
store.handleSnapshot({ request_id: requestId, subscription_id: "s", stream_id: "stream", session_key: key, session_generation: 1, watermark: 0, trades: [] });

// The cached replay to a throwing consumer: recorded, and the handle comes back and releases the callback.
const faultsBefore = store.metrics.consumer_fault_count || 0;
let stopThrowing;
assert.doesNotThrow(() => { stopThrowing = store.subscribe(spec, () => { throw new Error("broken screen"); }, { consumer: "test" }); });
assert.equal(typeof stopThrowing, "function");
assert.equal(store.metrics.consumer_fault_count, faultsBefore + 1);
stopThrowing();
const entry = [...store.entries.values()][0];
assert.equal(entry.callbacks.size, 1, "the throwing consumer is released by its handle");

// A batch whose item throws: batch mode ends, applied items are delivered, the failure is recorded and rethrown.
const delta = (n) => ({ subscription_id: "s", stream_id: "stream", session_key: key, session_generation: 1, sequence: n, delta_type: "trade.append", payload: { price: n, ingest_sequence: n } });
events.length = 0;
const original = store.handleDelta.bind(store);
let calls = 0;
store.handleDelta = (item) => { calls += 1; if (calls === 2) throw new Error("reducer bug"); return original(item); };
assert.throws(() => store.handleDeltaBatch({ items: [delta(1), delta(2), delta(3)] }), /reducer bug/);
assert.equal(store.batch, null, "batch mode ended");
assert.equal(events.length, 1, "the applied item was delivered");
assert.equal(store.metrics.renderer_delta_batch_failed, 1);
assert.ok(errors.some((line) => line.includes("delta batch failed")));
store.handleDelta = original;
events.length = 0;
assert.equal(store.handleDelta(delta(2)), true);
assert.equal(events.length, 1, "a later delta is notified at once (not queued in a stuck batch)");
stopFirst();
console.log("renderer view store delivery isolation contract passed");
