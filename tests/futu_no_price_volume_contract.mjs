import assert from "node:assert/strict";

// User decision: Futu has no 價量 and no large-order statistics. Rust B keeps no ladder for Futu (accum.rs
// keeps_price_ladder); its price_volume is only the session's 內外盤 totals, the 買賣報價 內外盤 bar.
globalThis.localStorage ??= { getItem: () => null, setItem() {} };
const { futuCanonicalViewSpec } = await import("../ui/renderer/js/market_data/moomoo_symbol.js");
const spec = futuCanonicalViewSpec("NOK");
assert.equal(spec.code, "US.NOK");
assert.ok(spec.channels.includes("price_volume"), "the 內外盤 bar reads price_volume's totals");
assert.ok(!spec.channels.includes("tradeflow"), "the Futu view reads no large-order statistics");
assert.ok(spec.channels.includes("orderbook") && spec.channels.includes("trades"));
console.log("futu no price volume contract passed");
