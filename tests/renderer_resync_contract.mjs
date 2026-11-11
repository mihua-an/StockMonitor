import assert from "node:assert/strict";
import { RealtimeViewStore } from "../ui/renderer/js/market_data/realtime_view_store.js";

function createReadyStore() {
  const sent = [];
  const store = new RealtimeViewStore({
    send: (message) => { sent.push(message); return true; },
  });
  store.subscribe({ market: "TW", code: "2330", session: "DAY", trading_date: "2026-09-04", channels: ["trades"] }, () => {});
  store.onConnected();
  const entry = store.stats().subscriptions[0];
  store.handleAccepted({ request_id: entry.request_id, subscription_id: "sub-1", stream_id: "TW|2330|DAY|2026-09-04", watermark: 0 });
  store.handleSnapshot({ subscription_id: "sub-1", request_id: entry.request_id, stream_id: "TW|2330|DAY|2026-09-04", session_generation: 1, watermark: 0, summary: {}, trend: [], trades: [] });
  sent.length = 0;
  return { store, sent };
}

function delta(sequence, extra = {}) {
  return {
    subscription_id: "sub-1",
    stream_id: "TW|2330|DAY|2026-09-04",
    sequence,
    delta_type: "trade.append",
    // A print as Market Runtime sends it: its durable sequence and exchange time (the view orders and keeps prints by
    // them -- view_state_reducer.insertTrade), one second apart.
    payload: { price: sequence, source: "shioaji", ingest_sequence: sequence,
      exchange_ts_ns: String(BigInt(Date.UTC(2026, 8, 4, 1, 0, 0)) * 1_000_000n + BigInt(sequence) * 1_000_000_000n) },
    ...extra,
  };
}

{
  const { store, sent } = createReadyStore();
  assert.equal(store.handleDeltaBatch({ subscription_id: "sub-1", items: [delta(1), delta(3), delta(4)] }), true);
  assert.equal(sent.filter((item) => item.type === "view.resync").length, 1);
  assert.equal(store.stats().renderer_delta_batch_aborted, 1);
}

{
  // Tabs asking for identical channels in a different order share one
  // subscription. Releasing the final tab retains the last snapshot for a
  // fast A/B/A switch, while the live server subscription is closed.
  const sent = [];
  const store = new RealtimeViewStore({
    send: (message) => { sent.push(message); return true; },
    cacheRetentionMs: 60000,
  });
  store.onConnected();
  const firstEvents = [];
  const releaseFirst = store.subscribe({market:"STK",code:"2330",session:"DAY",trading_date:"2026-09-04",channels:["trades","trend","orderbook"]}, event=>firstEvents.push(event));
  const pending = store.stats().subscriptions[0];
  store.handleAccepted({request_id:pending.request_id,subscription_id:"shared-sub",stream_id:"STK:2330:2026-09-04:DAY",watermark:0});
  store.handleSnapshot({request_id:pending.request_id,subscription_id:"shared-sub",stream_id:"STK:2330:2026-09-04:DAY",session_generation:1,watermark:2,summary:{current:100},trades:[{price:100}],trend:[{timestamp:"2026-09-04T09:00:00+08:00",time:"09:00",price:100}],orderbook:{bid_prices:[99],bid_volumes:[1]}});
  const releaseSecond = store.subscribe({market:"STK",code:"2330",session:"DAY",trading_date:"2026-09-04",channels:["orderbook","trend","trades"]},()=>{});
  assert.equal(store.stats().subscriptions.length,1);
  releaseFirst(); releaseSecond();
  assert.equal(store.stats().subscriptions[0].status,"CACHED");
  assert.equal(store.snapshot({market:"STK",code:"2330",session:"DAY",trading_date:"2026-09-04",channels:["trend","trades","orderbook"]}).trades[0].price,100);
  const cachedEvents=[];
  const releaseCached=store.subscribe({market:"STK",code:"2330",session:"DAY",trading_date:"2026-09-04",channels:["trades","orderbook","trend"]},event=>cachedEvents.push(event));
  assert.equal(cachedEvents[0].state.trades[0].price,100);
  assert.equal(cachedEvents[0].entry.status,"SUBSCRIBING");
  assert.equal(cachedEvents[0].state.presentation_state,"stale");
  releaseCached();
}

