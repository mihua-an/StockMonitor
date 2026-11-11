import assert from "node:assert/strict";
import test from "node:test";

import { RealtimeViewStore } from "../ui/renderer/js/market_data/realtime_view_store.js";

const spec = (code) => ({ market: "STK", code, session: "DAY", trading_date: "2026-09-21" });
const snapshot = ({ code, requestId, subscriptionId, sequence, generation = 7 }) => ({
  code,
  request_id: requestId,
  subscription_id: subscriptionId,
  stream_id: `${code}-stream`,
  generation,
  session_generation: generation,
  sequence,
  watermark: sequence,
  session_key: { market: "STK", logical_code: code, contract_code: code, session: "DAY", trading_date: "2026-09-21" },
  summary: { code, close: sequence }, trend: [{ minute: "09:00", close: sequence }], trades: [], orderbook: {},
});

test("Rust view cache and fencing keep rapid A-B-A on the final selection", () => {
  const sent = [];
  const store = new RealtimeViewStore({ send: (message) => { sent.push(message); return true; } });
  store.onConnected();

  const visible = [];
  let selection = 1;
  const bind = (code, generation) => store.subscribe(spec(code), (event) => {
    if (selection === generation) visible.push({ code, sequence: event.state?.watermark, type: event.type });
  });

  const releaseA1 = bind("2330", 1);
  const a1 = sent.find((message) => message.type === "view.subscribe" && message.payload.code === "2330").payload.request_id;
  store.handleAccepted({ request_id: a1, subscription_id: "a-old", stream_id: "2330-stream" });
  assert.equal(store.handleSnapshot(snapshot({ code: "2330", requestId: a1, subscriptionId: "a-old", sequence: 10 })), true);

  selection = 2;
  releaseA1();
  const releaseB = bind("2317", 2);
  const b1 = sent.findLast((message) => message.type === "view.subscribe" && message.payload.code === "2317").payload.request_id;
  store.handleAccepted({ request_id: b1, subscription_id: "b", stream_id: "2317-stream" });
  assert.equal(store.handleSnapshot(snapshot({ code: "2317", requestId: b1, subscriptionId: "b", sequence: 20 })), true);

  selection = 3;
  releaseB();
  const beforeA2 = visible.length;
  bind("2330", 3);
  // The final A paints its own cached snapshot synchronously, without a
  // callback, REST hydration, or one frame containing B's state.
  assert.deepEqual(visible[beforeA2], { code: "2330", sequence: 10, type: "snapshot" });
  const a2 = sent.findLast((message) => message.type === "view.subscribe" && message.payload.code === "2330").payload.request_id;
  assert.notEqual(a2, a1);
  assert.equal(store.handleSnapshot(snapshot({ code: "2330", requestId: a1, subscriptionId: "a-old", sequence: 99 })), false);

  store.handleAccepted({ request_id: a2, subscription_id: "a-new", stream_id: "2330-stream" });
  assert.equal(store.handleSnapshot(snapshot({ code: "2330", requestId: a2, subscriptionId: "a-new", sequence: 11 })), true);
  assert.equal(store.handleSnapshot(snapshot({ code: "2330", requestId: a2, subscriptionId: "a-new", sequence: 100, generation: 6 })), false);
  assert.deepEqual(visible.at(-1), { code: "2330", sequence: 11, type: "snapshot" });
  assert.equal(visible.some((item, index) => index >= beforeA2 && item.code === "2317"), false);
  // The initial state comes with the subscribe reply (snapshot_follows): no second view.snapshot is asked.
  assert.equal(sent.some((message) => message.type === "view.snapshot"), false);
});

test("first callback after an empty Rust snapshot requests an immediate snapshot", () => {
  const sent = [];
  const store = new RealtimeViewStore({ send: (message) => { sent.push(message); return true; } });
  store.onConnected();
  store.subscribe(spec("2330"), () => {});
  const requestId = sent.find((message) => message.type === "view.subscribe").payload.request_id;
  store.handleAccepted({ request_id: requestId, subscription_id: "new-symbol", stream_id: "rust-1" });
  assert.equal(store.handleDelta({ subscription_id: "new-symbol", stream_id: "rust-1", sequence: 1,
    delta_type: "quote.frame", payload: { summary: { current: 100 } } }), false);
  assert.equal(sent.some((message) => message.type === "view.resync" && message.payload.subscription_id === "new-symbol"), true);
});
