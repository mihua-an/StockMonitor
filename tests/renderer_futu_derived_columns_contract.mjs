import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalMoomooCode } from "../ui/renderer/js/market_data/moomoo_symbol.js";
import { viewStateToMoomooProductFields } from "../ui/renderer/js/features/realtime/moomoo_view_adapter.js";
import { readFutuComponentSources } from "./lib/futu_component_sources.mjs";

// Three Futu-side gaps that all had the same shape: Market Runtime shipped the
// fact, and the renderer threw it away one hop before the panel.
//
//  F2  the crypto row rendered as BTCUSD and every column was `--`, because the
//      renderer rewrote CC.BTC -> CC.BTCUSD on its own. That migration belongs
//      to the Futu daemon, which performs it ONLY when the local security
//      master lists the tradable pair. With no master (a fresh install) the
//      producer publishes futu:CC:CC.BTC while the renderer subscribed
//      futu:CC:CC.BTCUSD -- no state, so the whole row dashed.
//  F3  the 1m/3m/5m columns were `--` for every Futu row: realtimeRow() hardcoded
//      chg_1m/chg_3m/chg_5m to null.
//  F7  個股走勢A showed 振幅 `--`: focusedProduct() rebuilt a bare object out of
//      `summary` and dropped every field product() derives, amplitude included.

// --- F2: code canonicalization must not predict a security-master decision ---
assert.equal(canonicalMoomooCode(" cc.btc "), "CC.BTC", "canonicalization is shape-only: no instrument substitution");
assert.equal(canonicalMoomooCode("nok"), "US.NOK", "a bare code still gets the implicit US. market prefix");
assert.equal(canonicalMoomooCode(""), "");
assert.equal(canonicalMoomooCode("CC.BTCUSD"), "CC.BTCUSD", "CC.BTC and CC.BTCUSD are two instruments, never translated");

const quoteStoreSource = readFileSync(new URL("../ui/renderer/js/features/realtime/moomoo_quote_store.js", import.meta.url), "utf8");
assert.match(quoteStoreSource, /if \(this\.selectedCode && !productCodes\.has\(this\.selectedCode\)\) this\.selectedCode = "";/,
  "a selection the catalog does not list is dropped, never re-pointed at another instrument");

const componentSource = readFutuComponentSources();
assert.match(componentSource, /const code=canonicalMoomooCode\(value\);/, "watch-page codes are used as written (canonical shape)");

// --- F3/F7: one projection owns every derived product fact ---
// Shaped exactly like a Market Runtime view.snapshot payload for a Futu symbol.
const state = {
  summary: { current: 50.05, prev_close: 50, reference_price: 50.5, open: 50, high: 50.85, low: 49.16, total_volume: 202774 },
  trend: [834, 835, 836, 837, 838, 839].map((minute, index) => ({
    minute, time: `13:${54 + index}`, close: 50.2 - index * 0.03, average_price: 50.12,
  })),
  windows: { windows: { 1: { change_pct: 0.1 }, 3: { change_pct: 0.3 }, 5: { change_pct: 0.5 } } },
};
const fields = viewStateToMoomooProductFields(state);
assert.deepEqual([fields.chg_1m, fields.chg_3m, fields.chg_5m], [0.1, 0.3, 0.5],
  "1m/3m/5m are Rust B's rolling windows, the same reading the Shioaji rows use");
const noWindows = viewStateToMoomooProductFields({ summary: state.summary, trend: state.trend });
assert.deepEqual([noWindows.chg_1m, noWindows.chg_3m, noWindows.chg_5m], [null, null, null],
  "without B's windows the columns stay empty: the renderer never computes them from the minute trend");
assert.equal(fields.regular_high, 50.85);
assert.equal(fields.regular_low, 49.16);
assert.equal(fields.prev_close_price, 50);
assert.equal(fields.reference_price, 50.5, "the quote table's 參考價 and price colours read Market Runtime's comparison price");
assert.equal(Object.hasOwn(viewStateToMoomooProductFields({ summary: { current: 1 } }), "reference_price"), false,
  "no comparison price is no field, not a guess from 昨收");
assert.equal(fields.regular_avg_price, 50.12);
// 振幅 is (high-low)/prev_close, which is all product() needs once the adapter
// has supplied regular_high/regular_low/prev_close_price.
assert.equal(
  Number((((fields.regular_high - fields.regular_low) / fields.prev_close_price) * 100).toFixed(2)),
  3.38,
);

assert.doesNotMatch(componentSource, /chg_1m:null/,
  "realtimeRow must not null the minute-change columns Market Runtime already supplies");
assert.match(componentSource, /chg_1m:available\?p\.chg1:null/);
assert.match(componentSource, /chg_3m:available\?p\.chg3:null/);
assert.match(componentSource, /chg_5m:available\?p\.chg5:null/);
// A product row is the quote store's row: the store projects the WHOLE live view state through
// viewStateToMoomooProductFields (the 1m/3m/5m columns come from B's windows and the average price from the minute
// trend, not from `summary`), and realtimeRow runs that row through product().
const storeSource = readFileSync(new URL("../ui/renderer/js/features/realtime/moomoo_quote_store.js", import.meta.url), "utf8");
assert.match(storeSource, /selectRealtimeView\(spec, \(state\) => \(\{ fields: viewStateToMoomooProductFields\(state\) \}\)\)/,
  "the quote store must project the whole view state, not just its summary");
assert.match(componentSource, /realtimeRow\(row, live=true\)\{\s*const p=product\(row\);/,
  "realtimeRow must derive the row through product()");
// The resulting numbers are asserted behaviourally, against a real view state driven through the
// real store, in tests/renderer_moomoo_render_cost_contract.mjs.
// focusedProduct reads the live state through select() (no deep copy) but still projects the WHOLE
// state and still runs the merged row through product().
assert.match(componentSource, /function focusedProduct\(code\)\{[\s\S]*?selectRealtimeView\(spec,\(state\)=>\(\{fields:viewStateToMoomooProductFields\(state\)\}\)\)/,
  "focusedProduct must project the whole view state");
assert.match(componentSource, /return product\(\{\.\.\.base,\.\.\.fields,/,
  "focusedProduct must run the merged row through product() so amplitude survives");

console.log("renderer Futu derived-columns contract passed (F2 code authority, F3 1/3/5m, F7 振幅)");
