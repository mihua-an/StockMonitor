// Futu 成交明細 停住後補跳: Market Runtime used to give every
// view.subscribe of one spec on one connection the SAME view id, so a late reply to an abandoned request named the view
// the spec's current request was bound to, and closing it as an orphan unsubscribed the live view. Market Runtime now
// opens one view per subscribe, and a request this store stops waiting for is cancelled by its own request id.
import assert from "node:assert/strict";
import { RealtimeViewStore } from "../ui/renderer/js/market_data/realtime_view_store.js";

const spec = { source: "futu", market: "US", code: "US.NOK", session: "FULL", trading_date: "",
  channels: ["summary", "trend", "trades", "orderbook", "tradeflow", "signals"], live_expected: true };
const snapshot = (sub, requestId, watermark) => ({ subscription_id: sub, request_id: requestId, watermark, stream_id: "mr-1",
  daemon_instance_id: "mr-1", session_key: { market: "US", logical_code: "US.NOK", session: "FULL", trading_date: "2026-10-06" },
  summary: { current: 10 }, trades: [], trend: [] });
const delta = (sub, sequence) => ({ subscription_id: sub, sequence, stream_id: "mr-1", daemon_instance_id: "mr-1",
  delta_type: "quote.frame", channels: ["summary"], payload: { current: 10 + sequence / 100 } });

function harness() {
  const sent = [];
  const store = new RealtimeViewStore({ send: (m) => { sent.push(m); return true; } });
  store.onConnected();
  const requests = () => sent.filter((m) => m.type === "view.subscribe").map((m) => m.payload.request_id);
  const unsubscribes = () => sent.filter((m) => m.type === "view.unsubscribe").map((m) => m.payload.subscription_id || m.payload.request_id);
  return { store, requests, unsubscribes };
}

// Leave before the accept, come back: the abandoned request is cancelled by its id, the current view keeps streaming.
{
  const { store, requests, unsubscribes } = harness();
  let applied = 0;
  const release = store.subscribe(spec, () => {});
  release();
  store.subscribe(spec, () => { applied += 1; });
  const [rq1, rq2] = requests();
  assert.ok(rq1 && rq2 && rq1 !== rq2);
  store.handleAccepted({ request_id: rq1, subscription_id: "sub-7", stream_id: "mr-1" });
  store.handleSnapshot(snapshot("sub-7", rq1, 1));
  store.handleAccepted({ request_id: rq2, subscription_id: "sub-8", stream_id: "mr-1" });
  assert.equal(store.handleSnapshot(snapshot("sub-8", rq2, 1)), true);
  store.handleSnapshot(snapshot("sub-7", rq1, 1));
  assert.deepEqual(unsubscribes(), [rq1], "only the abandoned request is ever closed, once");
  assert.equal(store.handleDelta(delta("sub-8", 2)), true, "deltas keep applying");
  assert.ok(applied >= 2);
}

// A late snapshot naming the CURRENT view under an old request id is refused but never closes that view.
{
  const { store, requests, unsubscribes } = harness();
  store.subscribe(spec, () => {});
  const [rq1] = requests();
  store.handleAccepted({ request_id: rq1, subscription_id: "sub-3", stream_id: "mr-1" });
  store.handleSnapshot(snapshot("sub-3", rq1, 5));
  store.handleSnapshot(snapshot("sub-3", "view-old-request", 5));
  assert.deepEqual(unsubscribes(), []);
}
console.log("renderer view store own view per request contract passed");
