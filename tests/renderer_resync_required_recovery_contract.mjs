import assert from "node:assert/strict";
import { RealtimeViewStore } from "../ui/renderer/js/market_data/realtime_view_store.js";

// A sequence gap marks the view RESYNC_REQUIRED and asks for a resync -- but requestResync() refuses
// inside its cooldown. Nothing ever asked again: checkStaleness() had no branch for
// RESYNC_REQUIRED, and every later delta is rejected as AWAITING_RESYNC_SNAPSHOT. Two gaps within
// ten seconds (routine under a real feed) froze the view until something resubscribed it -- in the
// app, the user switching tabs. Observed after the isolated feed: 5 views left RESYNC_REQUIRED.

const sent = [];
const store = new RealtimeViewStore({ send: (message) => { sent.push(message); return true; }, resyncCooldownMs: 10000 });
store.subscribe({ source: "shioaji", market: "IDX", code: "TAIEX", session: "DAY", trading_date: "2026-09-28", channels: ["trend"] }, () => {});
store.onConnected();
const entry = store.stats().subscriptions[0];
store.handleAccepted({ request_id: entry.request_id, subscription_id: "sub-1", stream_id: "s", watermark: 0 });
store.handleSnapshot({ subscription_id: "sub-1", request_id: entry.request_id, stream_id: "s", session_generation: 1, watermark: 0, trend: [] });
const delta = (sequence) => ({ subscription_id: "sub-1", stream_id: "s", sequence, delta_type: "trend.upsert", payload: { minute: 540 + sequence } });

// Gap 1: the resync goes out.
assert.equal(store.handleDelta(delta(1)), true);
store.handleDelta(delta(3));
assert.equal(sent.filter((m) => m.type === "view.resync").length, 1);
// Its snapshot re-baselines the view.
const resync = sent.findLast((m) => m.type === "view.resync");
store.handleSnapshot({ subscription_id: "sub-1", request_id: resync.payload.request_id, stream_id: "s", session_generation: 1, watermark: 3, trend: [] });
// Gap 2 inside the cooldown: refused, the view is RESYNC_REQUIRED with nothing in flight.
store.handleDelta(delta(4));
store.handleDelta(delta(6));
assert.equal(sent.filter((m) => m.type === "view.resync").length, 1, "the cooldown refuses the second resync");
assert.equal(store.stats().subscriptions[0].status, "RESYNC_REQUIRED");

// The supervisor must ask again once the cooldown has passed.
store.checkStaleness(Date.now() + 11000);
assert.equal(sent.filter((m) => m.type === "view.resync").length, 2,
  "a view left RESYNC_REQUIRED must be resynced by the staleness sweep, or it stays frozen");
assert.equal(store.stats().subscriptions[0].status, "RESYNCING");
console.log("renderer resync-required recovery contract passed");
