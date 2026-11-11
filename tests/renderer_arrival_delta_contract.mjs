import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The per-projection arrival must survive the DELTA path, not just the snapshot.
//
// `applyDeltaToState()` merged only the delta's business payload. Every frame carried a fresh
// `channel_arrival_us`, the renderer state kept the snapshot's, and `canonicalReadModel()` therefore
// measured every subsequent event against the first arrival of the session -- so the reported
// "latency" grew with uptime instead of describing the event that was rendered. A long-running page
// would show minutes of BidAsk latency with a perfectly healthy socket.
//
// This drives the REAL store: real handleAccepted/handleSnapshot/handleDelta, the real
// applyDeltaToState behind them, the real canonicalReadModel on the way out, and the real
// componentUpdated at the end. The wire frames are the shapes Market Runtime (native/market_runtime/src/wire.rs) emits.

const { RealtimeViewStore } = await import("../ui/renderer/js/market_data/realtime_view_store.js");
const { canonicalReadModel } = await import("../ui/renderer/js/core/market_read_adapters.js");

globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
globalThis.CustomEvent = class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } };
globalThis.window = { dispatchEvent: () => true };
const clock = Date.now;
let epochMs = 1_800_000_000_000;
Date.now = () => epochMs;

const { componentUpdated, marketRenderDestinationLatency } = await import(
  "../ui/renderer/js/core/market_render_trace.js");

const CODE = "2330";
const SPEC = {
  source: "shioaji", market: "STK", code: CODE, trading_date: "2026-09-28", session: "DAY",
  channels: ["summary", "trend", "trades", "orderbook"], live_expected: true,
};
const us = (msAgo) => (epochMs - msAgo) * 1000;
const identity = {
  source: "shioaji", market: "STK", code: CODE, session: "DAY", trading_date: "2026-09-28",
  session_key: { logical_code: CODE, market: "STK", trading_date: "2026-09-28", session: "DAY" },
};

function boot() {
  const sent = [];
  const store = new RealtimeViewStore({ send: (message) => { sent.push(message); return true; } });
  store.onConnected();
  store.subscribe(SPEC, () => {});
  const accepted = sent.find((m) => m.type === "view.subscribe").payload;
  store.handleAccepted({
    request_id: accepted.request_id, subscription_id: "sub-1", stream_id: "s1", watermark: 0,
  });
  return { store, accepted };
}

/** The read model the components actually consume, from the store's own state. */
const readOf = (store) => canonicalReadModel(store.snapshot(SPEC) || {}, SPEC);

// ---------------------------------------------------------------------------------------------
// A snapshot establishes arrival A; a delta must move it to B.
// ---------------------------------------------------------------------------------------------
for (const lane of [
  { name: "Tick / trades", channel: "trades", component: "trades",
    deltaType: "trade.append", payload: { sequence: 2, price: 1_000_000, volume: 1 },
    destination: "stock_tick:trades" },
  { name: "BidAsk / orderbook", channel: "orderbook", component: "orderbook",
    deltaType: "orderbook.latest", payload: { bids: [], asks: [] },
    destination: "stock_bidask:orderbook" },
]) {
  const { store, accepted } = boot();
  const arrivalA = us(900);
  const arrivalB = us(12);

  store.handleSnapshot({
    ...identity, subscription_id: "sub-1", stream_id: "s1", request_id: accepted.request_id,
    sequence: 1, watermark: 1, summary: { current: 100 }, trades: [], trend: [],
    orderbook: { bids: [], asks: [] },
    channel_arrival_us: {
      summary: arrivalA, trades: arrivalA, trend: arrivalA, orderbook: arrivalA,
      resolution: "epoch_microseconds",
    },
  });
  assert.equal(
    readOf(store).sourceDetails.channelArrivalUs[lane.channel], arrivalA,
    `${lane.name}: the snapshot's arrival must reach the read model`,
  );

  store.handleDelta({
    ...identity, subscription_id: "sub-1", stream_id: "s1", sequence: 2,
    delta_type: lane.deltaType, channels: [lane.channel], payload: lane.payload,
    channel_arrival_us: {
      summary: arrivalB, trades: arrivalB, trend: arrivalB, orderbook: arrivalB,
      resolution: "epoch_microseconds",
    },
  });

  const after = readOf(store).sourceDetails.channelArrivalUs[lane.channel];
  assert.equal(
    after, arrivalB,
    `${lane.name}: a delta's arrival must replace the snapshot's. Holding the snapshot value made `
    + 'the reported latency grow with uptime rather than describe the event just rendered',
  );
  assert.notEqual(after, arrivalA);

  // And it must produce the delta's latency, not the snapshot's, through the real measurement.
  const host = { isConnected: true, dataset: {} };
  componentUpdated(lane.component, { marketRead: readOf(store) }, host);
  const measured = marketRenderDestinationLatency()[lane.destination];
  assert.equal(
    measured.latest_ms, 12,
    `${lane.name}: the measured latency must be the delta's 12ms, not the snapshot's 900ms`,
  );
}

// ---------------------------------------------------------------------------------------------
// The wire keys are the projection names the daemon emits, and `quote` is not one of them.
// ---------------------------------------------------------------------------------------------
{
  // Market Runtime builds every view's arrival stamps in one place (native/market_runtime/src/wire.rs).
  const wireSource = readFileSync(new URL("../native/market_runtime/src/wire.rs", import.meta.url), "utf8");
  const wire = /pub fn arrivals[\s\S]*?\n}/.exec(wireSource)?.[0] || "";
  assert.ok(wire, "wire::arrivals must still exist in Market Runtime");
  for (const key of ["summary", "trades", "orderbook", "trend"]) {
    assert.ok(new RegExp(`"${key}"`).test(wire), `the wire must carry a ${key} arrival`);
  }
  assert.ok(
    !/"quote"/.test(wire),
    'the wire must not key an arrival as "quote": a Shioaji Tick arrives as a trade, so a '
    + 'quote-named stamp is never written for it and any consumer reading one gets nothing',
  );
  assert.ok(
    /arrivals\.summary_us/.test(wire) && /arrivals\.orderbook_us/.test(wire),
    "and the fields must be the projection-named ones, not payload-named",
  );

  const adapters = readFileSync(
    new URL("../ui/renderer/js/core/market_read_adapters.js", import.meta.url), "utf8");
  assert.ok(
    !/channel_arrival_us\?\.quote/.test(adapters),
    "no consumer may read a quote-keyed arrival",
  );
  const page = readFileSync(new URL("../ui/renderer/js/features/realtime/canonical_view_owner.js", import.meta.url), "utf8");
  assert.ok(
    /channel_arrival_us\?\.summary/.test(page),
    "the product row must read the summary projection's arrival, which a Shioaji Tick does update",
  );
}

Date.now = clock;
console.log("renderer arrival delta contract passed");
