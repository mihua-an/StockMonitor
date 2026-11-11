import assert from "node:assert/strict";

// One bucket delta lands in price order without a full sort; existing buckets are merged in place.
const { applyDeltaToState } = await import("../ui/renderer/js/market_data/realtime_view_store.js");
const base = { price_volume: { buckets: [{ price: 10, volume: 1 }, { price: 12, volume: 2 }] } };
const delta = (bucket) => ({ delta_type: "trade.frame", payload: { price_volume: { bucket } } });
let state = base;
for (const bucket of [{ price: 11, volume: 5 }, { price: 9, volume: 1 }, { price: 13, volume: 4 }, { price: 12, volume: 7 }]) {
  state = applyDeltaToState(state, delta(bucket));
}
const rows = state.price_volume?.buckets;
{
  assert.deepEqual(rows.map((r) => r.price), [9, 10, 11, 12, 13]);
  assert.equal(rows.find((r) => r.price === 12).volume, 7);
  assert.deepEqual(base.price_volume.buckets.map((r) => r.price), [10, 12], "the earlier state is untouched");
}
// A delta does not copy the ladder; the sorted rows are built once, when read, and every intermediate state
// still reads its own ladder.
{
  const levels = 400;
  const start = { price_volume: { buckets: Array.from({ length: levels }, (_, i) => ({ price: i, volume: 1 })) } };
  const realSlice = Array.prototype.slice;
  let copied = 0;
  Array.prototype.slice = function (...args) { if (this.length >= levels) copied += 1; return realSlice.apply(this, args); };
  let s = start;
  const kept = [];
  try {
    for (let n = 0; n < 200; n += 1) {
      s = applyDeltaToState(s, delta({ price: n % levels, volume: 100 + n }));
      if (n === 49) kept.push(s);
    }
    assert.equal(copied, 0, "200 deltas, no ladder copy until someone reads it");
    const latest = s.price_volume.buckets;
    assert.equal(copied, 1, "one build on the first read");
    assert.strictEqual(s.price_volume.byPrice, latest, "byPrice is the same rows");
    assert.strictEqual(s.price_volume.buckets, latest, "a second read reuses the build");
    assert.equal(latest.length, levels);
    assert.equal(latest[199].volume, 299);
    assert.equal(kept[0].price_volume.buckets[49].volume, 149, "an earlier state still reads its own ladder");
    assert.equal(kept[0].price_volume.buckets[50].volume, 1);
    assert.equal(start.price_volume.buckets[0].volume, 1, "the original rows are untouched");
    assert.equal(JSON.parse(JSON.stringify(s.price_volume)).buckets.length, levels, "serialisation sees the rows");
  } finally {
    Array.prototype.slice = realSlice;
  }
  // A projection nobody reads does not hold every delta: it is built every 256 deltas.
  let unread = start;
  for (let n = 0; n < 1000; n += 1) unread = applyDeltaToState(unread, delta({ price: 1, volume: n }));
  assert.equal(unread.price_volume.buckets[1].volume, 999);
}
console.log("renderer price volume merge contract passed");
