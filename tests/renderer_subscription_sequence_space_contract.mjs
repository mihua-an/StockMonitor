// A view's sequence numbers belong to one subscription (Market Runtime numbers every view.subscribe from 1, server.rs
// View::sent_sequence). After a plain WebSocket reconnect to the SAME daemon in the SAME session,
// every Shioaji and Futu view kept the old subscription's sequence (4958: 263254), refused the new subscription's
// snapshot as STALE_SNAPSHOT and its deltas as DUPLICATE_OR_OLD_SEQUENCE / AWAITING_RESYNC_SNAPSHOT, and the 55 s
// re-subscribe started at 1 again -- 成交明細 / 走勢 / 買賣報價 / 商品列 frozen while only events.tape kept moving.
import assert from "node:assert/strict";
import { RealtimeViewStore } from "../ui/renderer/js/market_data/realtime_view_store.js";

const SPEC = { market: "STK", code: "4958", session: "DAY", trading_date: "2026-10-08", channels: ["trades"] };
const SESSION_KEY = { market: "STK", logical_code: "4958", session: "DAY", trading_date: "2026-10-08" };
const DAEMON = "market-runtime-1";

function snapshot(subscriptionId, requestId, watermark, extra = {}) {
  return { subscription_id: subscriptionId, request_id: requestId, stream_id: DAEMON, daemon_instance_id: DAEMON,
    session_generation: 1, session_key: SESSION_KEY, watermark, summary: { current: watermark }, trades: [], trend: [], ...extra };
}

function delta(subscriptionId, sequence, price = sequence) {
  return { subscription_id: subscriptionId, stream_id: DAEMON, daemon_instance_id: DAEMON, session_generation: 1,
    session_key: SESSION_KEY, sequence, delta_type: "trade.append", payload: { price } };
}

function newStore() {
  const sent = [];
  const store = new RealtimeViewStore({ send: (message) => { sent.push(message); return true; } });
  const events = [];
  store.subscribe(SPEC, (event) => events.push(event));
  return { store, sent, events };
}

const entryOf = (store) => store.stats().subscriptions[0];

// Bind the pending request to `subscriptionId` and apply its first snapshot at `watermark`.
function bind(store, subscriptionId, watermark) {
  const { request_id: requestId } = entryOf(store);
  assert.equal(store.handleAccepted({ request_id: requestId, subscription_id: subscriptionId, stream_id: DAEMON, watermark: 0 }), true);
  assert.equal(store.handleSnapshot(snapshot(subscriptionId, requestId, watermark)), true, `snapshot of ${subscriptionId} applies`);
  return requestId;
}

{
  // The incident: a long-lived subscription, a resync in flight, then a reconnect to the same daemon.
  const { store } = newStore();
  store.onConnected();
  bind(store, "sub-1", 263250);
  for (let seq = 263251; seq <= 263254; seq += 1) assert.equal(store.handleDelta(delta("sub-1", seq)), true);
  assert.equal(store.requestResync(store.stats().subscriptions[0].key, { force: true }), true);
  assert.equal(entryOf(store).resync_required, true);

  store.onDisconnected();
  store.onConnected();
  const pending = entryOf(store);
  assert.equal(pending.last_sequence, 0, "a new subscription starts a new sequence space");
  assert.equal(pending.resync_required, false, "a resync of the closed subscription is not carried over");
  assert.ok(store.snapshot(SPEC), "the old state stays as a stale display cache");
  assert.equal(store.snapshot(SPEC).presentation_state, "stale");

  bind(store, "sub-1698", 1);
  assert.equal(entryOf(store).status, "LIVE");
  assert.equal(entryOf(store).baseline_subscription_id, "sub-1698");
  assert.equal(store.handleDelta(delta("sub-1698", 2, 101)), true);
  assert.equal(store.handleDelta(delta("sub-1698", 3, 102)), true);
  assert.equal(store.snapshot(SPEC).trades.at(-1).price, 102);
  assert.equal(store.stats().stale_snapshot_count, 0);

  // A frame of the closed subscription that was still in flight is late, never applied, never a resync.
  const before = store.stats();
  assert.equal(store.handleDelta(delta("sub-1", 263255)), false);
  assert.equal(store.stats().late_closed_delta_count, before.late_closed_delta_count + 1);
  assert.equal(entryOf(store).last_sequence, 3);
}

