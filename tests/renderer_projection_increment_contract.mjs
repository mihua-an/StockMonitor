// Rust B's live day / flow items name only what changed after the first (`replace: false`). Every publish used to
// carry the whole session's minute series, K bars and price ladder of every changed instrument -- 11-05 13:00-14:00
// that was 4.8 GB of flow and 1.7 GB of day pushed to the screens four times a second. The view state merges an
// increment by key into the block it holds, so it reads exactly as the whole block would.
import assert from "node:assert/strict";
import { applyDeltaToState } from "../ui/renderer/js/market_data/view_state_reducer.js";

let state = {};
state = applyDeltaToState(state, { delta_type: "tradeflow.updated", payload: { replace: true, header_total: 5,
  minuteSeries: [{ minute: 600, c: 1 }, { minute: 601, c: 5 }], largeOrders: [{ durable_sequence: 3 }] } });
state = applyDeltaToState(state, { delta_type: "tradeflow.updated", payload: { replace: false, header_total: 9,
  minuteSeries: [{ minute: 601, c: 6 }, { minute: 602, c: 9 }] } });
assert.deepEqual(state.tradeflow.minuteSeries, [{ minute: 600, c: 1 }, { minute: 601, c: 6 }, { minute: 602, c: 9 }], "minutes by minute");
assert.equal(state.tradeflow.header_total, 9, "the header fields replace");
assert.deepEqual(state.tradeflow.largeOrders, [{ durable_sequence: 3 }], "a large-order list left out is unchanged");
state = applyDeltaToState(state, { delta_type: "tradeflow.updated", payload: { replace: false, minuteSeries: [], largeOrders: [] } });
assert.deepEqual(state.tradeflow.largeOrders, [], "a list it carries replaces");

state = applyDeltaToState(state, { delta_type: "day.updated", payload: { replace: true, volume: 5,
  fixed_k: { k5: [{ start_minute: 600, close: 1 }] },
  price_volume: { out_volume: 5, buckets: [{ price: 100, volume: 2 }, { price: 102, volume: 3 }] } } });
state = applyDeltaToState(state, { delta_type: "day.updated", payload: { replace: false, volume: 8,
  fixed_k: { k5: [{ start_minute: 600, close: 2 }, { start_minute: 605, close: 3 }] },
  price_volume: { out_volume: 8, buckets: [{ price: 101, volume: 3 }] } } });
assert.equal(state.day.volume, 8);
assert.deepEqual(state.day.fixed_k.k5, [{ start_minute: 600, close: 2 }, { start_minute: 605, close: 3 }], "bars by start minute");
assert.deepEqual(state.day.price_volume.buckets.map((b) => b.price), [100, 101, 102], "ladder rows by price");
assert.deepEqual(state.price_volume.buckets.map((b) => [b.price, b.volume]), [[100, 2], [101, 3], [102, 3]], "the 價量 projection merges the rows too");
assert.equal(state.price_volume.out_volume, 8);

// A whole item after increments replaces everything (a reconnect, a new epoch).
state = applyDeltaToState(state, { delta_type: "tradeflow.updated", payload: { replace: true, minuteSeries: [{ minute: 700 }] } });
assert.deepEqual(state.tradeflow.minuteSeries, [{ minute: 700 }]);
// An increment with nothing held is taken as it is (Market Runtime never sends one without a base).
const fresh = applyDeltaToState({}, { delta_type: "tradeflow.updated", payload: { replace: false, minuteSeries: [{ minute: 1 }] } });
assert.deepEqual(fresh.tradeflow.minuteSeries, [{ minute: 1 }]);

console.log("renderer projection increment contract passed");
