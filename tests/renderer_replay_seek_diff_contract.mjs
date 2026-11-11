// 歷史回放's seek answered with what changed (`view.replay_diff`): the view store moves the replay view it holds by
// Market Runtime's operations, copies only what they touch, names the channels that changed, and asks for the view
// whole when the operations were made from another view than the one held.
import assert from "node:assert/strict";
import { RealtimeViewStore } from "../ui/renderer/js/market_data/realtime_view_store.js";
import { applyViewDiff } from "../ui/renderer/js/market_data/view_diff.js";

const trade = (n) => ({ durable_sequence: n, price: 100 + n });
const tape = (from, to) => Array.from({ length: to - from }, (_, i) => trade(from + i));
const spec = { source: "shioaji", market: "STK", code: "2303", session: "DAY", trading_date: "2026-10-30", channels: ["trades", "trend", "summary"], replay_id: "replay-1" };

function openReplayView() {
  const sent = [];
  const events = [];
  const remediations = [];
  const store = new RealtimeViewStore({
    send: (message) => { sent.push(message); return true; },
    remediation: { begin: () => ({ end: () => {} }), emit: (event) => remediations.push(event) },
  });
  store.subscribe(spec, (event) => events.push(event));
  store.onConnected();
  const pending = store.stats().subscriptions[0];
  store.handleAccepted({ request_id: pending.request_id, subscription_id: "sub-1", stream_id: "s", replay_id: "replay-1", watermark: 0 });
  store.handleSnapshot({ request_id: pending.request_id, subscription_id: "sub-1", stream_id: "s", watermark: 1, sequence: 1, generation: 4,
    source: "shioaji", market: "STK", code: "2303", trading_date: "2026-10-30", session: "DAY",
    summary: { price: 101, high: 105 }, trades: tape(0, 100), trend: [{ minute: 540, time: "09:00", timestamp: "2026-10-30T09:00:00+08:00", close: 100 }, { minute: 541, time: "09:01", timestamp: "2026-10-30T09:01:00+08:00", close: 101 }],
    orderbook: { bids: [{ price: 100, volume: 3 }] } });
  sent.length = 0;
  events.length = 0;
  return { store, sent, events, remediations };
}

const diff = (extra = {}) => ({ subscription_id: "sub-1", replay_id: "replay-1", base_sequence: 1, base_generation: 4, sequence: 2, watermark: 2,
  generation: 5, resync_reason: "REPLAY_SEEK", channels: ["generation", "sequence", "summary", "trades", "trend", "watermark"],
  ops: [
    { path: ["generation"], set: 5 }, { path: ["sequence"], set: 2 }, { path: ["watermark"], set: 2 },
    { path: ["summary", "price"], set: 103 },
    { path: ["trades"], keep: [3, 100], prepend: [], append: [trade(100), trade(101), trade(102)] },
    { path: ["trend", 1, "close"], set: 103 },
  ], ...extra });

{
  // A seek a few seconds on: the view held moves by the operations, the panels hear only the channels that changed,
  // and what did not change is the same object as before (a panel reading it draws nothing).
  const { store, sent, events } = openReplayView();
  const before = store.snapshot(spec);
  assert.equal(store.handleReplayDiff(diff()), true);
  const after = store.snapshot(spec);
  assert.equal(after.summary.price, 103);
  assert.equal(after.summary.high, 105, "a field the seek did not change stays");
  assert.deepEqual(after.trades.map((t) => t.durable_sequence), Array.from({ length: 100 }, (_, i) => i + 3), "the tape moved on by three prints");
  assert.equal(after.trend[1].close, 103);
  assert.equal(after.generation, 5);
  assert.equal(after.session_generation, 5, "the replay's generation, as a snapshot's is read");
  assert.equal(after.orderbook, before.orderbook, "an untouched channel is the same object");
  assert.deepEqual(after.trend[0], before.trend[0], "the trend, when it changed, is normalized as a snapshot's is");
  assert.notEqual(after.trend, before.trend);
  assert.equal(before.summary.price, 101, "the view held before is not changed under its readers");
  const patch = events.find((event) => event.type === "patch");
  assert.ok(patch, "the change is announced as a patch");
  assert.deepEqual(patch.changedChannels, diff().channels);
  assert.equal(sent.length, 0, "nothing asked of Market Runtime");
  assert.equal(store.stats().replay_diff_count, 1);
  // The next seek moves the view the first one made.
  assert.equal(store.handleReplayDiff(diff({ base_sequence: 2, base_generation: 5, sequence: 3, generation: 6,
    ops: [{ path: ["generation"], set: 6 }, { path: ["trades"], keep: [0, 97], prepend: [trade(0), trade(1), trade(2)], append: [] }] })), true);
  assert.deepEqual(store.snapshot(spec).trades.map((t) => t.durable_sequence), Array.from({ length: 100 }, (_, i) => i), "a seek back moved the tape back");
}

{
  // Made from another view than the one held (another sequence, another generation, operations that do not fit):
  // refused, recorded as the producer's fault, and the view asked for whole; the view shown is left as it was.
  for (const unfit of [{ base_sequence: 7 }, { base_generation: 3 }, { ops: [{ path: ["trades"], keep: [3, 500], prepend: [], append: [] }] },
    { ops: [{ path: ["nowhere", "x"], set: 1 }] }]) {
    const { store, sent, remediations } = openReplayView();
    const before = store.snapshot(spec);
    assert.equal(store.handleReplayDiff(diff(unfit)), false, JSON.stringify(unfit));
    assert.equal(store.snapshot(spec).summary.price, before.summary.price, "the view held is not touched");
    const resync = sent.find((message) => message.type === "view.resync");
    assert.ok(resync, `asked for the view whole: ${JSON.stringify(unfit)}`);
    assert.equal(resync.payload.reason, "replay_diff_unfit");
    assert.ok(remediations.some((event) => JSON.stringify(event).includes("replay_diff_unfit")), "recorded with its reason");
    assert.equal(store.stats().replay_diff_count, 0);
  }
}

{
  // The operations themselves: a tape that moved on, a field gone, a new field, an index set.
  const state = { a: { b: [1, 2, 3], keep: { x: 1 } }, gone: 1, tape: [1, 2, 3, 4] };
  const next = applyViewDiff(state, [
    { path: ["a", "b", 2], set: 9 }, { path: ["gone"], remove: true }, { path: ["new"], set: [1] }, { path: ["tape"], keep: [2, 4], prepend: [0], append: [5, 6] }]);
  assert.deepEqual(next, { a: { b: [1, 2, 9], keep: { x: 1 } }, tape: [0, 3, 4, 5, 6], new: [1] });
  assert.equal(next.a.keep, state.a.keep);
  assert.deepEqual(state, { a: { b: [1, 2, 3], keep: { x: 1 } }, gone: 1, tape: [1, 2, 3, 4] }, "the view held is never changed in place");
  assert.throws(() => applyViewDiff(state, [{ path: ["a", "b", 5], set: 1 }]), /no element/);
  assert.throws(() => applyViewDiff(state, [{ path: ["missing"], remove: true }]), /no field/);
  assert.throws(() => applyViewDiff(state, [{ path: ["a"] }]), /sets, removes or keeps nothing/);
}

console.log("renderer_replay_seek_diff_contract: ok");