{
  // A sequence gap must preserve the last visible snapshot and expose an
  // explicit resync state instead of clearing all three realtime panels.
  const {store}=createReadyStore();
  assert.equal(store.handleDelta(delta(2)),false);
  const state=store.snapshot({market:"TW",code:"2330",session:"DAY",trading_date:"2026-09-04",channels:["trades"]});
  assert.equal(state.presentation_state,"resyncing");
  assert.equal(state.stale,true);
  assert.deepEqual(state.trades,[]);
}

{
  // The renderer retains only the display window; persistence remains the
  // backend recorder's responsibility.
  const {store}=createReadyStore();
  for(let sequence=1;sequence<=200;sequence++) store.handleDelta(delta(sequence));
  const snapshot=store.snapshot({market:"TW",code:"2330",session:"DAY",trading_date:"2026-09-04",channels:["trades"]});
  assert.equal(snapshot.trades.length,100);
  assert.equal(snapshot.trades[0].price,101);
}

{
  // A newer provider generation (a broker reconnect, an App restart) continues the same state in Market Runtime and
  // its view sequence carries on: contiguous deltas are applied and the generation adopted, no resync (each App start
  // re-snapshotted every view the providers touched). A gap still resyncs; an older generation is a fault, resynced.
  const { store, sent } = createReadyStore();
  assert.equal(store.handleDeltaBatch({ subscription_id: "sub-1", items: [delta(1, { session_generation: 2 }), delta(2, { session_generation: 2 })] }), true);
  assert.equal(sent.filter((item) => item.type === "view.resync").length, 0, "a reconnect's next delta is no reason to resync");
  assert.equal(store.stats().subscriptions[0].session_generation, 2, "the newer generation is adopted");
  assert.equal(store.handleDelta(delta(4, { session_generation: 3 })), false, "a gap under a new generation still resyncs");
  assert.equal(store.stats().subscriptions[0].last_reject_reason, "SEQUENCE_GAP");
  const older = createReadyStore();
  assert.equal(older.store.handleDelta(delta(1, { session_generation: 2 })), true);
  assert.equal(older.store.handleDelta(delta(2, { session_generation: 1 })), false);
  assert.equal(older.store.stats().subscriptions[0].last_reject_reason, "SESSION_GENERATION_CHANGED");
  assert.equal(older.sent.filter((item) => item.type === "view.resync").length, 1);
}

{
  const { store } = createReadyStore();
  assert.equal(store.handleDelta(delta(1, { stream_id: "TW|2317|DAY|2026-09-04" })), false);
  assert.equal(store.stats().renderer_delta_applied, 0);
}

{
  const { store } = createReadyStore();
  assert.equal(store.handleDelta(delta(1, {
    delta_type: "trade.frame",
    channels: ["trades", "summary", "trend", "price_volume"],
    payload: {
      trade: { price: 101, volume: 2 }, summary: { current: 101, pct_chg: 1 },
      trend: { action: "append", point: { timestamp: "2026-09-04T09:01:00+08:00", time: "09:01", close: 101 } },
      price_volume: { bucket: { price: 101, total_volume: 2 } },
    },
  })), true);
  const state = store.snapshot({ market: "TW", code: "2330", session: "DAY", trading_date: "2026-09-04", channels: ["trades"] });
  assert.equal(state.trades.at(-1).price, 101);
  assert.equal(state.summary.current, 101);
  assert.equal(state.trend.length, 1);
  assert.equal(state.price_volume.buckets[0].price, 101);
}

{
  const { store, sent } = createReadyStore();
  const first = store.stats().subscriptions[0];
  store.onDisconnected();
  store.onConnected();
  const second = store.stats().subscriptions[0];
  assert.notEqual(second.request_id, first.request_id);
  assert.equal(store.handleAccepted({
    request_id: first.request_id,
    subscription_id: "late-old-subscription",
    stream_id: first.stream_id,
    watermark: 0,
  }), false);
  // A request of the dropped connection: its view went with that socket, and this window never closes a view it did
  // not open on this connection.
  assert.equal(sent.some((item) => item.type === "view.unsubscribe"), false);
}

console.log("renderer resync contract tests passed");