{
  // The 55 s subscription timeout re-subscribes on the same connection: it must converge, not loop.
  const { store, sent } = newStore();
  store.onConnected();
  bind(store, "sub-10", 5000);
  assert.equal(store.handleDelta(delta("sub-10", 5001)), true);
  // Stuck in RESYNCING past the timeout -> a fresh view.subscribe.
  store.requestResync(entryOf(store).key, { force: true });
  sent.length = 0;
  const later = Date.now() + 60_000;
  store.checkStaleness(later);
  assert.ok(sent.some((m) => m.type === "view.subscribe"), "timed-out resync re-subscribes");
  assert.ok(sent.some((m) => m.type === "view.unsubscribe" && m.payload.subscription_id === "sub-10"));
  bind(store, "sub-11", 1);
  assert.equal(store.handleDelta(delta("sub-11", 2)), true);
  assert.equal(entryOf(store).status, "LIVE");
}

{
  // Within ONE subscription the stale-snapshot gate still holds, and a newer resync snapshot re-baselines it.
  const { store } = newStore();
  store.onConnected();
  const requestId = bind(store, "sub-20", 10);
  assert.equal(store.handleDelta(delta("sub-20", 11)), true);
  assert.equal(store.handleDelta(delta("sub-20", 12)), true);
  assert.equal(store.handleSnapshot(snapshot("sub-20", requestId, 9)), false, "an older snapshot of the same view is stale");
  assert.equal(entryOf(store).last_reject_reason, "STALE_SNAPSHOT");
  assert.equal(store.requestResync(entryOf(store).key, { force: true }), true);
  const resyncId = store.stats().subscriptions[0] && [...store.entries.values()][0].resync_request_id;
  // Deltas cut before the resync snapshot never reach the client (Market Runtime filters them by the cut).
  assert.equal(store.handleDelta(delta("sub-20", 13)), false, "deltas wait for the resync snapshot");
  assert.equal(store.handleSnapshot(snapshot("sub-20", resyncId, 14)), true);
  assert.equal(store.handleDelta(delta("sub-20", 15)), true);
  assert.equal(entryOf(store).last_sequence, 15);
}

{
  // A late snapshot answering the abandoned request cannot re-baseline the new subscription.
  const { store, sent } = newStore();
  store.onConnected();
  const oldRequest = entryOf(store).request_id;
  store.onDisconnected();
  store.onConnected();
  bind(store, "sub-31", 1);
  assert.equal(store.handleSnapshot(snapshot("sub-30", oldRequest, 900)), false);
  assert.equal(entryOf(store).baseline_subscription_id, "sub-31");
  assert.equal(entryOf(store).last_sequence, 1);
  assert.ok(!sent.some((m) => m.type === "view.unsubscribe"), "a view of the dropped connection is not closed on this one");
  assert.equal(store.handleDelta(delta("sub-31", 2)), true);
}

{
  // A delta of the new subscription before its snapshot has no baseline: it is refused and the snapshot asked for
  // again; the retained display state is not touched.
  const { store, sent } = newStore();
  store.onConnected();
  bind(store, "sub-40", 50);
  store.onDisconnected();
  store.onConnected();
  const { request_id: requestId } = entryOf(store);
  store.handleAccepted({ request_id: requestId, subscription_id: "sub-41", stream_id: DAEMON, watermark: 0 });
  sent.length = 0;
  assert.equal(store.handleDelta(delta("sub-41", 2)), false);
  assert.equal(entryOf(store).last_reject_reason, "SNAPSHOT_NOT_APPLIED");
  assert.ok(sent.some((m) => m.type === "view.resync" && m.payload.subscription_id === "sub-41"));
  assert.equal(store.snapshot(SPEC).summary.current, 50);
  assert.equal(store.handleSnapshot(snapshot("sub-41", [...store.entries.values()][0].resync_request_id, 3)), true);
  assert.equal(store.handleDelta(delta("sub-41", 4)), true);
}

console.log("renderer subscription sequence space contract tests passed");
