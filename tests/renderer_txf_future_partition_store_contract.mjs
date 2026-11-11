import assert from "node:assert/strict";

// 夜盤 across midnight: the display subscribes the next calendar partition before 00:00, while Market
// Runtime holds nothing for it. Its snapshot is empty (sequence 0) and the first event after midnight arrives as
// delta sequence 1: the real store must take it, or the after-midnight half of the night never shows.
globalThis.CustomEvent = class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } };
globalThis.window = { dispatchEvent: () => true };
const { RealtimeViewStore } = await import("../ui/renderer/js/market_data/realtime_view_store.js");

const SPEC = { source: "shioaji", market: "FUT", code: "TXFR1", trading_date: "2026-10-01", session: "FULL",
  channels: ["summary", "trend"], live_expected: true };
const identity = { source: "shioaji", market: "FUT", code: "TXFR1", session: "FULL", trading_date: "2026-10-01",
  session_key: { logical_code: "TXFR1", market: "FUT", trading_date: "2026-10-01", session: "FULL" } };

const sent = [];
const events = [];
const store = new RealtimeViewStore({ send: (message) => { sent.push(message); return true; } });
store.onConnected();
store.subscribe(SPEC, (event) => events.push(event));
const request = sent.find((m) => m.type === "view.subscribe").payload;
store.handleAccepted({ request_id: request.request_id, subscription_id: "sub-1", stream_id: "s1", watermark: 0 });
store.handleSnapshot({ ...identity, subscription_id: "sub-1", stream_id: "s1", request_id: request.request_id,
  sequence: 0, watermark: 0, summary: {}, trend: [] });
store.handleDelta({ ...identity, subscription_id: "sub-1", stream_id: "s1", sequence: 1, delta_type: "trend.upsert",
  channels: ["trend"], payload: { timestamp: "2026-10-01T00:00:00+08:00", minute_timestamp: "2026-10-01T00:00:00+08:00", minute: 0, close: 48470, price: 48470, volume: 3 } });
const state = store.snapshot(SPEC);
assert.equal((state?.trend || []).length, 1, "the first after-midnight point is kept");
assert.ok(events.some((e) => e.type === "delta" || e.type === "batch"), "and the subscriber is told");
console.log("renderer txf future partition store contract ok");
