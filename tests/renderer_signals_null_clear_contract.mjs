import assert from "node:assert/strict";

// Market Runtime names a new 量變 comparison minute with volume_change_pct null (no
// value yet). The store skipped every null, so the previous minute's percentage stayed under the new minute. Tested
// at the store's own state boundary, not through a page handler.
const { applyDeltaToState } = await import("../ui/renderer/js/market_data/realtime_view_store.js");

let state = {};
const signals = (fields) => ({ delta_type: "signals.frame", payload: { signals: fields } });

state = applyDeltaToState(state, signals({ volume_compare_minute: 600, volume_change_pct: 12.5, chg_1m: 0.4 }));
assert.equal(state.signals.volume_change_pct, 12.5);

const before = state;
state = applyDeltaToState(state, signals({ volume_compare_minute: 601, volume_change_pct: null }));
assert.equal(before.signals.volume_change_pct, 12.5, "the state handed out before is never written to");
assert.equal(state.signals.volume_compare_minute, 601);
assert.equal(state.signals.volume_change_pct, null, "a new comparison minute without a value clears the old one");
assert.equal(state.signals.chg_1m, 0.4, "a field left out is not cleared");

state = applyDeltaToState(state, signals({ chg_1m: null }));
assert.equal(state.signals.chg_1m, 0.4, "a lone null is still 'no new value', as in Market Runtime's merge");

console.log("renderer signals null-clear contract ok");
